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
const TWILIO_APP_SID = process.env.TWILIO_APP_SID; // Certifique-se que esta variável está definida

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// --- Middlewares ---
app.use(cors());
app.use(bodyParser.json());

// Configuração do Multer para upload de arquivos
const upload = multer({ storage: multer.memoryStorage() });

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Mapas para gerenciar conexões WebSocket ---
// activeChildWebSockets: { childId: WebSocket }
const activeChildWebSockets = new Map();
// parentListeners: { childId: Set<WebSocket> }
const parentListeners = new Map();

// --- Rotas HTTP de Comando e Informação ---

// Rota para o App Filho registrar seu childId via HTTP (se necessário para algum fluxo, embora WebSocket seja preferencial)
app.post('/register-child', async (req, res) => {
    const { childId } = req.body;
    if (!childId) {
        return res.status(400).send('childId é obrigatório.');
    }
    console.log(`[HTTP_CMD] Recebida requisição POST /register-child para childId: ${childId}`);
    try {
        await docClient.put({
            TableName: DYNAMODB_TABLE_CHILDREN,
            Item: { childId: childId }
        }).promise();
        res.status(200).send(`Child ${childId} registrado com sucesso.`);
    } catch (error) {
        console.error('[HTTP_ERROR] Erro ao registrar child no DynamoDB:', error);
        res.status(500).send('Erro ao registrar child.');
    }
});


// Rota para o App Pai solicitar o início do microfone de um filho
app.post('/start-microphone', (req, res) => {
    const { childId } = req.body; // Supondo que childId vem no corpo da requisição
    if (!childId) {
        return res.status(400).send('childId é obrigatório.');
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /start-microphone para o filho: ${childId}`);

    const childWs = activeChildWebSockets.get(childId);

    if (childWs && childWs.readyState === WebSocket.OPEN) {
        // Envia um comando via WebSocket para o App Filho iniciar a gravação de áudio
        const command = { type: 'START_AUDIO_STREAMING' };
        childWs.send(JSON.stringify(command));
        console.log(`[HTTP_CMD] Comando 'START_AUDIO_STREAMING' enviado para o filho: ${childId}`);
        res.status(200).send(`Comando de iniciar microfone enviado para ${childId}.`);
    } else {
        console.error(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando START_AUDIO NÃO PODE ser enviado.`);
        res.status(404).send(`Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}.`);
    }
});


// Rota para o App Pai solicitar o fim do microfone de um filho
app.post('/stop-microphone', (req, res) => {
    const { childId } = req.body;
    if (!childId) {
        return res.status(400).send('childId é obrigatório.');
    }
    console.log(`[HTTP_CMD] Recebida requisição POST /stop-microphone para o filho: ${childId}`);

    const childWs = activeChildWebSockets.get(childId);

    if (childWs && childWs.readyState === WebSocket.OPEN) {
        const command = { type: 'STOP_AUDIO_STREAMING' };
        childWs.send(JSON.stringify(command));
        console.log(`[HTTP_CMD] Comando 'STOP_AUDIO_STREAMING' enviado para o filho: ${childId}`);
        res.status(200).send(`Comando de parar microfone enviado para ${childId}.`);
    } else {
        console.error(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}.`);
        res.status(404).send(`Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}.`);
    }
});


// Rota para o App Pai (ou outro cliente) obter a lista de childIds registrados
app.get('/get-child-ids', async (req, res) => {
    console.log('[HTTP_CMD] Requisição GET recebida na rota /get-child-ids');
    try {
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN,
            ProjectionExpression: "childId"
        };
        const result = await docClient.scan(params).promise();
        const childIds = result.Items.map(item => item.childId);
        console.log(`[HTTP_CMD] Child IDs encontrados: ${childIds.join(', ')}`);
        res.json({ childIds: childIds });
    } catch (error) {
        console.error('[HTTP_ERROR] Erro ao buscar child IDs do DynamoDB:', error);
        res.status(500).send('Erro ao buscar child IDs.');
    }
});


app.post('/notifications', (req, res) => {
    console.log('[HTTP] Requisição POST recebida na rota /notifications');
    res.status(200).send('Notificação recebida com sucesso.');
});

// --- Rota para obter token Twilio ---
app.get('/twilio-token', (req, res) => {
    if (!twilioClient) {
        return res.status(500).send('Twilio client not configured.');
    }
    const identity = req.query.identity || 'default_user';
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const accessToken = new AccessToken(
        TWILIO_ACCOUNT_SID,
        TWILIO_API_KEY_SID,
        TWILIO_API_KEY_SECRET,
        { identity: identity }
    );

    const voiceGrant = new VoiceGrant({
        incomingAllow: true,
        outgoingApplicationSid: TWILIO_APP_SID,
    });

    accessToken.addGrant(voiceGrant);
    res.json({ token: accessToken.toJwt() });
});

// --- Rotas para upload de mídia ---
app.post('/upload', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const { childId, messageId } = req.body;
    if (!childId || !messageId) {
        return res.status(400).send('Missing childId or messageId.');
    }

    const fileContent = req.file.buffer;
    const fileKey = `uploads/${childId}/${messageId}/${req.file.originalname}`;

    try {
        await s3.upload({
            Bucket: S3_BUCKET_NAME,
            Key: fileKey,
            Body: fileContent,
            ContentType: req.file.mimetype
        }).promise();

        await docClient.update({
            TableName: DYNAMODB_TABLE_MESSAGES,
            Key: { messageId: messageId },
            UpdateExpression: 'SET s3Url = :s',
            ExpressionAttributeValues: { ':s': `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${fileKey}` }
        }).promise();

        res.status(200).send('File uploaded successfully.');
    } catch (error) {
        console.error('Error uploading file to S3 or updating DynamoDB:', error);
        res.status(500).send('Error uploading file.');
    }
});

// --- Rotas de histórico de conversas ---
app.get('/conversations/:childId', async (req, res) => {
    const { childId } = req.params;
    try {
        const result = await docClient.query({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: { ':cid': childId },
            ScanIndexForward: false
        }).promise();
        res.json(result.Items);
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).send('Error fetching conversations.');
    }
});

app.get('/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    try {
        const result = await docClient.query({
            TableName: DYNAMODB_TABLE_MESSAGES,
            IndexName: 'conversationId-index',
            KeyConditionExpression: 'conversationId = :cid',
            ExpressionAttributeValues: { ':cid': conversationId },
            ScanIndexForward: true
        }).promise();
        res.json(result.Items);
    } catch (error) {
        console.error('Error fetching messages for conversation:', error);
        res.status(500).send('Error fetching messages.');
    }
});

// --- FUNÇÃO PARA GERAR O CABEÇALHO WAV ---
function createWavHeader(dataSize) {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;

    const header = Buffer.alloc(44);

    // RIFF Chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt Subchunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data Subchunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
}

// --- WebSocket Handling ---
wss.on('connection', ws => {
    console.log('[WS] Novo cliente conectado.');

    ws.on('message', message => {
        // Tenta parsear como JSON para comandos ou sinalização
        try {
            const parsedMessage = JSON.parse(message);

            if (parsedMessage.type === 'REGISTER_CHILD' && parsedMessage.childId) {
                // App Filho se registra
                ws.isChild = true;
                ws.childId = parsedMessage.childId;
                activeChildWebSockets.set(ws.childId, ws);
                console.log(`[WS] App Filho '${ws.childId}' registrado e conectado.`);
            } else if (parsedMessage.type === 'LISTEN_TO_CHILD' && parsedMessage.childId) {
                // App Pai solicitando escuta
                ws.isParent = true;
                ws.listeningChildId = parsedMessage.childId;
                if (!parentListeners.has(ws.listeningChildId)) {
                    parentListeners.set(ws.listeningChildId, new Set());
                }
                parentListeners.get(ws.listeningChildId).add(ws);
                console.log(`[WS] App Pai conectado e escutando childId: ${ws.listeningChildId}.`);
            } else {
                console.warn(`[WS] Mensagem JSON desconhecida de cliente:`, parsedMessage);
            }
        } catch (e) {
            // Se não for JSON, assumimos que são dados de áudio binários do App Filho
            if (ws.isChild && ws.childId && parentListeners.has(ws.childId)) {
                const listeners = parentListeners.get(ws.childId);
                listeners.forEach(listenerWs => {
                    if (listenerWs.readyState === WebSocket.OPEN) {
                        const wavHeader = createWavHeader(message.length);
                        const wavChunkBinary = Buffer.concat([wavHeader, message]);
                        const wavChunkBase64 = wavChunkBinary.toString('base64');
                        listenerWs.send(wavChunkBase64);
                    }
                });
            } else {
                // console.log('[WS] Mensagem de texto ou binária não tratada:', message.toString().substring(0, 50) + '...');
            }
        }
    });

    ws.on('close', () => {
        if (ws.isChild && ws.childId) {
            activeChildWebSockets.delete(ws.childId);
            console.log(`[WS] App Filho '${ws.childId}' desconectado.`);
        }
        if (ws.isParent && ws.listeningChildId) {
            if (parentListeners.has(ws.listeningChildId)) {
                parentListeners.get(ws.listeningChildId).delete(ws);
                if (parentListeners.get(ws.listeningChildId).size === 0) {
                    parentListeners.delete(ws.listeningChildId);
                }
            }
            console.log(`[WS] App Pai desconectado de escuta para childId: ${ws.listeningChildId}.`);
        }
        console.log('[WS] Cliente desconectado.');
    });

    ws.on('error', error => {
        console.error('[WS_ERROR] Erro no WebSocket:', error);
    });
});

// --- Rotas para tratamento de erros ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});

app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
});