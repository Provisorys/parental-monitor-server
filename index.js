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

// --- TWILIO CONFIG (Mantido, mas não será usado para streaming FFmpeg) ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- NGINX RTMP STREAMING CONFIG ---
const FFMPEG_PUBLISH_RTMP_URL_BASE = process.env.FFMPEG_PUBLISH_RTMP_URL_BASE || 'rtmp://localhost:1935/live/';
const CLIENT_STREAM_HTTP_URL_BASE = process.env.CLIENT_STREAM_HTTP_URL_BASE || 'http://localhost:8000/live/';
const CLIENT_STREAM_FORMAT_EXTENSION = '.m3u8';

// --- WEB SOCKETS ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const childConnections = new Map(); // childId -> { ws: WebSocket, ffmpegProcess: ChildProcess }
const parentConnections = new Map(); // parentId -> { ws: WebSocket, activeChildStreamUrl: string } // Agora 'ws' pode ser o WebSocket do pai

const ffmpegProcesses = new Map(); // childId -> { ffmpegProcess: ChildProcess, buffer: Buffer[] }

// Função para iniciar o stream FFmpeg (SEM MUDANÇAS AQUI)
function startFfmpegStream(childId, childWs) {
    if (ffmpegProcesses.has(childId)) {
        console.warn(`[FFMPEG] Processo FFmpeg já existe para ${childId}. Não iniciando um novo.`);
        return `<span class="math-inline">\{CLIENT\_STREAM\_HTTP\_URL\_BASE\}</span>{childId}${CLIENT_STREAM_FORMAT_EXTENSION}`;
    }

    const rtmpPublishUrl = `<span class="math-inline">\{FFMPEG\_PUBLISH\_RTMP\_URL\_BASE\}</span>{childId}`;
    const clientStreamUrl = `<span class="math-inline">\{CLIENT\_STREAM\_HTTP\_URL\_BASE\}</span>{childId}${CLIENT_STREAM_FORMAT_EXTENSION}`;

    console.log(`[FFMPEG] Tentando iniciar processo FFmpeg para ${childId}`);
    console.log(`[FFMPEG] Publicando em RTMP: ${rtmpPublishUrl}`);
    console.log(`[FFMPEG] URL HLS para o pai: ${clientStreamUrl}`);

    const ffmpegArgs = [
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '44100',
        '-ac', '1',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-f', 'flv',
        rtmpPublishUrl
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpegProcesses.set(childId, { ffmpegProcess: ffmpeg, buffer: [] });

    childWs.on('message', (message) => {
        if (typeof message === 'object' && message instanceof Buffer) {
            if (ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(message);
            } else {
                ffmpegProcesses.get(childId)?.buffer.push(message);
            }
        }
    });

    ffmpeg.stderr.on('data', (data) => {
        console.error(`[FFMPEG][${childId}] stderr: ${data}`);
    });

    ffmpeg.on('close', (code) => {
        console.log(`[FFMPEG][${childId}] Processo FFmpeg finalizado com código ${code}`);
        if (ffmpegProcesses.has(childId)) {
            const { ffmpegProcess, buffer } = ffmpegProcesses.get(childId);
            ffmpegProcess.stdin.end();
            ffmpegProcesses.delete(childId);

            // Notificar pais que estão ouvindo que o stream terminou
            parentConnections.forEach((conn, parentId) => {
                if (conn.activeChildStreamUrl === clientStreamUrl && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                    console.log(`[WS] Notificando pai ${parentId} que o stream de ${childId} parou.`);
                    conn.ws.send(JSON.stringify({ type: 'stream_ended', childId: childId }));
                    conn.activeChildStreamUrl = null;
                }
            });
        }
    });

    ffmpeg.on('error', (err) => {
        console.error(`[FFMPEG][${childId}] Erro no processo FFmpeg: ${err}`);
        if (ffmpegProcesses.has(childId)) {
            ffmpegProcesses.delete(childId);
        }
    });

    return clientStreamUrl;
}

// --- Modificação CRUCIAL AQUI: Lógica para diferenciar conexões WS de filho e pai ---
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`); // Analisar a URL completa
    const path = url.pathname;
    const queryParams = new URLSearchParams(url.search);

    if (path.startsWith('/child_audio/')) {
        const childId = path.split('/')[2]; // Assume /child_audio/YOUR_CHILD_ID
        if (!childId) {
            console.error('[WS] Conexão WebSocket de filho sem ID.');
            ws.close(1008, 'ID do filho ausente');
            return;
        }

        console.log(`[WS] Filho ${childId} conectado para áudio.`);
        childConnections.set(childId, { ws: ws, ffmpegProcess: null });

        const streamUrlForParent = startFfmpegStream(childId, ws);
        childConnections.get(childId).ffmpegProcess = ffmpegProcesses.get(childId).ffmpegProcess;

        ws.on('close', () => {
            console.log(`[WS] Filho ${childId} desconectado.`);
            if (childConnections.has(childId)) {
                const { ffmpegProcess } = childConnections.get(childId);
                if (ffmpegProcess && !ffmpegProcess.killed) {
                    console.log(`[FFMPEG] Matando processo FFmpeg para ${childId} devido à desconexão do filho.`);
                    ffmpegProcess.kill('SIGKILL');
                }
                ffmpegProcesses.delete(childId);
                childConnections.delete(childId);
            }
        });

        ws.on('error', (error) => {
            console.error(`[WS] Erro no WebSocket do filho ${childId}:`, error);
            if (childConnections.has(childId)) {
                const { ffmpegProcess } = childConnections.get(childId);
                if (ffmpegProcess && !ffmpegProcess.killed) {
                    console.log(`[FFMPEG] Matando processo FFmpeg para ${childId} devido a erro no WebSocket.`);
                    ffmpegProcess.kill('SIGKILL');
                }
                ffmpegProcesses.delete(childId);
                childConnections.delete(childId);
            }
        });

    } else if (path.startsWith('/parent_listen/')) {
        const parentId = path.split('/')[2]; // Assume /parent_listen/YOUR_PARENT_ID
        if (!parentId) {
            console.error('[WS] Conexão WebSocket de pai sem ID.');
            ws.close(1008, 'ID do pai ausente');
            return;
        }

        console.log(`[WS] Pai ${parentId} conectado para escutar. (A URL do stream será enviada via HTTP POST)`);
        parentConnections.set(parentId, { ws: ws, activeChildStreamUrl: null });

        ws.on('message', (message) => {
            // Pais podem enviar comandos aqui (ex: "start_stream", "stop_stream")
            console.log(`[WS] Mensagem do pai ${parentId}: ${message}`);
            try {
                const msg = JSON.parse(message);
                if (msg.type === 'request_stream_url' && msg.childId) {
                    const childConn = childConnections.get(msg.childId);
                    if (childConn && childConn.ffmpegProcess) {
                        const streamUrl = `<span class="math-inline">\{CLIENT\_STREAM\_HTTP\_URL\_BASE\}</span>{msg.childId}${CLIENT_STREAM_FORMAT_EXTENSION}`;
                        ws.send(JSON.stringify({ type: 'stream_url', childId: msg.childId, url: streamUrl }));
                        parentConnections.get(parentId).activeChildStreamUrl = streamUrl;
                        console.log(`[WS] Enviando URL do stream para pai ${parentId}: ${streamUrl}`);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Filho não está transmitindo ou não encontrado.' }));
                    }
                }
            } catch (e) {
                console.error(`[WS] Erro ao parsear mensagem do pai ${parentId}: ${e}`);
            }
        });

        ws.on('close', () => {
            console.log(`[WS] Pai ${parentId} desconectado.`);
            parentConnections.delete(parentId);
        });

        ws.on('error', (error) => {
            console.error(`[WS] Erro no WebSocket do pai ${parentId}:`, error);
            parentConnections.delete(parentId);
        });

    } else {
        console.warn(`[WS] Conexão WebSocket para caminho desconhecido: ${path}`);
        ws.close(1000, 'Caminho WebSocket inválido.');
    }
});

// Rota para receber dados do filho (mantida, mas não para áudio streaming)
app.post('/api/child_data', async (req, res) => {
    console.warn('[HTTP] Rota /api/child_data chamada (esta rota é para dados, não áudio stream)');
    res.status(200).send('OK');
});

// Rota HTTP para o pai "solicitar" o stream (se preferir por HTTP e não WS)
// Eu adicionei uma opção de WS para isso, mas manterei esta rota também
app.post('/api/start_listening', async (req, res) => {
    const { parentId, childId } = req.body;
    if (!parentId || !childId) {
        return res.status(400).json({ success: false, message: 'ID do pai e do filho são obrigatórios.' });
    }

    console.log(`[API] Pai ${parentId} solicitou stream do filho ${childId}.`);

    const childConn = childConnections.get(childId);
    if (!childConn || !childConn.ffmpegProcess) {
        return res.status(404).json({ success: false, message: 'Filho não conectado ou stream não disponível.' });
    }

    const streamUrl = `<span class="math-inline">\{CLIENT\_STREAM\_HTTP\_URL\_BASE\}</span>{childId}${CLIENT_STREAM_FORMAT_EXTENSION}`;

    // Para esta rota HTTP, não precisamos armazenar o ws do pai aqui.
    // O pai apenas recebe a URL e a usa no seu próprio reprodutor.
    // Se você quiser que o servidor notifique o pai sobre o fim do stream,
    // o pai DEVE ter uma conexão WebSocket para o servidor (conforme o novo wss.on('connection') acima)
    res.json({ success: true, streamUrl: streamUrl, childId: childId });
});


// --- O restante do seu código Express (middleware, rotas, etc.) ---
app.use(bodyParser.json());
app.use(cors());

app.get('/test', (req, res) => {
    res.send('Servidor de monitoramento parental está online!');
});

app.post('/api/register_parent', async (req, res) => {
    res.status(200).send('Registro de pai (placeholder)');
});

app.post('/api/register_child', async (req, res) => {
    res.status(200).send('Registro de filho (placeholder)');
});

app.post('/api/login_parent', async (req, res) => {
    res.status(200).send('Login de pai (placeholder)');
});

app.post('/api/login_child', async (req, res) => {
    res.status(200).send('Login de filho (placeholder)');
});

app.get('/api/parent/:parentId/children', async (req, res) => {
    const { parentId } = req.params;
    console.log(`[API] Buscando crianças para o pai ${parentId}`);
    res.json({ children: [{ id: 'child1', name: 'Filho Teste' }] });
});

const upload = multer({
    limits: { fileSize: 10 * 1024 * 1024 }
}).single('audio');

app.post('/api/upload_audio', (req, res) => {
    upload(req, res, async (err) => {
        if (err instanceof multer.MulterError) {
            console.error('Multer Error:', err);
            return res.status(500).json({ success: false, message: `Erro de upload: ${err.message}` });
        } else if (err) {
            console.error('Unknown Upload Error:', err);
            return res.status(500).json({ success: false, message: `Erro desconhecido: ${err.message}` });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo de áudio enviado.' });
        }

        const { senderId, receiverId, messageType, conversationId } = req.body;
        if (!senderId || !receiverId || !messageType || !conversationId) {
            return res.status(400).json({ success: false, message: 'Dados de mensagem incompletos.' });
        }

        const audioBuffer = req.file.buffer;
        const audioKey = `audios/${uuidv4()}.mp3`;

        const uploadParams = {
            Bucket: S3_BUCKET_NAME,
            Key: audioKey,
            Body: audioBuffer,
            ContentType: req.file.mimetype
        };

        try {
            const data = await s3.upload(uploadParams).promise();
            const audioUrl = data.Location;

            const messageId = uuidv4();
            const timestamp = new Date().toISOString();

            const messageParams = {
                TableName: DYNAMODB_TABLE_MESSAGES,
                Item: {
                    messageId: messageId,
                    conversationId: conversationId,
                    senderId: senderId,
                    receiverId: receiverId,
                    type: messageType,
                    content: audioUrl,
                    timestamp: timestamp
                }
            };

            await docClient.put(messageParams).promise();

            res.json({ success: true, message: 'Áudio enviado com sucesso!', audioUrl: audioUrl, messageId: messageId });
        } catch (error) {
            console.error('Erro ao fazer upload para S3 ou salvar no DynamoDB:', error);
            res.status(500).json({ success: false, message: 'Erro ao processar o upload do áudio.' });
        }
    });
});

app.get('/api/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    console.log(`[API] Buscando mensagens para conversa ${conversationId}`);
    res.json({ messages: [] });
});

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
    console.log(`FFmpeg RTMP Publish URL Base: ${FFMPEG_PUBLISH_RTMP_URL_BASE}`);
    console.log(`Client HLS Stream HTTP URL Base: ${CLIENT_STREAM_HTTP_URL_BASE}`);
    console.log(`--- WebSocket Endpoints ---`);
    console.log(`Filho (áudio): ws://localhost:${PORT}/child_audio/<childId>`);
    console.log(`Pai (escutar): ws://localhost:${PORT}/parent_listen/<parentId>`);
});