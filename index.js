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
const activeAudioClients = new Map();
const activeConnections = new Map();

const app = express();
const PORT = process.env.PORT || 10000;

const upload = multer();

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const DYNAMODB_TABLE_CHILDREN = 'Children';

app.use(cors());
app.use(bodyParser.json());

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
        const params = {
            TableName: DODB_TABLE_CHILDREN
        };
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela 'Children'. Encontrados ${data.Items.length} filhos.`);
        
        const childrenWithStatus = data.Items.map(child => ({
            ...child,
            connected: childToWebSocket.has(child.childId) || Array.from(activeAudioClients.values()).some(client => client.childId === child.childId && !client.isParentAudioClient)
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
        ExpressionAttributeValues: {
            ':parentId': parentId
        }
    };

    try {
        const data = await docClient.scan(params).promise();
        const conversations = data.Items.map(item => ({
            childId: item.childId,
            childName: item.childName,
            lastActivity: item.lastActivity,
            connected: childToWebSocket.has(item.childId) || Array.from(activeAudioClients.values()).some(client => client.childId === item.childId && !item.isParentAudioClient),
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
        ExpressionAttributeValues: {
            ':conversationId': conversationId
        },
        ScanIndexForward: true, // Ordenar por timestamp crescente
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
        ExpressionAttributeValues: {
            ':childId': childId
        },
        ScanIndexForward: true, // Ordenar por timestamp crescente
        Limit: 100 // Limita as últimas 100 localizações, ajuste conforme necessário
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
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN,
            Key: {
                childId: recipientChildId
            }
        };
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
        Bucket: bucketName,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'private'
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

app.get('/download-media/:key', async (req, res) => {
    const key = req.params.key;
    const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

    const params = {
        Bucket: bucketName,
        Key: key
    };

    try {
        const data = await s3.getObject(params).promise();
        res.setHeader('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
        res.setHeader('Content-Type', data.ContentType);
        res.send(data.Body);
    } catch (error) {
        console.error('Erro ao baixar arquivo do S3:', error);
        res.status(404).send('Arquivo não encontrado ou erro de servidor.');
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
const wssCommands = new WebSocket.Server({ noServer: true });
const wssAudio = new WebSocket.Server({ noServer: true });

// WebSocket de Comandos (GPS, Chat)
wssCommands.on('connection', ws => {
    ws.id = uuidv4();
    ws.clientType = 'unknown';
    ws.currentParentId = null;
    ws.currentChildId = null;
    ws.currentChildName = null;

    activeConnections.set(ws.id, { ws: ws, type: ws.clientType, id: ws.id });
    console.log(`[WebSocket-Commands] Novo cliente conectado (temp ID: ${ws.id}). Total de entradas: ${activeConnections.size}`);

    ws.on('message', async message => {
        let finalParsedMessage = null;

        try {
            let messageString = (Buffer.isBuffer(message) ? message.toString('utf8') : message).trim();
            
            console.log(`[WebSocket-Commands] Mensagem bruta TRIMMADA para parse: '${messageString}'`);

            // --- Lógica para lidar com JSON duplamente stringificado ---
            // Detecta se a string começa e termina com aspas literais E contém aspas escapadas internas
            if (messageString.startsWith('"') && messageString.endsWith('"') && messageString.includes('\\"')) {
                console.log(`[WebSocket-Commands] Detectado JSON duplamente stringificado. Tentando des-stringificar.`);
                try {
                    // Remove as aspas externas literais
                    messageString = messageString.substring(1, messageString.length - 1);
                    // Desescapa as aspas internas (e quaisquer outras barras invertidas duplas)
                    messageString = messageString.replace(/\\"/g, '"');
                    messageString = messageString.replace(/\\\\/g, '\\'); // Para lidar com escapes de barras invertidas duplas
                    console.log(`[WebSocket-Commands] Mensagem des-stringificada e desescapada: '${messageString}'`);
                } catch (e) {
                    console.warn(`[WebSocket-Commands] Falha na des-stringificação inicial, prosseguindo com a string original. Erro: ${e.message}`);
                    // Se falhar, use a string original e deixe o JSON.parse principal lidar com isso (e falhar).
                }
            }
            // --- Fim da lógica para lidar com JSON duplamente stringificado ---

            finalParsedMessage = JSON.parse(messageString);
            
            console.log(`[WebSocket-Commands] DEBUG FINAL: typeof finalParsedMessage: ${typeof finalParsedMessage}`);
            console.log(`[WebSocket-Commands] DEBUG FINAL: finalParsedMessage === null: ${finalParsedMessage === null}`);
            console.log(`[WebSocket-Commands] DEBUG FINAL: Array.isArray(finalParsedMessage): ${Array.isArray(finalParsedMessage)}`);


            if (typeof finalParsedMessage !== 'object' || finalParsedMessage === null || Array.isArray(finalParsedMessage)) {
                console.error('[WebSocket-Commands] Mensagem parseada inválida (não é um objeto JSON esperado APÓS TRATAMENTO):', finalParsedMessage); 
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }

            console.log('[WebSocket-Commands] Mensagem JSON recebida (após validação final):', finalParsedMessage);

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
                console.log(`[WS-Commands] Conteúdo de 'data' processado:`, data);
            }
            
            console.log(`[WS-Commands] Desestruturado - type: ${type}, parentId: ${effectiveParentId}, childId (effective): ${effectiveChildId}, childName (effective): ${effectiveChildName}`);

            switch (type) {
                case 'parentConnect':
                    ws.currentParentId = effectiveParentId;
                    ws.clientType = 'parent';

                    if (ws.currentParentId) {
                         activeConnections.set(ws.currentParentId, { ws: ws, type: ws.clientType, id: ws.currentParentId });
                         if (ws.id !== ws.currentParentId) {
                            activeConnections.delete(ws.id);
                            ws.id = ws.currentParentId;
                         }
                         parentToWebSocket.set(ws.currentParentId, ws);
                         console.log(`[WebSocket-Manager] Conexão parent ${ws.currentParentId} atualizada. Total de entradas: ${activeConnections.size}`);
                         console.log(`[WS-Commands] Pai conectado e identificado: ID: ${ws.currentParentId}, ouvindo filho: ${effectiveChildId || 'nenhum'}`);
                    } else {
                         console.warn('[WS-Commands] parentConnect sem parentId.');
                    }
                    break;
                case 'childConnect':
                    if (effectiveChildId && effectiveParentId) {
                        ws.clientType = 'child';
                        ws.currentChildId = effectiveChildId;
                        ws.currentParentId = effectiveParentId;
                        ws.currentChildName = effectiveChildName || 'Desconhecido';
                        
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
                        console.log(`[WS-Commands] Filho conectado e identificado: ID: ${ws.currentChildId}, Parent ID: ${ws.currentParentId}, Nome: ${ws.currentChildName}. Total de entradas: ${activeConnections.size}`);
                        
                        const parentWs = parentToWebSocket.get(ws.currentParentId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({
                                type: 'childStatus',
                                childId: ws.currentChildId,
                                status: 'online',
                                childName: ws.currentChildName
                            }));
                            console.log(`[WS-Commands] Notificação de status 'online' enviada para o pai ${ws.currentParentId} para o filho ${ws.currentChildId}.`);
                        }
                    } else {
                        console.warn('[WS-Commands] Mensagem childConnect inválida: childId ou parentId faltando.', finalParsedMessage);
                    }
                    break;
                case 'locationUpdate':
                    const locChildId = ws.currentChildId;
                    const locParentId = ws.currentParentId;

                    if (!locChildId || effectiveLatitude === undefined || effectiveLatitude === null || effectiveLongitude === undefined || effectiveLongitude === null) {
                        console.warn('[WS-Commands] Mensagem de localização recebida de cliente não identificado ou dados incompletos.');
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
                        console.warn('[WS-Commands] Mensagem de chat inválida: IDs ou mensagem ausentes.');
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
                    if (ws.clientType !== 'parent' || !targetChildIdForLocation) {
                        console.warn('[WS-Commands] Requisição de localização inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }

                    const targetChildClientWsLocation = childToWebSocket.get(targetChildIdForLocation);
                    
                    if (targetChildClientWsLocation && targetChildClientWsLocation.readyState === WebSocket.OPEN) {
                        targetChildClientWsLocation.send(JSON.stringify({ type: 'startLocationUpdates' }));
                        console.log(`[Location-Server] Comando 'startLocationUpdates' enviado para filho ${targetChildIdForLocation} via WS de comandos.`);
                        ws.send(JSON.stringify({ type: 'info', message: `Solicitando localização para ${targetChildIdForLocation}.` }));
                    } else {
                        console.warn(`[Location-Server] Filho ${targetChildIdForLocation} não encontrado ou offline para requisição de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildIdForLocation} offline para GPS.` }));
                        return;
                    }

                    const audioWsOfChildStopOnGpsStart = findAudioWsForChild(targetChildIdForLocation);
                    if (audioWsOfChildStopOnGpsStart && audioWsOfChildStopOnGpsStart.readyState === WebSocket.OPEN) {
                         audioWsOfChildStopOnGpsStart.send(JSON.stringify({ type: 'stopAudioStreamFromServer' }));
                         console.log(`[Audio-Server] Comando 'stopAudioStreamFromServer' enviado para o filho ${targetChildIdForLocation} (canal de áudio) ao iniciar GPS.`);
                    }
                    break;

                case 'startAudioStream':
                    const targetChildIdForAudio = effectiveChildId;
                    console.log(`[Audio-Debug] Recebido 'startAudioStream' do pai ${ws.currentParentId} para filho ${targetChildIdForAudio}. ClientType: ${ws.clientType}`);
                    if (ws.clientType !== 'parent' || !targetChildIdForAudio) {
                        console.warn('[WS-Commands] Requisição de áudio inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de áudio inválida.' }));
                        return;
                    }
                    
                    const targetChildClientWsCommandsForAudio = childToWebSocket.get(targetChildIdForAudio);

                    if (targetChildClientWsCommandsForAudio && targetChildClientWsCommandsForAudio.readyState === WebSocket.OPEN) {
                        targetChildClientWsCommandsForAudio.send(JSON.stringify({ type: 'startRecording' }));
                        console.log(`[Audio-Server] Comando 'startRecording' enviado para o filho ${targetChildIdForAudio} via WS de COMANDOS.`);

                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'sent',
                            childId: targetChildIdForAudio,
                            message: `Comando 'startRecording' enviado para ${targetChildIdForAudio}.`
                        }));
                    } else {
                        console.warn(`[Audio-Server] Filho ${targetChildIdForAudio} NÃO ENCONTRADO ou offline no canal de COMANDOS para comando de áudio.`);
                        console.log(`[Audio-Server-Debug] Conexões de COMANDO ativas (IDs): ${Array.from(childToWebSocket.keys()).filter(Boolean)}`);

                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdForAudio,
                            message: `Filho ${targetChildIdForAudio} offline ou não conectado ao WS de comandos.`
                        }));
                        return;
                    }

                    if (targetChildClientWsCommandsForAudio && targetChildClientWsCommandsForAudio.readyState === WebSocket.OPEN) {
                        targetChildClientWsCommandsForAudio.send(JSON.stringify({ type: 'stopLocationUpdates' }));
                        console.log(`[Location-Server] Comando 'stopLocationUpdates' enviado para o filho ${targetChildIdForAudio} via WS de COMANDOS ao iniciar áudio.`);
                    }
                    break;
                case 'stopAudioStream':
                    const targetChildIdForStopAudio = effectiveChildId;
                     if (ws.clientType !== 'parent' || !targetChildIdForStopAudio) {
                        console.warn('[WS-Commands] Requisição de parada de áudio inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de parada de áudio inválida.' }));
                        return;
                    }
                    const childWsStopAudio = childToWebSocket.get(targetChildIdForStopAudio);

                    if (childWsStopAudio && childWsStopAudio.readyState === WebSocket.OPEN) {
                        childWsStopAudio.send(JSON.stringify({ type: 'stopAudioStreamFromServer' }));
                        console.log(`[Audio-Server] Comando 'stopAudioStreamFromServer' enviado para o filho ${targetChildIdForStopAudio} via WS de COMANDOS.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'stopped',
                            childId: targetChildIdForStopAudio,
                            message: `Comando 'stopAudioStreamFromServer' enviado para ${targetChildIdForStopAudio}.`
                        }));
                    } else {
                        console.warn(`[Audio-Server] Filho ${targetChildIdForStopAudio} não encontrado ou offline no canal de COMANDOS para comando de parada de áudio.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdForStopAudio,
                            message: `Filho ${targetChildIdForStopAudio} offline ou não conectado ao WS de comandos para parada.`
                        }));
                    }
                    break;
                case 'stopLocationUpdates':
                    const targetChildIdForStopLoc = effectiveChildId;
                     if (ws.clientType !== 'parent' || !targetChildIdForStopLoc) {
                        console.warn('[WS-Commands] Requisição de parada de localização inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de parada de localização inválida.' }));
                        return;
                    }
                    const childWsStopLoc = childToWebSocket.get(targetChildIdForStopLoc);

                    if (childWsStopLoc && childWsStopLoc.readyState === WebSocket.OPEN) {
                        childWsStopLoc.send(JSON.stringify({ type: 'stopLocationUpdates' }));
                        console.log(`[Location-Server] Comando 'stopLocationUpdates' enviado para o filho ${targetChildIdForStopLoc} via WS de comandos.`);
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
                default:
                    console.warn('[WS-Commands] Tipo de mensagem desconhecido:', type);
            }
        } catch (error) {
            console.error('[WS-Commands] Erro crítico ao processar mensagem:', error.message);
            const rawMessageDebug = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            console.error('[WS-Commands] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WS-Commands] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        
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
                    console.log(`[WS-Commands] Notificação de status 'offline' enviada para o pai ${ws.currentParentId} para o filho ${ws.currentChildId}.`);
                }

            } catch (error) {
                console.error('Erro ao atualizar status de conexão do filho no DynamoDB:', error);
            }
        } else if (ws.clientType === 'parent' && ws.currentParentId) {
             console.log(`[WS-Commands] Pai ${ws.currentParentId} desconectado.`);
        } else {
             console.warn(`[WS-Commands] Cliente desconectado de tipo desconhecido ou sem ID principal (ID: ${disconnectedId}).`);
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas: ${activeConnections.size}`);
    });

    ws.on('error', error => {
        console.error('[WS-Commands] Erro no cliente WebSocket:', error);
    });
});

// Função auxiliar para encontrar a conexão de áudio do filho (se existir)
function findAudioWsForChild(childId) {
    for (const [wsInstance, clientInfo] of activeAudioClients.entries()) {
        if (clientInfo.childId === childId && !clientInfo.isParentAudioClient) {
            return wsInstance;
        }
    }
    return null;
}

// WebSocket Server para Áudio
wssAudio.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const childId = parameters.childId;
    const parentId = parameters.parentId;

    if (!childId) {
        console.error("[Audio-WS] Conexão de áudio rejeitada: childId ausente nos parâmetros da URL.");
        ws.close();
        return;
    }

    ws.childId = childId;
    ws.parentId = parentId;
    ws.isParentAudioClient = false;

    activeAudioClients.set(ws, { childId: ws.childId, parentId: ws.parentId, isParentAudioClient: ws.isParentAudioClient });
    console.log(`[Audio-WS] Filho ${ws.childId} conectado ao WebSocket de áudio. Parent: ${ws.parentId}. Total de conexões de áudio: ${activeAudioClients.size}`);

    ws.on('message', message => {
        try {
            const messageString = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            
            // A lógica de áudio no filho já deve estar enviando JSON direto, mas este fallback ajuda
            if (messageString.startsWith('{') && messageString.endsWith('}')) {
                const parsedAudioData = JSON.parse(messageString);
                if (parsedAudioData.type === 'audioData' && parsedAudioData.data) {
                    const audioBase64 = parsedAudioData.data;
                    
                    const audioDataJson = JSON.stringify({
                        type: 'audioData',
                        childId: parsedAudioData.childId || ws.childId,
                        data: audioBase64
                    });

                    parentToWebSocket.forEach((parentWs, pId) => {
                        if (parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(audioDataJson);
                        }
                    });
                } else {
                    console.log(`[Audio-WS] Recebida mensagem de controle (não áudio) do filho ${ws.childId}:`, parsedAudioData);
                }
            } else {
                console.warn(`[Audio-WS] Recebido mensagem não JSON no canal de áudio do filho ${ws.childId}. Tratando como buffer bruto.`);
                const audioBase64 = Buffer.from(message).toString('base64');
                const audioDataJson = JSON.stringify({
                    type: 'audioData',
                    childId: ws.childId,
                    data: audioBase64
                });

                parentToWebSocket.forEach((parentWs, pId) => {
                    if (parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(audioDataJson);
                    }
                });
                console.log(`[Audio-WS] Recebido buffer de áudio do filho ${ws.childId}. Tamanho: ${message.length} bytes. Encaminhando como JSON/Base64.`);
            }
        } catch (error) {
            console.error(`[Audio-WS] Erro ao processar mensagem do filho ${ws.childId}: ${error.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[Audio-WS] Filho ${ws.childId} desconectado do WebSocket de áudio. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        activeAudioClients.delete(ws);
        console.log(`[Audio-WS] Conexão de áudio de ${ws.childId} removida. Total: ${activeAudioClients.size}`);
    });

    ws.on('error', error => {
        console.error(`[Audio-WS] Erro no WebSocket de áudio para ${ws.childId}:`, error);
    });
});


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

    if (pathname === '/ws-commands') {
        wssCommands.handleUpgrade(request, socket, head, ws => {
            wssCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio') {
        wssAudio.handleUpgrade(request, socket, head, ws => {
            wssAudio.emit('connection', ws, request); // Passa 'request' para wssAudio.on('connection')
        });
    } else {
        socket.destroy();
    }
});

// --- INICIO DO SERVIDOR ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos (GPS, Chat) em: ws://localhost:${PORT}/ws-commands`);
    console.log(`WebSocket de áudio em: ws://localhost:${PORT}/ws-audio`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
});
