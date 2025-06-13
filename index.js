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
// Mapa para armazenar todas as conexões WebSocket ativas (temporárias ou por ID)
const wsConnections = new Map();
// Mapeia childId para a instância WebSocket do filho no canal de COMANDOS GERAIS
const childToWebSocket = new Map();
// Mapeia parentId para a instância WebSocket do pai no canal de COMANDOS GERAIS
const parentToWebSocket = new Map();
// Mapeia childId para a instância WebSocket do filho no canal de DADOS DE ÁUDIO (Filho -> Servidor)
const activeAudioDataClients = new Map();
// Mapeia childId para a instância WebSocket do filho no canal de CONTROLE DE ÁUDIO (Servidor -> Filho)
const activeAudioControlClients = new Map();

// Mapa para manter todas as conexões ativas com seus IDs (temporários ou reais)
const activeConnections = new Map();

const app = express();
const PORT = process.env.PORT || 10000;

const upload = multer();

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
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const DYNAMODB_TABLE_CHILDREN = 'Children';

// Middlewares Express
app.use(cors());
app.use(bodyParser.json());

// --- ROTAS HTTP ---
app.get('/', (req, res) => {
    res.send('Servidor Parental Monitor Online!');
});

app.post('/register-child', async (req, res) => {
    const { childId, parentId, childName } = req.body;
    if (!childId || !parentId || !childName) {
        return res.status(400).send('childId, parentId e childName são obrigatórios.');
    }
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId,
            parentId: parentId,
            childName: childName,
            connected: false,
            lastActivity: new Date().toISOString()
        }
    };
    try {
        await docClient.put(params).promise();
        console.log(`Filho ${childName} (ID: ${childId}) registrado com sucesso para o pai ${parentId}.`);
        res.status(200).send('Filho registrado com sucesso!');
    } catch (error) {
        console.error('Erro ao registrar filho:', error);
        res.status(500).send('Erro ao registrar filho.');
    }
});

app.get('/get-registered-children', async (req, res) => {
    try {
        const params = { TableName: DYNAMODB_TABLE_CHILDREN };
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela 'Children'. Encontrados ${data.Items.length} filhos.`);
        const childrenWithStatus = data.Items.map(child => ({
            ...child,
            // Verifica conexão no canal de comandos gerais
            connected: childToWebSocket.has(child.childId)
        }));
        res.status(200).json(childrenWithStatus);
    } catch (error) {
        console.error('Erro ao buscar filhos no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor ao buscar filhos.');
    }
});

app.get('/conversations/:parentId', async (req, res) => {
    const { parentId } = req.params;
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        FilterExpression: 'parentId = :parentId',
        ExpressionAttributeValues: { ':parentId': parentId }
    };
    try {
        const data = await docClient.scan(params).promise();
        const conversations = data.Items.map(item => ({
            childId: item.childId,
            childName: item.childName,
            lastActivity: item.lastActivity,
            connected: childToWebSocket.has(item.childId),
            parentId: item.parentId
        }));
        res.status(200).json(conversations);
        console.log(`[HTTP] Conversas para o pai ${parentId} retornadas.`);
    } catch (error) {
        console.error('Erro ao obter conversas:', error);
        res.status(500).send('Erro ao obter conversas.');
    }
});

app.get('/messages/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        KeyConditionExpression: 'conversationId = :conversationId',
        ExpressionAttributeValues: { ':conversationId': conversationId },
        ScanIndexForward: true,
    };
    try {
        const data = await docClient.query(params).promise();
        res.status(200).json(data.Items);
        console.log(`[HTTP] Mensagens para a conversa ${conversationId} retornadas.`);
    } catch (error) {
        console.error('Erro ao obter mensagens:', error);
        res.status(500).send('Erro ao obter mensagens.');
    }
});

app.get('/locations/:childId', async (req, res) => {
    const { childId } = req.params;
    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        KeyConditionExpression: 'childId = :childId',
        ExpressionAttributeValues: { ':childId': childId },
        ScanIndexForward: true,
        Limit: 100
    };
    try {
        const data = await docClient.query(params).promise();
        res.status(200).json(data.Items);
        console.log(`[HTTP] Localizações para o filho ${childId} retornadas.`);
    } catch (error) {
        console.error('Erro ao obter localizações:', error);
        res.status(500).send('Erro ao obter localizações.');
    }
});

app.post('/send-notification', async (req, res) => {
    const { recipientChildId, title, body } = req.body;
    if (!recipientChildId || !title || !body) {
        return res.status(400).send('Dados incompletos para enviar notificação.');
    }
    try {
        const params = { TableName: DYNAMODB_TABLE_CHILDREN, Key: { childId: recipientChildId } };
        const data = await docClient.get(params).promise();
        const child = data.Item;
        if (!child || !child.childToken) {
            return res.status(404).send('Filho não encontrado ou sem token FCM registrado.');
        }
        const fcmToken = child.childToken;
        console.log(`[FCM] Simulação: Notificação '${title}' para ${fcmToken} (${recipientChildId})`);
        res.status(200).send('Notificação processada (requer integração Firebase Admin).');
    } catch (error) {
        console.error('Erro ao enviar notificação:', error);
        res.status(500).send('Erro interno do servidor ao enviar notificação.');
    }
});

app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo enviado.');
    }
    const { childId, type } = req.body;
    if (!childId || !type) {
        return res.status(400).send('childId ou type não fornecidos.');
    }
    const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';
    const key = `${childId}/${type}/${uuidv4()}-${req.file.originalname}`;
    const params = {
        Bucket: bucketName, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype, ACL: 'private'
    };
    try {
        const data = await s3.upload(params).promise();
        console.log(`[S3] Mídia ${key} (${type}) do filho ${childId} carregada com sucesso.`, data.Location);
        res.status(200).json({ url: data.Location, key: data.Key });
    } catch (error) {
        console.error('Erro ao fazer upload para S3:', error);
        res.status(500).send('Erro no upload do arquivo.');
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

// --- WEBSOCKET SERVERS ---
const server = http.createServer(app);
// Canal para comandos gerais, GPS, Chat, Status de Conexão
const wssGeneralCommands = new WebSocket.Server({ noServer: true });
// Canal para dados de áudio (Filho -> Servidor)
const wssAudioData = new WebSocket.Server({ noServer: true });
// Canal para controle de áudio (Servidor -> Filho)
const wssAudioControl = new WebSocket.Server({ noServer: true });

// Função para atualizar o status de conexão no DynamoDB
async function updateChildConnectionStatus(childId, connected) {
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Key: { childId: childId },
        UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
        ExpressionAttributeValues: {
            ':connected': connected,
            ':lastActivity': new Date().toISOString()
        }
    };
    try {
        await docClient.update(params).promise();
        console.log(`[DynamoDB-Helper] Status de conexão para ${childId} atualizado para ${connected}.`);
    } catch (error) {
        console.error(`[DynamoDB-Helper] Erro ao atualizar status de conexão para ${childId}:`, error);
    }
}

// Lidar com upgrade de HTTP para WebSocket
server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    console.log(`[HTTP-Upgrade] Tentativa de upgrade para pathname: ${pathname}`);

    if (pathname === '/ws-general-commands') { // Canal para comandos gerais
        wssGeneralCommands.handleUpgrade(request, socket, head, ws => {
            wssGeneralCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio-data') { // Canal para dados de áudio (Filho -> Servidor)
        wssAudioData.handleUpgrade(request, socket, head, ws => {
            wssAudioData.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio-control') { // Canal para controle de áudio (Servidor -> Filho)
        wssAudioControl.handleUpgrade(request, socket, head, ws => {
            wssAudioControl.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// --- LÓGICA DE WEBSOCKETS ---

// WebSocket de Comandos GERAIS (/ws-general-commands)
wssGeneralCommands.on('connection', ws => {
    ws.id = uuidv4();
    ws.clientType = 'unknown'; // Estado inicial
    ws.currentParentId = null;
    ws.currentChildId = null;
    ws.currentChildName = null;

    console.log(`[WS-GENERAL-CONN] Nova conexão WS: ID=${ws.id}, Estado inicial: clientType=${ws.clientType}, currentParentId=${ws.currentParentId}`);

    activeConnections.set(ws.id, { ws: ws, type: ws.clientType, id: ws.id });
    console.log(`[WebSocket-General] Novo cliente conectado (temp ID: ${ws.id}). Total de entradas: ${activeConnections.size}`);

    ws.on('message', async message => {
        let finalParsedMessage = null;
        try {
            let messageString = (Buffer.isBuffer(message) ? message.toString('utf8') : message).trim();

            // Lógica para lidar com JSON duplamente stringificado
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

            // Para mensagens onde childId/parentId/data podem vir aninhados em 'data' ou na raiz
            if (data && typeof data === 'object') {
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

                    console.log(`[WS-GENERAL-CONN] parentConnect recebido para ID=${ws.id}. Definido: clientType=${ws.clientType}, currentParentId=${ws.currentParentId}`);

                    if (ws.currentParentId) {
                         activeConnections.set(ws.currentParentId, { ws: ws, type: ws.clientType, id: ws.currentParentId });
                         if (ws.id !== ws.currentParentId) {
                            activeConnections.delete(ws.id);
                            ws.id = ws.currentParentId;
                         }
                         parentToWebSocket.set(ws.currentParentId, ws);
                         console.log(`[WebSocket-Manager] Conexão parent ${ws.currentParentId} atualizada. Total de entradas: ${activeConnections.size}`);
                         console.log(`[WebSocket-General] Pai conectado e identificado: ID: ${ws.currentParentId}, ouvindo filho: ${effectiveChildId || 'nenhum'}`);
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

                        console.log(`[WS-GENERAL-CONN] childConnect recebido para ID=${ws.id}. Definido: clientType=${ws.clientType}, currentChildId=${ws.currentChildId}, currentParentId=${ws.currentParentId}`);

                        activeConnections.set(ws.currentChildId, { ws: ws, type: ws.clientType, id: ws.currentChildId, parentId: ws.currentParentId, name: ws.currentChildName });
                        if (ws.id !== ws.currentChildId) {
                            activeConnections.delete(ws.id);
                            ws.id = ws.currentChildId;
                        }
                        childToWebSocket.set(ws.currentChildId, ws);

                        await docClient.update({
                            TableName: DYNAMODB_TABLE_CHILDREN,
                            Key: { childId: ws.currentChildId },
                            UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity, parentId = :parentId, childName = :childName',
                            ExpressionAttributeValues: {
                                ':connected': true,
                                ':lastActivity': new Date().toISOString(),
                                ':parentId': ws.currentParentId,
                                ':childName': ws.currentChildName
                            }
                        }).promise();
                        console.log(`[DynamoDB] Filho ${ws.currentChildName} (${ws.currentChildId}) status de conexão atualizado para 'true'.`);
                        console.log(`[WebSocket-General] Filho conectado e identificado: ID: ${ws.currentChildId}, Parent ID: ${ws.currentParentId}, Nome: ${ws.currentChildName}. Total de entradas: ${activeConnections.size}`);

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
                    const locChildId = effectiveChildId;
                    const locParentId = effectiveParentId;

                    if (!locChildId || effectiveLatitude === undefined || effectiveLatitude === null || effectiveLongitude === undefined || effectiveLongitude === null) {
                        console.warn('[WebSocket-General] Mensagem de localização recebida de cliente não identificado ou dados incompletos.');
                        return;
                    }
                    console.log(`[Location] Localização recebida do filho ${locChildId}: Lat ${effectiveLatitude}, Lng ${effectiveLongitude}`);

                    const locationParams = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            locationId: uuidv4(),
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
                        TableName: DYNAMODB_TABLE_MESSAGES,
                        Item: {
                            conversationId: [ws.currentParentId, ws.currentChildId].filter(Boolean).sort().join('-'),
                            messageId: uuidv4(),
                            parentId: ws.currentParentId || receiverIdFromPayload,
                            childId: ws.currentChildId || receiverIdFromPayload,
                            sender: senderId,
                            message: chatMessageContent,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(messageParams).promise();
                    console.log(`[DynamoDB] Mensagem de chat salva de ${senderId} para ${receiverIdFromPayload}.`);

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
                    const targetChildIdForLocation = effectiveChildId;
                    console.log(`[WS-General-DEBUG] ANTES requestLocation check: ws.clientType=${ws.clientType}, ws.currentParentId=${ws.currentParentId}, ws.id=${ws.id}`);
                    if (ws.clientType !== 'parent' || !targetChildIdForLocation) {
                        console.warn('[WebSocket-General] Requisição de localização inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }

                    const targetChildClientWsLocation = childToWebSocket.get(targetChildIdForLocation);

                    if (targetChildClientWsLocation && targetChildClientWsLocation.readyState === WebSocket.OPEN) {
                        targetChildClientWsLocation.send(JSON.stringify({ type: 'startLocationUpdates' }));
                        console.log(`[Location-Server] Comando 'startLocationUpdates' enviado para filho ${targetChildIdForLocation} via WS de comandos gerais.`);
                        ws.send(JSON.stringify({ type: 'info', message: `Solicitando localização para ${targetChildIdForLocation}.` }));
                    } else {
                        console.warn(`[Location-Server] Filho ${targetChildIdForLocation} não encontrado ou offline para requisição de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildIdForLocation} offline para GPS.` }));
                        return;
                    }
                    break;
                case 'stopLocationUpdates':
                    const targetChildIdForStopLoc = effectiveChildId;
                    console.log(`[WS-General-DEBUG] ANTES stopLocationUpdates check: ws.clientType=${ws.clientType}, ws.currentParentId=${ws.currentParentId}, ws.id=${ws.id}`);
                    if (ws.clientType !== 'parent' || !targetChildIdForStopLoc) {
                        console.warn('[WebSocket-General] Requisição de parada de localização inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de parada de localização inválida.' }));
                        return;
                    }
                    const childWsStopLoc = childToWebSocket.get(targetChildIdForStopLoc);

                    if (childWsStopLoc && childWsStopLoc.readyState === WebSocket.OPEN) {
                        childWsStopLoc.send(JSON.stringify({ type: 'stopLocationUpdates' }));
                        console.log(`[Location-Server] Comando 'stopLocationUpdates' enviado para o filho ${targetChildIdForStopLoc} via WS de comandos gerais.`);
                        ws.send(JSON.stringify({
                            type: 'locationCommandStatus',
                            status: 'stopped',
                            childId: targetChildIdForStopLoc,
                            message: `Comando 'stopLocationUpdates' enviado para ${targetChildIdForStopLoc}.`
                        }));
                    } else {
                        console.warn(`[Location-Server] Filho ${targetChildIdForStopLoc} não encontrado ou offline para comando de parada de localização.`);
                        ws.send(JSON.stringify({
                            type: 'locationCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdForStopLoc,
                            message: `Filho ${targetChildIdForStopLoc} offline ou não conectado ao WS de comandos para parada de localização.`
                        }));
                    }
                    break;
                // audioData NÃO deve chegar aqui se o filho estiver enviando para /ws-audio-data
                case 'audioData':
                    console.warn(`[WS-General] Mensagem 'audioData' recebida inesperadamente NESTE CANAL. Isso deveria vir do /ws-audio-data.`);
                    // Deixe a mensagem ser processada aqui APENAS se o pai estiver escutando.
                    // Isso é o encaminhamento do servidor para o pai.
                    const parentWs = parentToWebSocket.get(effectiveParentId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        // Re-envia a mensagem original (já está no formato certo)
                        parentWs.send(JSON.stringify(finalParsedMessage));
                        console.log(`[WS-General-Forward] Encaminhando audioData para Pai=${effectiveParentId}.`);
                    } else {
                        console.warn(`[WS-General-Forward] Pai ${effectiveParentId} não encontrado ou offline para encaminhar audioData.`);
                    }
                    break;
                case 'startAudioStream': // Comando para iniciar áudio (pai -> servidor)
                case 'stopAudioStream': // Comando para parar áudio (pai -> servidor)
                    // Esses comandos serão enviados do pai para o servidor (via WS-General)
                    // Mas o servidor PRECISA encaminhá-los para o filho via WS-AudioControl
                    const targetChildIdAudioCommand = effectiveChildId;
                    const childAudioControlWs = activeAudioControlClients.get(targetChildIdAudioCommand);

                    if (childAudioControlWs && childAudioControlWs.readyState === WebSocket.OPEN) {
                        childAudioControlWs.send(JSON.stringify({ type: type === 'startAudioStream' ? 'startRecording' : 'stopAudioStreamFromServer' }));
                        console.log(`[Audio-Command-Server] Comando '${type}' enviado para filho ${targetChildIdAudioCommand} via WS-AudioControl.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'sent',
                            childId: targetChildIdAudioCommand,
                            message: `Comando '${type}' enviado para ${targetChildIdAudioCommand}.`
                        }));
                    } else {
                        console.warn(`[Audio-Command-Server] Filho ${targetChildIdAudioCommand} não encontrado ou offline para comando de áudio '${type}'.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdAudioCommand,
                            message: `Filho ${targetChildIdAudioCommand} offline para comando de áudio '${type}'.`
                        }));
                    }
                    break;
                default:
                    console.warn('[WebSocket-General] Tipo de mensagem desconhecido:', type);
            }
        } catch (error) {
            console.error('[WebSocket-General] Erro crítico ao processar mensagem:', error.message);
            const rawMessageDebug = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            console.error('[WebSocket-General] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WebSocket-General] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        console.log(`[WS-GENERAL-CLOSE] Cliente desconectado. Finalizando estado: ID=${ws.id}, clientType=${ws.clientType}, currentParentId=${ws.currentParentId}, currentChildId=${ws.currentChildId}`);

        const disconnectedId = ws.id;

        activeConnections.delete(disconnectedId);
        if (ws.clientType === 'child' && ws.currentChildId) {
            childToWebSocket.delete(ws.currentChildId);
        } else if (ws.clientType === 'parent' && ws.currentParentId) {
            parentToWebSocket.delete(ws.currentParentId);
        }

        if (ws.clientType === 'child' && ws.currentChildId) {
            try {
                await docClient.update({
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: ws.currentChildId },
                    UpdateExpression: 'SET connected = :connected',
                    ExpressionAttributeValues: { ':connected': false }
                }).promise();
                console.log(`[DynamoDB] Filho ${ws.currentChildId} status de conexão atualizado para 'false'.`);

                const parentWs = parentToWebSocket.get(ws.currentParentId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(JSON.stringify({
                        type: 'childStatus',
                        childId: ws.currentChildId,
                        status: 'offline'
                    }));
                    console.log(`[WebSocket-General] Notificação de status 'offline' enviada para o pai ${ws.currentParentId} para o filho ${ws.currentChildId}.`);
                }

            } catch (error) {
                console.error('Erro ao atualizar status de conexão do filho no DynamoDB:', error);
            }
        } else if (ws.clientType === 'parent' && ws.currentParentId) {
             console.log(`[WebSocket-General] Pai ${ws.currentParentId} desconectado.`);
        } else {
             console.warn(`[WebSocket-General] Cliente desconectado de tipo desconhecido ou sem ID principal (ID: ${disconnectedId}).`);
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas: ${activeConnections.size}`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-General] Erro no cliente WebSocket:', error);
    });
});

// WebSocket de Dados de Áudio (/ws-audio-data) - Filho -> Servidor
wssAudioData.on('connection', ws => {
    ws.id = uuidv4();
    ws.clientType = 'unknown'; // Estado inicial
    ws.currentParentId = null;
    ws.currentChildId = null;

    console.log(`[WS-AUDIO-DATA-CONN] Nova conexão WS de dados de áudio: ID=${ws.id}, Estado inicial: clientType=${ws.clientType}, currentParentId=${ws.currentParentId}`);
    activeConnections.set(ws.id, { ws: ws, type: ws.clientType, id: ws.id });

    ws.on('message', async message => {
        let finalParsedMessage = null;
        try {
            let messageString = (Buffer.isBuffer(message) ? message.toString('utf8') : message).trim();
            if (messageString.startsWith('"') && messageString.endsWith('"') && messageString.includes('\\"')) {
                messageString = messageString.substring(1, messageString.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
            finalParsedMessage = JSON.parse(messageString);

            if (typeof finalParsedMessage !== 'object' || finalParsedMessage === null || Array.isArray(finalParsedMessage)) {
                console.error('[WebSocket-AudioData] Mensagem parseada inválida:', finalParsedMessage);
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }

            console.log('[WebSocket-AudioData] Mensagem JSON recebida:', finalParsedMessage);

            const { type, parentId, childId, data } = finalParsedMessage;

            // Se for a mensagem de identificação do filho para este canal
            if (type === 'childConnectAudioData') {
                ws.clientType = 'child-audio-data';
                ws.currentChildId = childId;
                ws.currentParentId = parentId;
                activeAudioDataClients.set(childId, ws);
                console.log(`[WS-AUDIO-DATA-CONN-DEBUG] Recebido childConnectAudioData do filho ${childId}. Conexão ID: ${ws.id}. Filho ADICIONADO ao activeAudioDataClients. Mapa agora contém: ${Array.from(activeAudioDataClients.keys()).join(', ')}. Tamanho do mapa: ${activeAudioDataClients.size}.`);
            }
            // Se for uma mensagem de dados de áudio real
            else if (type === 'audioData') {
                const audioDataChildId = childId || ws.currentChildId;
                const audioDataParentId = parentId || ws.currentParentId;
                const audioBase64 = data; // A string Base64 é o próprio 'data'

                if (!audioDataChildId || !audioBase64 || !audioDataParentId) {
                    console.warn('[WS-AudioData] Mensagem audioData inválida: childId, parentId ou dados Base64 ausentes.');
                    return;
                }

                // Encaminhar os dados de áudio para o pai no canal GERAL
                const parentWsForAudioData = parentToWebSocket.get(audioDataParentId);
                if (parentWsForAudioData && parentWsForAudioData.readyState === WebSocket.OPEN) {
                    parentWsForAudioData.send(JSON.stringify({
                        type: 'audioData', // Mantém o tipo 'audioData' para o pai
                        childId: audioDataChildId,
                        data: audioBase64 // Envia a string Base64 diretamente
                    }));
                    console.log(`[WS-AUDIO-DATA-FORWARD] Encaminhando dados de áudio de ChildId=${audioDataChildId} para Pai=${audioDataParentId} (via WS-General). Tamanho do dado: ${audioBase64.length}.`);
                } else {
                    console.warn(`[WS-AUDIO-DATA-FORWARD] Pai ${audioDataParentId} não encontrado ou offline para receber dados de áudio de ${audioDataChildId}.`);
                }
            } else {
                console.warn(`[WebSocket-AudioData] Tipo de mensagem desconhecido ou inesperado: ${type}`);
            }
        } catch (error) {
            console.error('[WebSocket-AudioData] Erro crítico ao processar mensagem:', error.message);
            const rawMessageDebug = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            console.error('[WebSocket-AudioData] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WebSocket-AudioData] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        if (ws.clientType === 'child-audio-data' && ws.currentChildId) {
            activeAudioDataClients.delete(ws.currentChildId);
            console.log(`[WS-AUDIO-DATA-CLOSE] Cliente de dados de áudio do filho ${ws.currentChildId} removido. Tamanho do mapa activeAudioDataClients: ${activeAudioDataClients.size}.`);
        }
        activeConnections.delete(ws.id);
        console.log(`[WS-AUDIO-DATA-CLOSE] Cliente desconectado. Finalizando estado: ID=${ws.id}, clientType=${ws.clientType}, currentParentId=${ws.currentParentId}, currentChildId=${ws.currentChildId}`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-AudioData] Erro no cliente WebSocket:', error);
        if (ws.clientType === 'child-audio-data' && ws.currentChildId) {
            activeAudioDataClients.delete(ws.currentChildId);
        }
        activeConnections.delete(ws.id);
    });
});

// WebSocket para Controle de Áudio (/ws-audio-control) - Servidor -> Filho
wssAudioControl.on('connection', ws => {
    ws.id = uuidv4();
    ws.clientType = 'unknown';
    ws.currentParentId = null;
    ws.currentChildId = null;

    console.log(`[WS-AUDIO-CONTROL-CONN] Nova conexão WS de controle de áudio: ID=${ws.id}, Estado inicial: clientType=${ws.clientType}, currentParentId=${ws.currentParentId}`);
    activeConnections.set(ws.id, { ws: ws, type: ws.clientType, id: ws.id });

    ws.on('message', async message => {
        let finalParsedMessage = null;
        try {
            let messageString = (Buffer.isBuffer(message) ? message.toString('utf8') : message).trim();
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

            const { type, parentId, childId } = finalParsedMessage;

            // Se for a mensagem de identificação do filho para este canal
            if (type === 'childConnectAudioControl') {
                ws.clientType = 'child-audio-control';
                ws.currentChildId = childId;
                ws.currentParentId = parentId;
                const isChildConnected = activeAudioControlClients.has(childId);
                console.log(`[WS-AUDIO-CONTROL-CONN-DEBUG] Recebido childConnectAudioControl do filho ${childId}. Conexão ID: ${ws.id}. Estado antes de adicionar ao mapa: isChildConnected = ${isChildConnected}.`);
                activeAudioControlClients.set(childId, ws);
                console.log(`[WS-AUDIO-CONTROL-CONN-DEBUG] Filho ${childId} ADICIONADO ao activeAudioControlClients. Mapa agora contém: ${Array.from(activeAudioControlClients.keys()).join(', ')}. Tamanho do mapa: ${activeAudioControlClients.size}.`);
            } else if (type === 'ping') { // Tratar ping do cliente (para keep-alive)
                ws.send(JSON.stringify({ type: 'pong' }));
                console.log(`[WS-AudioControl] Pong enviado em resposta ao ping do ID ${ws.id}.`);
            } else {
                console.warn('[WebSocket-AudioControl] Tipo de mensagem desconhecido ou inesperado:', type);
            }
        } catch (error) {
            console.error('[WebSocket-AudioControl] Erro crítico ao processar mensagem:', error.message);
            const rawMessageDebug = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            console.error('[WebSocket-AudioControl] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WebSocket-AudioControl] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        if (ws.clientType === 'child-audio-control' && ws.currentChildId) {
            activeAudioControlClients.delete(ws.currentChildId);
            console.log(`[WS-AUDIO-CONTROL-CLOSE] Cliente de controle de áudio do filho ${ws.currentChildId} removido. Tamanho do mapa activeAudioControlClients: ${activeAudioControlClients.size}.`);
        }
        activeConnections.delete(ws.id);
        console.log(`[WS-AUDIO-CONTROL-CLOSE] Cliente desconectado. Finalizando estado: ID=${ws.id}, clientType=${ws.clientType}, currentParentId=${ws.currentParentId}, currentChildId=${ws.currentChildId}`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-AudioControl] Erro no cliente WebSocket:', error);
        if (ws.clientType === 'child-audio-control' && ws.currentChildId) {
            activeAudioControlClients.delete(ws.currentChildId);
        }
        activeConnections.delete(ws.id);
    });
});


// --- INICIO DO SERVIDOR ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos gerais (GPS, Chat, Encaminhamento de Áudio) em: ws://localhost:${PORT}/ws-general-commands`);
    console.log(`WebSocket de dados de áudio (Filho -> Servidor) em: ws://localhost:${PORT}/ws-audio-data`);
    console.log(`WebSocket de controle de áudio (Servidor -> Filho) em: ws://localhost:${PORT}/ws-audio-control`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
});
