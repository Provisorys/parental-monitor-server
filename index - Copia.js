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
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // Manter se o app filho ainda usa /upload-audio

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

// --- WEBSOCKET SERVERS E HTTP SERVER: DECLARAÇÃO ÚNICA NO TOPO ---
const server = http.createServer(app); 

const wssGeneralCommands = new WebSocket.Server({ noServer: true }); 
const wssAudioControl = new WebSocket.Server({ noServer: true }); 

// Funções auxiliares
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

// sendCommandWithRetry foi movido para dentro dos ouvintes de mensagem do WebSocket para ter acesso ao parsedMessage.parentId
// e usar a lógica de parentListeningToChild corretamente.

// sendS3UrlToParent foi substituída pela lógica direta dentro dos handlers de upload para incorporar o controle parentListeningToChild.


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

// REMOVIDO: A rota /upload-media genérica duplicada que estava abaixo.
// app.post('/upload-media', upload.single('media'), async (req, res) => { ... });

app.get('/twilio-token', (req, res) => {
    console.log("Requisição para Twilio token recebida. Retornando placeholder.");
    res.status(200).json({ token: 'seu_token_do_twilio_aqui' });
});

// --- ROTA PARA RECEBER ÁUDIO VIA HTTP POST (do app filho) ---
app.post('/upload-audio', audioUpload.single('audio'), async (req, res) => {
    try {
        const childId = req.body.childId || 'unknown_child';
        const parentIdFromChild = req.body.parentId || 'unknown_parent'; 
        const timestamp = Date.now();
        const filename = `audios/${childId}/${timestamp}.wav`; 

        if (!req.file || !req.file.buffer) {
            console.error('[HTTP-Upload-Audio] Nenhum arquivo de áudio recebido do filho:', childId);
            return res.status(400).send('Nenhum arquivo de áudio recebido.');
        }

        const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'; 
        
        const s3Params = {
            Bucket: bucketName, 
            Key: filename, 
            Body: req.file.buffer, 
            ContentType: 'audio/wav', 
            // CORREÇÃO FINAL: Removido ACL: 'private' - se o bucket não permite ACLs, NENHUMA operação pode usar.
            // A acessibilidade é definida EXCLUSIVAMENTE pela política do bucket (se "PublicReadForGetObject" ou similar).
        };

        const s3Result = await s3.upload(s3Params).promise();

        console.log(`[HTTP-Upload-Audio] Áudio recebido de ${childId} e salvo em S3 como ${filename}. URL: ${s3Result.Location}`);

        // --- NOVO CONTROLE: Verificar se o pai está ouvindo este filho ---
        const parentIsListeningToThisChild = parentListeningToChild.get(parentIdFromChild);
        if (parentIsListeningToThisChild === childId) {
            const parentWs = parentToWebSocket.get(parentIdFromChild);
            if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                const message = JSON.stringify({
                    type: 'audioStreamUrl', 
                    childId: childId,
                    url: s3Result.Location
                });
                parentWs.send(message);
                console.log(`[WS-Parent] URL S3 de áudio enviada para o pai "${parentIdFromChild}" para filho "${childId}": ${s3Result.Location}`);
            } else {
                console.warn(`[WS-Parent] App Pai "${parentIdFromChild}" não conectado ou WebSocket não está aberto. Não foi possível enviar URL S3.`);
            }
        } else {
            console.log(`[WS-Parent] Pai ${parentIdFromChild} NÃO está ouvindo ativamente o filho ${childId}. URL de áudio ignorada.`);
            // Opcional: Se o pai não está ouvindo, podemos tentar parar a gravação deste filho
            // para evitar uploads desnecessários. Isso exigiria enviar um comando 'stopAudioStreamFromServer'
            // para o childId via activeAudioControlClients. Mas é mais complexo para um simples upload.
        }

        res.status(200).json({ message: 'Áudio salvo com sucesso!', url: s3Result.Location, childId: childId });
    } catch (error) {
        console.error('[HTTP-Upload-Audio] Erro ao fazer upload de áudio:', error);
        res.status(500).send('Erro ao salvar áudio.');
    }
});


app.use((req, res, next) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).send('Rota não encontrada.');
});

app.use((err, req, res, next) => {
    console.error('Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});


// Lidar com upgrade de HTTP para WebSocket (já existente)
server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    console.log(`[HTTP-Upgrade] Tentativa de upgrade para pathname: ${pathname}`);

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
            // Envia um erro para o pai se o comando falhar
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
                    const reqLocChildId = effectiveChildId; 
                    if (ws.clientType !== 'parent' || !reqLocChildId) { 
                        console.warn(`[WebSocket-General] Requisição de localização inválida: clientType='${ws.clientType}' (esperado 'parent') ou childId='${reqLocChildId}' ausente.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }
                    // Adicione a lógica de sendCommandWithRetry aqui, com o parentId correto do payload
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
                    // Adicione a lógica de sendCommandWithRetry aqui, com o parentId correto do payload
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
                    const parentIdForAudio = effectiveParentId; // Use o parentId do payload

                    // --- NOVO: Registra qual filho o pai está ouvindo ativamente ---
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
                    const parentIdForStopAudio = effectiveParentId; // Use o parentId do payload

                    sendCommandWithRetry(targetChildIdStopAudio, { type: 'stopAudioStreamFromServer', parentId: parentIdForStopAudio }, activeAudioControlClients, 'AudioControl', 5, 500, 0); 

                    // --- NOVO: Remove o registro de qual filho o pai está ouvindo ---
                    parentListeningToChild.delete(parentIdForStopAudio);
                    console.log(`[WS-General] Pai ${parentIdForStopAudio} parou de ouvir o filho ${targetChildIdStopAudio}. Registro removido.`);

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
            // --- NOVO: Limpa o registro de escuta de qualquer pai que estivesse ouvindo este filho ---
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
            // --- NOVO: Limpa o registro do que este pai estava ouvindo ---
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
    console.log(`WebSocket de comandos gerais em: ws://localhost:${PORT}/ws-general-commands`);
    console.log(`WebSocket de controle de áudio em: ws://localhost:${PORT}/ws-audio-control`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
});