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

const upload = multer(); // Instancia o multer uma vez

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- Variáveis para Controle de WebSockets ---
// Usaremos wsClientsMap para todos os clientes conectados, identificando-os como filhos ou pais.
// Chave: (childId ou parentId) -> Valor: WebSocket do cliente
const wsClientsMap = new Map();
const parentListeningSockets = new Map(); // Mapa: childId -> WebSocket do pai que está ouvindo o áudio (conexão de áudio ou comando)
const activeChildWebSockets = new Map(); // Mapa: childId -> WebSocket do filho (conexão ativa)

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER; // Seu número Twilio

const twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Crie o servidor HTTP
const server = http.createServer(app);

// Crie o servidor WebSocket, anexando-o ao servidor HTTP
const wss = new WebSocket.Server({ server });

// --- FUNÇÕES AUXILIARES (Definidas antes de serem usadas no WebSocket) ---

async function saveMessage(childId, parentId, message, messageType) {
    const timestamp = new Date().toISOString();
    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            messageId: uuidv4(),
            childId: childId,
            parentId: parentId,
            timestamp: timestamp,
            message: message,
            messageType: messageType // 'chat', 'audio', 'image', etc.
        }
    };

    try {
        await docClient.put(params).promise();
        console.log('[DynamoDB] Mensagem salva no DynamoDB:', params.Item);
    } catch (error) {
        console.error('[DynamoDB ERROR] Erro ao salvar mensagem no DynamoDB:', error);
    }
}

async function saveLocation(childId, latitude, longitude, timestamp, accuracy, speed) {
    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            childId: childId, // Chave de partição
            timestamp: timestamp, // Chave de ordenação
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
            accuracy: accuracy ? parseFloat(accuracy) : null,
            speed: speed ? parseFloat(speed) : null,
        }
    };

    try {
        await docClient.put(params).promise();
        console.log('[DynamoDB] Localização GPS salva para:', childId, 'Lat:', latitude, 'Lon:', longitude);
    } catch (error) {
        console.error('[DynamoDB ERROR] Erro ao salvar localização GPS no DynamoDB:', error);
        throw error; // Propagar o erro para quem chamou
    }
}


wss.on('connection', ws => {
    console.log('Novo cliente WebSocket conectado.');

    ws.on('message', async message => { // Adicionado 'async' aqui para usar 'await' dentro
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error('Falha ao parsear mensagem WebSocket:', e);
            ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido.' }));
            return;
        }

        const { type, childId, parentId, message: msgContent, audioData, command, latitude, longitude, timestamp, accuracy, speed } = parsedMessage;

        switch (type) {
            case 'registerParent':
                if (parentId) {
                    console.log(`[WS] Pai registrado: ${parentId}`);
                    wsClientsMap.set(parentId, ws);
                }
                break;
            case 'registerChild':
                if (childId) {
                    console.log(`[WS] Filho registrado: ${childId}`);
                    wsClientsMap.set(childId, ws);
                    activeChildWebSockets.set(childId, ws);
                }
                break;
            case 'chatMessage':
                if (childId && parentId && msgContent) {
                    const recipientWs = wsClientsMap.get(parentId === ws.id ? childId : parentId); // Envia para o outro lado da conversa
                    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                        recipientWs.send(JSON.stringify({ type: 'chatMessage', childId, parentId, message: msgContent }));
                    } else {
                        console.warn(`[WS] WebSocket para ${parentId === ws.id ? 'filho' : 'pai'} não encontrado ou não está aberto.`);
                    }
                    // Salvar no DynamoDB
                    saveMessage(childId, parentId, msgContent, 'chat');
                }
                break;
            case 'audioStreamRequest':
                if (childId && parentId) {
                    // Armazena o WebSocket do pai para enviar o stream de áudio
                    parentListeningSockets.set(childId, ws);
                    console.log(`[WS] Pai ${parentId} solicitou stream de áudio para filho ${childId}.`);
                    // Envie um comando ao filho para iniciar o stream
                    const childWs = activeChildWebSockets.get(childId);
                    if (childWs && childWs.readyState === WebSocket.OPEN) {
                        childWs.send(JSON.stringify({ type: 'startAudioStream' }));
                        console.log(`[WS] Comando 'startAudioStream' enviado para filho ${childId}.`);
                    } else {
                        console.warn(`[WS] WebSocket do filho ${childId} não encontrado ou não está aberto para iniciar stream de áudio.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Filho offline para streaming de áudio.' }));
                    }
                }
                break;
            case 'audioStreamData':
                if (childId && audioData) {
                    const parentWs = parentListeningSockets.get(childId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({ type: 'audioStreamData', childId, audioData }));
                    } else {
                        console.warn(`[WS] WebSocket do pai para filho ${childId} não encontrado ou não está aberto para stream de áudio.`);
                        // Se o pai desconectou, instrua o filho a parar de enviar áudio
                        const childWs = activeChildWebSockets.get(childId);
                        if (childWs && childWs.readyState === WebSocket.OPEN) {
                            childWs.send(JSON.stringify({ type: 'stopAudioStream' }));
                            console.log(`[WS] Comando 'stopAudioStream' enviado para filho ${childId} (pai desconectado).`);
                            parentListeningSockets.delete(childId); // Limpa o mapa
                        }
                    }
                }
                break;
            case 'stopAudioStream':
                if (childId) {
                    parentListeningSockets.delete(childId);
                    console.log(`[WS] Stream de áudio para filho ${childId} parado.`);
                    // Opcional: Notificar o filho para parar de enviar (se a parada veio do pai)
                    const childWs = activeChildWebSockets.get(childId);
                    if (childWs && childWs.readyState === WebSocket.OPEN) {
                        childWs.send(JSON.stringify({ type: 'stopAudioStreamAck' }));
                    }
                }
                break;
            case 'sendCommand':
                if (childId && command) {
                    console.log(`[WS] Comando '${command}' recebido para filho ${childId}.`);
                    const childWs = activeChildWebSockets.get(childId);
                    if (childWs && childWs.readyState === WebSocket.OPEN) {
                        childWs.send(JSON.stringify({ type: 'command', command }));
                        console.log(`[WS] Comando '${command}' enviado para filho ${childId}.`);
                    } else {
                        console.warn(`[WS] WebSocket do filho ${childId} não encontrado ou não está aberto para o comando '${command}'.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Filho offline para comandos.' }));
                    }
                }
                break;
            case 'commandResponse':
                if (parentId && childId && command && msgContent) {
                    console.log(`[WS] Resposta de comando '${command}' recebida do filho ${childId} para o pai ${parentId}.`);
                    const parentWs = wsClientsMap.get(parentId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({ type: 'commandResponse', childId, command, message: msgContent }));
                        console.log(`[WS] Resposta de comando '${command}' do filho ${childId} para o pai ${parentId}: ${msgContent}`);
                    } else {
                        console.warn(`[WS] WebSocket do pai ${parentId} não encontrado ou não está aberto para receber resposta de comando.`);
                    }
                }
                break;
            case 'locationUpdate': // NOVO: Para o filho enviar localização via WebSocket
                if (childId && latitude !== undefined && longitude !== undefined && timestamp) {
                    console.log(`[WS_LOCATION] Localização recebida via WebSocket de ${childId}: Lat=${latitude}, Lon=${longitude}, TS=${timestamp}`);
                    try {
                        await saveLocation(childId, latitude, longitude, timestamp, accuracy, speed);
                        // Opcional: Notificar o pai que está esperando essa atualização
                        // Isso exigiria um mecanismo para saber qual pai solicitou
                        // Para simplificar, se o pai está ouvindo, você pode repassar.
                        const parentWs = parentListeningSockets.get(childId); // Reutilizando parentListeningSockets para comando/resposta
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({ type: 'locationData', childId, latitude, longitude, timestamp, accuracy, speed }));
                            console.log(`[WS_LOCATION] Localização repassada para o pai ouvindo ${childId}.`);
                        }
                    } catch (error) {
                        console.error('[WS_LOCATION_ERROR] Erro ao salvar ou repassar localização via WebSocket:', error);
                        ws.send(JSON.stringify({ type: 'error', message: 'Falha ao processar localização.' }));
                    }
                } else {
                    console.warn(`[WS_LOCATION_ERROR] Dados de localização incompletos via WebSocket de ${childId}:`, parsedMessage);
                    ws.send(JSON.stringify({ type: 'error', message: 'Dados de localização incompletos.' }));
                }
                break;
            default:
                console.warn('[WS] Tipo de mensagem WebSocket desconhecido:', type);
                ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem desconhecido.' }));
        }
    });

    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado.');
        // Remove o cliente desconectado dos mapas
        for (let [key, value] of wsClientsMap.entries()) {
            if (value === ws) {
                wsClientsMap.delete(key);
                console.log(`[WS] Cliente ${key} removido do wsClientsMap.`);
                break;
            }
        }
        for (let [childId, value] of activeChildWebSockets.entries()) {
            if (value === ws) {
                activeChildWebSockets.delete(childId);
                // Se o filho desconecta, o pai não pode mais ouvir áudio ou comando
                parentListeningSockets.delete(childId); 
                console.log(`[WS] Filho ${childId} removido do activeChildWebSockets.`);
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error('[WS ERROR] Erro no WebSocket:', error);
    });
});


// --- ROTAS HTTP ---

// Rota para receber mensagens do app do filho (SMS)
app.post('/sms-webhook', async (req, res) => {
    const { From, Body } = req.body;
    console.log(`[HTTP] SMS recebido de ${From}: ${Body}`);

    // Aqui você precisaria de uma lógica para associar o número de telefone
    // (From) a um childId ou parentId para rotear a mensagem.
    // Por simplicidade, vamos registrar como uma mensagem genérica ou associar a um ID fixo.
    const childId = 'sms_child_default'; // Exemplo: ID fixo para SMS
    const parentId = 'parent_app_default'; // Exemplo: ID fixo para o app pai

    await saveMessage(childId, parentId, Body, 'sms');

    // Opcional: Enviar para o WebSocket do pai
    const parentWs = wsClientsMap.get(parentId);
    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
        parentWs.send(JSON.stringify({ type: 'smsReceived', from: From, message: Body, childId, parentId }));
    }

    res.status(200).send('<Response></Response>'); // Resposta Twilio
});

// Rota para enviar SMS via Twilio (opcional, para o pai enviar SMS ao filho)
app.post('/send-sms', async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        console.warn('[HTTP_ERROR] Tentativa de enviar SMS com dados incompletos.');
        return res.status(400).send('Para enviar SMS, ' +
            'os campos "to" (número do destinatário) e "message" (mensagem) são obrigatórios.');
    }

    try {
        const twilioMessage = await twilioClient.messages.create({
            body: message,
            to: to,
            from: TWILIO_PHONE_NUMBER
        });
        console.log('[HTTP] SMS enviado com sucesso:', twilioMessage.sid);
        res.status(200).send('SMS enviado com sucesso.');
    } catch (error) {
        console.error('[HTTP_ERROR] Erro ao enviar SMS:', error);
        res.status(500).send('Erro ao enviar SMS.');
    }
});

// Rota para fazer upload de arquivos para o S3
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        console.warn('[HTTP_ERROR] Tentativa de upload sem arquivo.');
        return res.status(400).send('Nenhum arquivo enviado.');
    }

    const { originalname, buffer, mimetype } = req.file;
    const { childId, parentId, messageType } = req.body; // Adicione messageType para saber o que é (imagem, áudio, vídeo)

    if (!childId || !parentId || !messageType) {
        console.warn('[HTTP_ERROR] Dados de upload incompletos: childId, parentId ou messageType ausentes.');
        return res.status(400).send('childId, parentId e messageType são obrigatórios para upload.');
    }

    const key = `${childId}/${messageType}/${uuidv4()}-${originalname}`;

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        ACL: 'private' // Ajuste conforme sua política de privacidade
    };

    try {
        const s3Data = await s3.upload(params).promise();
        console.log('[S3] Arquivo enviado para S3:', s3Data.Location);

        // Salvar a URL do arquivo no DynamoDB
        await saveMessage(childId, parentId, s3Data.Location, messageType);

        // Notificar o pai/filho via WebSocket sobre o novo arquivo
        const recipientWs = wsClientsMap.get(parentId); // Assumindo que o upload é para o pai ver
        if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
            recipientWs.send(JSON.stringify({
                type: 'fileUploaded',
                childId: childId,
                parentId: parentId,
                fileUrl: s3Data.Location,
                messageType: messageType
            }));
        }

        res.status(200).json({ message: 'Arquivo enviado com sucesso!', url: s3Data.Location });
    } catch (error) {
        console.error('[S3_ERROR] Erro ao enviar arquivo para S3:', error);
        res.status(500).send('Erro ao enviar arquivo.');
    }
});

// Rota para obter todos os child IDs da tabela Conversations
// IMPORTANTE: Esta rota faz um SCAN completo na tabela.
// Para tabelas muito grandes, isso pode ser lento e custoso.
app.get('/get-child-ids', async (req, res) => {
    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        // Usamos ProjectionExpression para otimizar, buscando apenas o childId
        // Certifique-se de que o nome do atributo 'childId' está correto na sua tabela DynamoDB
        ProjectionExpression: 'childId'
    };

    try {
        console.log('[HTTP] Iniciando scan na tabela Conversations para obter todos os child IDs...');
        const data = await docClient.scan(params).promise();
        console.log(`[HTTP] Scan concluído. Itens encontrados: ${data.Items.length}`);

        // Extrai todos os childId dos itens retornados e remove duplicados (se existirem)
        // e valores nulos/indefinidos
        const childIds = [...new Set(data.Items.map(item => item.childId).filter(Boolean))];

        console.log('[HTTP] Child IDs encontrados:', childIds);
        res.json(childIds);
    } catch (error) {
        console.error('[DynamoDB ERROR] Erro ao buscar todos os child IDs:', error);
        res.status(500).send('Erro interno do servidor ao buscar child IDs.');
    }
});


// Rota para receber e armazenar dados de localização GPS
app.post('/save-location', async (req, res) => {
    const { childId, latitude, longitude, timestamp, accuracy, speed } = req.body;

    console.log(`[HTTP_GPS_RECEIVE] Recebendo localização para ${childId}: Lat=${latitude}, Lon=${longitude}, TS=${timestamp}`); // <<< ADICIONE ESTE LOG

    if (!childId || latitude === undefined || longitude === undefined || !timestamp) {
        console.error('[HTTP_GPS_ERROR] Dados de localização incompletos na requisição POST /save-location:', req.body); // <<< ADICIONE ESTE LOG
        return res.status(400).send('childId, latitude, longitude e timestamp são obrigatórios.');
    }

    try {
        await saveLocation(childId, latitude, longitude, timestamp, accuracy, speed);
        // Opcional: Notificar o pai via WebSocket sobre a nova localização se ele estiver ouvindo
        // Isso exigiria uma forma de mapear childId para parentId E se o pai está "ativo" para esse filho
        // Por agora, apenas salva no DB e envia uma confirmação HTTP.
        res.status(200).send('Localização GPS salva com sucesso.');
    } catch (error) {
        console.error('[HTTP_GPS_ERROR] Erro ao salvar localização GPS no DynamoDB (POST /save-location):', error);
        res.status(500).send('Erro interno do servidor ao salvar localização GPS.');
    }
});

// Rota para obter o histórico de localização de um filho
app.get('/get-location-history/:childId', async (req, res) => {
    const { childId } = req.params;
    const { limit, startTimestamp } = req.query; // Opcional: limite de resultados e timestamp inicial

    console.log(`[HTTP_GPS_REQUEST] Pai solicitou histórico de localização para ${childId}.`); // <<< ADICIONE ESTE LOG

    if (!childId) {
        console.warn('[HTTP_GPS_ERROR] childId ausente na requisição GET /get-location-history.');
        return res.status(400).send('O parâmetro childId é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        KeyConditionExpression: 'childId = :id',
        ExpressionAttributeValues: {
            ':id': childId
        },
        ScanIndexForward: false, // Ordenar do mais recente para o mais antigo
        Limit: limit ? parseInt(limit) : 100 // Limite padrão de 100 resultados
    };

    if (startTimestamp) {
        params.KeyConditionExpression += ' AND #ts <= :startTs';
        params.ExpressionAttributeNames = { '#ts': 'timestamp' }; // Mapeia 'timestamp' para evitar conflitos com palavras reservadas
        params.ExpressionAttributeValues[':startTs'] = startTimestamp;
    }

    try {
        const data = await docClient.query(params).promise();
        console.log(`[HTTP_GPS_REQUEST] Histórico de localização para ${childId} encontrado. Itens: ${data.Items.length}`);
        res.json(data.Items);
    } catch (error) {
        console.error('[DynamoDB ERROR] Erro ao obter histórico de localização (GET /get-location-history):', error);
        res.status(500).send('Erro interno do servidor ao obter histórico de localização.');
    }
});

// Rota para obter a última localização conhecida de um filho
app.get('/get-last-location/:childId', async (req, res) => {
    const { childId } = req.params;

    console.log(`[HTTP_GPS_REQUEST] Pai solicitou a última localização para ${childId}.`); // <<< ADICIONE ESTE LOG

    if (!childId) {
        console.warn('[HTTP_GPS_ERROR] childId ausente na requisição GET /get-last-location.');
        return res.status(400).send('O parâmetro childId é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        KeyConditionExpression: 'childId = :id',
        ExpressionAttributeValues: {
            ':id': childId
        },
        Limit: 1,
        ScanIndexForward: false // Para pegar o mais recente
    };

    try {
        const data = await docClient.query(params).promise();
        if (data.Items && data.Items.length > 0) {
            console.log(`[HTTP_GPS_REQUEST] Última localização para ${childId} encontrada:`, data.Items[0]);
            res.json(data.Items[0]);
        } else {
            console.warn(`[HTTP_GPS_REQUEST] Nenhuma localização encontrada para o filho ${childId}.`);
            res.status(404).send('Nenhuma localização encontrada para o filho.');
        }
    } catch (error) {
        console.error('[DynamoDB ERROR] Erro ao obter última localização (GET /get-last-location):', error);
        res.status(500).send('Erro interno do servidor ao obter última localização.');
    }
});


// Middleware para tratar rotas não encontradas
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});

// Middleware para tratamento de erros gerais
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT || 10000, '0.0.0.0', () => { // AGORA USA 'server' AO INVÉS DE 'app'
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);    
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
	console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'Configurado' : 'Não Configurado'}`);
    console.log(`Twilio Auth Token: ${TWILIO_AUTH_TOKEN ? 'Configurado' : 'Não Configurado'}`);
    console.log(`Twilio Phone Number: ${TWILIO_PHONE_NUMBER || 'Não Configurado'}`);
});