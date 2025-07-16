// Importações necessárias
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

// --- NOVO MAPA PARA RASTREAR QUAL FILHO O PAI ESTÁ OUVINDO/ASSISTINDO ---
const parentListeningToChild = new Map(); // Key: parentId, Value: childId que o pai está ouvindo/assistindo

const app = express();
const PORT = process.env.PORT || 10000;

// Configuração do Multer:
// Aumentar o limite de tamanho do Multer para lidar com arquivos de áudio/vídeo potencialmente maiores
const upload = multer({
    limits: { fileSize: 50 * 1024 * 1024 } // Limite de 50 MB para uploads gerais (ajuste conforme necessário)
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

// Nomes das tabelas DynamoDB (MANTENDO OS NOMES EXISTENTES E ADICIONANDO 'Conversations')
const TABLE_CHILDREN = 'Children';
const TABLE_LOCATIONS = 'GPSintegracao';
const TABLE_MESSAGES = 'Messages';
const TABLE_CALLS = process.env.DYNAMODB_TABLE_CALLS || 'parental-monitor-calls'; // Mantido padrão, ajuste se tiver um nome específico
const TABLE_NOTIFICATIONS = process.env.DYNAMODB_TABLE_NOTIFICATIONS || 'parental-monitor-notifications'; // Mantido padrão, ajuste se tiver um nome específico
const TABLE_CONVERSATIONS = 'Conversations'; // A nova tabela

// Middlewares
app.use(cors());
app.use(bodyParser.json()); // Para JSON no corpo da requisição
app.use(bodyParser.urlencoded({ extended: true })); // Para dados de formulário URL-encoded

// Cria o servidor HTTP
const server = http.createServer(app);

// Cria o servidor WebSocket anexado ao servidor HTTP
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

// --- Rotas HTTP ---

// Rota de upload de áudio
app.post('/upload-audio', audioUpload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo de áudio enviado.');
    }

    const { childId, parentId, timestamp } = req.body;
    const audioBuffer = req.file.buffer;
    const audioFileName = `audio/${childId}/${Date.now()}_${uuidv4()}.wav`;

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

        // Enviar URL do S3 de volta para o cliente pai via WebSocket (se houver um pai escutando)
        const parentWs = parentToWebSocket.get(parentId);
        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                type: 'audioStreamUrl',
                childId: childId,
                url: data.Location,
                timestamp: timestamp
            });
            parentWs.send(message);
            console.log(`[Upload-Audio] URL do áudio (${data.Location}) enviada para o pai ${parentId}.`);
        } else {
            console.warn(`[Upload-Audio] Pai ${parentId} não conectado ou WebSocket não está aberto. Não foi possível enviar a URL do áudio.`);
        }

        res.status(200).json({ message: 'Áudio recebido e enviado para S3.', url: data.Location, childId: childId });
    } catch (error) {
        console.error('[Upload-Audio] Erro ao enviar áudio para S3:', error);
        res.status(500).send('Erro ao processar o áudio.');
    }
});

// Rota de upload de mídia geral (imagens, vídeos)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo de mídia enviado.');
    }

    const { childId, parentId, mediaType, timestamp } = req.body; // mediaType: 'image', 'video'
    const mediaBuffer = req.file.buffer;
    const originalname = req.file.originalname;
    const fileExtension = originalname.split('.').pop();
    const mediaFileName = `${mediaType}/${childId}/${Date.now()}_${uuidv4()}.${fileExtension}`;
    const contentType = req.file.mimetype;

    console.log(`[Upload-Media] Recebendo ${mediaType} para childId: ${childId}, parentId: ${parentId}, tamanho: ${mediaBuffer.length} bytes, tipo: ${contentType}`);

    const uploadParams = {
        Bucket: process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory',
        Key: mediaFileName,
        Body: mediaBuffer,
        ContentType: contentType
    };

    try {
        const data = await s3.upload(uploadParams).promise();
        console.log(`[Upload-Media] Mídia enviada com sucesso para S3: ${data.Location}`);

        // Opcional: Notificar o pai sobre a nova mídia
        const parentWs = parentToWebSocket.get(parentId);
        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                type: 'mediaUploaded',
                childId: childId,
                mediaType: mediaType,
                url: data.Location,
                timestamp: timestamp
            });
            parentWs.send(message);
            console.log(`[Upload-Media] URL da mídia (${data.Location}) enviada para o pai ${parentId}.`);
        }

        res.status(200).json({ message: 'Mídia recebida e enviada para S3.', url: data.Location, childId: childId, mediaType: mediaType });
    } catch (error) {
        console.error('[Upload-Media] Erro ao enviar mídia para S3:', error);
        res.status(500).send('Erro ao processar a mídia.');
    }
});

// Rota de registro de filho
app.post('/register-child', async (req, res) => {
    const { childId, parentId, childName, childToken, childImage } = req.body;
    console.log(`[Register] Tentativa de registro: childId=${childId}, parentId=${parentId}, childName=${childName}`);

    if (!childId || !parentId || !childName) {
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
            isConnected: true // Define como conectado no registro
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

// --- Rota para receber notificações (incluindo mensagens WhatsApp) ---
app.post('/send-notification', async (req, res) => {
    console.log('[Notification] Recebendo notificação:', req.body);
    // Adicionado messageType aqui para ser usado ao salvar/atualizar a conversa
    const { childId, message, messageType, timestamp, contactOrGroup, phoneNumber, direction } = req.body; 

    if (!childId || !message || !messageType || !timestamp || !contactOrGroup || !direction) {
        console.error('[Notification] Dados de notificação incompletos:', req.body);
        return res.status(400).send('Dados de notificação incompletos. Campos obrigatórios: childId, message, messageType, timestamp, contactOrGroup, direction.');
    }

    try {
        let conversationId;

        // 1. Tentar encontrar a conversa existente
        const getConversationParams = {
            TableName: TABLE_CONVERSATIONS,
            Key: {
                childId: childId,
                contactOrGroup: contactOrGroup
            }
        };
        const existingConversationData = await docClient.get(getConversationParams).promise();

        if (existingConversationData.Item) {
            // Conversa encontrada
            const conversation = existingConversationData.Item;
            conversationId = conversation.conversationId;
            console.log(`[Notification] Conversa existente encontrada para childId: ${childId}, contactOrGroup: ${contactOrGroup}, conversationId: ${conversationId}`);

            // Atualizar lastMessageTimestamp, lastMessageSnippet E lastMessageType
            const updateConversationParams = {
                TableName: TABLE_CONVERSATIONS,
                Key: {
                    childId: childId,
                    contactOrGroup: contactOrGroup
                },
                UpdateExpression: 'SET lastMessageTimestamp = :ts, lastMessageSnippet = :snippet, lastMessageType = :msgType', // NOVO: lastMessageType
                ExpressionAttributeValues: {
                    ':ts': timestamp,
                    ':snippet': message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                    ':msgType': messageType // NOVO: Valor do messageType
                }
            };
            await docClient.update(updateConversationParams).promise();
            console.log(`[Notification] Conversa atualizada: ${conversationId}`);

        } else {
            // Nenhuma conversa encontrada, criar uma nova
            conversationId = uuidv4();
            const newConversationParams = {
                TableName: TABLE_CONVERSATIONS,
                Item: {
                    id: uuidv4(),
                    conversationId: conversationId, 
                    childId: childId,
                    contactOrGroup: contactOrGroup,
                    lastMessageTimestamp: timestamp,
                    lastMessageSnippet: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                    lastMessageType: messageType, // NOVO: lastMessageType para novas conversas
                    createdAt: Date.now()
                }
            };
            await docClient.put(newConversationParams).promise();
            console.log(`[Notification] Nova conversa criada: ${conversationId} para childId: ${childId}, contactOrGroup: ${contactOrGroup}`);
        }

        // 2. Salvar a mensagem individual na tabela de mensagens (já está correto aqui)
        const messageItem = {
            id: uuidv4(),
            messageId: uuidv4(), 
            conversationId: conversationId, 
            childId: childId, 
            contactOrGroup: contactOrGroup, 
            messageText: message,
            timestamp: timestamp,
            direction: direction,
            messageType: messageType, 
            phoneNumber: phoneNumber || 'unknown_number' 
        };

        const putMessageParams = {
            TableName: TABLE_MESSAGES,
            Item: messageItem
        };
        await docClient.put(putMessageParams).promise();
        console.log(`[Notification] Mensagem salva em ${TABLE_MESSAGES}: ${messageItem.messageId} para conversa: ${conversationId}`);

        res.status(200).send('Notificação recebida e processada.');

    } catch (error) {
        console.error('[Notification] Erro ao processar notificação:', error);
        // CORREÇÃO: Enviar um status de erro válido e a mensagem de erro
        res.status(500).send(`Erro interno do servidor ao processar notificação: ${error.message}`);
    }
});


// Rotas para buscar dados (com nomes de tabela corrigidos)
app.get('/get-registered-children', async (req, res) => {
    try {
        const params = { TableName: TABLE_CHILDREN };
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela '${TABLE_CHILDREN}'. Encontrados ${data.Items.length} filhos.`);
        const childrenWithStatus = data.Items.map(child => ({
            ...child,
            connected: childToWebSocket.has(child.childId) // Verifica se está conectado via WebSocket
        }));
        res.status(200).json(childrenWithStatus);
    } catch (error) {
        console.error('Erro ao buscar filhos no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor ao buscar filhos.');
    }
});

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
            return res.status(200).json([]);
        }

        const conversationsPromises = childIds.map(async (childId) => {
            const getConversationsForChildParams = {
                TableName: TABLE_CONVERSATIONS,
                KeyConditionExpression: 'childId = :childId',
                ExpressionAttributeValues: { ':childId': childId }
            };
            const data = await docClient.query(getConversationsForChildParams).promise();
            // Adicionando o messageType da última mensagem aqui
            return data.Items.map(conv => ({
                ...conv,
                childName: childrenData.Items.find(c => c.childId === childId)?.childName || 'Desconhecido',
                // *** NOVO CAMPO: lastMessageType da última mensagem ***
                lastMessageType: conv.lastMessageType || 'text' // Adiciona o tipo da última mensagem, padrão 'text'
            }));
        });

        const allConversations = (await Promise.all(conversationsPromises)).flat();
        res.status(200).json(allConversations);

    } catch (error) {
        console.error('Erro ao obter conversas:', error);
        res.status(500).send('Erro ao obter conversas.');
    }
});


app.get('/messages/:childId/:contactOrGroup', async (req, res) => {
    const { childId, contactOrGroup } = req.params;
    const params = {
        TableName: TABLE_MESSAGES,
        FilterExpression: 'childId = :childId AND contactOrGroup = :contactOrGroup',
        ExpressionAttributeValues: {
            ':childId': childId,
            ':contactOrGroup': contactOrGroup
        },
        ScanIndexForward: true, 
    };
    try {
        const data = await docClient.scan(params).promise(); 
        data.Items.sort((a, b) => a.timestamp - b.timestamp);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao obter mensagens:', error);
        res.status(500).send('Erro ao obter mensagens.');
    }
});


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
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao obter localizações:', error);
        res.status(500).send('Erro ao obter localizações.');
    }
});

app.get('/twilio-token', (req, res) => {
    console.log("Requisição para Twilio token recebida. Retornando placeholder.");
    res.status(200).json({ token: 'seu_token_do_twilio_aqui' });
});

app.use((req, res, next) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).send('Rota não encontrada.');
});

app.use((err, req, res, next) => {
    console.error('Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});


// --- LÓGICA DE WEBSOCKETS ---

// Função auxiliar para enviar comandos com retentativa
function sendCommandWithRetry(childId, commandMessage, targetMap, mapNameForLog, maxRetries = 3, initialDelay = 1000, currentRetry = 0) {
    const targetWs = targetMap.get(childId);
    
    console.log(`[Command-Retry-DEBUG] Tentativa ${currentRetry + 1}: Buscando childId=${childId} no mapa ${mapNameForLog}. Mapa contém: ${Array.from(targetMap.keys()).join(', ')}`);

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(commandMessage));
        console.log(`[Command-Retry] Comando '${commandMessage.type}' enviado com sucesso para filho ${childId} via ${mapNameForLog} WS.`);
    } else {
        console.warn(`[Command-Retry] Filho ${childId} não conectado no mapa ${mapNameForLog} WS (tentativa ${currentRetry + 1}/${maxRetries}).`);
        if (currentRetry < maxRetries) {
            const delay = initialDelay * Math.pow(2, currentRetry);
            console.log(`[Command-Retry] Re-tentando comando '${commandMessage.type}' para filho ${childId} em ${delay}ms.`);
            setTimeout(() => {
                sendCommandWithRetry(childId, commandMessage, targetMap, mapNameForLog, maxRetries, initialDelay, currentRetry + 1);
            }, delay);
        } else {
            console.error(`[Command-Retry] Falha ao enviar comando '${commandMessage.type}' para filho ${childId} após ${maxRetries} tentativas no mapa ${mapNameForLog} WS.`);
            const parentWs = parentToWebSocket.get(commandMessage.parentId); 
            if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                parentWs.send(JSON.stringify({
                    type: 'commandFailed',
                    childId: childId,
                    command: commandMessage.type,
                    message: `Falha ao enviar comando '${commandMessage.type}'. Filho offline ou inacessível.`,
                    timestamp: new Date().toISOString()
                }));
            }
        }
    }
}


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
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }

            console.log('[WebSocket-General] Mensagem JSON recebida:', finalParsedMessage);

            const { type, parentId, childId, childName, latitude, longitude, timestamp, message: chatMessageContent, data } = finalParsedMessage;
            
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
                console.log(`[WS-General] Conteúdo de 'data' processado:`, data);
            }
            
            console.log(`[WS-General] Desestruturado - type: ${type}, parentId: ${effectiveParentId}, childId (effective): ${effectiveChildId}, childName (effective): ${effectiveChildName}`);

            switch (type) {
                case 'parentConnect':
                    ws.currentParentId = effectiveParentId;
                    ws.clientType = 'parent';

                    console.log(`[WS-GENERAL-CONN] parentConnect recebido (ID: ${ws.id}). Definido: clientType=${ws.clientType}, currentParentId=${ws.currentParentId}`);

                    if (ws.currentParentId) {
                         if (parentToWebSocket.has(ws.currentParentId)) {
                             const oldWs = parentToWebSocket.get(ws.currentParentId);
                             console.log(`[WS-GENERAL-CONN] Removendo conexão pai antiga para ${ws.currentParentId} (Temp ID: ${oldWs ? oldWs.id : 'N/A'}).`);
                             oldWs.close(1000, 'Nova conexão estabelecida'); 
                             parentToWebSocket.delete(ws.currentParentId);
                             activeConnections.delete(oldWs.id); 
                         }
                         parentToWebSocket.set(ws.currentParentId, ws);
                         if (activeConnections.has(ws.id) && ws.id !== ws.currentParentId) {
                             activeConnections.delete(ws.id);
                             activeConnections.set(ws.currentParentId, { ws: ws, type: ws.clientType, id: ws.currentParentId });
                             ws.id = ws.currentParentId; 
                         } else if (!activeConnections.has(ws.currentParentId)) {
                             activeConnections.set(ws.currentParentId, { ws: ws, type: ws.clientType, id: ws.currentParentId });
                             ws.id = ws.currentParentId; 
                         }
                         
                         console.log(`[WebSocket-Manager] Conexão parent ${ws.currentParentId} atualizada. Total de entradas ativas: ${activeConnections.size}. Pais conectados: ${Array.from(parentToWebSocket.keys()).join(', ')}`);
                         ws.send(JSON.stringify({ type: 'parentConnectedSuccess', parentId: ws.currentParentId }));
                    } else {
                         console.warn('[WebSocket-General] parentConnect sem parentId.');
                    }
                    break;
                case 'childConnect':
                    if (effectiveChildId && effectiveParentId) {
                        ws.clientType = 'child';
                        ws.currentChildId = effectiveChildId;
                        ws.currentParentId = effectiveParentId;
                        ws.currentChildName = effectiveChildName || 'Desconhecido';
                        
                        console.log(`[WS-GENERAL-CONN] childConnect recebido (ID: ${ws.id}). Definido: clientType=${ws.clientType}, currentChildId=${ws.currentChildId}, currentParentId=${ws.currentParentId}`);

                        if (childToWebSocket.has(ws.currentChildId)) {
                            const oldWs = childToWebSocket.get(ws.currentChildId);
                            console.log(`[WS-GENERAL-CONN] Removendo conexão filho antiga para ${ws.currentChildId} (Temp ID: ${oldWs ? oldWs.id : 'N/A'}).`);
                            oldWs.close(1000, 'Nova conexão estabelecida'); 
                            childToWebSocket.delete(ws.currentChildId);
                            activeConnections.delete(oldWs.id); 
                        }
                        childToWebSocket.set(ws.currentChildId, ws);

                        if (activeConnections.has(ws.id) && ws.id !== ws.currentChildId) {
                            activeConnections.delete(ws.id);
                            activeConnections.set(ws.currentChildId, { ws: ws, type: ws.clientType, id: ws.currentChildId, parentId: ws.currentParentId, name: ws.currentChildName });
                            ws.id = ws.currentChildId; 
                        } else if (!activeConnections.has(ws.currentChildId)) {
                            activeConnections.set(effectiveChildId, { ws: ws, type: ws.clientType, id: ws.currentChildId, parentId: ws.currentParentId, name: ws.currentChildName }); 
                            ws.id = effectiveChildId; 
                        }

                        // AGORA A FUNÇÃO updateChildConnectionStatus ESTÁ DEFINIDA!
                        await updateChildConnectionStatus(ws.currentChildId, true);
                        console.log(`[DynamoDB] Filho ${ws.currentChildName} (${ws.currentChildId}) status de conexão atualizado para 'true'.`);
                        console.log(`[WebSocket-Manager] Filho conectado e identificado: ID: ${ws.currentChildId}. Total de entradas ativas: ${activeConnections.size}. Filhos conectados (General WS): ${Array.from(childToWebSocket.keys()).join(', ')}`);
                        
                        const parentWs = parentToWebSocket.get(ws.currentParentId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({
                                type: 'childStatus',
                                childId: ws.currentChildId,
                                status: 'online',
                                childName: ws.currentChildName
                            }));
                            console.log(`[WebSocket-General] Notificação de status 'online' enviada para o pai ${ws.currentParentId} para o filho ${ws.currentChildId}.`);
                        }
                    } else {
                        console.warn('[WebSocket-General] Mensagem childConnect inválida: childId ou parentId faltando.', finalParsedMessage);
                    }
                    break;
                case 'locationUpdate': 
                    const locChildId = ws.currentChildId;
                    const locParentId = ws.currentParentId;

                    if (!locChildId || effectiveLatitude === undefined || effectiveLatitude === null || effectiveLongitude === undefined || effectiveLongitude === null) {
                        console.warn('[WebSocket-General] Mensagem de localização recebida de cliente não identificado ou dados incompletos.');
                        return;
                    }
                    console.log(`[Location] Localização recebida do filho ${locChildId}: Lat ${effectiveLatitude}, Lng ${effectiveLongitude}`);

                    const locationParams = {
                        TableName: TABLE_LOCATIONS,
                        Item: {
                            id: uuidv4(), // ADICIONADO: Campo 'id' para a tabela GPSintegracao
                            locationId: uuidv4(), // Mantido, se for um campo adicional
                            childId: locChildId,
                            latitude: effectiveLatitude,
                            longitude: effectiveLongitude,
                            timestamp: effectiveTimestamp || new Date().toISOString()
                        }
                    };
                    await docClient.put(locationParams).promise();

                    const connectedParentWsLocation = parentToWebSocket.get(locParentId);
                    if (connectedParentWsLocation && connectedParentWsLocation.readyState === WebSocket.OPEN) {
                        connectedParentWsLocation.send(JSON.stringify({
                            type: 'locationUpdate',
                            childId: locChildId,
                            latitude: effectiveLatitude,
                            longitude: effectiveLongitude,
                            timestamp: effectiveTimestamp || new Date().toISOString()
                        }));
                        console.log(`[Location] Localização do filho ${locChildId} encaminhada para o pai ${locParentId}.`);
                    } else {
                        console.warn(`[Location] Pai ${locParentId} não encontrado ou offline para receber dados de localização de ${locChildId}.`);
                    }
                    break;
                case 'chatMessage': 
                    const senderId = ws.currentChildId || ws.currentParentId; 
                    const receiverIdFromPayload = effectiveChildId || effectiveParentId; 

                    const targetWsReceiver = childToWebSocket.get(receiverIdFromPayload) || parentToWebSocket.get(receiverIdFromPayload);
                    const actualReceiverId = targetWsReceiver ? targetWsReceiver.id : receiverIdFromPayload; 

                    const senderName = ws.clientType === 'child' ? ws.currentChildName : 'Pai';

                    if (!senderId || !receiverIdFromPayload || !chatMessageContent) {
                        console.warn('[WebSocket-General] Mensagem de chat inválida: IDs ou mensagem ausentes.');
                        return;
                    }
                    console.log(`[Chat] Mensagem de ${senderName} (${senderId}) para ${receiverIdFromPayload}: ${chatMessageContent}`);

                    const messageParams = {
                        TableName: TABLE_MESSAGES,
                        Item: {
                            id: uuidv4(), // ADICIONADO: Campo 'id' para a tabela Messages
                            messageId: uuidv4(), 
                            senderId: senderId,
                            receiverId: receiverIdFromPayload,
                            messageText: chatMessageContent,
                            timestamp: new Date().toISOString(),
                            messageType: 'APP_CHAT_MESSAGE'
                        }
                    };
                    await docClient.put(messageParams).promise();
                    console.log(`[DynamoDB] Mensagem de chat interna salva de ${senderId} para ${receiverIdFromPayload}.`);


                    if (targetWsReceiver && targetWsReceiver.readyState === WebSocket.OPEN) {
                        targetWsReceiver.send(JSON.stringify({
                            type: 'chatMessage',
                            senderId: senderId,
                            receiverId: receiverIdFromPayload,
                            message: chatMessageContent,
                            timestamp: new Date().toISOString(),
                            senderName: senderName
                        }));
                        console.log(`[Chat] Mensagem encaminhada para ${receiverIdFromPayload}.`);
                    } else {
                        console.warn(`[Chat] Receptor ${receiverIdFromPayload} não encontrado ou offline.`);
                    }
                    break;
                case 'requestLocation': 
                    const reqLocChildId = effectiveChildId; 
                    if (ws.clientType !== 'parent' || !reqLocChildId) { 
                        console.warn(`[WebSocket-General] Requisição de localização inválida: clientType='${ws.clientType}' (esperado 'parent') ou childId='${reqLocChildId}' ausente.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }
                    sendCommandWithRetry(reqLocChildId, { type: 'startLocationUpdates', parentId: effectiveParentId }, childToWebSocket, 'General');
                    ws.send(JSON.stringify({ type: 'info', message: `Solicitando localização para ${reqLocChildId}.` }));
                    break;

                case 'stopLocationUpdates': 
                    const stopLocChildId = effectiveChildId; 
                    
                    if (ws.clientType !== 'parent' || !stopLocChildId) { 
                        console.warn(`[WebSocket-General] Requisição de parada de localização inválida: clientType='${ws.clientType}' (esperado 'parent') ou childId='${stopLocChildId}' ausente.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de parada de localização inválida.' }));
                        return;
                    }
                    sendCommandWithRetry(stopLocChildId, { type: 'stopLocationUpdates', parentId: effectiveParentId }, childToWebSocket, 'General');
                    ws.send(JSON.stringify({
                        type: 'locationCommandStatus',
                        status: 'sent',
                        childId: stopLocChildId,
                        message: `Comando 'stopLocationUpdates' enviado para ${stopLocChildId}.`
                    }));
                    break;
                case 'startAudioStream': 
                    console.log(`[WS-General] Comando 'startAudioStream' recebido do pai para filho: ${effectiveChildId}.`);
                    const targetChildIdAudioCommand = effectiveChildId;
                    const parentIdForAudio = effectiveParentId;

                    parentListeningToChild.set(parentIdForAudio, targetChildIdAudioCommand);
                    console.log(`[WS-General] Pai ${parentIdForAudio} AGORA está ouvindo o filho ${targetChildIdAudioCommand}.`);


                    sendCommandWithRetry(targetChildIdAudioCommand, { type: 'startRecording', parentId: parentIdForAudio }, activeAudioControlClients, 'AudioControl', 5, 500, 0); 
                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'activating',
                        childId: targetChildIdAudioCommand,
                        message: `Ativando canal de áudio para ${targetChildIdAudioCommand}.`
                    }));
                    break;

                case 'stopAudioStream': 
                    console.log(`[WS-General] Comando 'stopAudioStream' recebido do pai para filho: ${effectiveChildId}.`);
                    const targetChildIdStopAudio = effectiveChildId;
                    const parentIdForStopAudio = effectiveParentId;

                    sendCommandWithRetry(targetChildIdStopAudio, { type: 'stopAudioStreamFromServer', parentId: parentIdForStopAudio }, activeAudioControlClients, 'AudioControl', 5, 500, 0); 

                    parentListeningToChild.delete(parentIdForStopAudio);
                    console.log(`[WS-General] Pai ${parentIdForStopAudio} desconectado. Registro de escuta limpo.`);

                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'stopped',
                        childId: targetChildIdStopAudio,
                        message: `Comando 'stopAudioStreamFromServer' enviado para ${targetChildIdStopAudio}.`
                    }));
                    break;
                default:
                    console.warn('[WebSocket-General] Tipo de mensagem desconhecido:', type);
            }
        } catch (error) {
            console.error('[WebSocket-General] Erro crítico ao processar mensagem:', error.message);
            const rawMessageDebug = (Buffer.isBuffer(message) ? message.toString('utf8') : message);
            console.error('[WebSocket-General] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WS-GENERAL-CLOSE] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        console.log(`[WS-GENERAL-CLOSE-DEBUG] Fechando WS. childToWebSocket antes: ${Array.from(childToWebSocket.keys()).join(', ')}. parentToWebSocket antes: ${Array.from(parentToWebSocket.keys()).join(', ')}. Active Connections antes: ${Array.from(activeConnections.keys()).join(', ')}`);
        
        const disconnectedId = ws.id; 
        
        activeConnections.delete(disconnectedId);

        if (ws.clientType === 'child' && ws.currentChildId) {
            if (childToWebSocket.has(ws.currentChildId) && childToWebSocket.get(ws.currentChildId) === ws) {
                childToWebSocket.delete(ws.currentChildId);
                console.log(`[WS-GENERAL-CLOSE] Filho ${ws.currentChildId} removido do childToWebSocket.`);
            } else {
                console.warn(`[WS-GENERAL-CLOSE] Filho ${ws.currentChildId} não encontrado ou já substituído no childToWebSocket.`);
            }
            try {
                await updateChildConnectionStatus(ws.currentChildId, false); 
            } catch (error) {
                console.error('Erro ao atualizar status de conexão do filho no DynamoDB:', error);
            }
            for (let [parentId, listeningChildId] of parentListeningToChild.entries()) {
                if (listeningChildId === ws.currentChildId) {
                    parentListeningToChild.delete(parentId);
                    console.log(`[WS-GENERAL-CLOSE] Pai ${parentId} parou de ouvir o filho ${ws.currentChildId} (desconectado).`);
                }
            }
        } else if (ws.clientType === 'parent' && ws.currentParentId) {
            if (parentToWebSocket.has(ws.currentParentId) && parentToWebSocket.get(ws.currentParentId) === ws) {
                parentToWebSocket.delete(ws.currentParentId);
                console.log(`[WS-GENERAL-CLOSE] Pai ${ws.currentParentId} removido do parentToWebSocket.`);
            } else {
                console.warn(`[WS-GENERAL-CLOSE] Pai ${ws.currentParentId} não encontrado ou já substituído no parentToWebSocket.`);
            }
             console.log(`[WebSocket-General] Pai ${ws.currentParentId} desconectado.`);
            parentListeningToChild.delete(ws.currentParentId);
            console.log(`[WS-GENERAL-CLOSE] Pai ${ws.currentParentId} desconectado. Registro de escuta limpo.`);
        } else {
             console.warn(`[WS-GENERAL-CLOSE] Cliente desconectado de tipo desconhecido ou sem ID principal (ID: ${disconnectedId}).`);
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas (após remoção): ${activeConnections.size}. Filhos conectados (General WS): ${Array.from(childToWebSocket.keys()).join(', ')}. Pais conectados: ${Array.from(parentToWebSocket.keys()).join(', ')}`);
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

    console.log(`[WS-AUDIO-CONTROL-CONN] Nova conexão WS de controle de áudio (Temp ID: ${ws.id}). Estado inicial: clientType=${ws.clientType}`);
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
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
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
                    console.log(`[WS-AUDIO-CONTROL-CONN] Recebido childConnectAudioControl do filho ${effectiveChildId}. Conexão Temp ID: ${ws.id}.`);

                    ws.clientType = 'child-audio-control';
                    ws.currentChildId = effectiveChildId;
                    ws.currentParentId = effectiveParentId;
                    
                    if (activeAudioControlClients.has(effectiveChildId)) {
                        const oldWs = activeAudioControlClients.get(effectiveChildId);
                        console.log(`[WS-AUDIO-CONTROL-CONN] Removendo conexão de controle de áudio antiga para ${effectiveChildId} (Temp ID: ${oldWs ? oldWs.id : 'N/A'}).`);
                        oldWs.close(1000, 'Nova conexão estabelecida'); 
                        activeAudioControlClients.delete(effectiveChildId);
                        activeConnections.delete(oldWs.id); 
                    }

                    activeAudioControlClients.set(effectiveChildId, ws); 
                    if (activeConnections.has(ws.id) && ws.id !== effectiveChildId) {
                        activeConnections.delete(ws.id);
                        activeConnections.set(effectiveChildId, { ws: ws, type: ws.clientType, id: effectiveChildId });
                        ws.id = effectiveChildId; 
                    } else if (!activeConnections.has(effectiveChildId)) {
                        activeConnections.set(effectiveChildId, { ws: ws, type: ws.clientType, id: effectiveChildId });
                        ws.id = effectiveChildId; 
                    }

                    console.log(`[WS-AUDIO-CONTROL-CONN] Filho ${effectiveChildId} ADICIONADO ao activeAudioControlClients. Mapa agora contém: ${Array.from(activeAudioControlClients.keys()).join(', ')}. Tamanho do mapa: ${activeAudioControlClients.size}.`);

                    if (pendingAudioRequests.has(effectiveChildId)) {
                        ws.send(JSON.stringify({ type: 'startRecording' }));
                        console.log(`[Audio-Command-Server] Comando 'startRecording' ENVIADO para filho ${effectiveChildId} (requisição pendente).`);
                        pendingAudioRequests.delete(effectiveChildId);
                    }
                    break;
                case 'ping': 
                    ws.send(JSON.stringify({ type: 'pong' }));
                    console.log(`[WS-AudioControl] Pong enviado em resposta ao ping do ID ${ws.id}.`);
                    break;
                case 'pong': 
                    console.log(`[WS-AudioControl] Pong recebido do cliente ${ws.id}.`);
                    break;
                case 'startRecording': 
                case 'stopAudioStreamFromServer': 
                    console.warn(`[WebSocket-AudioControl] Mensagem de tipo ${type} recebida de CLIENTE inesperado. Este tipo de mensagem é para SERVER->CHILD.`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem inesperado neste canal.' }));
                    break;
                case 'audioData':
                    console.warn(`[WS-AudioControl] Mensagem 'audioData' recebida inesperadamente no canal de controle de áudio. Deve ir para /ws-audio-data.`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Mensagem de dados de áudio recebida no canal de controle.' }));
                    break;
                default:
                    console.warn('[WebSocket-AudioControl] Tipo de mensagem desconhecido:', type);
                    ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem desconhecido.' }));
            }
        } catch (error) {
            console.error('[WebSocket-AudioControl] Erro crítico ao processar mensagem:', error.message);
            const rawMessageDebug = (Buffer.isBuffer(message) ? message.toString('utf8') : message);
            console.error('[WebSocket-AudioControl] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-AUDIO-CONTROL-CLOSE] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        console.log(`[WS-AUDIO-CONTROL-CLOSE-DEBUG] Fechando WS. activeAudioControlClients antes: ${Array.from(activeAudioControlClients.keys()).join(', ')}. Active Connections antes: ${Array.from(activeConnections.keys()).join(', ')}`);

        activeConnections.delete(ws.id); 

        if (ws.clientType === 'child-audio-control' && ws.currentChildId) {
            if (activeAudioControlClients.has(ws.currentChildId) && activeAudioControlClients.get(ws.currentChildId) === ws) {
                activeAudioControlClients.delete(ws.currentChildId);
                console.log(`[WS-AUDIO-CONTROL-CLOSE] Cliente de controle de áudio do filho ${ws.currentChildId} removido.`);
            } else {
                console.warn(`[WS-AUDIO-CONTROL-CLOSE] Cliente de controle de áudio do filho ${ws.currentChildId} não encontrado ou já substituído.`);
            }
        }
        console.log(`[WS-AUDIO-CONTROL-CLOSE] Total de conexões de controle de áudio: ${activeAudioControlClients.size}. Total de entradas ativas (após remoção): ${activeConnections.size}.`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-AudioControl] Erro no cliente WebSocket:', error);
    });
});


// --- INICIO DO SERVIDOR ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`Endpoint de upload de áudio: http://localhost:${PORT}/upload-audio`);
    console.log(`Endpoint de upload de mídia (geral): http://localhost:${PORT}/upload-media`);
    console.log(`Endpoint de registro de filho: http://localhost:${PORT}/register-child`);
    console.log(`Endpoint de notificação (WhatsApp): http://localhost:${PORT}/send-notification`);
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
