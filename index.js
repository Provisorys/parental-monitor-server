const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const http = require('http');
const WebSocket = require('ws'); // Já importado
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

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

// --- TWILIO CONFIG (Mantido, mas não será usado para streaming de áudio direto) ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// --- Middlewares ---
app.use(cors());
app.use(bodyParser.json());

// Configuração do Multer para upload de arquivos (se ainda estiver usando)
const upload = multer({ storage: multer.memoryStorage() });

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Mapas para gerenciar conexões WebSocket ---
const childSockets = new Map(); // childId -> WebSocket
const parentListeners = new Map(); // childId -> Set<WebSocket> (Set para múltiplos pais ouvindo o mesmo filho)

// --- Funções HTTP para sinalização e outras funcionalidades ---
app.post('/start-listening/:childId', (req, res) => {
    const { childId } = req.params;
    console.log(`[HTTP] Solicitação para iniciar escuta para childId: ${childId}`);
    // Adicione aqui qualquer lógica de notificação ou inicialização adicional, se necessário
    res.status(200).send('Listening initiated');
});

app.post('/stop-listening/:childId', (req, res) => {
    const { childId } = req.params;
    console.log(`[HTTP] Solicitação para parar escuta para childId: ${childId}`);
    // Adicione aqui qualquer lógica para parar o monitoramento/streaming, se necessário
    res.status(200).send('Listening stopped');
});

// --- Rota para obter token Twilio (se ainda for usada) ---
app.get('/twilio-token', (req, res) => {
    if (!twilioClient) {
        return res.status(500).send('Twilio client not configured.');
    }
    const identity = req.query.identity || 'default_user';
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const accessToken = new AccessToken(
        TWILIO_ACCOUNT_SID,
        process.env.TWILIO_API_KEY_SID,
        process.env.TWILIO_API_KEY_SECRET,
        { identity: identity }
    );

    const voiceGrant = new VoiceGrant({
        incomingAllow: true,
        outgoingApplicationSid: process.env.TWILIO_APP_SID,
    });

    accessToken.addGrant(voiceGrant);
    res.json({ token: accessToken.toJwt() });
});

// --- Rotas para upload de mídia (se ainda forem usadas) ---
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

// --- Rotas de histórico de conversas (se ainda forem usadas) ---
app.get('/conversations/:childId', async (req, res) => {
    const { childId } = req.params;
    try {
        const result = await docClient.query({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: { ':cid': childId },
            ScanIndexForward: false // Mais recentes primeiro
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
            IndexName: 'conversationId-index', // Certifique-se de que este índice existe
            KeyConditionExpression: 'conversationId = :cid',
            ExpressionAttributeValues: { ':cid': conversationId },
            ScanIndexForward: true // Mensagens em ordem cronológica
        }).promise();
        res.json(result.Items);
    } catch (error) {
        console.error('Error fetching messages for conversation:', error);
        res.status(500).send('Error fetching messages.');
    }
});

// --- FUNÇÃO PARA GERAR O CABEÇALHO WAV ---
// Parâmetros de áudio do App Filho: 16kHz, Mono, 16-bit PCM
function createWavHeader(dataSize) {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8; // Bytes por segundo
    const blockAlign = numChannels * bitsPerSample / 8; // Bytes por amostra para todos os canais

    const header = Buffer.alloc(44); // Tamanho padrão do cabeçalho WAV

    // RIFF Chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4); // ChunkSize (36 bytes para o resto do cabeçalho + tamanho dos dados)
    header.write('WAVE', 8);

    // fmt Subchunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);  // Subchunk1Size (16 para PCM)
    header.writeUInt16LE(1, 20);   // AudioFormat (1 para PCM)
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data Subchunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40); // Subchunk2Size (tamanho dos dados de áudio)

    return header;
}

// --- WebSocket Handling ---
wss.on('connection', ws => {
    console.log('[WS] Novo cliente conectado.');

    ws.on('message', message => {
        // Tenta parsear como JSON primeiro para comandos de sinalização
        try {
            const parsedMessage = JSON.parse(message);

            if (parsedMessage.childId) {
                // É o App Filho se registrando
                ws.isChild = true;
                ws.childId = parsedMessage.childId;
                childSockets.set(ws.childId, ws);
                console.log(`[WS] App Filho '${ws.childId}' conectado.`);
            } else if (parsedMessage.type === 'LISTEN_TO_CHILD' && parsedMessage.childId) {
                // É o App Pai solicitando escuta
                ws.isParent = true;
                ws.listeningChildId = parsedMessage.childId;
                if (!parentListeners.has(ws.listeningChildId)) {
                    parentListeners.set(ws.listeningChildId, new Set());
                }
                parentListeners.get(ws.listeningChildId).add(ws);
                console.log(`[WS] App Pai conectado e escutando childId: ${ws.listeningChildId}`);
            } else {
                console.warn(`[WS] Mensagem JSON desconhecida de cliente:`, parsedMessage);
            }
        } catch (e) {
            // Se não for JSON, assumimos que são dados de áudio binários do App Filho
            // O 'message' aqui é um Buffer (dados binários)
            if (ws.isChild && ws.childId && parentListeners.has(ws.childId)) {
                // console.log(`[WS] Recebendo dados de áudio de '${ws.childId}' (tamanho: ${message.length} bytes).`); // Removido para reduzir logs de spam

                const listeners = parentListeners.get(ws.childId);
                listeners.forEach(listenerWs => {
                    if (listenerWs.readyState === WebSocket.OPEN) {
                        // 1. Gera o cabeçalho WAV para este CHUNK de áudio
                        const wavHeader = createWavHeader(message.length); // message.length é o tamanho dos dados brutos de áudio
                        // 2. Combina o cabeçalho com os dados brutos de áudio
                        const wavChunkBinary = Buffer.concat([wavHeader, message]);
                        // 3. Codifica o chunk WAV BINÁRIO para Base64 (para ser enviado como string para o Kodular)
                        const wavChunkBase64 = wavChunkBinary.toString('base64');
                        // 4. Envia a string Base64 para o App Pai
                        listenerWs.send(wavChunkBase64);
                        // console.log(`[WS] Retransmitido chunk de áudio (Base64, ${wavChunkBase64.length} chars) para pai escutando ${ws.childId}.`); // Removido para reduzir logs de spam
                    }
                });
            } else {
                // Mensagens de clientes não identificados ou não crianças
                // console.log('[WS] Mensagem de texto ou binária não tratada:', message.toString().substring(0, 50) + '...'); // Removido para reduzir logs de spam
            }
        }
    });

    ws.on('close', () => {
        if (ws.isChild && ws.childId) {
            childSockets.delete(ws.childId);
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