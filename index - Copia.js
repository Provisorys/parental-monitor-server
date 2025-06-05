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
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Mantido como solicitado
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

app.use((req, res, next) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).send('Rota não encontrada.');
});

app.use((err, req, res, next) => {
    console.error('Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

const server = http.createServer(app);

const wssCommands = new WebSocket.Server({ noServer: true });

wssCommands.on('connection', ws => {
    const connectionTempId = uuidv4(); 
    ws.id = connectionTempId;

    wsConnections.set(ws.id, { ws: ws, type: 'unknown', id: connectionTempId, parentId: null, name: null });
    console.log(`[WS-Commands] Novo cliente conectado. WS ID temporário: ${ws.id}. Total de entradas: ${wsConnections.size}`);

    ws.on('message', async message => {
        let parsedMessage = null;
        let messageContent = Buffer.isBuffer(message) ? message.toString('utf8') : message;

        for (let i = 0; i < 5; i++) {
            try {
                const tempParsed = JSON.parse(messageContent);
                if (typeof tempParsed === 'object' && tempParsed !== null && !Array.isArray(tempParsed)) {
                    parsedMessage = tempParsed;
                    break;
                } else {
                    messageContent = tempParsed;
                }
            } catch (e) {
                console.error('[WS-Commands] Falha ao parsear JSON na tentativa ' + (i + 1) + ':', e.message);
                parsedMessage = null;
                break;
            }
        }
        
        if (!parsedMessage || typeof parsedMessage !== 'object' || Array.isArray(parsedMessage)) {
            console.error('[WS-Commands] Mensagem JSON inválida ou não é um objeto esperado (após múltiplas tentativas):', parsedMessage);
            ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
            return;
        }

        console.log(`[WS-Commands] Mensagem JSON recebida (final): ${JSON.stringify(parsedMessage)}`);

        const { type, parentId, childId, childName, latitude, longitude, timestamp, message: chatMessageContent } = parsedMessage;
        
        let effectiveChildId = childId;
        let effectiveChildName = childName;
        let effectiveParentId = parentId;
        let effectiveLatitude = latitude;
        let effectiveLongitude = longitude;
        let effectiveTimestamp = timestamp;

        if (parsedMessage.data) {
            effectiveChildId = parsedMessage.data.childId || effectiveChildId;
            effectiveChildName = parsedMessage.data.childName || effectiveChildName;
            effectiveParentId = parsedMessage.data.parentId || effectiveParentId;
            effectiveLatitude = parsedMessage.data.latitude || effectiveLatitude;
            effectiveLongitude = parsedMessage.data.longitude || effectiveLongitude;
            effectiveTimestamp = parsedMessage.data.timestamp || effectiveTimestamp;
            console.log(`[WS-Commands] Conteúdo de 'data' processado:`, parsedMessage.data);
        }
        
        console.log(`[WS-Commands] Processando tipo: ${type}, parentId: ${effectiveParentId}, childId: ${effectiveChildId}, childName: ${effectiveChildName}`);

        switch (type) {
            case 'parentConnect':
                if (effectiveParentId) {
                    const currentConnInfo = wsConnections.get(ws.id);
                    if (currentConnInfo) {
                        currentConnInfo.type = 'parent';
                        currentConnInfo.id = effectiveParentId;
                        currentConnInfo.parentId = effectiveParentId;
                        wsConnections.set(ws.id, currentConnInfo);
                        parentToWebSocket.set(effectiveParentId, ws);
                        console.log(`[WS-Commands] Pai ${effectiveParentId} identificado e conectado. Total de entradas: ${wsConnections.size}`);
                    } else {
                        console.warn(`[WS-Commands] Conexão ${ws.id} não encontrada em wsConnections ao tentar identificar pai.`);
                    }
                } else {
                    console.warn('[WS-Commands] Mensagem parentConnect inválida: parentId faltando.');
                }
                break;
            case 'childConnect':
                if (effectiveChildId && effectiveParentId) {
                    const currentConnInfo = wsConnections.get(ws.id);
                    if (currentConnInfo) {
                        currentConnInfo.type = 'child';
                        currentConnInfo.id = effectiveChildId;
                        currentConnInfo.parentId = effectiveParentId;
                        currentConnInfo.name = effectiveChildName;
                        wsConnections.set(ws.id, currentConnInfo);
                        childToWebSocket.set(effectiveChildId, ws);

                        try {
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
                            console.log(`[DynamoDB-Update] Filho ${effectiveChildName} (${effectiveChildId}) status de conexão atualizado para 'true'.`);
                        } catch (dbError) {
                            console.error(`[DynamoDB-Update-Error] Erro ao atualizar status 'connected' para TRUE no DynamoDB para childId ${effectiveChildId}:`, dbError);
                        }

                        console.log(`[WS-Commands] Filho ${effectiveChildName} (${effectiveChildId}) conectado e identificado. Parent ID: ${effectiveParentId}.`);
                        
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
                        console.warn(`[WS-Commands] Conexão ${ws.id} não encontrada em wsConnections ao tentar identificar filho.`);
                    }
                } else {
                    console.warn('[WS-Commands] Mensagem childConnect inválida: childId ou parentId faltando.', parsedMessage);
                }
                break;
            case 'locationUpdate':
                const sendingClientInfoLoc = wsConnections.get(ws.id);
                const sendingChildIdLoc = sendingClientInfoLoc?.id;
                const childAssociatedParentIdLoc = sendingClientInfoLoc?.parentId;

                if (!sendingChildIdLoc || effectiveLatitude === undefined || effectiveLongitude === undefined) {
                    console.warn('[WS-Commands] Mensagem de localização recebida de cliente não identificado ou dados incompletos.');
                    return;
                }
                console.log(`[Location] Localização recebida do filho ${sendingChildIdLoc}: Lat ${effectiveLatitude}, Lng ${effectiveLongitude}`);

                const locationParams = {
                    TableName: DYNAMODB_TABLE_LOCATIONS,
                    Item: {
                        locationId: uuidv4(),
                        childId: sendingChildIdLoc,
                        latitude: effectiveLatitude,
                        longitude: effectiveLongitude,
                        timestamp: effectiveTimestamp || new Date().toISOString()
                    }
                };
                try { // Adicionado try-catch para PutItem
                    await docClient.put(locationParams).promise();
                    console.log(`[DynamoDB] Localização armazenada para childId: ${sendingChildIdLoc}.`);
                } catch (dbError) {
                    console.error(`[DynamoDB-Error] Erro ao armazenar localização para childId ${sendingChildIdLoc}:`, dbError);
                    // Pode optar por notificar o pai sobre a falha de armazenamento de localização
                }

                const connectedParentWsLocation = parentToWebSocket.get(childAssociatedParentIdLoc);
                if (connectedParentWsLocation && connectedParentWsLocation.readyState === WebSocket.OPEN) {
                    connectedParentWsLocation.send(JSON.stringify({
                        type: 'locationUpdate',
                        childId: sendingChildIdLoc,
                        latitude: effectiveLatitude,
                        longitude: effectiveLongitude,
                        timestamp: effectiveTimestamp || new Date().toISOString()
                    }));
                    console.log(`[Location] Localização do filho ${sendingChildIdLoc} encaminhada para o pai ${childAssociatedParentIdLoc}.`);
                }
                break;
            case 'chatMessage':
                const senderClientInfo = wsConnections.get(ws.id);
                const senderId = senderClientInfo?.id;
                const receiverId = effectiveChildId || effectiveParentId;
                const senderName = senderClientInfo && senderClientInfo.type === 'child' ? senderClientInfo.name : 'Pai';
                
                let receiverWs = null;
                if (senderClientInfo?.type === 'parent') {
                    receiverWs = childToWebSocket.get(receiverId);
                } else if (senderClientInfo?.type === 'child') {
                    receiverWs = parentToWebSocket.get(receiverId);
                }

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
                const requestingClientInfoLoc = wsConnections.get(ws.id);
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
                const requestingParentInfoAudio = wsConnections.get(ws.id);
                const targetChildIdForAudio = effectiveChildId;
                console.log(`[Audio-Debug] Recebido 'startAudioStream' do pai ${requestingParentInfoAudio ? requestingParentInfoAudio.id : 'desconhecido'} para filho ${targetChildIdForAudio}. ClientType: ${requestingParentInfoAudio ? requestingParentInfoAudio.type : 'desconhecido'}`);
                if (!requestingParentInfoAudio || requestingParentInfoAudio.type !== 'parent' || !targetChildIdForAudio) {
                    console.warn('[WS-Commands] Requisição de áudio inválida: não é pai ou childId ausente.');
                    ws.send(JSON.stringify({ type: 'error', message: 'Requisição de áudio inválida.' }));
                    return;
                }
                
                // <<< MODIFICAÇÃO AQUI: Verificação robusta do estado do WebSocket de áudio
                let audioWsOfChild = null;
                for (const [audioWsInstance, clientInfo] of activeAudioClients.entries()) {
                    // Garante que é o cliente de áudio do filho correto e NÃO é um cliente de áudio do pai (se você implementar um no futuro)
                    if (clientInfo.childId === targetChildIdForAudio && !clientInfo.isParentAudioClient) {
                        audioWsOfChild = audioWsInstance;
                        break;
                    }
                }

                // VERIFICA SE O WEBSOCKET DE ÁUDIO DO FILHO EXISTE E ESTÁ ABERTO
                if (audioWsOfChild && audioWsOfChild.readyState === WebSocket.OPEN) {
                    console.log(`[Audio-Debug] Tentando enviar 'startRecording' para filho ${targetChildIdForAudio}. WS de Áudio Aberto: ${audioWsOfChild.readyState === WebSocket.OPEN}`);
                    audioWsOfChild.send(JSON.stringify({ type: 'startRecording' }));
                    console.log(`[Audio-Server] Comando 'startRecording' enviado para o filho ${targetChildIdForAudio} via WS de áudio.`);

                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'sent',
                        childId: targetChildIdForAudio,
                        message: `Comando 'startRecording' enviado para ${targetChildIdForAudio}.`
                    }));
                } else {
                    console.warn(`[Audio-Server] Filho ${targetChildIdForAudio} não encontrado ou seu WS de áudio NÃO ESTÁ ABERTO (readyState: ${audioWsOfChild ? audioWsOfChild.readyState : 'null'}).`);
                    // Se o WebSocket de áudio não estiver OPEN, remova-o do mapa para manter a consistência
                    if (audioWsOfChild) {
                        activeAudioClients.delete(audioWsOfChild);
                        console.log(`[Audio-Server] Conexão de áudio de ${targetChildIdForAudio} removida do mapa activeAudioClients devido ao estado CLOSED/CLOSING/CONNECTING.`);
                    }
                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'childOffline',
                        childId: targetChildIdForAudio,
                        message: `Filho ${targetChildIdForAudio} offline ou não conectado ao WS de áudio.`
                    }));
                }
                break;
            case 'stopAudioStream':
                const requestingParentInfoStop = wsConnections.get(ws.id);
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

                // VERIFICA SE O WEBSOCKET DE ÁUDIO DO FILHO EXISTE E ESTÁ ABERTO
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
                    console.warn(`[Audio-Server] Filho ${targetChildIdForStopAudio} não encontrado ou seu WS de áudio NÃO ESTÁ ABERTO (readyState: ${audioWsOfChildStop ? audioWsOfChildStop.readyState : 'null'}) para comando de parada.`);
                    // Se o WebSocket de áudio não estiver OPEN, remova-o do mapa
                    if (audioWsOfChildStop) {
                        activeAudioClients.delete(audioWsOfChildStop);
                        console.log(`[Audio-Server] Conexão de áudio de ${targetChildIdForStopAudio} removida do mapa activeAudioClients na tentativa de parada.`);
                    }
                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'childOffline',
                        childId: targetChildIdForStopAudio,
                        message: `Filho ${targetChildIdForAudio} offline ou não conectado ao WS de áudio para parada.`
                    }));
                }
                break;

            default:
                console.warn('[WS-Commands] Tipo de mensagem desconhecido:', type);
        }
    });

    ws.on('close', async (code, reason) => {
        const disconnectedClientInfo = wsConnections.get(ws.id);
        console.log(`[WS-Commands] Cliente desconectado. WS ID: ${ws.id}. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        
        if (disconnectedClientInfo) {
            const { type: disconnectedType, id: disconnectedId, parentId: disconnectedParentId, name: disconnectedName } = disconnectedClientInfo;
            console.log(`[WS-Commands] Info do cliente desconectado: Tipo: ${disconnectedType}, ID: ${disconnectedId}, Parent ID: ${disconnectedParentId}`);

            wsConnections.delete(ws.id);

            if (disconnectedType === 'child' && disconnectedId) {
                childToWebSocket.delete(disconnectedId);
                try {
                    await docClient.update({
                        TableName: DYNAMODB_TABLE_CHILDREN,
                        Key: { childId: disconnectedId },
                        UpdateExpression: 'SET connected = :connected',
                        ExpressionAttributeValues: { ':connected': false }
                    }).promise();
                    console.log(`[DynamoDB-Update] Filho ${disconnectedId} status de conexão atualizado para 'false' no fechamento.`);
                    
                    const parentWs = parentToWebSocket.get(disconnectedParentId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({
                            type: 'childStatus',
                            childId: disconnectedId,
                            status: 'offline',
                            childName: disconnectedName
                        }));
                        console.log(`[WS-Commands] Notificação de status 'offline' enviada para o pai ${disconnectedParentId} para o filho ${disconnectedId}.`);
                    }

                } catch (dbError) {
                    console.error(`[DynamoDB-Update-Error] Erro ao atualizar status 'connected' para FALSE no DynamoDB para childId ${disconnectedId} no fechamento:`, dbError);
                }
            } else if (disconnectedType === 'parent' && disconnectedId) {
                parentToWebSocket.delete(disconnectedId);
                console.log(`[WS-Commands] Pai ${disconnectedId} removido do mapa de pais.`);
            }
        } else {
            console.warn(`[WS-Commands] Cliente desconectado com WS ID ${ws.id} não encontrado em wsConnections. (Já removido ou nunca identificado?)`);
        }
        console.log(`[WS-Manager] Total de entradas ativas após fechamento: ${wsConnections.size}`);
    });

    ws.on('error', error => {
        console.error('[WS-Commands] Erro no cliente WebSocket:', error);
        const erroredClientInfo = wsConnections.get(ws.id);
        if (erroredClientInfo) {
            const { type: erroredType, id: erroredId, parentId: erroredParentId, name: erroredName } = erroredClientInfo;
            console.log(`[WS-Commands] Info do cliente com erro: Tipo: ${erroredType}, ID: ${erroredId}, Parent ID: ${erroredParentId}`);

            wsConnections.delete(ws.id);
            if (erroredType === 'child' && erroredId) {
                childToWebSocket.delete(erroredId);
            } else if (erroredType === 'parent' && erroredId) {
                parentToWebSocket.delete(erroredId);
            }

            if (erroredType === 'child' && erroredId) {
                try {
                    docClient.update({
                        TableName: DYNAMODB_TABLE_CHILDREN,
                        Key: { childId: erroredId },
                        UpdateExpression: 'SET connected = :connected',
                        ExpressionAttributeValues: { ':connected': false }
                    }).promise();
                    console.log(`[DynamoDB-Update] Filho ${erroredId} status de conexão atualizado para 'false' devido a erro.`);
                    
                    const parentWs = parentToWebSocket.get(erroredParentId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({
                            type: 'childStatus',
                            childId: erroredId,
                            status: 'offline',
                            childName: erroredName
                        }));
                        console.log(`[WS-Commands] Notificação de status 'offline' enviada para o pai ${erroredParentId} para o filho ${erroredId} devido a erro.`);
                    }
                } catch (dbError) {
                    console.error(`[DynamoDB-Update-Error] Erro ao atualizar status 'connected' para FALSE no DynamoDB para childId ${erroredId} devido a erro:`, dbError);
                }
            }
        } else {
            console.warn(`[WS-Commands] Cliente com erro (WS ID ${ws.id}) não encontrado em wsConnections.`);
        }
        console.log(`[WS-Manager] Total de entradas ativas após erro: ${wsConnections.size}`);
    });
});

const wssAudio = new WebSocket.Server({ noServer: true });

wssAudio.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const childId = parameters.childId;
    const parentId = parameters.parentId;

    if (!childId) {
        console.error("[WS-Audio] Conexão de áudio rejeitada: childId ausente nos parâmetros da URL.");
        ws.close();
        return;
    }

    // Adiciona a conexão de áudio ao mapa ativo. A chave do mapa é a instância 'ws'.
    // O valor é um objeto com childId, parentId, e uma flag para distinguir de pais se houver um cliente de áudio do pai.
    activeAudioClients.set(ws, { childId: childId, parentId: parentId, isParentAudioClient: false });
    console.log(`[WS-Audio] Filho ${childId} conectado ao WebSocket de áudio. Parent: ${parentId}. Total de conexões de áudio: ${activeAudioClients.size}`);

    ws.on('message', message => {
        try {
            // Tenta converter a mensagem para string para verificar se é um JSON de controle
            const textMessage = message.toString('utf8');
            if (textMessage.startsWith('{') && textMessage.endsWith('}')) {
                const audioControlMessage = JSON.parse(textMessage);
                console.log(`[WS-Audio] Recebida mensagem de controle do filho ${childId}:`, audioControlMessage);
                if (audioControlMessage.type === 'audioStopped') {
                    console.log(`[WS-Audio] Filho ${childId} relatou que parou de transmitir áudio.`);
                }
            } else if (Buffer.isBuffer(message)) {
                // Se não é uma string JSON, assume que é um buffer de áudio binário
                console.log(`[WS-Audio] Recebido buffer de áudio do filho ${childId}. Tamanho: ${message.length} bytes. Encaminhando para pais.`);
                
                const audioBase64 = message.toString('base64');
                const audioMessageForParent = JSON.stringify({
                    type: 'audioData', // Novo tipo de mensagem para o áudio
                    childId: childId,
                    data: audioBase64
                });

                // Encaminha para todos os pais conectados no canal de COMANDOS
                parentToWebSocket.forEach((parentWs, pId) => {
                    if (parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(audioMessageForParent); 
                    }
                });
            }
        } catch (error) {
            console.error(`[WS-Audio] Erro ao processar mensagem do filho ${childId}: ${error.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-Audio] Filho ${childId} desconectado do WebSocket de áudio. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        // Remove a conexão de áudio do mapa quando ela fecha
        activeAudioClients.delete(ws);
        console.log(`[WS-Audio] Conexão de áudio de ${childId} removida. Total: ${activeAudioClients.size}`);
    });

    ws.on('error', error => {
        console.error(`[WS-Audio] Erro no WebSocket de áudio para ${childId}:`, error);
        // Remove a conexão de áudio do mapa em caso de erro
        activeAudioClients.delete(ws);
    });
});

// A função updateChildConnectionStatus não é mais usada diretamente nos eventos WS,
// pois a lógica de atualização está embutida nos handlers on('message') e on('close')
// do wssCommands. Mantida apenas como referência, pode ser removida se não for usada em outro lugar.
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
