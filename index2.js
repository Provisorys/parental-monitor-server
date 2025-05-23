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

const DYNAMODB_TABLE_CHILDREN = 'Children'; // Você pode remover esta constante se não for mais usar a tabela Children
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations'; // A tabela que você usará para obter childIds
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

const twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
const upload = multer();

// --- HTTP SERVER PARA WEBSOCKET ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Mapa para armazenar as conexões WebSocket dos filhos
const connectedChildren = new Map(); // childId -> wsClient

wss.on('connection', ws => {
    console.log('Cliente WebSocket conectado');

    ws.on('message', message => {
        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === 'REGISTER_CHILD_ID' && parsedMessage.childId) {
                ws.childId = parsedMessage.childId;
                connectedChildren.set(ws.childId, ws);
                console.log(`[WEBSOCKET] ChildId ${ws.childId} registrado e conectado.`);
            } else {
                console.log('Mensagem WebSocket recebida:', parsedMessage);
                if (parsedMessage.type === 'CURRENT_LOCATION_RESPONSE' && parsedMessage.childId) {
                    const { childId, latitude, longitude, timestamp } = parsedMessage;
                    console.log(`[LOCATION_RESPONSE] Localização atual recebida de ${childId}: Lat ${latitude}, Lon ${longitude}`);
                    
                    const params = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            childId: childId,
                            timestamp: timestamp,
                            latitude: latitude,
                            longitude: longitude
                        }
                    };

                    docClient.put(params).promise()
                        .then(() => {
                            console.log(`[LOCATION_SAVE_SUCCESS] Localização de ${childId} salva no DynamoDB.`);
                        })
                        .catch(error => {
                            console.error(`[LOCATION_SAVE_ERROR] Erro ao salvar localização de ${childId}:`, error.message);
                            if (error.code && error.statusCode) {
                                console.error(`AWS Error: Code - ${error.code}, Status - ${error.statusCode}, RequestId - ${error.requestId}`);
                            }
                        });
                }
            }
        } catch (e) {
            console.error('[WEBSOCKET_ERROR] Erro ao analisar mensagem WebSocket ou tipo desconhecido:', e);
            console.log(`Mensagem RAW: ${message}`);
        }
    });

    ws.on('close', () => {
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

// --- NOVAS ROTAS ---

// Rota para o app pai solicitar a localização atual de um filho
app.post('/request-current-location/:childId', async (req, res) => {
    const childIdToRequest = req.params.childId;
    console.log(`[LOCATION_REQUEST] Requisição do app pai para localização de: ${childIdToRequest}`);

    if (!childIdToRequest) {
        return res.status(400).send('childId é obrigatório para solicitar a localização.');
    }

    const wsClient = connectedChildren.get(childIdToRequest);

    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: 'REQUEST_CURRENT_LOCATION' }));
        console.log(`[WEBSOCKET] Enviada instrução REQUEST_CURRENT_LOCATION para ${childIdToRequest}`);
        res.status(200).send(`Solicitação de localização enviada para ${childIdToRequest}`);
    } else {
        console.warn(`[WEBSOCKET] Filho ${childIdToRequest} não conectado via WebSocket para solicitação de localização.`);
        res.status(404).send(`Filho ${childIdToRequest} não encontrado ou desconectado.`);
    }
});

// =====================================================================================================
// ROTA REINTRODUZIDA: GET /get-child-ids
// Esta rota usará a tabela Conversations para obter childIds únicos.
// =====================================================================================================
app.get('/get-child-ids', async (req, res) => {
    console.log('[GET_CHILD_IDS] Requisição para obter childIds.');
    try {
        const params = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS, // Usando a tabela Conversations
            ProjectionExpression: 'childId' // Pedir apenas o atributo childId
        };

        const result = await docClient.scan(params).promise();
        
        // Extrair childIds únicos
        const uniqueChildIds = [...new Set(result.Items.map(item => item.childId))];
        
        console.log(`[GET_CHILD_IDS] ChildIds encontrados: ${uniqueChildIds.join(', ')}`);
        res.status(200).json(uniqueChildIds);

    } catch (error) {
        console.error('[GET_CHILD_IDS_ERROR] Erro ao buscar childIds:', error.message);
        res.status(500).send('Erro interno do servidor ao buscar childIds.');
    }
});


// --- OUTRAS ROTAS EXISTENTES (coloque-as aqui) ---
// Certifique-se de que todas as suas outras rotas (como /twilio-token, /send-message, etc.)
// estejam AQUI, antes do tratamento de rota não encontrada.

app.post('/twilio-token', async (req, res) => {
    // ... seu código da rota /twilio-token ...
    try {
        const { identity } = req.body;
        if (!identity) {
            return res.status(400).send('Identity é obrigatório.');
        }

        const AccessToken = twilio.jwt.AccessToken;
        const ChatGrant = AccessToken.ChatGrant;

        const chatGrant = new ChatGrant({
            serviceSid: process.env.TWILIO_CHAT_SERVICE_SID,
        });

        const token = new AccessToken(
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID,
            TWILIO_API_KEY_SECRET,
            { identity: identity }
        );

        token.addGrant(chatGrant);

        console.log(`Token gerado para: ${identity}`);
        res.json({ token: token.toJwt() });
    } catch (error) {
        console.error('Erro ao gerar token Twilio:', error);
        res.status(500).send('Erro ao gerar token Twilio.');
    }
});

app.post('/send-message', upload.single('media'), async (req, res) => {
    try {
        const { conversationId, senderId, messageBody, messageType } = req.body;
        const mediaFile = req.file;

        if (!conversationId || !senderId || (!messageBody && !mediaFile) || !messageType) {
            return res.status(400).send('Dados da mensagem incompletos.');
        }

        let mediaUrl = null;
        if (mediaFile) {
            // Upload para S3
            const s3Key = `media/${conversationId}/${uuidv4()}-${mediaFile.originalname}`;
            const s3Params = {
                Bucket: S3_BUCKET_NAME,
                Key: s3Key,
                Body: mediaFile.buffer,
                ContentType: mediaFile.mimetype,
                ACL: 'public-read' // Atenção: tornar público-read pode não ser ideal para todos os casos
            };

            const s3UploadResult = await s3.upload(s3Params).promise();
            mediaUrl = s3UploadResult.Location;
            console.log(`Mídia enviada para S3: ${mediaUrl}`);
        }

        const messageId = uuidv4();
        const timestamp = Date.now();

        const messageParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: {
                messageId: messageId,
                conversationId: conversationId,
                senderId: senderId,
                body: messageBody || null,
                mediaUrl: mediaUrl || null,
                messageType: messageType,
                timestamp: timestamp
            }
        };

        await docClient.put(messageParams).promise();
        console.log('Mensagem salva no DynamoDB:', messageId);

        // Atualizar a última mensagem na tabela Conversations
        const updateConversationParams = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: { conversationId: conversationId },
            UpdateExpression: 'SET lastMessage = :lm, lastMessageTimestamp = :lmt',
            ExpressionAttributeValues: {
                ':lm': messageBody || 'Mídia',
                ':lmt': timestamp
            }
        };
        await docClient.update(updateConversationParams).promise();
        console.log('Conversa atualizada com a última mensagem.');

        // Enviar notificação push (se houver essa funcionalidade configurada)
        // Lógica de notificação push aqui...

        res.status(200).json({ messageId: messageId, mediaUrl: mediaUrl });

    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).send('Erro interno do servidor ao enviar mensagem.');
    }
});

// Rota para obter mensagens de uma conversa
app.get('/get-messages/:conversationId', async (req, res) => {
    try {
        const conversationId = req.params.conversationId;
        const params = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            KeyConditionExpression: 'conversationId = :cid',
            ExpressionAttributeValues: {
                ':cid': conversationId
            },
            // Ordernar por timestamp decrescente para pegar as mais recentes
            ScanIndexForward: false
        };

        const result = await docClient.query(params).promise();
        res.status(200).json(result.Items);
    } catch (error) {
        console.error('Erro ao obter mensagens:', error);
        res.status(500).send('Erro interno do servidor ao obter mensagens.');
    }
});

// Rota para obter conversas de um usuário (pai ou filho)
app.get('/get-conversations/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const params = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            // A menos que você tenha um índice secundário para userId, um Scan pode ser necessário
            // Ou o seu conversationId já incorpora o userId
            // Se userId é uma partition key ou parte de uma, use Query.
            // Para um Scan, você precisa de um FilterExpression:
            FilterExpression: 'parentUserId = :uid OR childId = :uid',
            ExpressionAttributeValues: {
                ':uid': userId
            }
        };

        const result = await docClient.scan(params).promise();
        res.status(200).json(result.Items);
    } catch (error) {
        console.error('Erro ao obter conversas:', error);
        res.status(500).send('Erro interno do servidor ao obter conversas.');
    }
});

// --- TRATAMENTO DE ERROS (MANTENHA ISSO NO FINAL, ANTES DE server.listen) ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO DO SERVIDOR ---
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
});