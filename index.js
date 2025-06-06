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
const wsConnections = new Map(); // Mantido por compatibilidade, mas childToWebSocket/parentToWebSocket são os principais.
const childToWebSocket = new Map(); // Mapeia childId para WebSocket do filho (comandos)
const parentToWebSocket = new Map(); // Mapeia parentId para WebSocket do pai (comandos)
const activeAudioClients = new Map(); // Mapeia WebSocket de áudio para info do filho
const activeConnections = new Map(); // Mapeia ws.id (UUID inicial ou child/parentId) para info do cliente

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
            TableName: DYNAMODB_TABLE_CHILDREN
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
    let clientId = uuidv4(); // ID temporário até ser identificado
    let clientType = 'unknown'; // 'parent' ou 'child'
    let currentParentId = null;
    let currentChildId = null;
    let currentChildName = null;

    ws.id = clientId;
    activeConnections.set(ws.id, { ws: ws, type: clientType, id: clientId });
    console.log(`[WebSocket-Commands] Novo cliente conectado (temp ID: ${ws.id}). Total de entradas: ${activeConnections.size}`);

    ws.on('message', async message => {
        let finalParsedMessage = null;
        try {
            let currentMessageContent = message;
            if (Buffer.isBuffer(currentMessageContent)) {
                currentMessageContent = currentMessageContent.toString('utf8');
            }

            // Tentar parsear o JSON
            try {
                finalParsedMessage = JSON.parse(currentMessageContent);
            } catch (e) {
                console.error('[WebSocket-Commands] Falha ao parsear a mensagem JSON:', e.message, 'Mensagem bruta:', currentMessageContent);
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }
            
            if (!finalParsedMessage || typeof finalParsedMessage !== 'object' || Array.isArray(finalParsedMessage)) {
                console.error('[WebSocket-Commands] parsedMessage inválido ou não é um objeto JSON esperado:', finalParsedMessage); 
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }

            console.log('[WebSocket-Commands] Mensagem JSON recebida:', finalParsedMessage);

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
                    currentParentId = effectiveParentId;
                    clientType = 'parent';
                    // Atualiza o ID do WS na activeConnections com o parentId real
                    // E mapeia no parentToWebSocket
                    if (currentParentId) {
                         activeConnections.set(currentParentId, { ws: ws, type: 'parent', id: currentParentId });
                         if (ws.id !== currentParentId) {
                            activeConnections.delete(ws.id); // Remove o temp ID
                            ws.id = currentParentId; // Atualiza o ID da instância WS
                         }
                         parentToWebSocket.set(currentParentId, ws);
                         console.log(`[WebSocket-Manager] Conexão parent ${currentParentId} atualizada. Total de entradas: ${activeConnections.size}`);
                         console.log(`[WS-Commands] Pai conectado e identificado: ID: ${currentParentId}, ouvindo filho: ${effectiveChildId || 'nenhum'}`);
                    } else {
                         console.warn('[WS-Commands] parentConnect sem parentId.');
                    }
                    break;
                case 'childConnect':
                    if (effectiveChildId && effectiveParentId) {
                        clientType = 'child';
                        currentChildId = effectiveChildId;
                        currentParentId = effectiveParentId;
                        currentChildName = effectiveChildName || 'Desconhecido';
                        
                        // Atualiza o ID do WS na activeConnections com o childId real
                        // E mapeia no childToWebSocket
                        activeConnections.set(effectiveChildId, { ws: ws, type: 'child', id: effectiveChildId, parentId: effectiveParentId, name: currentChildName });
                        if (ws.id !== effectiveChildId) {
                            activeConnections.delete(ws.id); // Remove o temp ID
                            ws.id = effectiveChildId; // Atualiza o ID da instância WS
                        }
                        childToWebSocket.set(effectiveChildId, ws);

                        await docClient.update({
                            TableName: DYNAMODB_TABLE_CHILDREN,
                            Key: { childId: effectiveChildId },
                            UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity, parentId = :parentId, childName = :childName',
                            ExpressionAttributeValues: {
                                ':connected': true,
                                ':lastActivity': new Date().toISOString(),
                                ':parentId': effectiveParentId,
                                ':childName': effectiveChildName
                            }
                        }).promise();
                        console.log(`[DynamoDB] Filho ${effectiveChildName} (${effectiveChildId}) status de conexão atualizado para 'true'.`);
                        console.log(`[WS-Commands] Filho conectado e identificado: ID: ${effectiveChildId}, Parent ID: ${effectiveParentId}, Nome: ${effectiveChildName}. Total de entradas: ${activeConnections.size}`);
                        
                        const parentWs = parentToWebSocket.get(effectiveParentId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({
                                type: 'childStatus',
                                childId: effectiveChildId,
                                status: 'online',
                                childName: effectiveChildName
                            }));
                            console.log(`[WS-Commands] Notificação de status 'online' enviada para o pai ${effectiveParentId} para o filho ${effectiveChildId}.`);
                        }
                    } else {
                        console.warn('[WS-Commands] Mensagem childConnect inválida: childId ou parentId faltando.', finalParsedMessage);
                    }
                    break;
                case 'locationUpdate':
                    // Usa currentChildId e currentParentId da sessão se disponíveis, senão do payload
                    const locChildId = currentChildId || effectiveChildId;
                    const locParentId = currentParentId || effectiveParentId;

                    if (!locChildId || effectiveLatitude === undefined || effectiveLongitude === undefined) {
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

                    const connectedParentWsLocation = parentToWebSocket.get(locParentId); // Usa o parentId associado
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
                    // Re-avaliar sender/receiver IDs para usar os IDs da sessão se disponíveis
                    const senderId = currentChildId || effectiveParentId; // Se a mensagem vem de um childConnect, currentChildId será o childId
                                                                        // Se a mensagem vem de um parentConnect, effectiveParentId será o parentId
                    const receiverId = effectiveChildId || effectiveParentId; // Este é o ID alvo da mensagem no payload

                    const senderInfo = activeConnections.get(ws.id); // Pega info do sender baseado no ws.id
                    const senderName = senderInfo && senderInfo.type === 'child' ? senderInfo.name : 'Pai';

                    const receiverWs = childToWebSocket.get(receiverId) || parentToWebSocket.get(receiverId); // Tenta encontrar o WS do receiver

                    if (!senderId || !receiverId || !chatMessageContent) {
                        console.warn('[WS-Commands] Mensagem de chat inválida: IDs ou mensagem ausentes.');
                        return;
                    }
                    console.log(`[Chat] Mensagem de ${senderName} (${senderId}) para ${receiverId}: ${chatMessageContent}`);

                    const messageParams = {
                        TableName: DYNAMODB_TABLE_MESSAGES,
                        Item: {
                            // Crie um conversationId consistente, ex: combinando parentId e childId em ordem alfabética
                            conversationId: [currentParentId, currentChildId].sort().join('-'), // Ajustado para ser mais robusto
                            messageId: uuidv4(),
                            parentId: currentParentId, // Assume que currentParentId é o do remetente ou do receptor
                            childId: currentChildId, // Assume que currentChildId é o do remetente ou do receptor
                            sender: senderId,
                            message: chatMessageContent,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(messageParams).promise();
                    console.log(`[DynamoDB] Mensagem de chat salva de ${senderId} para ${receiverId}.`);

                    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                        receiverWs.send(JSON.stringify({
                            type: 'chatMessage',
                            senderId: senderId,
                            receiverId: receiverId,
                            message: chatMessageContent,
                            timestamp: new Date().toISOString(),
                            senderName: senderName
                        }));
                        console.log(`[Chat] Mensagem encaminhada para ${receiverId}.`);
                    } else {
                        console.warn(`[Chat] Receptor ${receiverId} não encontrado ou offline.`);
                    }
                    break;
                case 'requestLocation':
                    const requestingParentInfoLoc = activeConnections.get(ws.id);
                    const targetChildIdForLocation = effectiveChildId;
                    if (!requestingParentInfoLoc || requestingParentInfoLoc.type !== 'parent' || !targetChildIdForLocation) {
                        console.warn('[WS-Commands] Requisição de localização inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }

                    const targetChildClientWsLocation = childToWebSocket.get(targetChildIdForLocation); // Conexão WS de COMANDOS do filho
                    
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
                    const requestingParentInfoAudio = activeConnections.get(ws.id);
                    const targetChildIdForAudio = effectiveChildId;
                    console.log(`[Audio-Debug] Recebido 'startAudioStream' do pai ${requestingParentInfoAudio ? requestingParentInfoAudio.id : 'desconhecido'} para filho ${targetChildIdForAudio}. ClientType: ${requestingParentInfoAudio ? requestingParentInfoAudio.type : 'desconhecido'}`);
                    if (!requestingParentInfoAudio || requestingParentInfoAudio.type !== 'parent' || !targetChildIdForAudio) {
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
                    const requestingParentInfoStop = activeConnections.get(ws.id);
                    const targetChildIdForStopAudio = effectiveChildId;
                    if (!requestingParentInfoStop || requestingParentInfoStop.type !== 'parent' || !targetChildIdForStopAudio) {
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
                    const requestingParentInfoStopLoc = activeConnections.get(ws.id);
                    const targetChildIdForStopLoc = effectiveChildId;
                    if (!requestingParentInfoStopLoc || requestingParentInfoStopLoc.type !== 'parent' || !targetChildIdForStopLoc) {
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
            console.error('[WS-Commands] Erro crítico ao processar mensagem (JSON.parse ou outro):', error);
            console.error('[WS-Commands] Mensagem original (tentativa toString):', message ? message.toString() : message);
            console.error('[WS-Commands] Tipo de mensagem recebida (no catch):', typeof message);
            ws.send(JSON.stringify({ type: 'error', message: 'Erro interno ao processar sua mensagem.' }));
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WS-Commands] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        
        const disconnectedClientInfo = activeConnections.get(ws.id);
        if (disconnectedClientInfo) {
            clientType = disconnectedClientInfo.type;
            currentChildId = disconnectedClientInfo.id; // Pode ser childId ou parentId, dependendo do tipo
            currentParentId = disconnectedClientInfo.parentId;
            currentChildName = disconnectedClientInfo.name;

            activeConnections.delete(ws.id);
            if (clientType === 'child' && currentChildId) {
                childToWebSocket.delete(currentChildId);
            } else if (clientType === 'parent' && currentChildId) {
                parentToWebSocket.delete(currentChildId);
            }

            if (clientType === 'child' && currentChildId) {
                try {
                    await docClient.update({
                        TableName: DYNAMODB_TABLE_CHILDREN,
                        Key: { childId: currentChildId },
                        UpdateExpression: 'SET connected = :connected',
                        ExpressionAttributeValues: { ':connected': false }
                    }).promise();
                    console.log(`[DynamoDB] Filho ${currentChildId} status de conexão atualizado para 'false'.`);

                    const parentWs = parentToWebSocket.get(currentParentId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({
                            type: 'childStatus',
                            childId: currentChildId,
                            status: 'offline'
                        }));
                        console.log(`[WS-Commands] Notificação de status 'offline' enviada para o pai ${currentParentId} para o filho ${currentChildId}.`);
                    }

                } catch (error) {
                    console.error('Erro ao atualizar status de conexão do filho no DynamoDB:', error);
                }
            }
        } else {
            console.warn(`[WS-Commands] Cliente desconectado com ID ${ws.id} não encontrado em activeConnections.`);
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas: ${activeConnections.size}`);
    });

    ws.on('error', error => {
        console.error('[WS-Commands] Erro no cliente WebSocket:', error);
        const erroredClientInfo = activeConnections.get(ws.id);
        if (erroredClientInfo) {
            activeConnections.delete(ws.id);
            if (erroredClientInfo.type === 'child' && erroredClientInfo.id) {
                childToWebSocket.delete(erroredClientInfo.id);
            } else if (erroredClientInfo.type === 'parent' && erroredClientInfo.id) {
                parentToWebSocket.delete(erroredClientInfo.id);
            }
            if (erroredClientInfo.type === 'child' && erroredClientInfo.id) {
                docClient.update({
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: erroredClientInfo.id },
                    UpdateExpression: 'SET connected = :connected',
                    ExpressionAttributeValues: { ':connected': false }
                }).promise().catch(e => console.error('Erro ao atualizar status de conexão do filho após erro WS:', e));
            }
        }
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

    activeAudioClients.set(ws, { childId: childId, parentId: parentId, isParentAudioClient: false });
    console.log(`[Audio-WS] Filho ${childId} conectado ao WebSocket de áudio. Parent: ${parentId}. Total de conexões de áudio: ${activeAudioClients.size}`);

    ws.on('message', message => {
        try {
            const textMessage = message.toString('utf8');
            // Se for JSON (o filho envia 'audioData' como JSON)
            if (textMessage.startsWith('{') && textMessage.endsWith('}')) {
                const parsedAudioData = JSON.parse(textMessage);
                if (parsedAudioData.type === 'audioData' && parsedAudioData.data) {
                    const audioBase64 = parsedAudioData.data; // Já é Base64 vindo do filho
                    
                    const audioDataJson = JSON.stringify({
                        type: 'audioData',
                        childId: parsedAudioData.childId,
                        data: audioBase64
                    });

                    // Encaminha para os pais conectados no CANAL DE COMANDOS
                    parentToWebSocket.forEach((parentWs, pId) => {
                        if (parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(audioDataJson);
                        }
                    });
                    // console.log(`[Audio-WS] Recebido chunk de áudio JSON do filho ${parsedAudioData.childId}. Tamanho JSON: ${audioDataJson.length}. Encaminhando.`);
                } else {
                    console.log(`[Audio-WS] Recebida mensagem de controle (não áudio) do filho ${childId}:`, parsedAudioData);
                }
            } else if (Buffer.isBuffer(message)) {
                // Caso o filho envie o buffer de áudio diretamente (legacy ou fallback)
                const audioBase64 = message.toString('base64');
                const audioDataJson = JSON.stringify({
                    type: 'audioData',
                    childId: childId,
                    data: audioBase64
                });

                parentToWebSocket.forEach((parentWs, pId) => {
                    if (parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(audioDataJson);
                    }
                });
                console.log(`[Audio-WS] Recebido buffer de áudio do filho ${childId}. Tamanho: ${message.length} bytes. Encaminhando como JSON/Base64.`);
            }
        } catch (error) {
            console.error(`[Audio-WS] Erro ao processar mensagem do filho ${childId}: ${error.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[Audio-WS] Filho ${childId} desconectado do WebSocket de áudio. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        activeAudioClients.delete(ws);
        console.log(`[Audio-WS] Conexão de áudio de ${childId} removida. Total: ${activeAudioClients.size}`);
    });

    ws.on('error', error => {
        console.error(`[Audio-WS] Erro no WebSocket de áudio para ${childId}:`, error);
        activeAudioClients.delete(ws);
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


server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    console.log(`[HTTP-Upgrade] Tentativa de upgrade para pathname: ${pathname}`);

    if (pathname === '/ws-commands') {
        wssCommands.handleUpgrade(request, socket, head, ws => {
            wssCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio') {
        wssAudio.handleUpgrade(request, socket, head, ws => {
            wssAudio.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});


server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos (GPS, Chat) em: ws://localhost:${PORT}/ws-commands`);
    console.log(`WebSocket de áudio em: ws://localhost:${PORT}/ws-audio`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
});
