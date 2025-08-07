const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

// --- DECLARAÇÕES DE MAPS DE CONEXÃO ---
const wsConnections = new Map();
const childToWebSocket = new Map();
const parentToWebSocket = new Map();
const activeAudioControlClients = new Map();
const activeConnections = new Map();
const pendingAudioRequests = new Map();
const parentListeningToChild = new Map(); // Key: parentId, Value: childId que o pai está ouvindo/assistindo

const app = express();
const PORT = process.env.PORT || 10000;

// Configuração do Multer
const upload = multer({
    limits: { fileSize: 50 * 1024 * 1024 } // Limite de 50 MB
});
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Configuração da AWS usando variáveis de ambiente
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

// Clientes DynamoDB e S3
const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

// Nomes das tabelas DynamoDB
const TABLE_CHILDREN = 'Children';
const TABLE_LOCATIONS = 'GPSintegracao';
const TABLE_MESSAGES = 'Messages';
const TABLE_CALLS = process.env.DYNAMODB_TABLE_CALLS || 'parental-monitor-calls';
const TABLE_NOTIFICATIONS = process.env.DYNAMODB_TABLE_NOTIFICATIONS || 'parental-monitor-notifications';
const TABLE_CONVERSATIONS = 'Conversations';

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Cria o servidor HTTP
const server = http.createServer(app);

// Cria os servidores WebSocket
const wssGeneralCommands = new WebSocket.Server({ noServer: true });
const wssAudioControl = new WebSocket.Server({ noServer: true });

// Lida com o upgrade de conexão para WebSockets
server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    if (pathname === '/ws-general-commands') {
        wssGeneralCommands.handleUpgrade(request, socket, head, ws => {
            wssGeneralCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio-control') {
        wssAudioControl.handleUpgrade(request, socket, head, ws => {
            wssAudioControl.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// --- FUNÇÃO AUXILIAR PARA ATUALIZAR STATUS DE CONEXÃO DO FILHO NO DYNAMODB ---
async function updateChildConnectionStatus(childId, isConnected) {
    const params = {
        TableName: TABLE_CHILDREN,
        Key: { childId: childId },
        UpdateExpression: 'SET isConnected = :val, lastSeen = :ts',
        ExpressionAttributeValues: {
            ':val': isConnected,
            ':ts': Date.now()
        }
    };
    try {
        await docClient.update(params).promise();
        console.log(`[DynamoDB] Status de conexão do filho ${childId} atualizado para ${isConnected}.`);
    } catch (error) {
        console.error(`[DynamoDB] Erro ao atualizar status de conexão do filho ${childId}:`, error);
    }
}

// --- FUNÇÃO AUXILIAR PARA ATUALIZAR CONVERSA ---
async function updateConversation(childId, contactOrGroup, timestamp, messageSnippet, messageType, messageDirection) {
    let conversationId;
    const sanitizedContactOrGroup = contactOrGroup || 'Desconhecido';
    const sanitizedMessageType = messageType || 'text';
    const sanitizedMessageDirection = messageDirection || 'unknown';
    const truncatedSnippet = messageSnippet ? messageSnippet.substring(0, 100) + (messageSnippet.length > 100 ? '...' : '') : 'Mensagem vazia';

    const getConversationParams = {
        TableName: TABLE_CONVERSATIONS,
        Key: {
            childId: childId,
            contactOrGroup: sanitizedContactOrGroup
        }
    };
    try {
        const existingConversationData = await docClient.get(getConversationParams).promise();
        if (existingConversationData.Item) {
            conversationId = existingConversationData.Item.conversationId;
            const updateConversationParams = {
                TableName: TABLE_CONVERSATIONS,
                Key: { childId: childId, contactOrGroup: sanitizedContactOrGroup },
                UpdateExpression: 'SET lastMessageTimestamp = :ts, lastMessageSnippet = :snippet, lastMessageType = :msgType, lastMessageDirection = :msgDirection',
                ExpressionAttributeValues: {
                    ':ts': parseInt(timestamp),
                    ':snippet': truncatedSnippet,
                    ':msgType': sanitizedMessageType,
                    ':msgDirection': sanitizedMessageDirection
                }
            };
            await docClient.update(updateConversationParams).promise();
            console.log(`[Conversations] Conversa atualizada: ${sanitizedContactOrGroup} para childId: ${childId}, conversationId: ${conversationId}, tipo: ${sanitizedMessageType}, direção: ${sanitizedMessageDirection}`);
        } else {
            conversationId = uuidv4();
            const newConversationParams = {
                TableName: TABLE_CONVERSATIONS,
                Item: {
                    conversationId: conversationId,
                    childId: childId,
                    contactOrGroup: sanitizedContactOrGroup,
                    lastMessageTimestamp: parseInt(timestamp),
                    lastMessageSnippet: truncatedSnippet,
                    lastMessageType: sanitizedMessageType,
                    lastMessageDirection: sanitizedMessageDirection,
                    createdAt: Date.now()
                }
            };
            await docClient.put(newConversationParams).promise();
            console.log(`[Conversations] Nova conversa criada: ${sanitizedContactOrGroup} para childId: ${childId}, conversationId: ${conversationId}, tipo: ${sanitizedMessageType}, direção: ${sanitizedMessageDirection}`);
        }
        return conversationId;
    } catch (error) {
        console.error(`[Conversations] Erro ao atualizar/criar conversa para childId: ${childId}, contactOrGroup: ${sanitizedContactOrGroup}:`, error);
        throw error;
    }
}

// --- FUNÇÃO AUXILIAR PARA SANITIZAR NOMES PARA CHAVES S3 ---
function sanitizeS3KeyPart(inputString) {
    if (!inputString) {
        return "unknown_contact";
    }
    return inputString.replace(/[^a-zA-Z0-9-_.]/g, '_').toLowerCase();
}

// --- Rotas HTTP ---

// Rota de upload de áudio
app.post('/upload-audio', audioUpload.single('audio'), async (req, res) => {
    if (!req.file) {
        console.error('[Upload-Audio] Nenhum arquivo de áudio enviado.');
        return res.status(400).send('Nenhum arquivo de áudio enviado.');
    }

    const { childId, parentId, timestamp } = req.body;
    const audioBuffer = req.file.buffer;
    const audioFileName = `WhatsappMedia/${childId}/audio/${Date.now()}_${uuidv4()}.wav`;
    const messageType = 'audio_stream';

    console.log(`[Upload-Audio] Recebendo áudio para childId: ${childId}, parentId: ${parentId}, tamanho: ${audioBuffer.length} bytes`);

    const uploadParams = {
        Bucket: process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory',
        Key: audioFileName,
        Body: audioBuffer,
        ContentType: 'audio/wav'
    };

    try {
        const data = await s3.upload(uploadParams).promise();
        console.log(`[Upload-Audio] Áudio enviado com sucesso para S3: ${data.Location}`);

        const parentWs = parentToWebSocket.get(parentId);
        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                type: 'audioStreamUrl',
                childId: childId,
                url: data.Location,
                timestamp: timestamp,
                messageType: messageType
            });
            parentWs.send(message);
            console.log(`[Upload-Audio] URL do áudio (${data.Location}) enviada para o pai ${parentId}.`);
        } else {
            console.warn(`[Upload-Audio] Pai ${parentId} não conectado ou WebSocket não está aberto.`);
        }

        res.status(200).json({ message: 'Áudio recebido e enviado para S3.', url: data.Location, childId: childId, messageType: messageType });
    } catch (error) {
        console.error('[Upload-Audio] Erro ao enviar áudio para S3:', error);
        res.status(500).send('Erro ao processar o áudio.');
    }
});

// Rota de upload de mídia geral
app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file) {
        console.error('[Upload-Media] Nenhum arquivo de mídia enviado.');
        return res.status(400).send('Nenhum arquivo de mídia enviado.');
    }

    const { childId, parentId, mediaType, timestamp, contactOrGroup } = req.body;
    const mediaBuffer = req.file.buffer;
    const originalname = req.file.originalname;
    const fileExtension = originalname.split('.').pop();

    let contentType = req.file.mimetype;
    if (mediaType === "audio" && (fileExtension === "opus" || fileExtension === "ogg")) {
        contentType = "audio/ogg";
    } else if (mediaType === "audio" && fileExtension === "mp3") {
        contentType = "audio/mpeg";
    } else if (mediaType === "audio" && fileExtension === "wav") {
        contentType = "audio/wav";
    }

    const sanitizedContactOrGroup = sanitizeS3KeyPart(contactOrGroup);
    const mediaFileName = `WhatsappMedia/${childId}/${sanitizedContactOrGroup}/${mediaType}/${Date.now()}_${uuidv4()}.${fileExtension}`;

    console.log(`[Upload-Media] Recebendo ${mediaType} para childId: ${childId}, parentId: ${parentId}, tamanho: ${mediaBuffer.length} bytes, tipo: ${contentType}, extensão: ${fileExtension}, caminho S3: ${mediaFileName}`);

    const uploadParams = {
        Bucket: process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory',
        Key: mediaFileName,
        Body: mediaBuffer,
        ContentType: contentType
    };

    try {
        const data = await s3.upload(uploadParams).promise();
        console.log(`[Upload-Media] Mídia enviada com sucesso para S3: ${data.Location}`);

        let snippet = "";
        if (mediaType === "image") snippet = "📷 Imagem";
        else if (mediaType === "video") snippet = "🎥 Vídeo";
        else if (mediaType === "audio") snippet = "🎵 Áudio";
        else if (mediaType === "document") snippet = "📄 Documento";
        else snippet = "📎 Arquivo";

        let conversationId;
        if (contactOrGroup) {
            conversationId = await updateConversation(childId, contactOrGroup, timestamp, snippet, mediaType, "sent");
        } else {
            console.warn(`[Upload-Media] contactOrGroup não fornecido. Usando UUID avulso para mensagem.`);
            conversationId = uuidv4();
        }

        const messageItem = {
            id: uuidv4(),
            messageId: uuidv4(),
            conversationId: conversationId,
            childId: childId,
            contactOrGroup: contactOrGroup || 'N/A',
            messageText: data.Location,
            timestamp: parseInt(timestamp),
            direction: "sent",
            messageType: mediaType,
            phoneNumber: "unknown_number"
        };

        const putMessageParams = {
            TableName: TABLE_MESSAGES,
            Item: messageItem
        };
        await docClient.put(putMessageParams).promise();
        console.log(`[Upload-Media] Mensagem de mídia salva em ${TABLE_MESSAGES}: ${messageItem.messageId} para conversa: ${conversationId}`);

        const parentWs = parentToWebSocket.get(parentId);
        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                type: 'mediaUploaded',
                childId: childId,
                mediaType: mediaType,
                url: data.Location,
                timestamp: timestamp,
                contactOrGroup: contactOrGroup
            });
            parentWs.send(message);
            console.log(`[Upload-Media] URL da mídia (${data.Location}) enviada para o pai ${parentId}.`);
        }

        res.status(200).json({ message: 'Mídia recebida e enviada para S3.', url: data.Location, childId: childId, mediaType: mediaType });
    } catch (error) {
        console.error('[Upload-Media] Erro ao enviar mídia para S3 ou salvar no DynamoDB:', error);
        res.status(500).send('Erro ao processar a mídia.');
    }
});

// Rota de registro de filho
app.post('/register-child', async (req, res) => {
    const { childId, parentId, childName, childToken, childImage } = req.body;
    console.log(`[Register] Tentativa de registro: childId=${childId}, parentId=${parentId}, childName=${childName}`);

    if (!childId || !parentId || !childName) {
        console.error('[Register] Dados incompletos para registro.');
        return res.status(400).send('childId, parentId e childName são obrigatórios.');
    }

    const params = {
        TableName: TABLE_CHILDREN,
        Item: {
            childId: childId,
            parentId: parentId,
            childName: childName,
            childToken: childToken || 'N/A',
            childImage: childImage || null,
            lastSeen: Date.now(),
            isConnected: true
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[Register] Filho ${childName} (${childId}) registrado/atualizado com sucesso para o pai ${parentId}.`);
        res.status(200).json({ message: 'Filho registrado/atualizado com sucesso.', childId: childId });
    } catch (error) {
        console.error('[Register] Erro ao registrar filho no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor.');
    }
});

// Rota para receber notificações (incluindo mensagens WhatsApp)
app.post('/send-notification', async (req, res) => {
    console.log('[Notification] Recebendo notificação:', req.body);
    const { childId, message, messageType, timestamp, contactOrGroup, phoneNumber, direction, parentId } = req.body;

    if (!childId || !message || !messageType || !timestamp || !contactOrGroup || !direction || !parentId) {
        console.error('[Notification] Dados de notificação incompletos:', req.body);
        return res.status(400).send('Dados de notificação incompletos. Campos obrigatórios: childId, message, messageType, timestamp, contactOrGroup, direction, parentId.');
    }

    try {
        // Atualizar a tabela Conversations e obter o conversationId
        const conversationId = await updateConversation(childId, contactOrGroup, timestamp, message, messageType, direction);

        // Salvar a mensagem individual na tabela de mensagens
        const messageItem = {
            id: uuidv4(),
            messageId: uuidv4(),
            conversationId: conversationId,
            childId: childId,
            contactOrGroup: contactOrGroup,
            messageText: message,
            timestamp: parseInt(timestamp),
            direction: direction,
            messageType: messageType,
            phoneNumber: phoneNumber || 'unknown_number'
        };

        const putMessageParams = {
            TableName: TABLE_MESSAGES,
            Item: messageItem
        };
        await docClient.put(putMessageParams).promise();
        console.log(`[Notification] Mensagem salva em ${TABLE_MESSAGES}: ${messageItem.messageId} para conversa: ${conversationId}, tipo: ${messageType}, direção: ${direction}`);

        // Notificar o pai via WebSocket, se conectado
        const parentWs = parentToWebSocket.get(parentId);
        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
            const wsMessage = JSON.stringify({
                type: 'chatMessage',
                childId: childId,
                message: message,
                messageType: messageType,
                timestamp: timestamp,
                contactOrGroup: contactOrGroup,
                direction: direction,
                phoneNumber: phoneNumber || 'unknown_number'
            });
            parentWs.send(wsMessage);
            console.log(`[Notification] Mensagem enviada para o pai ${parentId} via WebSocket: ${wsMessage}`);
        } else {
            console.warn(`[Notification] Pai ${parentId} não conectado ou WebSocket não está aberto.`);
        }

        res.status(200).send('Notificação recebida e processada.');
    } catch (error) {
        console.error('[Notification] Erro ao processar notificação:', error);
        res.status(500).send(`Erro interno do servidor ao processar notificação: ${error.message}`);
    }
});

// Rota para listar filhos registrados
app.get('/get-registered-children', async (req, res) => {
    try {
        const params = { TableName: TABLE_CHILDREN };
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela '${TABLE_CHILDREN}'. Encontrados ${data.Items.length} filhos.`);
        const childrenWithStatus = data.Items.map(child => ({
            ...child,
            connected: childToWebSocket.has(child.childId)
        }));
        res.status(200).json(childrenWithStatus);
    } catch (error) {
        console.error('[DynamoDB] Erro ao buscar filhos:', error);
        res.status(500).send('Erro interno do servidor ao buscar filhos.');
    }
});

// Rota para listar conversas de um pai
app.get('/conversations/:parentId', async (req, res) => {
    const { parentId } = req.params;
    try {
        const getChildrenParams = {
            TableName: TABLE_CHILDREN,
            FilterExpression: 'parentId = :parentId',
            ExpressionAttributeValues: { ':parentId': parentId }
        };
        const childrenData = await docClient.scan(getChildrenParams).promise();
        const childIds = childrenData.Items.map(child => child.childId);

        if (childIds.length === 0) {
            console.log(`[Conversations] Nenhum filho encontrado para o pai: ${parentId}.`);
            return res.status(200).json([]);
        }

        const conversationsPromises = childIds.map(async (child) => {
            const getConversationsForChildParams = {
                TableName: TABLE_CONVERSATIONS,
                KeyConditionExpression: 'childId = :childId',
                ExpressionAttributeValues: { ':childId': child }
            };
            const data = await docClient.query(getConversationsForChildParams).promise();
            return data.Items.map(conv => ({
                ...conv,
                childName: childrenData.Items.find(c => c.childId === child)?.childName || 'Desconhecido',
                lastMessageType: conv.lastMessageType || 'text',
                lastMessageDirection: conv.lastMessageDirection || 'unknown'
            }));
        });

        const allConversations = (await Promise.all(conversationsPromises)).flat();
        allConversations.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
        console.log(`[Conversations] ${allConversations.length} conversas encontradas para o pai ${parentId}.`);
        res.status(200).json(allConversations);
    } catch (error) {
        console.error('[Conversations] Erro ao obter conversas:', error);
        res.status(500).send('Erro ao obter conversas.');
    }
});

// Rota para listar mensagens por conversationId
app.get('/messages/:childId/:conversationId', async (req, res) => {
    const { childId, conversationId } = req.params;
    const limit = parseInt(req.query.limit) || 100; // Limite padrão de 100 mensagens
    console.log(`[Messages] Recebendo requisição para listar mensagens do filho: ${childId}, conversa ID: ${conversationId}, limite: ${limit}`);

    const params = {
        TableName: TABLE_MESSAGES,
        KeyConditionExpression: 'childId = :childId',
        FilterExpression: 'conversationId = :conversationId',
        ExpressionAttributeValues: {
            ':childId': childId,
            ':conversationId': conversationId
        },
        ScanIndexForward: true,
        Limit: limit
    };
    try {
        const data = await docClient.query(params).promise();
        console.log(`[Messages] ${data.Items.length} mensagens encontradas para a conversa ID ${conversationId} do filho ${childId}.`);
        // Ordenar mensagens por timestamp (crescente)
        const sortedMessages = data.Items.sort((a, b) => a.timestamp - b.timestamp);
        res.status(200).json(sortedMessages);
    } catch (error) {
        console.error('[Messages] Erro ao obter mensagens:', error);
        res.status(500).send('Erro ao obter mensagens.');
    }
});

// Rota para localizações
app.get('/locations/:childId', async (req, res) => {
    const { childId } = req.params;
    const params = {
        TableName: TABLE_LOCATIONS,
        KeyConditionExpression: 'childId = :childId',
        ExpressionAttributeValues: { ':childId': childId },
        ScanIndexForward: true,
        Limit: 100
    };
    try {
        const data = await docClient.query(params).promise();
        console.log(`[Locations] ${data.Items.length} localizações encontradas para o filho ${childId}.`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[Locations] Erro ao obter localizações:', error);
        res.status(500).send('Erro ao obter localizações.');
    }
});

// Rota para Twilio token (placeholder)
app.get('/twilio-token', (req, res) => {
    console.log('[Twilio] Requisição para Twilio token recebida. Retornando placeholder.');
    res.status(200).json({ token: 'seu_token_do_twilio_aqui' });
});

// Middleware para rotas não encontradas
app.use((req, res, next) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).send('Rota não encontrada.');
});

// Middleware para erros
app.use((err, req, res, next) => {
    console.error('[HTTP] Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- LÓGICA DE WEBSOCKETS ---
const sendCommandWithRetry = (childId, commandMessage, targetMap, mapNameForLog, maxRetries = 3, initialDelay = 1000, currentRetry = 0) => {
    const targetWs = targetMap.get(childId);
    console.log(`[Command-Retry] Tentativa ${currentRetry + 1}: Buscando childId=${childId} no mapa ${mapNameForLog}.`);

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(commandMessage));
        console.log(`[Command-Retry] Comando '${commandMessage.type}' enviado com sucesso para filho ${childId} via ${mapNameForLog} WS.`);
    } else {
        console.warn(`[Command-Retry] Filho ${childId} não conectado no mapa ${mapNameForLog} WS (tentativa ${currentRetry + 1}/${maxRetries}).`);
        if (currentRetry < maxRetries) {
            const delay = initialDelay * Math.pow(2, currentRetry);
            console.log(`[Command-Retry] Re-tentando comando '${commandMessage.type}' em ${delay}ms.`);
            setTimeout(() => {
                sendCommandWithRetry(childId, commandMessage, targetMap, mapNameForLog, maxRetries, initialDelay, currentRetry + 1);
            }, delay);
        } else {
            console.error(`[Command-Retry] Falha ao enviar comando '${commandMessage.type}' após ${maxRetries} tentativas.`);
            const parentWs = parentToWebSocket.get(commandMessage.parentId);
            if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                parentWs.send(JSON.stringify({
                    type: 'commandFailed',
                    childId: childId,
                    command: commandMessage.type,
                    message: `Filho ${childId} offline ou inacessível.`,
                    timestamp: new Date().toISOString()
                }));
            }
        }
    }
};

wssGeneralCommands.on('connection', ws => {
    ws.id = uuidv4();
    ws.clientType = 'unknown';
    ws.currentParentId = null;
    ws.currentChildId = null;
    ws.currentChildName = null;

    console.log(`[WS-GENERAL-CONN] Nova conexão WS (Temp ID: ${ws.id}). Estado inicial: clientType=${ws.clientType}`);
    activeConnections.set(ws.id, { ws: ws, type: ws.clientType, tempId: ws.id });

    ws.on('message', async message => {
        let finalParsedMessage = null;
        const rawMessageString = (Buffer.isBuffer(message) ? message.toString('utf8') : message).trim();
        console.log(`[WebSocket-General-RAW] Mensagem recebida (raw): ${rawMessageString}`);

        try {
            let messageString = rawMessageString;
            if (messageString.startsWith('"') && messageString.endsWith('"') && messageString.includes('\\"')) {
                messageString = messageString.substring(1, messageString.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
            finalParsedMessage = JSON.parse(messageString);

            if (typeof finalParsedMessage !== 'object' || finalParsedMessage === null || Array.isArray(finalParsedMessage)) {
                console.error('[WebSocket-General] Mensagem parseada inválida:', finalParsedMessage);
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido.' }));
                return;
            }

            console.log('[WebSocket-General] Mensagem JSON recebida:', finalParsedMessage);

            const { type, parentId, childId, childName, latitude, longitude, timestamp, message: chatMessageContent, messageType, contactOrGroup, direction, phoneNumber, data } = finalParsedMessage;

            let effectiveChildId = childId;
            let effectiveChildName = childName;
            let effectiveParentId = parentId;
            let effectiveLatitude = latitude;
            let effectiveLongitude = longitude;
            let effectiveTimestamp = timestamp;

            if (data) {
                effectiveChildId = data.childId || effectiveChildId;
                effectiveChildName = data.childName || effectiveChildName;
                effectiveParentId = data.parentId || effectiveParentId;
                effectiveLatitude = data.latitude || effectiveLatitude;
                effectiveLongitude = data.longitude || effectiveLongitude;
                effectiveTimestamp = data.timestamp || effectiveTimestamp;
            }

            switch (type) {
                case 'parentConnect':
                    ws.currentParentId = effectiveParentId;
                    ws.clientType = 'parent';
                    console.log(`[WS-GENERAL-CONN] parentConnect recebido (ID: ${ws.id}). Definido: clientType=${ws.clientType}, currentParentId=${ws.currentParentId}`);

                    if (ws.currentParentId) {
                        if (parentToWebSocket.has(ws.currentParentId)) {
                            const oldWs = parentToWebSocket.get(ws.currentParentId);
                            console.log(`[WS-GENERAL-CONN] Removendo conexão pai antiga para ${ws.currentParentId}.`);
                            oldWs.close(1000, 'Nova conexão estabelecida');
                            parentToWebSocket.delete(ws.currentParentId);
                            activeConnections.delete(oldWs.id);
                        }
                        parentToWebSocket.set(ws.currentParentId, ws);
                        activeConnections.set(ws.currentParentId, { ws: ws, type: ws.clientType, id: ws.currentParentId });
                        ws.id = ws.currentParentId;
                        console.log(`[WebSocket-Manager] Conexão parent ${ws.currentParentId} atualizada.`);
                        ws.send(JSON.stringify({ type: 'parentConnectedSuccess', parentId: ws.currentParentId }));
                    }
                    break;
                case 'childConnect':
                    if (effectiveChildId && effectiveParentId) {
                        ws.clientType = 'child';
                        ws.currentChildId = effectiveChildId;
                        ws.currentParentId = effectiveParentId;
                        ws.currentChildName = effectiveChildName || 'Desconhecido';

                        if (childToWebSocket.has(ws.currentChildId)) {
                            const oldWs = childToWebSocket.get(ws.currentChildId);
                            console.log(`[WS-GENERAL-CONN] Removendo conexão filho antiga para ${ws.currentChildId}.`);
                            oldWs.close(1000, 'Nova conexão estabelecida');
                            childToWebSocket.delete(ws.currentChildId);
                            activeConnections.delete(oldWs.id);
                        }
                        childToWebSocket.set(ws.currentChildId, ws);
                        activeConnections.set(ws.currentChildId, { ws: ws, type: ws.clientType, id: ws.currentChildId, parentId: ws.currentParentId, name: ws.currentChildName });
                        ws.id = ws.currentChildId;

                        await updateChildConnectionStatus(ws.currentChildId, true);
                        console.log(`[DynamoDB] Filho ${ws.currentChildName} (${ws.currentChildId}) conectado.`);

                        const parentWs = parentToWebSocket.get(ws.currentParentId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({
                                type: 'childStatus',
                                childId: ws.currentChildId,
                                status: 'online',
                                childName: ws.currentChildName
                            }));
                            console.log(`[WebSocket-General] Notificação de status 'online' enviada para o pai ${ws.currentParentId}.`);
                        }
                    }
                    break;
                case 'locationUpdate':
                    if (!ws.currentChildId || effectiveLatitude === undefined || effectiveLongitude === undefined) {
                        console.warn('[WebSocket-General] Dados de localização incompletos.');
                        return;
                    }
                    console.log(`[Location] Localização recebida do filho ${ws.currentChildId}: Lat ${effectiveLatitude}, Lng ${effectiveLongitude}`);

                    const locationParams = {
                        TableName: TABLE_LOCATIONS,
                        Item: {
                            id: uuidv4(),
                            locationId: uuidv4(),
                            childId: ws.currentChildId,
                            latitude: effectiveLatitude,
                            longitude: effectiveLongitude,
                            timestamp: effectiveTimestamp || new Date().toISOString()
                        }
                    };
                    await docClient.put(locationParams).promise();

                    const connectedParentWs = parentToWebSocket.get(ws.currentParentId);
                    if (connectedParentWs && connectedParentWs.readyState === WebSocket.OPEN) {
                        connectedParentWs.send(JSON.stringify({
                            type: 'locationUpdate',
                            childId: ws.currentChildId,
                            latitude: effectiveLatitude,
                            longitude: effectiveLongitude,
                            timestamp: effectiveTimestamp || new Date().toISOString()
                        }));
                        console.log(`[Location] Localização encaminhada para o pai ${ws.currentParentId}.`);
                    }
                    break;
                case 'chatMessage':
                    const senderId = ws.currentChildId || ws.currentParentId;
                    const receiverId = effectiveChildId || effectiveParentId;
                    const senderName = ws.clientType === 'child' ? ws.currentChildName : 'Pai';

                    if (!senderId || !receiverId || !chatMessageContent) {
                        console.warn('[WebSocket-General] Mensagem de chat inválida.');
                        return;
                    }
                    console.log(`[Chat] Mensagem de ${senderName} (${senderId}) para ${receiverId}: ${chatMessageContent}`);

                    let conversationId;
                    if (messageType !== 'APP_CHAT_MESSAGE') {
                        conversationId = await updateConversation(senderId, contactOrGroup || 'Desconhecido', effectiveTimestamp || Date.now(), chatMessageContent, messageType || 'text', direction || 'unknown');
                    } else {
                        conversationId = uuidv4();
                    }

                    const messageParams = {
                        TableName: TABLE_MESSAGES,
                        Item: {
                            id: uuidv4(),
                            messageId: uuidv4(),
                            conversationId: conversationId,
                            senderId: senderId,
                            receiverId: receiverId,
                            messageText: chatMessageContent,
                            timestamp: effectiveTimestamp || new Date().toISOString(),
                            messageType: messageType || 'text',
                            contactOrGroup: contactOrGroup || 'N/A',
                            direction: direction || 'unknown',
                            phoneNumber: phoneNumber || 'unknown_number'
                        }
                    };
                    await docClient.put(messageParams).promise();
                    console.log(`[Chat] Mensagem salva: ${messageParams.Item.messageId}`);

                    const targetWs = childToWebSocket.get(receiverId) || parentToWebSocket.get(receiverId);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify({
                            type: 'chatMessage',
                            senderId: senderId,
                            receiverId: receiverId,
                            message: chatMessageContent,
                            timestamp: effectiveTimestamp || new Date().toISOString(),
                            messageType: messageType || 'text',
                            contactOrGroup: contactOrGroup || 'N/A',
                            direction: direction || 'unknown',
                            senderName: senderName,
                            phoneNumber: phoneNumber || 'unknown_number'
                        }));
                        console.log(`[Chat] Mensagem encaminhada para ${receiverId}.`);
                    }
                    break;
                case 'requestLocation':
                    if (ws.clientType !== 'parent' || !effectiveChildId) {
                        console.warn('[WebSocket-General] Requisição de localização inválida.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }
                    sendCommandWithRetry(effectiveChildId, { type: 'startLocationUpdates', parentId: effectiveParentId }, childToWebSocket, 'General');
                    ws.send(JSON.stringify({ type: 'info', message: `Solicitando localização para ${effectiveChildId}.` }));
                    break;
                case 'stopLocationUpdates':
                    if (ws.clientType !== 'parent' || !effectiveChildId) {
                        console.warn('[WebSocket-General] Requisição de parada de localização inválida.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de parada de localização inválida.' }));
                        return;
                    }
                    sendCommandWithRetry(effectiveChildId, { type: 'stopLocationUpdates', parentId: effectiveParentId }, childToWebSocket, 'General');
                    ws.send(JSON.stringify({
                        type: 'locationCommandStatus',
                        status: 'sent',
                        childId: effectiveChildId,
                        message: `Comando 'stopLocationUpdates' enviado.`
                    }));
                    break;
                case 'startAudioStream':
                    console.log(`[WS-General] Comando 'startAudioStream' recebido para filho: ${effectiveChildId}.`);
                    parentListeningToChild.set(effectiveParentId, effectiveChildId);
                    sendCommandWithRetry(effectiveChildId, { type: 'startRecording', parentId: effectiveParentId }, activeAudioControlClients, 'AudioControl', 5, 500, 0);
                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'activating',
                        childId: effectiveChildId,
                        message: `Ativando canal de áudio para ${effectiveChildId}.`
                    }));
                    break;
                case 'stopAudioStream':
                    console.log(`[WS-General] Comando 'stopAudioStream' recebido para filho: ${effectiveChildId}.`);
                    sendCommandWithRetry(effectiveChildId, { type: 'stopAudioStreamFromServer', parentId: effectiveParentId }, activeAudioControlClients, 'AudioControl', 5, 500, 0);
                    parentListeningToChild.delete(effectiveParentId);
                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'stopped',
                        childId: effectiveChildId,
                        message: `Comando 'stopAudioStreamFromServer' enviado.`
                    }));
                    break;
                default:
                    console.warn('[WebSocket-General] Tipo de mensagem desconhecido:', type);
            }
        } catch (error) {
            console.error('[WebSocket-General] Erro ao processar mensagem:', error.message);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno: ${error.message}` }));
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WS-GENERAL-CLOSE] Cliente desconectado (ID: ${ws.id}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);

        activeConnections.delete(ws.id);
        if (ws.clientType === 'child' && ws.currentChildId) {
            childToWebSocket.delete(ws.currentChildId);
            await updateChildConnectionStatus(ws.currentChildId, false);
            for (let [parentId, listeningChildId] of parentListeningToChild.entries()) {
                if (listeningChildId === ws.currentChildId) {
                    parentListeningToChild.delete(parentId);
                }
            }
        } else if (ws.clientType === 'parent' && ws.currentParentId) {
            parentToWebSocket.delete(ws.currentParentId);
            parentListeningToChild.delete(ws.currentParentId);
        }
        console.log(`[WebSocket-Manager] Total de conexões ativas: ${activeConnections.size}.`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-General] Erro no cliente WebSocket:', error);
    });
});

wssAudioControl.on('connection', ws => {
    ws.id = uuidv4();
    ws.clientType = 'unknown';
    ws.currentParentId = null;
    ws.currentChildId = null;

    console.log(`[WS-AUDIO-CONTROL-CONN] Nova conexão WS de controle de áudio (Temp ID: ${ws.id}).`);
    activeConnections.set(ws.id, { ws: ws, type: ws.clientType, tempId: ws.id });

    ws.on('message', async message => {
        let finalParsedMessage = null;
        const rawMessageString = (Buffer.isBuffer(message) ? message.toString('utf8') : message).trim();
        console.log(`[WebSocket-AudioControl-RAW] Mensagem recebida (raw): ${rawMessageString}`);

        try {
            let messageString = rawMessageString;
            if (messageString.startsWith('"') && messageString.endsWith('"') && messageString.includes('\\"')) {
                messageString = messageString.substring(1, messageString.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
            finalParsedMessage = JSON.parse(messageString);

            if (typeof finalParsedMessage !== 'object' || finalParsedMessage === null || Array.isArray(finalParsedMessage)) {
                console.error('[WebSocket-AudioControl] Mensagem parseada inválida:', finalParsedMessage);
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido.' }));
                return;
            }

            console.log('[WebSocket-AudioControl] Mensagem JSON recebida:', finalParsedMessage);

            const { type, parentId, childId, data } = finalParsedMessage;

            let effectiveChildId = childId;
            let effectiveParentId = parentId;

            if (data) {
                effectiveChildId = data.childId || effectiveChildId;
                effectiveParentId = data.parentId || effectiveParentId;
            }

            switch (type) {
                case 'childConnectAudioControl':
                    ws.clientType = 'child-audio-control';
                    ws.currentChildId = effectiveChildId;
                    ws.currentParentId = effectiveParentId;

                    if (activeAudioControlClients.has(effectiveChildId)) {
                        const oldWs = activeAudioControlClients.get(effectiveChildId);
                        oldWs.close(1000, 'Nova conexão estabelecida');
                        activeAudioControlClients.delete(effectiveChildId);
                        activeConnections.delete(oldWs.id);
                    }

                    activeAudioControlClients.set(effectiveChildId, ws);
                    activeConnections.set(effectiveChildId, { ws: ws, type: ws.clientType, id: effectiveChildId });
                    ws.id = effectiveChildId;

                    console.log(`[WS-AUDIO-CONTROL-CONN] Filho ${effectiveChildId} conectado ao canal de controle de áudio.`);

                    if (pendingAudioRequests.has(effectiveChildId)) {
                        ws.send(JSON.stringify({ type: 'startRecording' }));
                        pendingAudioRequests.delete(effectiveChildId);
                    }
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    console.log(`[WS-AudioControl] Pong enviado para ${ws.id}.`);
                    break;
                case 'pong':
                    console.log(`[WS-AudioControl] Pong recebido de ${ws.id}.`);
                    break;
                default:
                    console.warn('[WebSocket-AudioControl] Tipo de mensagem desconhecido:', type);
                    ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem desconhecido.' }));
            }
        } catch (error) {
            console.error('[WebSocket-AudioControl] Erro ao processar mensagem:', error.message);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno: ${error.message}` }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-AUDIO-CONTROL-CLOSE] Cliente desconectado (ID: ${ws.id}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        activeConnections.delete(ws.id);
        if (ws.clientType === 'child-audio-control' && ws.currentChildId) {
            activeAudioControlClients.delete(ws.currentChildId);
        }
        console.log(`[WS-AUDIO-CONTROL-CLOSE] Total de conexões de controle de áudio: ${activeAudioControlClients.size}.`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-AudioControl] Erro no cliente WebSocket:', error);
    });
});

// --- INICIO DO SERVIDOR ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`Endpoint de upload de áudio: http://localhost:${PORT}/upload-audio`);
    console.log(`Endpoint de upload de mídia: http://localhost:${PORT}/upload-media`);
    console.log(`Endpoint de registro de filho: http://localhost:${PORT}/register-child`);
    console.log(`Endpoint de notificação: http://localhost:${PORT}/send-notification`);
    console.log(`Endpoint para listar conversas: http://localhost:${PORT}/conversations/:parentId`);
    console.log(`Endpoint para listar mensagens: http://localhost:${PORT}/messages/:childId/:conversationId`);
    console.log(`WebSocket de comandos gerais em: ws://localhost:${PORT}/ws-general-commands`);
    console.log(`WebSocket de controle de áudio em: ws://localhost:${PORT}/ws-audio-control`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`Tabela DynamoDB CHILDREN: ${TABLE_CHILDREN}`);
    console.log(`Tabela DynamoDB LOCATIONS: ${TABLE_LOCATIONS}`);
    console.log(`Tabela DynamoDB MESSAGES: ${TABLE_MESSAGES}`);
    console.log(`Tabela DynamoDB CALLS: ${TABLE_CALLS}`);
    console.log(`Tabela DynamoDB NOTIFICATIONS: ${TABLE_NOTIFICATIONS}`);
    console.log(`Tabela DynamoDB CONVERSATIONS: ${TABLE_CONVERSATIONS}`);
});