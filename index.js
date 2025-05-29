const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http'); // Importa o módulo HTTP
const WebSocket = require('ws'); // Importa o módulo WebSocket
const { v4: uuidv4 } = require('uuid'); // Para gerar UUIDs
const url = require('url'); // Adicione esta linha para usar url.parse

const app = express();
const PORT = process.env.PORT || 10000; // Define a porta, padrão 10000

const upload = multer(); // Instancia o multer uma vez

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' // Região padrão, pode ser sobrescrita pela variável de ambiente
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

// --- Constantes para Nomes de Tabelas DynamoDB ---
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Tabela para dados de localização
const DYNAMODB_TABLE_CHILDREN = 'Children';

// --- MIDDLEWARES ---
app.use(cors()); // Habilita CORS para todas as rotas
app.use(bodyParser.json()); // Para parsing de application/json
app.use(bodyParser.urlencoded({ extended: true })); // Para parsing de application/x-www-form-urlencoded

// --- Rotas HTTP (APIs REST) ---

// Rota de teste
app.get('/', (req, res) => {
    console.log('[HTTP] Requisição GET na rota raiz.');
    res.send('Servidor WebSocket e HTTP rodando!');
});

// Rota para registrar um novo filho
app.post('/registerChild', upload.none(), async (req, res) => {
    console.log('[HTTP] Requisição POST para /registerChild.');
    const { parentId, childName, childToken, fcmToken } = req.body;

    if (!parentId || !childName || !childToken || !fcmToken) {
        console.warn('[HTTP_ERROR] Dados incompletos para registro de filho.');
        return res.status(400).send('Dados incompletos.');
    }

    const childId = uuidv4(); // Gera um UUID para o childId

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId,
            parentId: parentId,
            childName: childName,
            childToken: childToken,
            fcmToken: fcmToken,
            registeredAt: new Date().toISOString()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Filho ${childName} (${childId}) registrado com sucesso.`);
        res.status(201).json({ childId: childId, message: 'Filho registrado com sucesso!' });
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao registrar filho:', error);
        res.status(500).send('Erro ao registrar filho.');
    }
});

// Rota para obter todos os filhos registrados - ROTA RESTAURADA
app.get('/children', async (req, res) => {
    console.log('[HTTP] Requisição GET para /children.');
    const { parentId } = req.query;

    if (!parentId) {
        console.warn('[HTTP_ERROR] parentId não fornecido para listar filhos.');
        return res.status(400).send('parentId é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        FilterExpression: 'parentId = :pId',
        ExpressionAttributeValues: {
            ':pId': parentId
        }
    };

    try {
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela 'Children'. Encontrados ${data.Items.length} filhos.`);
        res.json(data.Items);
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao obter filhos:', error);
        res.status(500).send('Erro ao obter filhos.');
    }
});

// Rota para obter mensagens de uma conversa específica (ex: childId)
app.get('/messages', async (req, res) => {
    console.log('[HTTP] Requisição GET para /messages.');
    const { conversationId } = req.query;

    if (!conversationId) {
        console.warn('[HTTP_ERROR] conversationId não fornecido para obter mensagens.');
        return res.status(400).send('conversationId é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        KeyConditionExpression: 'conversationId = :cid',
        ExpressionAttributeValues: {
            ':cid': conversationId
        },
        ScanIndexForward: true // Ordenar por timestamp
    };

    try {
        const data = await docClient.query(params).promise();
        console.log(`[DynamoDB] Mensagens para conversa ${conversationId} solicitadas. Encontradas ${data.Items.length} mensagens.`);
        res.json(data.Items);
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao obter mensagens:', error);
        res.status(500).send('Erro ao obter mensagens.');
    }
});

// Rota para obter o histórico de localizações
app.get('/locations', async (req, res) => {
    console.log('[HTTP] Requisição GET para /locations.');
    const { childId, startDate, endDate } = req.query; // childId é obrigatório para localização

    if (!childId) {
        console.warn('[HTTP_ERROR] childId não fornecido para obter localizações.');
        return res.status(400).send('childId é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        KeyConditionExpression: 'childId = :cId',
        ExpressionAttributeValues: {
            ':cId': childId
        }
    };

    // Adiciona filtro de data se fornecido
    if (startDate && endDate) {
        params.KeyConditionExpression += ' AND #ts BETWEEN :sDate AND :eDate';
        params.ExpressionAttributeNames = { '#ts': 'timestamp' }; // timestamp é uma palavra reservada no DynamoDB
        params.ExpressionAttributeValues[':sDate'] = parseInt(startDate);
        params.ExpressionAttributeValues[':eDate'] = parseInt(endDate);
    }

    try {
        const data = await docClient.query(params).promise();
        console.log(`[DynamoDB] Localizações para childId ${childId} solicitadas. Encontradas ${data.Items.length} localizações.`);
        res.json(data.Items);
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao obter localizações:', error);
        res.status(500).send('Erro ao obter localizações.');
    }
});

// Rota para receber notificações (SMS, Chamadas, etc.)
app.post('/notifications', upload.none(), async (req, res) => {
    console.log('[HTTP] Requisição POST para /notifications.');
    const { childId, message, messageType, timestamp, contactOrGroup, direction, phoneNumber, recipientId, title, body } = req.body;

    if (!childId || !message || !messageType || !timestamp || !contactOrGroup || !direction || !recipientId || !title || !body) {
        console.warn('[HTTP_ERROR] Dados de notificação incompletos.');
        return res.status(400).send('Dados de notificação incompletos.');
    }

    const notificationId = uuidv4();

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES, // Usando a mesma tabela de mensagens para notificações
        Item: {
            conversationId: `notification_${childId}_${contactOrGroup}`, // Cria uma ID de conversa para notificações
            messageId: notificationId,
            childId: childId,
            message: message,
            messageType: messageType,
            timestamp: timestamp,
            contactOrGroup: contactOrGroup,
            direction: direction,
            phoneNumber: phoneNumber,
            recipientId: recipientId,
            title: title,
            body: body
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Notificação tipo ${messageType} registrada para childId ${childId}.`);
        res.status(201).send('Notificação registrada com sucesso!');
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao registrar notificação:', error);
        res.status(500).send('Erro ao registrar notificação.');
    }
});

// Middleware para 404 (rota não encontrada) -- Mantido no final das rotas HTTP
app.use((req, res) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).send('Rota não encontrada');
});

// Middleware para tratamento de erros gerais
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- Configuração do Servidor HTTP e WebSocket ---
const server = http.createServer(app); // Cria um servidor HTTP a partir da aplicação Express

// Mapas para armazenar clientes WebSocket conectados
const clients = new Map(); // Mapa geral de todos os WS conectados (key: ws instance, value: { type, id })
const clientsByChildId = new Map(); // Mapa de clientes WS por childId
const clientsByParentId = new Map(); // Mapa de clientes WS por parentId

// Servidor WebSocket para comandos (GPS, Chat, etc.)
const wss = new WebSocket.Server({ noServer: true });
// Servidor WebSocket para áudio
const wss_audio = new WebSocket.Server({ noServer: true });

// Função auxiliar para enviar mensagem para um cliente específico
function sendMessageToClient(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        console.warn(`[WS_SEND_WARN] Não foi possível enviar mensagem. WebSocket não está OPEN. State: ${ws.readyState}`);
    }
}

// Manipulador de conexão WebSocket para comandos
wss.on('connection', (ws, request, type) => {
    console.log(`[WS_CONNECTION] Novo cliente WebSocket conectado para ${type}.`);
    ws.on('message', (message) => {
        const messageString = message.toString();
        console.log(`[WS_MESSAGE] Mensagem recebida (${type}): ${messageString}`);
        try {
            const parsedMessage = JSON.parse(messageString);
            const { type: msgType, childId, parentId, latitude, longitude, timestamp, message: chatMessage, notificationId, callType } = parsedMessage;

            switch (msgType) {
                case 'childConnect':
                    console.log(`[WS_CHILD_CONNECT] Child ${childId} conectado.`);
                    clients.set(ws, { type: 'child', id: childId });
                    clientsByChildId.set(childId, ws);
                    break;
                case 'parentConnect':
                    console.log(`[WS_PARENT_CONNECT] Parent ${parentId} conectado.`);
                    clients.set(ws, { type: 'parent', id: parentId });
                    clientsByParentId.set(parentId, ws);
                    break;
                case 'locationUpdate':
                    console.log(`[WS_LOCATION_UPDATE] Localização do child ${childId}: Lat ${latitude}, Lng ${longitude}`);
                    // Salvar no DynamoDB
                    const locationParams = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            childId: childId,
                            locationId: uuidv4(), // Gerar um ID único para cada localização
                            latitude: latitude,
                            longitude: longitude,
                            timestamp: timestamp,
                            receivedAt: new Date().toISOString()
                        }
                    };
                    docClient.put(locationParams).promise()
                        .then(() => console.log(`[DynamoDB] Localização do child ${childId} salva com sucesso.`))
                        .catch(err => console.error('[DynamoDB_ERROR] Erro ao salvar localização:', err));

                    // Enviar para os pais conectados
                    clientsByParentId.forEach((parentWs, pId) => {
                        console.log(`[WS_SEND] Enviando localização para o pai ${pId}.`);
                        sendMessageToClient(parentWs, parsedMessage);
                    });
                    break;
                case 'getLocation':
                    console.log(`[WS_COMMAND] Comando 'getLocation' recebido para childId: ${childId}.`);
                    const targetChildWs = clientsByChildId.get(childId);
                    if (targetChildWs) {
                        sendMessageToClient(targetChildWs, { type: 'getLocation' });
                        console.log(`[WS_COMMAND] Comando 'getLocation' enviado para o filho ${childId}.`);
                    } else {
                        console.warn(`[WS_COMMAND_WARN] Filho ${childId} não encontrado online para enviar 'getLocation'.`);
                    }
                    break;
                case 'chatMessage':
                    console.log(`[WS_CHAT] Mensagem de chat: ${chatMessage} de ${parentId} para ${childId}`);
                    // Salvar no DynamoDB (opcional, pode ser feito por outra rota HTTP)
                    // Repassar para o destinatário (childId ou parentId)
                    const targetWs = clients.get(ws)?.type === 'parent' ? clientsByChildId.get(childId) : clientsByParentId.get(parentId);
                    if (targetWs) {
                        sendMessageToClient(targetWs, parsedMessage);
                        console.log(`[WS_CHAT] Mensagem de chat repassada.`);
                    } else {
                        console.warn(`[WS_CHAT_WARN] Destinatário ${childId || parentId} não encontrado online para chat.`);
                    }
                    break;
                case 'notificationStatus':
                    console.log(`[WS_NOTIFICATION] Status de notificação recebido para ${notificationId} do child ${childId}: ${parsedMessage.status}`);
                    // Lógica para atualizar status de notificação, se necessário.
                    break;
                case 'startAudioStream':
                    console.log(`[WS_AUDIO_COMMAND] Comando 'startAudioStream' recebido para childId: ${childId}.`);
                    const audioTargetChildWs = clientsByChildId.get(childId);
                    if (audioTargetChildWs) {
                        sendMessageToClient(audioTargetChildWs, { type: 'startAudioStream' });
                        console.log(`[WS_AUDIO_COMMAND] Comando 'startAudioStream' enviado para o filho ${childId}.`);
                    } else {
                        console.warn(`[WS_AUDIO_COMMAND_WARN] Filho ${childId} não encontrado online para iniciar streaming de áudio.`);
                    }
                    break;
                case 'stopAudioStream':
                    console.log(`[WS_AUDIO_COMMAND] Comando 'stopAudioStream' recebido para childId: ${childId}.`);
                    const stopAudioTargetChildWs = clientsByChildId.get(childId);
                    if (stopAudioTargetChildWs) {
                        sendMessageToClient(stopAudioTargetChildWs, { type: 'stopAudioStream' });
                        console.log(`[WS_AUDIO_COMMAND] Comando 'stopAudioStream' enviado para o filho ${childId}.`);
                    } else {
                        console.warn(`[WS_AUDIO_COMMAND_WARN] Filho ${childId} não encontrado online para parar streaming de áudio.`);
                    }
                    break;
                case 'callInitiate':
                    console.log(`[WS_CALL_INITIATE] Comando 'callInitiate' recebido para childId: ${childId}, callType: ${callType}.`);
                    const callTargetChildWs = clientsByChildId.get(childId);
                    if (callTargetChildWs) {
                        sendMessageToClient(callTargetChildWs, { type: 'initiateCall', childId: childId, callType: callType });
                        console.log(`[WS_CALL_INITIATE] Comando 'initiateCall' enviado para o filho ${childId}.`);
                    } else {
                        console.warn(`[WS_CALL_INITIATE_WARN] Filho ${childId} não encontrado online para iniciar chamada.`);
                    }
                    break;
                case 'callStatus':
                    console.log(`[WS_CALL_STATUS] Status de chamada recebido do child ${childId}: ${parsedMessage.status}.`);
                    // Repassar status para o pai, se houver necessidade
                    clientsByParentId.forEach((parentWs, pId) => {
                        console.log(`[WS_SEND] Enviando status de chamada para o pai ${pId}.`);
                        sendMessageToClient(parentWs, parsedMessage);
                    });
                    break;
                default:
                    console.warn(`[WS_UNKNOWN] Tipo de mensagem desconhecido recebido: ${msgType}`);
            }
        } catch (e) {
            console.error('[WS_ERROR] Erro ao parsear ou processar mensagem WebSocket:', e.message, 'Mensagem original:', messageString);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS_CLOSE] Cliente WebSocket desconectado (${type}). Code: ${code}, Reason: ${reason}`);
        clients.delete(ws);
        // Remover do mapa por childId ou parentId
        for (let [key, value] of clientsByChildId.entries()) {
            if (value === ws) {
                clientsByChildId.delete(key);
                console.log(`[WS_CLEANUP] Child ${key} removido dos clientes online.`);
                break;
            }
        }
        for (let [key, value] of clientsByParentId.entries()) {
            if (value === ws) {
                clientsByParentId.delete(key);
                console.log(`[WS_CLEANUP] Parent ${key} removido dos clientes online.`);
                break;
            }
        }
    });

    ws.on('error', (error) => {
        console.error(`[WS_ERROR] Erro no WebSocket (${type}):`, error.message);
    });
});

// Manipulador de conexão WebSocket para áudio
wss_audio.on('connection', (ws, request, type) => {
    console.log(`[WS_AUDIO_CONNECTION] Novo cliente WebSocket de áudio conectado para ${type}.`);
    ws.on('message', (message) => {
        // As mensagens de áudio são buffers, não JSON
        if (message instanceof Buffer) {
            // console.log(`[WS_AUDIO_MESSAGE] Recebido ${message.length} bytes de áudio.`);
            // Repassar o buffer de áudio para todos os pais conectados (ou para o pai específico que solicitou)
            clientsByParentId.forEach((parentWs, pId) => {
                if (parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(message); // Envia o buffer diretamente
                }
            });
        } else {
            console.warn(`[WS_AUDIO_WARN] Mensagem de áudio recebida não é um buffer.`);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS_AUDIO_CLOSE] Cliente WebSocket de áudio desconectado. Code: ${code}, Reason: ${reason}`);
    });

    ws.on('error', (error) => {
        console.error('[WS_AUDIO_ERROR] Erro no WebSocket de áudio:', error.message);
    });
});

// --- MANIPULADOR DE UPGRADE HTTP (CRÍTICO PARA WEBSOCKETS) ---
// Este evento é disparado quando uma requisição HTTP tem cabeçalhos de "Upgrade"
server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    console.log(`[HTTP_UPGRADE] Requisição de Upgrade recebida para pathname: ${pathname}`); // <<< NOVO LOG CRÍTICO AQUI

    if (pathname === '/ws-commands') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, 'commands');
            console.log(`[WS_UPGRADE_SUCCESS] Upgrade para /ws-commands processado com sucesso.`); // <<< NOVO LOG
        });
    } else if (pathname === '/ws-audio') {
        wss_audio.handleUpgrade(request, socket, head, (ws) => {
            wss_audio.emit('connection', ws, request, 'audio');
            console.log(`[WS_UPGRADE_SUCCESS] Upgrade para /ws-audio processado com sucesso.`); // <<< NOVO LOG
        });
    } else {
        console.warn(`[WS_UPGRADE_FAIL] Pathname '${pathname}' não é um endpoint WebSocket conhecido. Fechando socket.`); // <<< NOVO LOG
        socket.destroy(); // Fecha a conexão se a rota WS não for encontrada
    }
});

// --- INICIO ---
server.listen(PORT, '0.0.0.0', () => { // AGORA USA 'server' AO INVÉS DE 'app'
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos (GPS, Chat) em: ws://localhost:${PORT}/ws-commands`);
    console.log(`WebSocket de áudio em: ws://localhost:${PORT}/ws-audio`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
});