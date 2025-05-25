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

const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Usando sua tabela existente
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: ${req.method} ${req.url}`);
    next();
});

app.get('/', (req, res) => {
    res.status(200).send('Servidor Parental Monitor rodando!');
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});

// --- ROTAS DE API ---
app.post('/notifications', async (req, res) => {
    const { childId, message, messageType, timestamp, contactOrGroup, direction, phoneNumber } = req.body;
    const timestampValue = timestamp || Date.now();
    const messageTypeString = messageType || 'TEXT_MESSAGE';

    if (!childId || !message) {
        console.warn('[NOTIFICATIONS] Erro: childId ou message faltando.'); // Log
        return res.status(400).json({ message: 'childId e message são obrigatórios' });
    }

    const messageDirection = direction || (messageTypeString === "SENT" ? "sent" : messageTypeString === "RECEIVED" ? "received" : "unknown");
    const contactOrGroupValue = contactOrGroup || 'unknown';
    const phoneNumberValue = phoneNumber || 'unknown_number';

    const messageItem = {
        id: timestampValue + Math.floor(Math.random() * 1000),
        childId,
        message,
        messageType: messageTypeString,
        timestamp: timestampValue,
        contactOrGroup: contactOrGroupValue,
        phoneNumber: phoneNumberValue,
        direction: messageDirection
    };

    try {
        await docClient.put({
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageItem
        }).promise();
        console.log('[NOTIFICATIONS] Mensagem salva com sucesso no DynamoDB.');

        console.log('[NOTIFICATIONS] Tentando atualizar conversa no DynamoDB:', { childId: childId, contactOrGroup: contactOrGroupValue });
        await docClient.update({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: {
                childId: childId,
                contactOrGroup: contactOrGroupValue
            },
            UpdateExpression: 'SET #ts = :timestamp, #lm = :lastMessage, #pn = :phoneNumber, #dir = :direction',
            ExpressionAttributeNames: {
                "#ts": 'lastTimestamp',
                "#lm": 'lastMessage',
                "#pn": 'phoneNumber',
                "#dir": 'lastDirection'
            },
            ExpressionAttributeValues: {
                ':timestamp': timestampValue,
                ':lastMessage': message,
                ':phoneNumber': phoneNumberValue,
                ':direction': messageDirection
            }
        }).promise();
        console.log('[NOTIFICATIONS] Conversa atualizada com sucesso no DynamoDB.');

        res.status(200).json({ message: 'Notificação recebida e salva com sucesso' });
    } catch (error) {
        console.error('[NOTIFICATIONS] Erro ao processar notificação:', error); // Log
        res.status(500).json({ message: 'Erro interno', error: error.message });
    }
});

app.post('/media', upload.single('file'), async (req, res) => {
    const { childId, type, timestamp, direction, contactOrGroup, phoneNumber } = req.body;
    const file = req.file;
    const timestampValue = timestamp || Date.now();

    if (!file) {
        console.warn('[MEDIA] Erro: Arquivo é obrigatório.'); // Log
        return res.status(400).json({ message: 'Arquivo é obrigatório' });
    }
    if (!direction || !['sent', 'received'].includes(direction)) {
        console.warn('[MEDIA] Erro: direction deve ser "sent" ou "received".'); // Log
        return res.status(400).json({ message: 'direction deve ser "sent" ou "received"' });
    }

    const contactOrGroupValue = contactOrGroup || 'unknown';
    const phoneNumberValue = phoneNumber || 'unknown_number';
    const fileExtension = file.originalname ? `.${file.originalname.split('.').pop()}` : '';
    const mediaId = timestampValue + Math.floor(Math.random() * 1000);
    const s3Key = `media/${childId}/${mediaId}${fileExtension}`;

    try {
        await s3.upload({
            Bucket: S3_BUCKET_NAME,
            Key: s3Key,
            Body: file.buffer,
            ContentType: file.mimetype
        }).promise();
        console.log(`[MEDIA] Arquivo ${s3Key} enviado com sucesso para S3.`); // Log

        const messageItem = {
            id: mediaId,
            childId,
            message: `Mídia (${type || file.mimetype})`,
            messageType: type || file.mimetype,
            timestamp: timestampValue,
            contactOrGroup: contactOrGroupValue,
            phoneNumber: phoneNumberValue,
            direction,
            s3Url: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`
        };

        await docClient.put({
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageItem
        }).promise();
        console.log('[MEDIA] Entrada de mídia salva com sucesso no DynamoDB.'); // Log

        await docClient.update({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: {
                childId: childId,
                contactOrGroup: contactOrGroupValue
            },
            UpdateExpression: 'SET #ts = :timestamp, #lm = :lastMessage, #pn = :phoneNumber, #dir = :direction',
            ExpressionAttributeNames: {
                '#ts': 'lastTimestamp',
                '#lm': 'lastMessage',
                '#pn': 'phoneNumber',
                '#dir': 'lastDirection'
            },
            ExpressionAttributeValues: {
                ':timestamp': timestampValue,
                ':lastMessage': `Mídia (${type || file.mimetype})`,
                ':phoneNumber': phoneNumberValue,
                ':direction': direction
            }
        }).promise();
        console.log('[MEDIA] Conversa atualizada com sucesso no DynamoDB para mídia.'); // Log

        res.status(200).json({ message: 'Mídia recebida com sucesso', s3Url: messageItem.s3Url });

    } catch (error) {
        console.error('[MEDIA] Erro ao processar mídia:', error); // Log
        res.status(500).json({ message: 'Erro ao processar mídia', error: error.message });
    }
});

app.get('/get-conversations/:childId', async (req, res) => {
    const { childId } = req.params;
    if (!childId) {
        console.warn('[CONVERSATIONS] Erro: childId é obrigatório na requisição de conversas.'); // Log
        return res.status(400).json({ message: 'childId é obrigatório' });
    }

    try {
        console.log(`[CONVERSATIONS] Buscando conversas para childId: ${childId} na tabela ${DYNAMODB_TABLE_CONVERSATIONS}`);
        const convData = await docClient.query({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: {
                ':cid': childId
            }
        }).promise();

        console.log(`[CONVERSATIONS] Conversas encontradas para ${childId}: ${convData.Items.length} itens.`);

        const groupedConversations = [];

        for (const conv of convData.Items) {
            console.log(`[CONVERSATIONS] Buscando mensagens para conversa: ${conv.contactOrGroup} (childId: ${childId})`);
            const scanMessages = await docClient.scan({
                TableName: DYNAMODB_TABLE_MESSAGES,
                FilterExpression: 'childId = :cid AND contactOrGroup = :cog AND phoneNumber = :pn',
                ExpressionAttributeValues: {
                    ':cid': childId,
                    ':cog': conv.contactOrGroup,
                    ':pn': conv.phoneNumber
                }
            }).promise();

            const messages = scanMessages.Items || [];
            messages.sort((a, b) => b.timestamp - a.timestamp);
            console.log(`[CONVERSATIONS] Mensagens encontradas para ${conv.contactOrGroup}: ${messages.length} itens.`);

            groupedConversations.push({
                contactOrGroup: conv.contactOrGroup,
                phoneNumber: conv.phoneNumber,
                lastTimestamp: conv.lastTimestamp,
                lastMessage: conv.lastMessage,
                lastDirection: conv.lastDirection,
                messages
            });
        }

        groupedConversations.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
        res.status(200).json(groupedConversations);

    } catch (error) {
        console.error('[CONVERSATIONS] Erro ao buscar conversas:', error);
        res.status(500).json({ message: 'Erro ao buscar conversas', error: error.message });
    }
});

app.get('/get-child-ids', async (req, res) => {
    try {
        console.log(`[CHILD_IDS] Tentando escanear child IDs na tabela ${DYNAMODB_TABLE_CONVERSATIONS} do DynamoDB.`);
        const data = await docClient.scan({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            ProjectionExpression: 'childId',
        }).promise();

        const childIds = [...new Set(data.Items.map(item => item.childId))];
        console.log('[CHILD_IDS] childIDs encontrados no DynamoDB (GET /get-child-ids):', childIds);

        res.status(200).json(childIds);
    } catch (error) {
        console.error('[CHILD_IDS] Erro ao listar child IDs:', error);
        res.status(500).json({ message: 'Erro ao listar child IDs', error: error.message });
    }
});

app.post('/rename-child-id/:oldChildId/:newChildId', async (req, res) => {
    return res.status(501).json({
        message: 'Funcionalidade de renomear childId não está implementada'
    });
});

app.get('/twilio-token', (req, res) => {
    const { identity } = req.query;

    if (!identity) {
        console.warn('[TWILIO] Erro: A identidade (identity) é obrigatória para o token Twilio.'); // Log
        return res.status(400).send('A identidade (identity) é obrigatória.');
    }

    try {
        const accessToken = new twilio.jwt.AccessToken(
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID,
            TWILIO_API_KEY_SECRET,
            { identity: identity }
        );

        const grant = new twilio.jwt.AccessToken.VideoGrant();
        accessToken.addGrant(grant);

        res.json({ token: accessToken.toJwt() });

        console.log(`[TWILIO] Token Twilio gerado para identidade: ${identity}`);
    } catch (error) {
        console.error('[TWILIO] Erro ao gerar token Twilio:', error);
        res.status(500).json({ error: 'Erro ao gerar token Twilio', details: error.message });
    }
});

// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/audio-stream' });

const parentListeningSockets = new Map(); // Mapa: childId -> WebSocket do pai que está ouvindo
const activeChildWebSockets = new Map(); // Mapa: childId -> WebSocket do filho ativo

// --- FUNÇÃO AUXILIAR PARA WEBSOCKETS ---
function findChildWebSocket(childId) {
    const targetClient = activeChildWebSockets.get(childId);
    console.log(`[WS_FIND] Buscando WebSocket para childId: ${childId}. Estado atual do mapa activeChildWebSockets: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`); // Log de debug
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
        console.log(`[WS_FIND] WebSocket ENCONTRADO e ABERTO para childId: ${childId}`); // Log de debug
        return targetClient;
    }
    console.log(`[WS_FIND] WebSocket NÃO ENCONTRADO ou FECHADO para childId: ${childId}. readyState: ${targetClient ? targetClient.readyState : 'N/A'}`); // Log de debug
    return null;
}

// --- NOVAS ROTAS PARA LIGAR/DESLIGAR MICROFONE (via HTTP do app pai) ---
app.post('/start-microphone', async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /start-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /start-microphone para o filho: ${childId}`);

    const childWs = findChildWebSocket(childId); // Esta função já tem logs de debug

    if (childWs) {
        try {
            const command = JSON.stringify({ type: 'START_AUDIO' });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando '${command}' enviado via WebSocket para o filho: ${childId}`);
            res.status(200).json({ message: `Comando START_AUDIO enviado para ${childId}.` });
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando START_AUDIO via WebSocket para ${childId}:`, error);
            res.status(500).json({ message: 'Erro ao enviar comando para o filho.', error: error.message });
        }
    } else {
        console.warn(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando START_AUDIO NÃO PODE ser enviado.`);
        res.status(404).json({ message: `Filho ${childId} não está conectado via WebSocket.` });
    }
});

app.post('/stop-microphone', async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /stop-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /stop-microphone para o filho: ${childId}`);

    const childWs = findChildWebSocket(childId); // Esta função já tem logs de debug

    if (childWs) {
        try {
            const command = JSON.stringify({ type: 'STOP_AUDIO' });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando '${command}' enviado via WebSocket para o filho: ${childId}`);
            res.status(200).json({ message: `Comando STOP_AUDIO enviado para ${childId}.` });
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando STOP_AUDIO via WebSocket para ${childId}:`, error);
            res.status(500).json({ message: 'Erro ao enviar comando para o filho.', error: error.message });
        }
    } else {
        console.warn(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando STOP_AUDIO NÃO PODE ser enviado.`);
        res.status(404).json({ message: `Filho ${childId} não está conectado via WebSocket.` });
    }
});

wss.on('connection', ws => {
    ws.id = uuidv4();
    console.log(`[WS_CONNECT] Novo cliente WebSocket conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wss.clients.size}`); // Log
    ws.isParent = false;
    ws.clientId = null;
    ws.parentId = null;

    ws.on('message', async message => { // MODIFIED: Added 'async' keyword here
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        let processedAsText = false; // Flag para controlar se a mensagem foi processada como texto

        // Tenta processar como string primeiro
        if (typeof message === 'string') {
            const messageString = message.toString();
            const displayMessage = messageString.length > 100 ? messageString.substring(0, 100) + '...' : messageString;
            console.log(`[WS_MSG] [${messageOrigin}] Mensagem WebSocket de TEXTO recebida: "${displayMessage}"`);

            if (messageString.startsWith('CHILD_ID:')) {
                ws.clientId = messageString.substring('CHILD_ID:'.length);
                ws.isParent = false;
                activeChildWebSockets.set(ws.clientId, ws);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou. Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                    ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                } else {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado, mas nenhum pai está ouvindo ativamente neste momento.`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('PARENT_ID:')) {
                ws.isParent = true;
                ws.parentId = messageString.substring('PARENT_ID:'.length);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Pai conectado com ID: ${ws.parentId || 'desconhecido'}`);
                processedAsText = true;
            } else if (messageString.startsWith('LISTEN_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('LISTEN_TO_CHILD:'.length);
                    parentListeningSockets.set(targetChildId, ws);
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                    const childWs = findChildWebSocket(targetChildId);
                    if (childWs) {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Enviando START_AUDIO para filho: ${targetChildId}`);
                        childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                    } else {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não está ativo para iniciar áudio imediatamente.`);
                        ws.send(JSON.stringify({ type: 'ERROR', message: `Filho ${targetChildId} não está conectado.` }));
                    }
                    processedAsText = true;
                } else {
                    console.warn(`[WS_MSG] [Conexão ${ws.id}] Mensagem LISTEN_TO_CHILD recebida de um não-pai.`);
                    processedAsText = true;
                }
            } else if (messageString.startsWith('STOP_LISTENING_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('STOP_LISTENING_TO_CHILD:'.length);
                    parentListeningSockets.delete(targetChildId);
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                    const childWs = findChildWebSocket(targetChildId);
                    if (childWs) {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Enviando STOP_AUDIO para filho: ${targetChildId}`);
                        childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                    }
                    processedAsText = true;
                } else {
                    console.warn(`[WS_MSG] [Conexão ${ws.id}] Mensagem STOP_LISTENING_TO_CHILD recebida de um não-pai.`);
                    processedAsText = true;
                }
            } else {
                try {
                    const parsedMessage = JSON.parse(messageString);
                    console.log(`[WS_MSG] [${messageOrigin}] Mensagem JSON recebida:`, parsedMessage);

                    if (parsedMessage.type === 'CURRENT_LOCATION_RESPONSE') {
                        const { childId, latitude, longitude, timestamp } = parsedMessage;
                        if (childId && latitude != null && longitude != null && timestamp) {
                            const locationItem = {
                                childId: childId,
                                timestamp: timestamp,
                                latitude: latitude,
                                longitude: longitude,
                                // Adicione o locationId para garantir a unicidade no DynamoDB
                                locationId: `${childId}-${timestamp}-${uuidv4()}`
                            };

                            console.log(`[WS_MSG] [${messageOrigin}] Tentando salvar localização no DynamoDB:`, locationItem);
                            try {
                                await docClient.put({
                                    TableName: DYNAMODB_TABLE_LOCATIONS,
                                    Item: locationItem
                                }).promise();
                                console.log(`[WS_MSG] [${messageOrigin}] Localização salva com sucesso no DynamoDB.`);
                            } catch (dbError) {
                                console.error(`[WS_MSG] [${messageOrigin}] Erro ao salvar localização no DynamoDB:`, dbError);
                            }
                        } else {
                            console.warn(`[WS_MSG] [${messageOrigin}] Dados de localização incompletos na mensagem:`, parsedMessage);
                        }
                    } else {
                        // Reencaminhar a mensagem para o pai que está ouvindo
                        const parentWs = parentListeningSockets.get(ws.clientId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            console.log(`[WS_MSG] [${messageOrigin}] Reencaminhando mensagem JSON para o pai ${parentWs.parentId || 'desconhecido'}.`);
                            parentWs.send(message);
                        } else {
                            console.log(`[WS_MSG] [${messageOrigin}] Nenhum pai ouvindo para reencaminhar mensagem JSON.`);
                        }
                    }
                    processedAsText = true;
                } catch (jsonError) {
                    // Se não for JSON e não for um comando conhecido, trate como texto simples
                    console.warn(`[WS_MSG] [${messageOrigin}] Mensagem de texto não reconhecida: "${displayMessage}"`);
                    processedAsText = true;
                }
            }
        }

        // Se não foi processado como texto (provavelmente é um Buffer de áudio)
        if (!processedAsText && message instanceof Buffer) {
            console.log(`[WS_MSG] [${messageOrigin}] Dados binários (áudio) recebidos. Tamanho: ${message.length} bytes.`);
            // Apenas reencaminhe se for do filho e houver um pai escutando
            if (ws.clientId) {
                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(message);
                    // console.log(`[WS_MSG] [${messageOrigin}] Áudio reencaminhado para o pai ${parentWs.parentId || 'desconhecido'}.`); // Este log pode ser muito verboso
                } else {
                    // console.log(`[WS_MSG] [${messageOrigin}] Nenhuma conexão de pai ativa para reencaminhar áudio.`); // Este log pode ser muito verboso
                }
            } else {
                console.warn(`[WS_MSG] [${messageOrigin}] Dados binários recebidos de uma conexão não identificada como filho.`);
            }
        }
    });

    ws.on('close', () => {
        // Remover a conexão do mapa quando o WebSocket é fechado
        if (ws.clientId) {
            activeChildWebSockets.delete(ws.clientId);
            // Também remover de parentListeningSockets se era um pai que parou de ouvir um filho específico
            for (const [childId, parentWs] of parentListeningSockets.entries()) {
                if (parentWs === ws) {
                    parentListeningSockets.delete(childId);
                    console.log(`[WS_CLOSE] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho ${childId} devido à desconexão.`);
                }
            }
            console.log(`[WS_CLOSE] ChildId ${ws.clientId} desconectado. Total de conexões ativas: ${wss.clients.size}`);
        } else if (ws.parentId) {
            // Se um pai se desconectar, remover suas entradas de escuta
            for (const [childId, parentWs] of parentListeningSockets.entries()) {
                if (parentWs === ws) {
                    parentListeningSockets.delete(childId);
                    console.log(`[WS_CLOSE] Pai (ID: ${ws.parentId}) parou de ouvir o filho ${childId} devido à desconexão.`);
                }
            }
            console.log(`[WS_CLOSE] Pai (ID: ${ws.parentId}) desconectado. Total de conexões ativas: ${wss.clients.size}`);
        } else {
            console.log(`[WS_CLOSE] Cliente WebSocket desconectado (ID: ${ws.id}, tipo desconhecido). Total de conexões ativas: ${wss.clients.size}`);
        }
    });

    ws.on('error', error => {
        console.error(`[WS_ERROR] Erro no WebSocket (ID: ${ws.id}):`, error);
    });
});

// --- ERROS ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});
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
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Twilio Account SID configurado via env: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio Auth Token configurado via env: ${process.env.TWILIO_AUTH_TOKEN ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurado via env: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurado via env: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
});