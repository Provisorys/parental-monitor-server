const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process'); // Importar child_process

const app = express();
const PORT = process.env.PORT || 3000;

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_CHILDREN = 'Children';
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- STREAMING CONFIG ---
// A URL base para onde os streams de áudio serão servidos.
// Se você estiver usando Nginx RTMP, seria algo como 'rtmp://seu-dominio.com/live/'
// Se o próprio Node.js for servir os arquivos (mais complexo e pode exigir HTTP Live Streaming - HLS/DASH para clientes web),
// então seria a URL do seu servidor.
const STREAM_BASE_URL = process.env.STREAM_BASE_URL || 'http://localhost:8000/live/'; // Exemplo com Nginx RTMP

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
    limits: { fileSize: 20 * 1024 * 1024 }
});

// --- ROTAS DE API (mantidas as existentes) ---
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
        id: timestampValue + Math.floor(Math.random() * 1000),
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
    const mediaId = timestampValue + Math.floor(Math.random() * 1000);
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
            const scanMessages = await docClient.scan({
                TableName: DYNAMODB_TABLE_MESSAGES,
                FilterExpression: 'childId = :cid AND contactOrGroup = :cog AND phoneNumber = :pn',
                ExpressionAttributeValues: {
                    ':cid': childId,
                    ':cog': conv.contactOrGroup,
                    ':pn': conv.phoneNumber
                }
            }).promise();

            const messages = scanMessages.Items || [];
            messages.sort((a, b) => b.timestamp - a.timestamp);
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

        groupedConversations.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
        res.status(200).json(groupedConversations);

    } catch (error) {
        console.error('[CONVERSATIONS] Erro ao buscar conversas:', error);
        res.status(500).json({ message: 'Erro ao buscar conversas', error: error.message });
    }
});

app.get('/get-child-ids', async (req, res) => {
    try {
        console.log(`[CHILD_IDS] Tentando escanear child IDs na tabela ${DYNAMODB_TABLE_CONVERSATIONS} do DynamoDB.`);
        const data = await docClient.scan({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            ProjectionExpression: 'childId',
        }).promise();

        const childIds = [...new Set(data.Items.map(item => item.childId))];
        console.log('[CHILD_IDS] childIDs encontrados no DynamoDB (GET /get-child-ids):', childIds);

        res.status(200).json(childIds);
    } catch (error) {
        console.error('[CHILD_IDS] Erro ao listar child IDs:', error);
        res.status(500).json({ message: 'Erro ao listar child IDs', error: error.message });
    }
});

app.post('/rename-child-id/:oldChildId/:newChildId', async (req, res) => {
    return res.status(501).json({
        message: 'Funcionalidade de renomear childId não está implementada.'
    });
});

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

        const grant = new twilio.jwt.AccessToken.VideoGrant();
        accessToken.addGrant(grant);

        res.json({ token: accessToken.toJwt() });

        console.log(`[TWILIO] Token Twilio gerado para identidade: ${identity}`);
    } catch (error) {
        console.error('[TWILIO] Erro ao gerar token Twilio:', error);
        res.status(500).json({ error: 'Erro ao gerar token Twilio', details: error.message });
    }
});

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
const ffmpegProcesses = new Map(); // Mapa: childId -> Processo FFmpeg

// --- FUNÇÃO AUXILIAR PARA WEBSOCKETS ---
function findChildWebSocket(childId) {
    const targetClient = activeChildWebSockets.get(childId);
    console.log(`[WS_FIND] Buscando WebSocket para childId: ${childId}. Estado atual do mapa activeChildWebSockets: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
        console.log(`[WS_FIND] WebSocket ENCONTRADO e ABERTO para childId: ${childId}`);
        return targetClient;
    }
    console.log(`[WS_FIND] WebSocket NÃO ENCONTRADO ou FECHADO para childId: ${childId}. readyState: ${targetClient ? targetClient.readyState : 'N/A'}`);
    return null;
}

/**
 * Inicia um processo FFmpeg para receber áudio de um filho e retransmiti-lo.
 * @param {string} childId - O ID do filho que está transmitindo.
 * @param {WebSocket} childWs - O WebSocket do filho.
 * @returns {string} A URL do stream para o pai.
 */
function startFfmpegStream(childId, childWs) {
    if (ffmpegProcesses.has(childId)) {
        console.warn(`[FFMPEG] Processo FFmpeg já existe para ${childId}. Não iniciando um novo.`);
        return `${STREAM_BASE_URL}${childId}.flv`; // Retorna a URL existente
    }

    // A URL de saída para o stream. Ex: rtmp://localhost/live/childId
    // Ou, se for servir diretamente via Node.js, seria um arquivo temporário
    const streamOutputUrl = `${STREAM_BASE_URL}${childId}.flv`; // Exemplo para Nginx RTMP

    // Argumentos do FFmpeg:
    // -i pipe:0: Lê a entrada do stdin (do WebSocket)
    // -f s16le: Formato de áudio (assumindo PCM 16-bit little-endian do cliente)
    // -ar 44100: Taxa de amostragem
    // -ac 1: Canais de áudio (mono)
    // -c:a aac: Codec de áudio de saída (AAC)
    // -b:a 64k: Bitrate do áudio de saída
    // -f flv: Formato de contêiner de saída (FLV é comum para RTMP)
    // <streamOutputUrl>: A URL de saída (ex: RTMP URL)

    // Nota: Os parâmetros de entrada (-f s16le -ar 44100 -ac 1) devem corresponder exatamente ao formato de áudio
    // que o aplicativo do filho está enviando via WebSocket.
    // Para WebM/Opus, os argumentos seriam diferentes.
    // Ex: ['-i', 'pipe:0', '-c:a', 'copy', '-f', 'flv', streamOutputUrl] se o cliente enviar WebM/Opus.
    // Se o cliente enviar apenas bytes brutos de áudio (PCM), os argumentos abaixo são mais adequados.
    const ffmpegArgs = [
        '-i', 'pipe:0',         // Entrada do stdin
        '-f', 's16le',          // Formato de áudio raw (16-bit signed, little-endian)
        '-ar', '44100',          // Taxa de amostragem
        '-ac', '1',             // Canais de áudio (mono)
        '-c:a', 'aac',          // Codec de áudio de saída (AAC)
        '-b:a', '64k',          // Bitrate do áudio de saída
        '-f', 'flv',            // Formato de contêiner de saída (FLV para RTMP)
        streamOutputUrl
    ];

    console.log(`[FFMPEG] Iniciando processo FFmpeg para ${childId} com argumentos: ${ffmpegArgs.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpegProcesses.set(childId, ffmpeg);

    ffmpeg.stdin.on('error', (err) => {
        console.error(`[FFMPEG_ERROR] Erro no stdin do FFmpeg para ${childId}: ${err.message}`);
    });

    ffmpeg.stderr.on('data', (data) => {
        console.log(`[FFMPEG_LOG] FFmpeg para ${childId} (stderr): ${data.toString()}`);
    });

    ffmpeg.on('close', (code) => {
        console.log(`[FFMPEG_CLOSE] Processo FFmpeg para ${childId} encerrado com código ${code}`);
        ffmpegProcesses.delete(childId); // Remove do mapa ao encerrar
    });

    ffmpeg.on('error', (err) => {
        console.error(`[FFMPEG_ERROR] Erro ao spawnar FFmpeg para ${childId}: ${err.message}`);
        ffmpegProcesses.delete(childId); // Remove do mapa em caso de erro
    });

    return streamOutputUrl;
}

/**
 * Encerra um processo FFmpeg existente.
 * @param {string} childId - O ID do filho cujo processo FFmpeg deve ser encerrado.
 */
function stopFfmpegStream(childId) {
    const ffmpeg = ffmpegProcesses.get(childId);
    if (ffmpeg) {
        console.log(`[FFMPEG] Encerrando processo FFmpeg para ${childId}`);
        ffmpeg.kill('SIGINT'); // Envia sinal de interrupção para o FFmpeg
        ffmpegProcesses.delete(childId);
    } else {
        console.log(`[FFMPEG] Nenhum processo FFmpeg ativo encontrado para ${childId} para encerrar.`);
    }
}

wss.on('connection', ws => {
    ws.id = uuidv4();
    console.log(`[WS_CONNECT] Novo cliente WebSocket conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wss.clients.size}`);

    ws.isParent = false;
    ws.clientId = null;
    ws.parentId = null;

    ws.on('message', message => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);

        let processedAsText = false;

        if (typeof message === 'string') {
            const messageString = message.toString();
            const displayMessage = messageString.length > 100 ? messageString.substring(0, 100) + '...' : messageString;
            console.log(`[WS_MSG] [${messageOrigin}] Mensagem WebSocket de TEXTO recebida: "${displayMessage}"`);

            if (messageString.startsWith('CHILD_ID:')) {
                ws.clientId = messageString.substring('CHILD_ID:'.length);
                ws.isParent = false;
                activeChildWebSockets.set(ws.clientId, ws);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou. Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                    ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                    // Se o pai já está ouvindo, inicia o stream e envia a URL
                    const streamUrl = startFfmpegStream(ws.clientId, ws);
                    parentWs.send(JSON.stringify({ type: 'STREAM_URL', url: streamUrl }));
                    console.log(`[WS_MSG] [Conexão ${ws.id}] URL do stream (${streamUrl}) enviada para o pai de ${ws.clientId}.`);
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
                    parentListeningSockets.set(targetChildId, ws);
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                    const childWs = findChildWebSocket(targetChildId);
                    if (childWs) {
                        childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal START_AUDIO enviado para o filho ${targetChildId} via WebSocket (pedido de escuta do pai).`);

                        // INICIA O STREAM FFmpeg E ENVIA A URL PARA O PAI
                        const streamUrl = startFfmpegStream(targetChildId, childWs);
                        ws.send(JSON.stringify({ type: 'STREAM_URL', url: streamUrl }));
                        console.log(`[WS_MSG] [Conexão ${ws.id}] URL do stream (${streamUrl}) enviada para o pai ${ws.parentId || 'desconhecido'}.`);
                    } else {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não encontrado no mapa activeChildWebSockets, mas pai (ID: ${ws.parentId || 'desconhecido'}) está esperando.`);
                        ws.send(JSON.stringify({ type: 'STATUS', message: `Filho ${targetChildId} não está online. Tentando ouvir, mas sem áudio.` }));
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
                    if (parentListeningSockets.has(targetChildId) && parentListeningSockets.get(targetChildId) === ws) {
                        parentListeningSockets.delete(targetChildId);
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

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
                            stopFfmpegStream(targetChildId); // Encerra o processo FFmpeg
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
                processedAsText = true;
            } else {
                console.warn(`[WS_MSG] [${messageOrigin}] Mensagem de texto desconhecida ou inesperada: ${displayMessage}`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de texto desconhecido ou não permitido.' }));
                processedAsText = true;
            }
        }

        // Se não foi processada como string, e é um Buffer/ArrayBuffer, assume que é áudio
        if (!processedAsText && (message instanceof Buffer || message instanceof ArrayBuffer)) {
            // Se já tiver um clientId (é um filho) e não for um pai, encaminha para o FFmpeg
            if (ws.clientId && !ws.isParent) {
                const ffmpeg = ffmpegProcesses.get(ws.clientId);
                if (ffmpeg && ffmpeg.stdin.writable) {
                    try {
                        ffmpeg.stdin.write(message); // Escreve os bytes de áudio para o stdin do FFmpeg
                        // console.log(`[WS_MSG] [${messageOrigin}] Bytes de áudio (${message.length} bytes) encaminhados para FFmpeg.`);
                    } catch (e) {
                        console.error(`[FFMPEG_WRITE_ERROR] Erro ao escrever para o stdin do FFmpeg para ${ws.clientId}: ${e.message}`);
                        // Considerar parar o stream e notificar o pai se o FFmpeg falhar
                    }
                } else {
                    // console.log(`[WS_MSG] [${messageOrigin}] FFmpeg não está pronto ou não existe para o filho ${ws.clientId}. Descartando ${message.length} bytes de áudio.`);
                }
            } else {
                console.warn(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida inesperada (não é de filho ou não é áudio). Tamanho: ${message.length} bytes.`);
            }
        } else if (!processedAsText) {
            console.warn(`[WS_MSG] [${messageOrigin}] Mensagem recebida não é string nem binária esperada. Tipo: ${typeof message}, Tamanho: ${message ? message.length : 'N/A'}`);
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WS_CLOSE] [${messageOrigin}] Cliente WebSocket desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}. Total de conexões ativas: ${wss.clients.size - 1}`);

        if (ws.clientId) {
            console.log(`[WS_CLOSE] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WS_CLOSE] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

            // Encerra o processo FFmpeg quando o filho se desconecta
            stopFfmpegStream(ws.clientId);

            let hadActiveParent = false;
            for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                if (childIdInMap === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                    parentWsInMap.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId }));
                    console.log(`[WS_CLOSE] [${parentWsInMap.id}] Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${ws.clientId}.`);
                    parentListeningSockets.delete(childIdInMap);
                    hadActiveParent = true;
                }
            }
            if (hadActiveParent) {
                console.log(`[WS_CLOSE] [${messageOrigin}] Removida a escuta de pais para o filho desconectado ${ws.clientId}.`);
            }
        } else if (ws.isParent && ws.parentId) {
            console.log(`[WS_CLOSE] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado.`);
            for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                if (parentWsListening === ws) {
                    parentListeningSockets.delete(childIdBeingListened);
                    console.log(`[WS_CLOSE] [${messageOrigin}] Pai ${ws.parentId} parou de ouvir o filho: ${childIdBeingListened}.`);

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
                        stopFfmpegStream(childIdBeingListened); // Encerra o processo FFmpeg
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

        if (ws.clientId) {
            console.log(`[WS_ERROR] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets devido a um erro.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WS_ERROR] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

            stopFfmpegStream(ws.clientId); // Encerra o processo FFmpeg
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
                       stopFfmpegStream(childIdBeingListened); // Encerra o processo FFmpeg
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
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});

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