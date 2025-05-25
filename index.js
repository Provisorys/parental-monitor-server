const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT;

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_CHILDREN = 'Children';
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Usando sua tabela existente
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Configuração do Multer para upload de arquivos em memória
const upload = multer({ storage: multer.memoryStorage() });

// Mapa para armazenar as conexões WebSocket dos filhos
const connectedChildren = new Map(); // childId -> WebSocket

// --- HTTP ROUTES ---

// Rota para registrar um novo filho
app.post('/register-child', async (req, res) => {
    const { childId, childName } = req.body;

    if (!childId || !childName) {
        return res.status(400).send({ message: 'childId e childName são obrigatórios.' });
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId,
            childName: childName,
            createdAt: new Date().toISOString()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DB_SUCCESS] Filho ${childId} (${childName}) registrado com sucesso.`);
        res.status(201).send({ message: 'Filho registrado com sucesso!' });
    } catch (error) {
        console.error('[DB_ERROR] Erro ao registrar filho:', error);
        res.status(500).send({ message: 'Erro interno do servidor ao registrar filho.' });
    }
});

// Rota para obter todos os childIds registrados
app.get('/get-child-ids', async (req, res) => {
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        ProjectionExpression: 'childId'
    };

    try {
        const data = await docClient.scan(params).promise();
        const childIds = data.Items.map(item => item.childId);
        console.log(`[HTTP_REQUEST] Lista de childIds solicitada. Encontrados: ${childIds.length}`);
        res.status(200).send(childIds);
    } catch (error) {
        console.error('[DB_ERROR] Erro ao obter childIds:', error);
        res.status(500).send({ message: 'Erro interno do servidor ao obter childIds.' });
    }
});

// =====================================================================
// >>>>> NOVO: ROTA HTTP PARA SOLICITAR LOCALIZAÇÃO DO APP PAI <<<<<
// =====================================================================
app.post('/request-current-location/:childId', async (req, res) => {
    const childId = req.params.childId;
    console.log(`[HTTP_REQUEST] Solicitação de localização para childId: ${childId}`);

    const childWs = connectedChildren.get(childId);
    if (childWs && childWs.readyState === WebSocket.OPEN) {
        try {
            childWs.send(JSON.stringify({ type: 'REQUEST_CURRENT_LOCATION' }));
            console.log(`[WEBSOCKET] Mensagem REQUEST_CURRENT_LOCATION enviada para ${childId}.`);
            res.status(200).send({ message: 'Solicitação de localização enviada.' });
        } catch (error) {
            console.error(`[WEBSOCKET_ERROR] Erro ao enviar REQUEST_CURRENT_LOCATION para ${childId}:`, error);
            res.status(500).send({ message: 'Erro ao enviar solicitação para o dispositivo filho.' });
        }
    } else {
        console.warn(`[CHILD_STATUS] Dispositivo filho ${childId} não conectado via WebSocket.`);
        res.status(404).send({ message: 'Dispositivo filho não conectado ou não encontrado.' });
    }
});
// =====================================================================


// Rota para enviar mensagens (HTTP)
app.post('/send-message', async (req, res) => {
    const { fromChildId, toChildId, messageContent, type } = req.body;
    const timestamp = new Date().toISOString();
    const messageId = uuidv4(); // Gerar um ID único para a mensagem

    if (!fromChildId || !toChildId || !messageContent || !type) {
        return res.status(400).send('Dados da mensagem incompletos.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            messageId,
            fromChildId,
            toChildId,
            messageContent,
            type,
            timestamp
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DB_SUCCESS] Mensagem de ${fromChildId} para ${toChildId} salva no DynamoDB.`);

        // Tentar enviar via WebSocket se o receptor estiver online
        const receiverWs = connectedChildren.get(toChildId);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
                type: 'NEW_MESSAGE',
                messageId,
                fromChildId,
                toChildId,
                messageContent,
                messageType: type, // Usando messageType para evitar conflito com 'type' do WS
                timestamp
            }));
            console.log(`[WEBSOCKET] Mensagem enviada via WebSocket para ${toChildId}.`);
        } else {
            console.warn(`[WEBSOCKET] Receptor ${toChildId} não conectado. Mensagem apenas salva no DB.`);
        }

        res.status(200).send({ message: 'Mensagem enviada e salva.', messageId });
    } catch (error) {
        console.error('[DB_ERROR] Erro ao salvar mensagem:', error);
        res.status(500).send({ message: 'Erro interno do servidor ao enviar mensagem.' });
    }
});

// Rota para obter o histórico de mensagens entre dois filhos
app.get('/get-message-history/:child1Id/:child2Id', async (req, res) => {
    const { child1Id, child2Id } = req.params;

    // Busca mensagens onde child1 enviou para child2
    const params1 = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        IndexName: 'FromToIdIndex', // Certifique-se de que este índice existe no DynamoDB
        KeyConditionExpression: 'fromChildId = :c1id AND toChildId = :c2id',
        ExpressionAttributeValues: {
            ':c1id': child1Id,
            ':c2id': child2Id
        }
    };

    // Busca mensagens onde child2 enviou para child1
    const params2 = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        IndexName: 'FromToIdIndex', // Reutiliza o mesmo índice
        KeyConditionExpression: 'fromChildId = :c1id AND toChildId = :c2id',
        ExpressionAttributeValues: {
            ':c1id': child2Id,
            ':c2id': child1Id
        }
    };

    try {
        const [messages1, messages2] = await Promise.all([
            docClient.query(params1).promise(),
            docClient.query(params2).promise()
        ]);

        const allMessages = [...messages1.Items, ...messages2.Items];

        // Ordenar as mensagens por timestamp
        allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        console.log(`[HTTP_REQUEST] Histórico de mensagens entre ${child1Id} e ${child2Id} solicitado.`);
        res.status(200).send(allMessages);

    } catch (error) {
        console.error('[DB_ERROR] Erro ao obter histórico de mensagens:', error);
        res.status(500).send({ message: 'Erro interno do servidor ao obter histórico de mensagens.' });
    }
});

// =====================================================================
// Rota para upload de mídias (áudio/imagem/vídeo)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    const { fromChildId, toChildId, mediaType, messageId } = req.body;
    const file = req.file;

    if (!fromChildId || !toChildId || !mediaType || !messageId || !file) {
        return res.status(400).send('Dados incompletos para upload de mídia.');
    }

    const s3Key = `media/${fromChildId}/${messageId}-${file.originalname}`;

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: 'public-read' // Ou 'private' se você controlar o acesso via servidor
    };

    try {
        const uploadResult = await s3.upload(params).promise();
        const mediaUrl = uploadResult.Location; // URL pública do arquivo

        // Salvar metadados da mídia no DynamoDB (opcional, mas recomendado)
        const mediaDbParams = {
            TableName: DYNAMODB_TABLE_MESSAGES, // Ou uma tabela específica para mídias
            Item: {
                messageId: messageId, // Usar o mesmo ID da mensagem para linkar
                fromChildId: fromChildId,
                toChildId: toChildId,
                messageContent: mediaUrl, // A URL da mídia
                type: mediaType, // 'audio', 'image', 'video'
                timestamp: new Date().toISOString()
            }
        };
        await docClient.put(mediaDbParams).promise();
        console.log(`[S3_SUCCESS] Mídia ${s3Key} (${mediaType}) uploaded e metadados salvos.`);

        // Notificar o receptor via WebSocket
        const receiverWs = connectedChildren.get(toChildId);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
                type: 'NEW_MESSAGE',
                messageId,
                fromChildId,
                toChildId,
                messageContent: mediaUrl, // Enviar a URL da mídia
                messageType: mediaType,
                timestamp: new Date().toISOString()
            }));
            console.log(`[WEBSOCKET] Mídia enviada via WebSocket para ${toChildId}.`);
        }

        res.status(200).send({ message: 'Mídia uploaded e URL salva.', mediaUrl });

    } catch (error) {
        console.error('[S3_ERROR] Erro ao fazer upload de mídia:', error);
        res.status(500).send({ message: 'Erro interno do servidor ao fazer upload de mídia.' });
    }
});

// Rota para obter presigned URL de upload para mídias (se o app usa isso em vez de upload direto)
app.post('/get-presigned-url', async (req, res) => {
    const { fileName, fileType, childId, messageId } = req.body; // childId é o remetente
    if (!fileName || !fileType || !childId || !messageId) {
        return res.status(400).send('fileName, fileType, childId e messageId são obrigatórios.');
    }

    const s3Key = `media/${childId}/${messageId}-${fileName}`;

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        ContentType: fileType,
        Expires: 300 // URL válida por 5 minutos
    };

    try {
        const url = await s3.getSignedUrlPromise('putObject', params);
        res.status(200).send({ url, s3Key });
    } catch (error) {
        console.error('Erro ao gerar URL pré-assinada:', error);
        res.status(500).send('Erro interno do servidor.');
    }
});


// Rota para enviar SMS via Twilio (para app pai ou avisos)
app.post('/send-sms', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).send('Número de telefone e mensagem são obrigatórios.');
    }

    try {
        const smsResponse = await twilioClient.messages.create({
            body: message,
            from: TWILIO_PHONE_NUMBER,
            to: to
        });
        console.log(`[TWILIO] SMS enviado para ${to}: SID ${smsResponse.sid}`);
        res.status(200).send({ message: 'SMS enviado com sucesso!', sid: smsResponse.sid });
    } catch (error) {
        console.error('[TWILIO_ERROR] Erro ao enviar SMS:', error);
        res.status(500).send({ message: 'Erro ao enviar SMS.' });
    }
});


// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    console.log('Novo cliente WebSocket conectado');

    ws.on('message', async message => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log(`[WEBSOCKET_MESSAGE] Recebido: ${JSON.stringify(parsedMessage)}`);

            switch (parsedMessage.type) {
                case 'REGISTER_CHILD_ID':
                    const { childId } = parsedMessage;
                    ws.childId = childId; // Armazena o childId na conexão WebSocket
                    connectedChildren.set(childId, ws); // Adiciona ao mapa
                    console.log(`[WEBSOCKET] ChildId ${childId} registrado para esta conexão.`);
                    break;

                case 'CURRENT_LOCATION_RESPONSE':
                    const { childId: locationChildId, latitude, longitude } = parsedMessage;
                    const timestamp = new Date().toISOString();

                    const params = {
                        TableName: DYNAMODB_TABLE_LOCATIONS, // Sua tabela de localização
                        Item: {
                            id: uuidv4(), // ID único para cada entrada de localização
                            childId: locationChildId,
                            latitude: latitude,
                            longitude: longitude,
                            timestamp: timestamp
                        }
                    };

                    try {
                        await docClient.put(params).promise();
                        console.log(`[LOCATION_SAVE_SUCCESS] Localização de ${locationChildId} salva no DynamoDB.`);

                        // =========================================================
                        // AJUSTE: ENVIAR LOCALIZAÇÃO PARA O APP PAI VIA WEBSOCKET
                        // =========================================================
                        wss.clients.forEach(function each(client) {
                            // Envia para *todos* os clientes conectados que não são o próprio remetente (app filho)
                            // Idealmente, você poderia ter um sistema para registrar "clientes pai"
                            // e enviar apenas para eles, mas para simplificar, enviamos para todos,
                            // e o app pai filtra pelo 'type'.
                            if (client !== ws && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'LOCATION_UPDATE_FOR_PARENT',
                                    childId: locationChildId,
                                    latitude: latitude,
                                    longitude: longitude,
                                    timestamp: timestamp
                                }));
                                console.log(`[WEBSOCKET] Localização de ${locationChildId} enviada para um cliente conectado (possível app pai).`);
                            }
                        });
                        // =========================================================

                    } catch (error) {
                        console.error('[DB_ERROR] Erro ao salvar localização no DynamoDB:', error);
                    }
                    break;

                // Outros tipos de mensagem WebSocket (se houver, como NEW_MESSAGE_ACK, etc.)
                // case 'ACK':
                //     console.log(`ACK recebido de ${parsedMessage.childId}`);
                //     break;

                default:
                    console.log(`[WEBSOCKET_WARNING] Tipo de mensagem desconhecido: ${parsedMessage.type}`);
                    break;
            }
        } catch (e) {
            console.error('[WEBSOCKET_ERROR] Erro ao analisar mensagem WebSocket ou tipo desconhecido:', e);
            console.log(`Mensagem RAW: ${message}`);
        }
    });

    ws.on('close', () => {
        // Remover a conexão do mapa quando o WebSocket é fechado
        if (ws.childId) {
            connectedChildren.delete(ws.childId);
            console.log(`[WEBSOCKET] ChildId ${ws.childId} desconectado.`);
        }
        console.log('Cliente WebSocket desconectado');
    });

    ws.on('error', error => {
        console.error('Erro no WebSocket:', error);
    });
});

// Middleware para tratamento de rotas não encontradas (404)
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});

// Middleware de tratamento de erros global
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Twilio Account SID configurada via env: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio Auth Token configurada via env: ${process.env.TWILIO_AUTH_TOKEN ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurada via env: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurada via env: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
    console.log(`Twilio Phone Number configurada via env: ${process.env.TWILIO_PHONE_NUMBER ? 'Sim' : 'Não'}`);
});