const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

const wsConnections = new Map();
const childToWebSocket = new Map();
const parentToWebSocket = new Map();
const activeAudioClients = new Map();

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
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // GEMINI, MUDE NADA AQUI
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
        console.log(`[HTTP] Filho ${childName} (ID: ${childId}) registrado com sucesso para o pai ${parentId}.`);
        res.status(200).send('Filho registrado com sucesso!');
    } catch (error) {
        console.error('[HTTP] Erro ao registrar filho:', error);
        res.status(500).send('Erro ao registrar filho.');
    }
});

app.get('/get-registered-children', async (req, res) => { // GEMINI, MUDE NADA AQUI
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

app.post('/send-notification', async (req, res) => { // GEMINI, MUDE NADA AQUI
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

app.post('/upload-media', upload.single('media'), async (req, res) => { // GEMINI, MUDE NADA AQUI
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

app.get('/download-media/:key', async (req, res) => { // GEMINI, MUDE NADA AQUI
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
const wssCommands = new WebSocket.Server({ noServer: true }); // Para comandos (GPS, Chat)
const wssAudio = new WebSocket.Server({ noServer: true });    // Para streaming de áudio

// WebSocket de Comandos (GPS, Chat)
wssCommands.on('connection', ws => {
    let clientId = uuidv4(); // ID temporário até ser identificado
    let clientType = 'unknown'; // 'parent' ou 'child'
    let currentParentId = null;
    let currentChildId = null;
    let currentChildName = null;

    ws.id = clientId; // Adiciona um ID à instância do WebSocket
    activeConnections.set(ws.id, { ws: ws, type: clientType, id: clientId });
    console.log(`[WebSocket-Commands] Novo cliente conectado. Total de entradas: ${activeConnections.size}`);

    ws.on('message', async message => {
        let finalParsedMessage = null;
        try {
            console.log(`[WebSocket-Commands] Tipo da variável 'message' recebida (ANTES do parse): ${typeof message}`);
            console.log(`[WebSocket-Commands] message é Buffer? ${Buffer.isBuffer(message)}`);

            let currentMessageContent = message;
            if (Buffer.isBuffer(currentMessageContent)) {
                currentMessageContent = currentMessageContent.toString('utf8');
            }

            let parseAttempts = 0;
            let parsedResult = null;
            let successfullyParsedToObject = false;

            while (parseAttempts < 5) {
                try {
                    parsedResult = JSON.parse(currentMessageContent);
                    if (typeof parsedResult === 'object' && parsedResult !== null && !Array.isArray(parsedResult)) {
                        successfullyParsedToObject = true;
                        break;
                    } else {
                        currentMessageContent = parsedResult;
                        parseAttempts++;
                    }
                } catch (e) {
                    break;
                }
            }
            
            if (successfullyParsedToObject) {
                finalParsedMessage = parsedResult;
            } else {
                finalParsedMessage = parsedResult; 
                console.error('[WebSocket-Commands] Falha ao parsear a mensagem para um objeto JSON após múltiplas tentativas:', currentMessageContent);
            }

            console.log(`[WebSocket-Commands] Pulando cópia profunda devido a erro persistente; usando rawParsedMessage diretamente.`);
            console.log(`[WebSocket-Commands] DEBUG - finalParsedMessage antes da validação:`, finalParsedMessage);
            console.log(`[WebSocket-Commands] DEBUG - typeof finalParsedMessage:`, typeof finalParsedMessage);
            console.log(`[WebSocket-Commands] DEBUG - !finalParsedMessage:`, !finalParsedMessage);

            if (!finalParsedMessage || typeof finalParsedMessage !== 'object' || Array.isArray(finalParsedMessage)) {
                console.error('[WebSocket-Commands] parsedMessage inválido ou não é um objeto JSON esperado APÓS ATRIBUIÇÃO DIRETA:', finalParsedMessage); 
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }

            console.log('[WebSocket-Commands] Mensagem JSON recebida (APÓS LÓGICA DE PARSE E VALIDAÇÃO FINAL):', finalParsedMessage);
            console.log(`[WebSocket-Commands] DEBUG (before switch) - currentParentId: ${currentParentId}, clientType: ${clientType}`);

            // Desestruturação para pegar campos diretamente no top-level da mensagem
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
                    activeConnections.set(effectiveParentId, { ws: ws, type: 'parent', id: effectiveParentId });
                    if (ws.id !== effectiveParentId) {
                        activeConnections.delete(ws.id);
                        ws.id = effectiveParentId;
                    }
                    parentToWebSocket.set(effectiveParentId, ws);
                    console.log(`[WebSocket-Manager] Conexão parent ${currentParentId} atualizada. Total de entradas: ${activeConnections.size}`);
                    console.log(`[WS-Commands] Pai conectado e identificado: ID: ${currentParentId}, ouvindo filho: ${effectiveChildId || 'nenhum'}`);
                    break;
                case 'childConnect':
                    if (effectiveChildId && effectiveParentId) {
                        clientType = 'child';
                        currentChildId = effectiveChildId;
                        currentParentId = effectiveParentId;
                        currentChildName = effectiveChildName || 'Desconhecido';
                        
                        activeConnections.set(effectiveChildId, { ws: ws, type: 'child', id: effectiveChildId, parentId: effectiveParentId, name: currentChildName });
                        if (ws.id !== effectiveChildId) {
                            activeConnections.delete(ws.id);
                            ws.id = effectiveChildId;
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
                        console.log(`[WS-Commands] Filho conectado e identificado: ID: ${effectiveChildId}, Parent ID: ${effectiveParentId}, Nome: ${effectiveChildName}`);
                        
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
                    const sendingChildInfo = activeConnections.get(ws.id);
                    const sendingChildId = sendingChildInfo ? sendingChildInfo.id : null;
                    const childAssociatedParentId = sendingChildInfo ? sendingChildInfo.parentId : null;

                    if (!sendingChildId || effectiveLatitude === undefined || effectiveLongitude === undefined) {
                        console.warn('[WS-Commands] Mensagem de localização recebida de cliente não identificado ou dados incompletos.');
                        return;
                    }
                    console.log(`[Location] Localização recebida do filho ${sendingChildId}: Lat ${effectiveLatitude}, Lng ${effectiveLongitude}`);

                    const locationParams = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            locationId: uuidv4(),
                            childId: sendingChildId,
                            latitude: effectiveLatitude,
                            longitude: effectiveLongitude,
                            timestamp: effectiveTimestamp || new Date().toISOString()
                        }
                    };
                    await docClient.put(locationParams).promise();

                    const connectedParentWsLocation = parentToWebSocket.get(childAssociatedParentId);
                    if (connectedParentWsLocation && connectedParentWsLocation.readyState === WebSocket.OPEN) {
                        connectedParentWsLocation.send(JSON.stringify({
                            type: 'locationUpdate',
                            childId: sendingChildId,
                            latitude: effectiveLatitude,
                            longitude: effectiveLongitude,
                            timestamp: effectiveTimestamp || new Date().toISOString()
                        }));
                        console.log(`[Location] Localização do filho ${sendingChildId} encaminhada para o pai ${childAssociatedParentId}.`);
                    }
                    break;
                case 'chatMessage':
                    const senderClientInfo = activeConnections.get(ws.id);
                    const senderId = senderClientInfo ? senderClientInfo.id : null;
                    const receiverId = effectiveChildId || effectiveParentId;
                    const senderName = senderClientInfo && senderClientInfo.type === 'child' ? senderClientInfo.name : 'Pai';
                    const receiverClientInfo = activeConnections.get(receiverId);

                    if (!senderId || !receiverId || !chatMessageContent) {
                        console.warn('[WS-Commands] Mensagem de chat inválida: IDs ou mensagem ausentes.');
                        return;
                    }
                    console.log(`[Chat] Mensagem de ${senderName} (${senderId}) para ${receiverId}: ${chatMessageContent}`);

                    const messageParams = {
                        TableName: DYNAMODB_TABLE_MESSAGES,
                        Item: {
                            conversationId: `${senderClientInfo.type === 'parent' ? senderId : receiverId}-${senderClientInfo.type === 'parent' ? receiverId : senderId}`,
                            messageId: uuidv4(),
                            parentId: senderClientInfo.type === 'parent' ? senderId : receiverId,
                            childId: senderClientInfo.type === 'child' ? senderId : receiverId,
                            sender: senderId,
                            message: chatMessageContent,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(messageParams).promise();
                    console.log(`[DynamoDB] Mensagem de chat salva de ${senderId} para ${receiverId}.`);

                    if (receiverClientInfo && receiverClientInfo.ws && receiverClientInfo.ws.readyState === WebSocket.OPEN) {
                        receiverClientInfo.ws.send(JSON.stringify({
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
                    const requestingClientInfoLoc = activeConnections.get(ws.id);
                    const targetChildIdForLocation = effectiveChildId;
                    if (!requestingClientInfoLoc || requestingClientInfoLoc.type !== 'parent' || !targetChildIdForLocation) {
                        console.warn('[WS-Commands] Requisição de localização inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }
                    const targetChildClientWsLocation = childToWebSocket.get(targetChildIdForLocation);
                    if (targetChildClientWsLocation && targetChildClientWsLocation.readyState === WebSocket.OPEN) {
                        targetChildClientWsLocation.send(JSON.stringify({ type: 'requestLocation' }));
                        console.log(`[Location] Requisição de localização enviada para filho ${targetChildIdForLocation}.`);
                        ws.send(JSON.stringify({ type: 'info', message: `Requisição de localização enviada para ${targetChildIdForLocation}.` }));
                    } else {
                        console.warn(`[Location] Filho ${targetChildIdForLocation} não encontrado ou offline para requisição de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildIdForLocation} offline.` }));
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
                    
                    let audioWsOfChild = null;
                    for (const [audioWsInstance, clientInfo] of activeAudioClients.entries()) {
                        if (clientInfo.childId === targetChildIdForAudio && !clientInfo.isParentAudioClient) {
                            audioWsOfChild = audioWsInstance;
                            break;
                        }
                    }

                    console.log(`[Audio-Debug] Tentando encontrar WS de áudio do filho ${targetChildIdForAudio}. Encontrado: ${!!audioWsOfChild}. WS de Áudio Aberto: ${!!audioWsOfChild?.readyState === WebSocket.OPEN}`);
                    if (audioWsOfChild && audioWsOfChild.readyState === WebSocket.OPEN) {
                        audioWsOfChild.send(JSON.stringify({ type: 'startRecording' }));
                        console.log(`[Audio-Server] Comando 'startRecording' enviado para o filho ${targetChildIdForAudio} via WS de áudio.`);

                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'sent',
                            childId: targetChildIdForAudio,
                            message: `Comando 'startRecording' enviado para ${targetChildIdForAudio}.`
                        }));
                    } else {
                        console.warn(`[Audio-Server] Filho ${targetChildIdForAudio} NÃO ENCONTRADO ou offline para comando de áudio.`);
                        console.log(`[Audio-Server-Debug] Conexões de áudio ativas (IDs): ${Array.from(activeAudioClients.values()).map(c => c.childId).filter(Boolean)}`);

                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdForAudio,
                            message: `Filho ${targetChildIdForAudio} offline ou não conectado ao WS de áudio.`
                        }));
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
                    let audioWsOfChildStop = null;
                    for (const [audioWsInstance, clientInfo] of activeAudioClients.entries()) {
                        if (clientInfo.childId === targetChildIdForStopAudio && !clientInfo.isParentAudioClient) {
                            audioWsOfChildStop = audioWsInstance;
                            break;
                        }
                    }

                    if (audioWsOfChildStop && audioWsOfChildStop.readyState === WebSocket.OPEN) {
                        audioWsOfChildStop.send(JSON.stringify({ type: 'stopAudioStreamFromServer' }));
                        console.log(`[Audio-Server] Comando 'stopAudioStreamFromServer' enviado para o filho ${targetChildIdForStopAudio} via WS de áudio.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'stopped',
                            childId: targetChildIdForStopAudio,
                            message: `Comando 'stopAudioStreamFromServer' enviado para ${targetChildIdForStopAudio}.`
                        }));
                    } else {
                        console.warn(`[Audio-Server] Filho ${targetChildIdForStopAudio} não encontrado ou offline para comando de parada de áudio.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdForStopAudio,
                            message: `Filho ${targetChildIdForStopAudio} offline ou não conectado ao WS de áudio para parada.`
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
            } else if (clientType === 'parent' && currentChildId) { // currentChildId aqui é na verdade o parentId para parent
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

                    const parentWs = parentToWebSocket.get(currentParentId); // Usa o parentId do filho
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

// WebSocket Server para Áudio
wssAudio.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const childId = parameters.childId;
    const parentId = parameters.parentId; // Opcional, para logs ou futura lógica

    if (!childId) {
        console.error("[Audio-WS] Conexão de áudio rejeitada: childId ausente nos parâmetros da URL.");
        ws.close();
        return;
    }

    // Registra a conexão de áudio no mapa DEDICADO activeAudioClients
    activeAudioClients.set(ws, { childId: childId, parentId: parentId, isParentAudioClient: false });
    console.log(`[Audio-WS] Filho ${childId} conectado ao WebSocket de áudio. Parent: ${parentId}. Total de conexões de áudio: ${activeAudioClients.size}`);

    ws.on('message', message => {
        try {
            const textMessage = message.toString('utf8');
            if (textMessage.startsWith('{') && textMessage.endsWith('}')) {
                const audioControlMessage = JSON.parse(textMessage);
                console.log(`[Audio-WS] Recebida mensagem de controle do filho ${childId}:`, audioControlMessage);
                if (audioControlMessage.type === 'audioStopped') {
                    console.log(`[Audio-WS] Filho ${childId} relatou que parou de transmitir áudio.`);
                }
            } else if (Buffer.isBuffer(message)) {
                // APENAS ESTA PARTE FOI MODIFICADA: ENCODIFICA O ÁUDIO EM BASE64 E EMBALA EM JSON
                const audioBase64 = message.toString('base64');
                const audioDataJson = JSON.stringify({
                    type: 'audioData',
                    childId: childId, // ID do filho que enviou o áudio
                    data: audioBase64 // Dados de áudio em Base64
                });

                // Encaminha para os pais conectados no CANAL DE COMANDOS
                parentToWebSocket.forEach((parentWs, pId) => {
                    if (parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(audioDataJson);
                        // console.log(`[Audio-WS] Encaminhando áudio em Base64 do filho ${childId} para o pai ${pId}. Tamanho JSON: ${audioDataJson.length}`);
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
        // Remove a conexão de áudio quando o filho desconecta
        activeAudioClients.delete(ws);
        console.log(`[Audio-WS] Conexão de áudio de ${childId} removida. Total: ${activeAudioClients.size}`);
    });

    ws.on('error', error => {
        console.error(`[Audio-WS] Erro no WebSocket de áudio para ${childId}:`, error);
        // Remove em caso de erro também
        activeAudioClients.delete(ws);
    });
});


// Função auxiliar para atualizar o status de conexão no DynamoDB
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
