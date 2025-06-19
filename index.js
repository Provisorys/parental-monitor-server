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
const wsConnections = new Map(); // Mapa para armazenar todas as conexões WebSocket ativas (temporárias ou por ID)
const childToWebSocket = new Map(); // Mapeia childId para a instância WebSocket do filho no canal de COMANDOS GERAIS
const parentToWebSocket = new Map(); // Mapeia parentId para a instância WebSocket do pai no canal de COMANDOS GERAIS
const activeAudioControlClients = new Map(); // Mapeia childId para a instância WebSocket do filho no canal de CONTROLE de ÁUDIO
// const activeAudioDataClients = new Map(); // Removido, pois dados de áudio agora vêm via HTTP POST para S3

const activeConnections = new Map(); // Mapa para manter todas as conexões ativas com seus IDs (temporários ou reais)

// Mapa para rastrear solicitações de áudio pendentes (quando o canal de áudio do filho está em standby)
const pendingAudioRequests = new Map(); // Key: childId, Value: true (se houver uma solicitação pendente)

const app = express();
const PORT = process.env.PORT || 10000;

// Configuração do Multer:
// 'upload' para uploads gerais (seção de fotos/vídeos existentes)
const upload = multer(); 
// 'audioUpload' específico para áudio, garantindo que o buffer esteja na memória
const audioUpload = multer({ storage: multer.memoryStorage() }); // NOVO: Para a rota /upload-audio

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
        TableName: DählDB_TABLE_CHILDREN, // CORRIGIDO: DYNAMODB_TABLE_CHILDREN
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
        Bucket: bucketName, Body: req.file.buffer, ContentType: req.file.mimetype, ACL: 'private'
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

// --- ROTA PARA RECEBER ÁUDIO VIA HTTP POST (do app filho) ---
// Esta rota receberá chunks de áudio em formato WAV
app.post('/upload-audio', audioUpload.single('audio'), async (req, res) => {
    try {
        const childId = req.body.childId || 'unknown_child';
        const parentIdFromChild = req.body.parentId || 'unknown_parent'; // Recebe parentId do corpo da requisição do filho
        const timestamp = Date.now();
        // Nome de arquivo único no S3 para cada chunk
        const filename = `audios/${childId}/${timestamp}.wav`; 

        if (!req.file || !req.file.buffer) {
            console.error('[HTTP-Upload-Audio] Nenhum arquivo de áudio recebido do filho:', childId);
            return res.status(400).send('Nenhum arquivo de áudio recebido.');
        }

        const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'; // Usar o mesmo bucket do /upload-media
        
        const s3Params = {
            Bucket: bucketName, 
            Key: filename, // Caminho e nome do arquivo no S3
            Body: req.file.buffer, // O conteúdo do arquivo (Buffer)
            ContentType: 'audio/wav', // O tipo MIME do arquivo
            ACL: 'public-read' // MUITO IMPORTANTE: Permite acesso público para o app pai reproduzir a URL
        };

        const s3Result = await s3.upload(s3Params).promise();

        console.log(`[HTTP-Upload-Audio] Áudio recebido de ${childId} e salvo em S3 como ${filename}. URL: ${s3Result.Location}`);

        // Envia a URL do S3 para o aplicativo pai via WebSocket (parentToWebSocket)
        sendS3UrlToParent(parentIdFromChild, childId, s3Result.Location);

        // Responda ao aplicativo filho que o upload foi bem-sucedido
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

// --- WEBSOCKET SERVERS ---
// Note: 'server' já foi definido no topo como http.createServer(app)
// Estas instâncias WebSocket são vinculadas via server.on('upgrade')
const wssGeneralCommands = new WebSocket.Server({ noServer: true }); 
// const wssAudioData = new WebSocket.Server({ noServer: true }); // Removido, pois dados de áudio agora vêm via HTTP POST
const wssAudioControl = new WebSocket.Server({ noServer: true }); 

// Função para atualizar o status de conexão no DynamoDB (já existente)
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

// Lidar com upgrade de HTTP para WebSocket (já existente)
server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    console.log(`[HTTP-Upgrade] Tentativa de upgrade para pathname: ${pathname}`);

    if (pathname === '/ws-general-commands') {
        wssGeneralCommands.handleUpgrade(request, socket, head, ws => {
            wssGeneralCommands.emit('connection', ws, request);
        });
    // REMOVIDO: /ws-audio-data aqui
    } else if (pathname === '/ws-audio-control') {
        wssAudioControl.handleUpgrade(request, socket, head, ws => {
            wssAudioControl.emit('connection', ws, request);
        });
    } else {
        socket.destroy(); 
    }
});

// Função genérica para enviar comandos com re-tentativa (já existente)
function sendCommandWithRetry(childId, commandMessage, targetMap, mapNameForLog, maxRetries = 3, initialDelay = 1000, currentRetry = 0) {
    const targetWs = targetMap.get(childId);
    
    // Log de depuração do estado do mapa
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
            // Notificar o pai que o comando falhou
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


// --- LÓGICA DE WEBSOCKETS ---

// WebSocket de Comandos GERAIS (/ws-general-commands)
// Este WS também será usado para o pai receber URLs de áudio do S3.
wssGeneralCommands.on('connection', ws => {
    ws.id = uuidv4(); // ID temporário inicial
    ws.clientType = 'unknown'; 
    ws.currentParentId = null;
    ws.currentChildId = null;
    ws.currentChildName = null;

    console.log(`[WS-GENERAL-CONN] Nova conexão WS (Temp ID: ${ws.id}). Estado inicial: clientType=${ws.clientType}`);
    activeConnections.set(ws.id, { ws: ws, type: ws.clientType, tempId: ws.id }); // Armazena com ID temporário

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
                         // Se já existe uma conexão para este parentId, a removemos (pode ser uma reconexão)
                         if (parentToWebSocket.has(ws.currentParentId)) {
                             const oldWs = parentToWebSocket.get(ws.currentParentId);
                             console.log(`[WS-GENERAL-CONN] Removendo conexão pai antiga para ${ws.currentParentId} (Temp ID: ${oldWs ? oldWs.id : 'N/A'}).`);
                             oldWs.close(1000, 'Nova conexão estabelecida'); // Fecha a conexão antiga
                             parentToWebSocket.delete(ws.currentParentId);
                             activeConnections.delete(oldWs.id); // Remove do mapa geral se ainda estiver lá
                         }
                         parentToWebSocket.set(ws.currentParentId, ws);
                         // Remove a entrada temporária e adiciona a permanente se ainda não estiver lá
                         if (activeConnections.has(ws.id) && ws.id !== ws.currentParentId) {
                             activeConnections.delete(ws.id);
                             activeConnections.set(ws.currentParentId, { ws: ws, type: ws.clientType, id: ws.currentParentId });
                             ws.id = ws.currentParentId; // Atualiza o ID da instância do WS
                         } else if (!activeConnections.has(ws.currentParentId)) {
                             activeConnections.set(ws.currentParentId, { ws: ws, type: ws.clientType, id: ws.currentParentId });
                             ws.id = ws.currentParentId; // Atualiza o ID da instância do WS
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

                        // Se já existe uma conexão para este childId, a removemos (pode ser uma reconexão)
                        if (childToWebSocket.has(ws.currentChildId)) {
                            const oldWs = childToWebSocket.get(ws.currentChildId);
                            console.log(`[WS-GENERAL-CONN] Removendo conexão filho antiga para ${ws.currentChildId} (Temp ID: ${oldWs ? oldWs.id : 'N/A'}).`);
                            oldWs.close(1000, 'Nova conexão estabelecida'); // Fecha a conexão antiga
                            childToWebSocket.delete(ws.currentChildId);
                            activeConnections.delete(oldWs.id); // Remove do mapa geral se ainda estiver lá
                        }
                        childToWebSocket.set(ws.currentChildId, ws);

                        // Remove a entrada temporária e adiciona a permanente se ainda não estiver lá
                        if (activeConnections.has(ws.id) && ws.id !== ws.currentChildId) {
                            activeConnections.delete(ws.id);
                            activeConnections.set(ws.currentChildId, { ws: ws, type: ws.clientType, id: ws.currentChildId, parentId: ws.currentParentId, name: ws.currentChildName });
                            ws.id = ws.currentChildId; // Atualiza o ID da instância do WS
                        } else if (!activeConnections.has(ws.currentChildId)) {
                            activeConnections.set(effectiveChildId, { ws: ws, type: ws.clientType, id: ws.currentChildId, parentId: ws.currentParentId, name: ws.currentChildName }); // CORRIGIDO: usa effectiveChildId aqui
                            ws.id = effectiveChildId; // Atualiza o ID da instância do WS
                        }


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
                    // Usa a função de re-tentativa para enviar o comando ao filho no CANAL GERAL (onde startLocationUpdates é esperado)
                    sendCommandWithRetry(reqLocChildId, { type: 'startLocationUpdates', parentId: ws.currentParentId }, childToWebSocket, 'General');
                    ws.send(JSON.stringify({ type: 'info', message: `Solicitando localização para ${reqLocChildId}.` }));
                    break;

                case 'stopLocationUpdates': 
                    const stopLocChildId = effectiveChildId; 
                    
                    if (ws.clientType !== 'parent' || !stopLocChildId) { 
                        console.warn(`[WebSocket-General] Requisição de parada de localização inválida: clientType='${ws.clientType}' (esperado 'parent') ou childId='${stopLocChildId}' ausente.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de parada de localização inválida.' }));
                        return;
                    }
                    // Usa a função de re-tentativa para enviar o comando ao filho no CANAL GERAL
                    sendCommandWithRetry(stopLocChildId, { type: 'stopLocationUpdates', parentId: ws.currentParentId }, childToWebSocket, 'General');
                    ws.send(JSON.stringify({
                        type: 'locationCommandStatus',
                        status: 'sent',
                        childId: stopLocChildId,
                        message: `Comando 'stopLocationUpdates' enviado para ${stopLocChildId}.`
                    }));
                    break;
                case 'startAudioStream': // Comando para iniciar áudio (pai -> servidor, via canal geral)
                    console.log(`[WS-General] Comando 'startAudioStream' recebido do pai para filho: ${effectiveChildId}.`);
                    const targetChildIdAudioCommand = effectiveChildId;

                    // IMPORTANTE: Envia o comando startRecording para o CANAL DE CONTROLE DE ÁUDIO do filho
                    sendCommandWithRetry(targetChildIdAudioCommand, { type: 'startRecording', parentId: ws.currentParentId }, activeAudioControlClients, 'AudioControl', 5, 500, 0); 
                    ws.send(JSON.stringify({
                        type: 'audioCommandStatus',
                        status: 'activating',
                        childId: targetChildIdAudioCommand,
                        message: `Ativando canal de áudio para ${targetChildIdAudioCommand}.`
                    }));
                    break;

                case 'stopAudioStream': // Comando para parar áudio (pai -> servidor, via canal geral)
                    console.log(`[WS-General] Comando 'stopAudioStream' recebido do pai para filho: ${effectiveChildId}.`);
                    const targetChildIdStopAudio = effectiveChildId;
                    
                    // IMPORTANTE: Envia o comando stopAudioStreamFromServer para o CANAL DE CONTROLE DE ÁUDIO do filho
                    sendCommandWithRetry(targetChildIdStopAudio, { type: 'stopAudioStreamFromServer', parentId: ws.currentParentId }, activeAudioControlClients, 'AudioControl', 5, 500, 0); 

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
            const rawMessageDebug = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            console.error('[WebSocket-General] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WS-GENERAL-CLOSE] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        console.log(`[WS-GENERAL-CLOSE-DEBUG] Fechando WS. childToWebSocket antes: ${Array.from(childToWebSocket.keys()).join(', ')}. parentToWebSocket antes: ${Array.from(parentToWebSocket.keys()).join(', ')}. Active Connections antes: ${Array.from(activeConnections.keys()).join(', ')}`);
        
        const disconnectedId = ws.id; // Usa o ID atual da instância do WS
        
        activeConnections.delete(disconnectedId);

        if (ws.clientType === 'child' && ws.currentChildId) {
            if (childToWebSocket.has(ws.currentChildId) && childToWebSocket.get(ws.currentChildId) === ws) {
                childToWebSocket.delete(ws.currentChildId);
                console.log(`[WS-GENERAL-CLOSE] Filho ${ws.currentChildId} removido do childToWebSocket.`);
            } else {
                console.warn(`[WS-GENERAL-CLOSE] Filho ${ws.currentChildId} não encontrado ou já substituído no childToWebSocket.`);
            }
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
            if (parentToWebSocket.has(ws.currentParentId) && parentToWebSocket.get(ws.currentParentId) === ws) {
                parentToWebSocket.delete(ws.currentParentId);
                console.log(`[WS-GENERAL-CLOSE] Pai ${ws.currentParentId} removido do parentToWebSocket.`);
            } else {
                console.warn(`[WS-GENERAL-CLOSE] Pai ${ws.currentParentId} não encontrado ou já substituído no parentToWebSocket.`);
            }
             console.log(`[WebSocket-General] Pai ${ws.currentParentId} desconectado.`);
        } else {
             console.warn(`[WS-GENERAL-CLOSE] Cliente desconectado de tipo desconhecido ou sem ID principal (ID: ${disconnectedId}).`);
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas (após remoção): ${activeConnections.size}. Filhos conectados (General WS): ${Array.from(childToWebSocket.keys()).join(', ')}. Pais conectados: ${Array.from(parentToWebSocket.keys()).join(', ')}`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-General] Erro no cliente WebSocket:', error);
        // O evento 'close' também será acionado após um erro, lidando com a remoção.
    });
});

// WebSocket Server para CONTROLE DE ÁUDIO (parent -> server, server -> child)
// Já existe no seu código, mantido como está.
wssAudioControl.on('connection', ws => {
    ws.id = uuidv4(); // ID temporário inicial
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
                    
                    // Se já existe uma conexão de controle de áudio para este childId, a removemos
                    if (activeAudioControlClients.has(effectiveChildId)) {
                        const oldWs = activeAudioControlClients.get(effectiveChildId);
                        console.log(`[WS-AUDIO-CONTROL-CONN] Removendo conexão de controle de áudio antiga para ${effectiveChildId} (Temp ID: ${oldWs ? oldWs.id : 'N/A'}).`);
                        oldWs.close(1000, 'Nova conexão estabelecida'); // Fecha a conexão antiga
                        activeAudioControlClients.delete(effectiveChildId);
                        activeConnections.delete(oldWs.id); // Remove do mapa geral se ainda estiver lá
                    }

                    activeAudioControlClients.set(effectiveChildId, ws); 
                    // Remove a entrada temporária e adiciona a permanente se ainda não estiver lá
                    if (activeConnections.has(ws.id) && ws.id !== effectiveChildId) {
                        activeConnections.delete(ws.id);
                        activeConnections.set(effectiveChildId, { ws: ws, type: ws.clientType, id: effectiveChildId });
                        ws.id = effectiveChildId; // Atualiza o ID da instância do WS
                    } else if (!activeConnections.has(effectiveChildId)) {
                        activeConnections.set(effectiveChildId, { ws: ws, type: ws.clientType, id: effectiveChildId });
                        ws.id = effectiveChildId; // Atualiza o ID da instância do WS
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
                // Estes são comandos que o servidor envia AO FILHO, não que o pai envia PARA o servidor neste canal.
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
            const rawMessageDebug = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            console.error('[WebSocket-AudioControl] Mensagem original (raw):', rawMessageDebug);
            ws.send(JSON.stringify({ type: 'error', message: `Erro interno ao processar sua mensagem: ${error.message}` }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-AUDIO-CONTROL-CLOSE] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        console.log(`[WS-AUDIO-CONTROL-CLOSE-DEBUG] Fechando WS. activeAudioControlClients antes: ${Array.from(activeAudioControlClients.keys()).join(', ')}. Active Connections antes: ${Array.from(activeConnections.keys()).join(', ')}`);

        activeConnections.delete(ws.id); // Remove a conexão pelo seu ID (temporário ou final)

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
        // O evento 'close' também será acionado após um erro, lidando com a remoção.
    });
});


// WebSocket Server para DADOS de ÁUDIO (ANTIGO: filho -> server, server -> parent (via wssGeneralCommands))
// ESTE CÓDIGO ESTÁ COMENTADO PORQUE AGORA USAMOS HTTP POST PARA ENVIAR DADOS DE ÁUDIO PARA O S3
// wssAudioData.on('connection', (ws, req) => {
//     const parameters = url.parse(req.url, true).query;
//     const childId = parameters.childId;
//     const parentId = parameters.parentId;

//     if (!childId || !parentId) {
//         console.error("[Audio-Data-WS] Conexão de dados de áudio rejeitada: childId ou parentId ausente nos parâmetros da URL.");
//         ws.close(1008, "Missing childId or parentId in query"); 
//         return;
//     }
    
//     if (activeAudioDataClients.has(childId)) {
//         const oldWs = activeAudioDataClients.get(childId).ws;
//         console.log(`[WS-AUDIO-DATA-CONN] Removendo conexão de dados de áudio antiga para ${childId} (Temp ID: ${oldWs ? oldWs.id : 'N/A'}).`);
//         oldWs.close(1000, 'Nova conexão de dados de áudio estabelecida');
//         activeConnections.delete(oldWs.id);
//         activeAudioDataClients.delete(childId);
//     }

//     activeAudioDataClients.set(childId, { ws: ws, parentId: parentId }); 
//     const connectionId = uuidv4(); 
//     ws.id = connectionId; 
//     activeConnections.set(connectionId, { ws: ws, type: 'child-audio-data', id: connectionId, currentChildId: childId, currentParentId: parentId });


//     console.log(`[WS-AUDIO-DATA-CONN] Nova conexão WS de dados de áudio: ChildId=${childId}, ParentId=${parentId}. Total de conexões de áudio de dados: ${activeAudioDataClients.size}. Total de entradas ativas: ${activeConnections.size}`);

//     ws.on('message', message => {
//         try {
//             let parsedAudioData;
//             const messageString = Buffer.isBuffer(message) ? message.toString('utf8').trim() : message.toString().trim();
            
//             if (messageString.startsWith('{') && messageString.endsWith('}')) {
//                  try {
//                      parsedAudioData = JSON.parse(messageString);
//                      if (parsedAudioData.type !== 'audioData' || !parsedAudioData.data) {
//                          console.warn(`[Audio-Data-WS] JSON inesperado ou malformatado no canal de dados de áudio de ChildId=${childId}: ${messageString}`);
//                          return;
//                      }
//                  } catch (e) {
//                      console.warn(`[Audio-Data-WS] Erro ao parsear JSON, tratando como Base64. Erro: ${e.message}`);
//                      parsedAudioData = {
//                          type: 'audioData',
//                          childId: childId,
//                          data: Buffer.isBuffer(message) ? message.toString('base64') : message.toString()
//                      };
//                  }
//             } else {
//                 parsedAudioData = {
//                     type: 'audioData',
//                     childId: childId,
//                     data: Buffer.isBuffer(message) ? message.toString('base64') : message.toString()
//                 };
//             }
            
//             parsedAudioData.childId = childId; 
//             parsedAudioData.parentId = parentId; 
            
//             const parentWs = parentToWebSocket.get(parentId); 
//             if (parentWs && parentWs.readyState === WebSocket.OPEN) {
//                 parentWs.send(JSON.stringify(parsedAudioData));
//                 console.log(`[WS-AUDIO-DATA-FORWARD] Encaminhando dados de áudio de ChildId=${childId} para Pai=${parentId} (via WS-General). Tamanho do dado: ${parsedAudioData.data.length}.`);
//             } else {
//                 console.warn(`[WS-AUDIO-DATA-FORWARD] Pai ${parentId} não encontrado ou offline para receber dados de áudio de ${childId}.`);
//             }
//         } catch (error) {
//             console.error(`[Audio-Data-WS] Erro ao processar mensagem do filho ${childId}: ${error.message}`);
//         }
//     });

//     ws.on('close', (code, reason) => {
//         console.log(`[WS-AUDIO-DATA-CLOSE] Filho ${childId} desconectado do WebSocket de dados de áudio (ID: ${ws.id}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
//         console.log(`[WS-AUDIO-DATA-CLOSE-DEBUG] Fechando WS. activeAudioDataClients antes: ${Array.from(activeAudioDataClients.keys()).join(', ')}. Active Connections antes: ${Array.from(activeConnections.keys()).join(', ')}`);

//         activeConnections.delete(ws.id); 
        
//         if (activeAudioDataClients.has(childId) && activeAudioDataClients.get(childId).ws === ws) {
//             activeAudioDataClients.delete(childId);
//             console.log(`[WS-AUDIO-DATA-CLOSE] Conexão de áudio de ${childId} removida.`);
//         } else {
//             console.warn(`[WS-AUDIO-DATA-CLOSE] Conexão de áudio de ${childId} não encontrada ou já substituída.`);
//         }
//         console.log(`[WS-AUDIO-DATA-CLOSE] Total de conexões de áudio de dados: ${activeAudioDataClients.size}. Total de entradas ativas: ${activeConnections.size}.`);
//     });

//     ws.on('error', error => {
//         console.error(`[WS-AUDIO-DATA-ERROR] Erro no WebSocket de dados de áudio para ${childId} (ID: ${ws.id}):`, error);
//     });
// });


// --- INICIO DO SERVIDOR ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos gerais em: ws://localhost:${PORT}/ws-general-commands`);
    // console.log(`WebSocket de dados de áudio em: ws://localhost:${PORT}/ws-audio-data`); // Removido
    console.log(`WebSocket de controle de áudio em: ws://localhost:${PORT}/ws-audio-control`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
});
