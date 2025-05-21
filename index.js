const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000; // Definindo uma porta padrão se não estiver no ambiente

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_CHILDREN = 'Children'; // Não utilizado diretamente neste código, mas mantido
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: ${req.method} ${req.url}`);
    next();
});

app.get('/', (req, res) => {
    res.status(200).send('Servidor Parental Monitor rodando!');
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20 MB
});

// --- ROTAS DE API ---

/**
 * @api {post} /notifications Enviar Notificação de Mensagem
 * @apiName PostNotifications
 * @apiGroup Notifications
 *
 * @apiParam {String} childId ID do filho associado à notificação.
 * @apiParam {String} message Conteúdo da mensagem.
 * @apiParam {String} [messageType=TEXT_MESSAGE] Tipo da mensagem (ex: TEXT_MESSAGE, CALL_START, CALL_END).
 * @apiParam {Number} [timestamp=Date.now()] Timestamp da mensagem.
 * @apiParam {String} [contactOrGroup=unknown] Nome do contato ou grupo.
 * @apiParam {String} [direction=unknown] Direção da mensagem ('sent', 'received', 'unknown').
 * @apiParam {String} [phoneNumber=unknown_number] Número de telefone associado à mensagem.
 *
 * @apiSuccess {String} message Mensagem de sucesso.
 * @apiError {String} message Mensagem de erro.
 */
app.post('/notifications', async (req, res) => {
    const { childId, message, messageType, timestamp, contactOrGroup, direction, phoneNumber } = req.body;
    const timestampValue = timestamp || Date.now();
    const messageTypeString = messageType || 'TEXT_MESSAGE';

    if (!childId || !message) {
        console.warn('[NOTIFICATIONS] Erro: childId ou message faltando.');
        return res.status(400).json({ message: 'childId e message são obrigatórios' });
    }

    const messageDirection = direction || (messageTypeString === "SENT" ? "sent" : messageTypeString === "RECEIVED" ? "received" : "unknown");
    const contactOrGroupValue = contactOrGroup || 'unknown';
    const phoneNumberValue = phoneNumber || 'unknown_number';

    const messageItem = {
        id: timestampValue + Math.floor(Math.random() * 1000), // Usando timestamp + random para garantir unicidade
        childId,
        message,
        messageType: messageTypeString,
        timestamp: timestampValue,
        contactOrGroup: contactOrGroupValue,
        phoneNumber: phoneNumberValue,
        direction: messageDirection
    };

    try {
        await docClient.put({
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageItem
        }).promise();
        console.log('[NOTIFICATIONS] Mensagem salva com sucesso no DynamoDB.');

        console.log('[NOTIFICATIONS] Tentando atualizar conversa no DynamoDB:', { childId: childId, contactOrGroup: contactOrGroupValue });
        await docClient.update({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: {
                childId: childId,
                contactOrGroup: contactOrGroupValue
            },
            UpdateExpression: 'SET #ts = :timestamp, #lm = :lastMessage, #pn = :phoneNumber, #dir = :direction',
            ExpressionAttributeNames: {
                "#ts": 'lastTimestamp',
                "#lm": 'lastMessage',
                "#pn": 'phoneNumber',
                "#dir": 'lastDirection'
            },
            ExpressionAttributeValues: {
                ':timestamp': timestampValue,
                ':lastMessage': message,
                ':phoneNumber': phoneNumberValue,
                ':direction': messageDirection
            }
        }).promise();
        console.log('[NOTIFICATIONS] Conversa atualizada com sucesso no DynamoDB.');

        res.status(200).json({ message: 'Notificação recebida e salva com sucesso' });
    } catch (error) {
        console.error('[NOTIFICATIONS] Erro ao processar notificação:', error);
        res.status(500).json({ message: 'Erro interno', error: error.message });
    }
});

/**
 * @api {post} /media Enviar Mídia (Arquivo)
 * @apiName PostMedia
 * @apiGroup Media
 *
 * @apiHeader {Content-Type} multipart/form-data
 *
 * @apiParam {File} file Arquivo de mídia a ser enviado.
 * @apiParam {String} childId ID do filho associado à mídia.
 * @apiParam {String} [type] Tipo da mídia (ex: image/jpeg, video/mp4, audio/mp3). Se não fornecido, usa o mimetype do arquivo.
 * @apiParam {Number} [timestamp=Date.now()] Timestamp da mídia.
 * @apiParam {String} direction Direção da mídia ('sent' ou 'received').
 * @apiParam {String} [contactOrGroup=unknown] Nome do contato ou grupo.
 * @apiParam {String} [phoneNumber=unknown_number] Número de telefone associado à mídia.
 *
 * @apiSuccess {String} message Mensagem de sucesso.
 * @apiSuccess {String} s3Url URL do arquivo no S3.
 * @apiError {String} message Mensagem de erro.
 */
app.post('/media', upload.single('file'), async (req, res) => {
    const { childId, type, timestamp, direction, contactOrGroup, phoneNumber } = req.body;
    const file = req.file;
    const timestampValue = timestamp || Date.now();

    if (!file) {
        console.warn('[MEDIA] Erro: Arquivo é obrigatório.');
        return res.status(400).json({ message: 'Arquivo é obrigatório' });
    }
    if (!direction || !['sent', 'received'].includes(direction)) {
        console.warn('[MEDIA] Erro: direction deve ser "sent" ou "received".');
        return res.status(400).json({ message: 'direction deve ser "sent" ou "received"' });
    }

    const contactOrGroupValue = contactOrGroup || 'unknown';
    const phoneNumberValue = phoneNumber || 'unknown_number';
    const fileExtension = file.originalname ? `.${file.originalname.split('.').pop()}` : '';
    const mediaId = timestampValue + Math.floor(Math.random() * 1000); // Usando timestamp + random para garantir unicidade
    const s3Key = `media/${childId}/${mediaId}${fileExtension}`;

    try {
        await s3.upload({
            Bucket: S3_BUCKET_NAME,
            Key: s3Key,
            Body: file.buffer,
            ContentType: file.mimetype
        }).promise();
        console.log(`[MEDIA] Arquivo ${s3Key} enviado com sucesso para S3.`);

        const messageItem = {
            id: mediaId,
            childId,
            message: `Mídia (${type || file.mimetype})`,
            messageType: type || file.mimetype,
            timestamp: timestampValue,
            contactOrGroup: contactOrGroupValue,
            phoneNumber: phoneNumberValue,
            direction,
            s3Url: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`
        };

        await docClient.put({
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageItem
        }).promise();
        console.log('[MEDIA] Entrada de mídia salva com sucesso no DynamoDB.');

        await docClient.update({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: {
                childId: childId,
                contactOrGroup: contactOrGroupValue
            },
            UpdateExpression: 'SET #ts = :timestamp, #lm = :lastMessage, #pn = :phoneNumber, #dir = :direction',
            ExpressionAttributeNames: {
                '#ts': 'lastTimestamp',
                '#lm': 'lastMessage',
                '#pn': 'phoneNumber',
                '#dir': 'lastDirection'
            },
            ExpressionAttributeValues: {
                ':timestamp': timestampValue,
                ':lastMessage': `Mídia (${type || file.mimetype})`,
                ':phoneNumber': phoneNumberValue,
                ':direction': direction
            }
        }).promise();
        console.log('[MEDIA] Conversa atualizada com sucesso no DynamoDB para mídia.');

        res.status(200).json({ message: 'Mídia recebida com sucesso', s3Url: messageItem.s3Url });

    } catch (error) {
        console.error('[MEDIA] Erro ao processar mídia:', error);
        res.status(500).json({ message: 'Erro ao processar mídia', error: error.message });
    }
});

/**
 * @api {get} /get-conversations/:childId Obter Conversas de um Filho
 * @apiName GetConversations
 * @apiGroup Conversations
 *
 * @apiParam {String} childId ID do filho.
 *
 * @apiSuccess {Object[]} groupedConversations Lista de conversas agrupadas por contato/grupo.
 * @apiSuccess {String} groupedConversations.contactOrGroup Nome do contato ou grupo.
 * @apiSuccess {String} groupedConversations.phoneNumber Número de telefone do contato/grupo.
 * @apiSuccess {Number} groupedConversations.lastTimestamp Último timestamp de mensagem nesta conversa.
 * @apiSuccess {String} groupedConversations.lastMessage Última mensagem nesta conversa.
 * @apiSuccess {String} groupedConversations.lastDirection Direção da última mensagem.
 * @apiSuccess {Object[]} groupedConversations.messages Lista de mensagens dentro desta conversa, ordenada pela mais recente.
 * @apiError {String} message Mensagem de erro.
 */
app.get('/get-conversations/:childId', async (req, res) => {
    const { childId } = req.params;
    if (!childId) {
        console.warn('[CONVERSATIONS] Erro: childId é obrigatório na requisição de conversas.');
        return res.status(400).json({ message: 'childId é obrigatório' });
    }

    try {
        console.log(`[CONVERSATIONS] Buscando conversas para childId: ${childId} na tabela ${DYNAMODB_TABLE_CONVERSATIONS}`);
        const convData = await docClient.query({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: {
                ':cid': childId
            }
        }).promise();

        console.log(`[CONVERSATIONS] Conversas encontradas para ${childId}: ${convData.Items.length} itens.`);

        const groupedConversations = [];

        for (const conv of convData.Items) {
            console.log(`[CONVERSATIONS] Buscando mensagens para conversa: ${conv.contactOrGroup} (childId: ${childId})`);
            const scanMessages = await docClient.scan({ // Utilizando scan com FilterExpression porque query em uma tabela sem GSI por contactOrGroup não é eficiente.
                TableName: DYNAMODB_TABLE_MESSAGES,
                FilterExpression: 'childId = :cid AND contactOrGroup = :cog AND phoneNumber = :pn',
                ExpressionAttributeValues: {
                    ':cid': childId,
                    ':cog': conv.contactOrGroup,
                    ':pn': conv.phoneNumber
                }
            }).promise();

            const messages = scanMessages.Items || [];
            messages.sort((a, b) => b.timestamp - a.timestamp); // Ordena as mensagens pela mais recente primeiro
            console.log(`[CONVERSATIONS] Mensagens encontradas para ${conv.contactOrGroup}: ${messages.length} itens.`);

            groupedConversations.push({
                contactOrGroup: conv.contactOrGroup,
                phoneNumber: conv.phoneNumber,
                lastTimestamp: conv.lastTimestamp,
                lastMessage: conv.lastMessage,
                lastDirection: conv.lastDirection,
                messages
            });
        }

        groupedConversations.sort((a, b) => b.lastTimestamp - a.lastTimestamp); // Ordena as conversas pela mais recente primeiro
        res.status(200).json(groupedConversations);

    } catch (error) {
        console.error('[CONVERSATIONS] Erro ao buscar conversas:', error);
        res.status(500).json({ message: 'Erro ao buscar conversas', error: error.message });
    }
});

/**
 * @api {get} /get-child-ids Obter Todos os IDs de Filhos
 * @apiName GetChildIds
 * @apiGroup Children
 *
 * @apiSuccess {String[]} childIds Lista de IDs de filhos únicos.
 * @apiError {String} message Mensagem de erro.
 */
app.get('/get-child-ids', async (req, res) => {
    try {
        console.log(`[CHILD_IDS] Tentando escanear child IDs na tabela ${DYNAMODB_TABLE_CONVERSATIONS} do DynamoDB.`);
        const data = await docClient.scan({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            ProjectionExpression: 'childId',
        }).promise();

        const childIds = [...new Set(data.Items.map(item => item.childId))]; // Garante IDs únicos
        console.log('[CHILD_IDS] childIDs encontrados no DynamoDB (GET /get-child-ids):', childIds);

        res.status(200).json(childIds);
    } catch (error) {
        console.error('[CHILD_IDS] Erro ao listar child IDs:', error);
        res.status(500).json({ message: 'Erro ao listar child IDs', error: error.message });
    }
});

/**
 * @api {post} /rename-child-id/:oldChildId/:newChildId Renomear ID de Filho (Não Implementado)
 * @apiName RenameChildId
 * @apiGroup Children
 *
 * @apiParam {String} oldChildId O ID do filho a ser renomeado.
 * @apiParam {String} newChildId O novo ID para o filho.
 *
 * @apiError {String} message Mensagem indicando que a funcionalidade não está implementada.
 */
app.post('/rename-child-id/:oldChildId/:newChildId', async (req, res) => {
    // Esta funcionalidade seria complexa, exigindo atualização em múltiplas tabelas.
    // É mantida como um placeholder para futuras implementações, se necessário.
    return res.status(501).json({
        message: 'Funcionalidade de renomear childId não está implementada.'
    });
});

/**
 * @api {get} /twilio-token Obter Token Twilio
 * @apiName GetTwilioToken
 * @apiGroup Twilio
 *
 * @apiParam {String} identity A identidade do cliente para o token Twilio.
 *
 * @apiSuccess {String} token Token de acesso Twilio.
 * @apiError {String} error Mensagem de erro.
 */
app.get('/twilio-token', (req, res) => {
    const { identity } = req.query;

    if (!identity) {
        console.warn('[TWILIO] Erro: A identidade (identity) é obrigatória para o token Twilio.');
        return res.status(400).send('A identidade (identity) é obrigatória.');
    }

    try {
        const accessToken = new twilio.jwt.AccessToken(
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID,
            TWILIO_API_KEY_SECRET,
            { identity: identity }
        );

        const grant = new twilio.jwt.AccessToken.VideoGrant(); // Grant para Twilio Video
        accessToken.addGrant(grant);

        res.json({ token: accessToken.toJwt() });

        console.log(`[TWILIO] Token Twilio gerado para identidade: ${identity}`);
    } catch (error) {
        console.error('[TWILIO] Erro ao gerar token Twilio:', error);
        res.status(500).json({ error: 'Erro ao gerar token Twilio', details: error.message });
    }
});

/**
 * @api {post} /start-microphone Enviar Comando para Ligar Microfone do Filho
 * @apiName StartMicrophone
 * @apiGroup Commands
 *
 * @apiParam {String} childId ID do filho alvo.
 *
 * @apiSuccess {String} message Mensagem de sucesso.
 * @apiError {String} message Mensagem de erro.
 */
app.post('/start-microphone', async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /start-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /start-microphone para o filho: ${childId}`);

    const childWs = findChildWebSocket(childId);

    if (childWs) {
        try {
            const command = JSON.stringify({ type: 'START_AUDIO' });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando '${command}' enviado via WebSocket para o filho: ${childId}`);
            res.status(200).json({ message: `Comando START_AUDIO enviado para ${childId}.` });
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando START_AUDIO via WebSocket para ${childId}:`, error);
            res.status(500).json({ message: 'Erro ao enviar comando para o filho.', error: error.message });
        }
    } else {
        console.warn(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando START_AUDIO NÃO PODE ser enviado.`);
        res.status(404).json({ message: `Filho ${childId} não está conectado via WebSocket.` });
    }
});

/**
 * @api {post} /stop-microphone Enviar Comando para Desligar Microfone do Filho
 * @apiName StopMicrophone
 * @apiGroup Commands
 *
 * @apiParam {String} childId ID do filho alvo.
 *
 * @apiSuccess {String} message Mensagem de sucesso.
 * @apiError {String} message Mensagem de erro.
 */
app.post('/stop-microphone', async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /stop-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /stop-microphone para o filho: ${childId}`);

    const childWs = findChildWebSocket(childId);

    if (childWs) {
        try {
            const command = JSON.stringify({ type: 'STOP_AUDIO' });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando '${command}' enviado via WebSocket para o filho: ${childId}`);
            res.status(200).json({ message: `Comando STOP_AUDIO enviado para ${childId}.` });
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando STOP_AUDIO via WebSocket para ${childId}:`, error);
            res.status(500).json({ message: 'Erro ao enviar comando para o filho.', error: error.message });
        }
    } else {
        console.warn(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando STOP_AUDIO NÃO PODE ser enviado.`);
        res.status(404).json({ message: `Filho ${childId} não está conectado via WebSocket.` });
    }
});

// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/audio-stream' });

const parentListeningSockets = new Map(); // Mapa: childId -> WebSocket do pai que está ouvindo
const activeChildWebSockets = new Map(); // Mapa: childId -> WebSocket do filho ativo

// --- FUNÇÃO AUXILIAR PARA WEBSOCKETS ---
function findChildWebSocket(childId) {
    const targetClient = activeChildWebSockets.get(childId);
    console.log(`[WS_FIND] Buscando WebSocket para childId: ${childId}. Estado atual do mapa activeChildWebSockets: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`); // Log de debug
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
        console.log(`[WS_FIND] WebSocket ENCONTRADO e ABERTO para childId: ${childId}`); // Log de debug
        return targetClient;
    }
    console.log(`[WS_FIND] WebSocket NÃO ENCONTRADO ou FECHADO para childId: ${childId}. readyState: ${targetClient ? targetClient.readyState : 'N/A'}`); // Log de debug
    return null;
}

wss.on('connection', ws => {
    ws.id = uuidv4(); // Atribui um ID único a cada conexão WebSocket
    console.log(`[WS_CONNECT] Novo cliente WebSocket conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wss.clients.size}`);

    ws.isParent = false; // Flag para identificar se a conexão é de um pai
    ws.clientId = null; // ID do filho, se for uma conexão de filho
    ws.parentId = null; // ID do pai, se for uma conexão de pai

    ws.on('message', message => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);

        let processedAsText = false; // Flag para controlar se a mensagem foi processada como texto

        // Tenta processar como string primeiro
        if (typeof message === 'string') {
            const messageString = message.toString();
            const displayMessage = messageString.length > 100 ? messageString.substring(0, 100) + '...' : messageString;
            console.log(`[WS_MSG] [${messageOrigin}] Mensagem WebSocket de TEXTO recebida: "${displayMessage}"`);

            if (messageString.startsWith('CHILD_ID:')) {
                ws.clientId = messageString.substring('CHILD_ID:'.length);
                ws.isParent = false;
                activeChildWebSockets.set(ws.clientId, ws);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                // Se um pai já estava tentando ouvir este filho, envia o comando START_AUDIO
                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou. Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                    ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                } else {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado, mas nenhum pai está ouvindo ativamente neste momento.`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('PARENT_ID:')) {
                ws.isParent = true;
                ws.parentId = messageString.substring('PARENT_ID:'.length);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Pai conectado com ID: ${ws.parentId || 'desconhecido'}`);
                processedAsText = true;
            } else if (messageString.startsWith('LISTEN_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('LISTEN_TO_CHILD:'.length);
                    // Mapeia o childId para o WebSocket do pai que está ouvindo
                    parentListeningSockets.set(targetChildId, ws);
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                    // Envia comando START_AUDIO para o filho se ele já estiver conectado
                    const childWs = findChildWebSocket(targetChildId);
                    if (childWs) {
                        childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal START_AUDIO enviado para o filho ${targetChildId} via WebSocket (pedido de escuta do pai).`);
                    } else {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não encontrado no mapa activeChildWebSockets, mas pai (ID: ${ws.parentId || 'desconhecido'}) está esperando.`);
                    }
                    ws.send(JSON.stringify({ type: 'STATUS', message: `Você está ouvindo ${targetChildId}` }));
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de escuta apenas para pais.' }));
                    console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando LISTEN_TO_CHILD de um cliente não-pai. Mensagem: ${messageString}`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('STOP_LISTENING_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('STOP_LISTENING_TO_CHILD:'.length);
                    // Remove o pai do mapa de ouvintes para este filho
                    if (parentListeningSockets.has(targetChildId) && parentListeningSockets.get(targetChildId) === ws) {
                        parentListeningSockets.delete(targetChildId);
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                        // Verifica se ainda há outros pais ouvindo o mesmo filho. Se não houver, envia STOP_AUDIO.
                        let anotherParentListening = false;
                        for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                            if (childIdInMap === targetChildId && parentWsInMap.readyState === WebSocket.OPEN) {
                                anotherParentListening = true;
                                break;
                            }
                        }

                        if (!anotherParentListening) {
                            const childWs = findChildWebSocket(targetChildId);
                            if (childWs) {
                                childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                                console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal STOP_AUDIO enviado para o filho ${targetChildId} (nenhum pai mais ouvindo).`);
                            }
                        }
                        ws.send(JSON.stringify({ type: 'STATUS', message: `Você parou de ouvir ${targetChildId}` }));
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Você não estava ouvindo este filho.' }));
                        console.warn(`[WS_MSG] [Conexão ${ws.id}] Pai tentou parar de ouvir ${targetChildId} mas não estava registrado como ouvinte.`);
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de parada de escuta apenas para pais.' }));
                    console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando STOP_LISTENING_TO_CHILD de um cliente não-pai. Mensagem: ${messageString}`);
                }
                processedAsText = true;
            } else if (ws.isParent && messageString.startsWith('COMMAND:')) {
                const command = messageString.substring('COMMAND:'.length);
                console.log(`[WS_MSG] [${messageOrigin}] Comando de pai recebido: ${command}`);
                // Futuramente, pode haver lógica para encaminhar comandos específicos para filhos
                processedAsText = true;
            } else {
                console.warn(`[WS_MSG] [${messageOrigin}] Mensagem de texto desconhecida ou inesperada: ${displayMessage}`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de texto desconhecido ou não permitido.' }));
                processedAsText = true;
            }
        }

        // Se não foi processada como string, tente decodificar como UTF-8 se for binário
        if (!processedAsText && (message instanceof Buffer || message instanceof ArrayBuffer)) {
            try {
                // Tenta decodificar como string para ver se é um comando em formato de string binária (ex: de certas bibliotecas mobile)
                const decodedMessage = message.toString('utf8');
                const displayDecodedMessage = decodedMessage.length > 100 ? decodedMessage.substring(0, 100) + '...' : decodedMessage;
                // console.log(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida. Tentando decodificar como UTF-8: "${displayDecodedMessage}"`); // Habilitar para depuração profunda

                if (decodedMessage.startsWith('CHILD_ID:')) {
                    ws.clientId = decodedMessage.substring('CHILD_ID:'.length);
                    ws.isParent = false;
                    activeChildWebSockets.set(ws.clientId, ws);
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado (via binário decodificado) e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                    const parentWs = parentListeningSockets.get(ws.clientId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou (via binário decodificado). Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                        ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                    } else {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado (via binário decodificado), mas nenhum pai está ouvindo ativamente neste momento.`);
                    }
                } else if (ws.clientId && !ws.isParent) {
                    // Se já tiver um clientId e não for um pai, assume que é áudio e retransmite
                    const parentWs = parentListeningSockets.get(ws.clientId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(message); // Retransmite o Buffer original
                        // console.log(`[WS_MSG] [${messageOrigin}] Bytes de áudio retransmitidos para o pai de ${ws.clientId}: ${message.length} bytes.`); // Habilitar para depuração de fluxo de áudio
                    } else {
                        // console.log(`[WS_MSG] [${messageOrigin}] Pai não está ouvindo o filho ${ws.clientId}, descartando ${message.length} bytes de áudio.`); // Habilitar para depuração de fluxo de áudio
                    }
                } else {
                    console.warn(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida que não é CHILD_ID e não é esperada para áudio neste contexto. Tamanho: ${message.length} bytes. Decodificado (parcial): "${displayDecodedMessage}"`);
                }
            } catch (e) {
                console.error(`${messageOrigin} Erro ao decodificar mensagem binária como UTF-8: ${e.message}`, e);
                console.warn(`${messageOrigin} Mensagem binária recebida inesperada (não pôde ser decodificada como UTF-8): ${message.length} bytes.`);
            }
        } else if (!processedAsText) { // Se não foi string e não foi Buffer/ArrayBuffer
            console.warn(`[WS_MSG] [${messageOrigin}] Mensagem recebida não é string nem binária esperada. Tipo: ${typeof message}, Tamanho: ${message ? message.length : 'N/A'}`);
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WS_CLOSE] [${messageOrigin}] Cliente WebSocket desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}. Total de conexões ativas: ${wss.clients.size - 1}`);

        // Lógica para remover o filho do mapa de ativos quando ele se desconecta
        if (ws.clientId) {
            console.log(`[WS_CLOSE] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WS_CLOSE] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

            // Notifica qualquer pai que esteja ouvindo este filho que o filho se desconectou e remove a escuta
            let hadActiveParent = false;
            for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                if (childIdInMap === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                    parentWsInMap.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId }));
                    console.log(`[WS_CLOSE] [${parentWsInMap.id}] Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${ws.clientId}.`);
                    parentListeningSockets.delete(childIdInMap); // Remove a entrada de escuta
                    hadActiveParent = true;
                }
            }
            if (hadActiveParent) {
                console.log(`[WS_CLOSE] [${messageOrigin}] Removida a escuta de pais para o filho desconectado ${ws.clientId}.`);
            }
        } else if (ws.isParent && ws.parentId) {
            // Se for um pai se desconectando, remove ele de todas as escutas que ele estava fazendo
            console.log(`[WS_CLOSE] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado.`);
            for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                if (parentWsListening === ws) { // Se o WS desconectado é o pai que estava ouvindo
                    parentListeningSockets.delete(childIdBeingListened);
                    console.log(`[WS_CLOSE] [${messageOrigin}] Pai ${ws.parentId} parou de ouvir o filho: ${childIdBeingListened}.`);

                    // Verifica se ainda há outros pais ouvindo o mesmo filho. Se não houver, envia STOP_AUDIO para o filho.
                    let anotherParentStillListening = false;
                    for (const [cId, pWs] of parentListeningSockets.entries()) {
                        if (cId === childIdBeingListened && pWs.readyState === WebSocket.OPEN) {
                            anotherParentStillListening = true;
                            break;
                        }
                    }

                    if (!anotherParentStillListening) {
                        const childWs = findChildWebSocket(childIdBeingListened);
                        if (childWs) {
                            childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                            console.log(`[WS_CLOSE] [Conexão ${childWs.id}] Sinal STOP_AUDIO enviado para o filho ${childIdBeingListened} (nenhum pai mais ouvindo após desconexão).`);
                        }
                    }
                }
            }
        } else {
            console.log(`[WS_CLOSE] [Conexão ${ws.id}] Cliente WebSocket desconectado sem ID de filho ou pai.`);
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.error(`[WS_ERROR] [${messageOrigin}] Erro no WebSocket:`, error);
        // Lógica de limpeza semelhante ao 'close' em caso de erro
        if (ws.clientId) {
            console.log(`[WS_ERROR] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets devido a um erro.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WS_ERROR] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

            for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                if (childIdInMap === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                    parentWsInMap.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId }));
                    console.log(`[WS_ERROR] [${parentWsInMap.id}] Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${ws.clientId} devido a um erro.`);
                    parentListeningSockets.delete(childIdInMap);
                }
            }
        } else if (ws.isParent && ws.parentId) {
           for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
               if (parentWsListening === ws) {
                   parentListeningSockets.delete(childIdBeingListened);
                   console.log(`[WS_ERROR] [${messageOrigin}] Pai ${ws.parentId} removido do mapa de ouvintes para ${childIdBeingListened} devido a um erro.`);

                   let anotherParentStillListening = false;
                   for (const [cId, pWs] of parentListeningSockets.entries()) {
                       if (cId === childIdBeingListened && pWs.readyState === WebSocket.OPEN) {
                           anotherParentStillListening = true;
                           break;
                       }
                   }
                   if (!anotherParentStillListening) {
                       const childWs = findChildWebSocket(childIdBeingListened);
                       if (childWs) {
                           childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                           console.log(`[WS_ERROR] [Conexão ${childWs.id}] Sinal STOP_AUDIO enviado para o filho ${childIdBeingListened} (nenhum pai mais ouvindo após erro).`);
                       }
                   }
               }
           }
        }
    });
});

// Inicia o servidor HTTP e WebSocket
server.listen(PORT, () => {
    console.log(`Servidor Parental Monitor ouvindo na porta ${PORT}`);
});

// --- ERROS ---
// Middleware para rotas não encontradas
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});

// Middleware para tratamento de erros gerais do servidor
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Twilio Account SID configurado via env: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurada via env: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurada via env: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
});