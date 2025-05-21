const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio'); // Twilio ainda está presente, mas não usaremos para o streaming direto via FFmpeg+Nginx
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process'); // Importar child_process

const app = express();
const PORT = process.env.PORT || 3000; // Porta do seu servidor Node.js

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
// A URL base para onde o FFmpeg publicará o stream RTMP.
// Como o Nginx está no WSL e o Node.js pode estar no Windows, 'localhost' funciona.
// Se o Node.js estivesse em outra máquina, seria o IP do Windows/Servidor.
const FFMPEG_PUBLISH_RTMP_URL_BASE = process.env.FFMPEG_PUBLISH_RTMP_URL_BASE || 'rtmp://localhost:1935/live/';

// A URL base que o cliente pai usará para consumir o stream via HTTP (HLS).
// O cliente pai (seja um navegador no Windows ou um app Kodular no celular)
// acessará o Nginx rodando no WSL via 'localhost' (se no mesmo PC) ou o IP do Windows.
const CLIENT_STREAM_HTTP_URL_BASE = process.env.CLIENT_STREAM_HTTP_URL_BASE || 'http://localhost:8000/live/';
const CLIENT_STREAM_FORMAT_EXTENSION = '.m3u8'; // Usando HLS. Altere para '.flv' se usar FLV direto.

// --- WEB SOCKETS ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const childConnections = new Map(); // childId -> { ws: WebSocket, ffmpegProcess: ChildProcess, currentParentWs: WebSocket }
const parentConnections = new Map(); // parentId -> { ws: WebSocket, activeChildStreamUrl: string }

const ffmpegProcesses = new Map(); // childId -> { ffmpegProcess: ChildProcess, buffer: Buffer[] }

// Função para iniciar o stream FFmpeg
/**
 * Inicia um processo FFmpeg para receber áudio de um filho e retransmiti-lo para Nginx RTMP.
 * @param {string} childId - O ID do filho que está transmitindo.
 * @param {WebSocket} childWs - O WebSocket do filho (para ler os dados).
 * @returns {string} A URL do stream HLS para o pai.
 */
function startFfmpegStream(childId, childWs) {
    if (ffmpegProcesses.has(childId)) {
        console.warn(`[FFMPEG] Processo FFmpeg já existe para ${childId}. Não iniciando um novo.`);
        // Retorna a URL do stream existente
        return `${CLIENT_STREAM_HTTP_URL_BASE}${childId}${CLIENT_STREAM_FORMAT_EXTENSION}`;
    }

    // A URL RTMP para o FFmpeg publicar no Nginx
    const rtmpPublishUrl = `${FFMPEG_PUBLISH_RTMP_URL_BASE}${childId}`;

    // A URL HTTP para o cliente pai consumir (HLS)
    const clientStreamUrl = `${CLIENT_STREAM_HTTP_URL_BASE}${childId}${CLIENT_STREAM_FORMAT_EXTENSION}`;

    console.log(`[FFMPEG] Tentando iniciar processo FFmpeg para ${childId}`);
    console.log(`[FFMPEG] Publicando em RTMP: ${rtmpPublishUrl}`);
    console.log(`[FFMPEG] URL HLS para o pai: ${clientStreamUrl}`);

    // Argumentos do FFmpeg.
    // Presumindo que o cliente está enviando áudio PCM bruto (raw audio).
    // Se o Kodular pode enviar Opus ou outro formato, podemos otimizar isso.
    const ffmpegArgs = [
        '-i', 'pipe:0',         // Entrada do stdin (do WebSocket)
        '-f', 's16le',          // Formato de áudio raw: 16-bit signed, little-endian
        '-ar', '44100',         // Taxa de amostragem: 44.1 kHz (comum para áudio)
        '-ac', '1',             // Canais de áudio: 1 (mono)
        '-c:a', 'aac',          // Codec de áudio de saída: AAC (boa qualidade e compatibilidade)
        '-b:a', '64k',          // Bitrate do áudio de saída: 64 kbps (pode ser ajustado)
        '-f', 'flv',            // Formato de contêiner de saída: FLV para RTMP
        rtmpPublishUrl          // A URL RTMP de saída para o Nginx
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    // Armazena o processo FFmpeg e um buffer para dados
    ffmpegProcesses.set(childId, { ffmpegProcess: ffmpeg, buffer: [] });

    // Lidar com dados recebidos do WebSocket do filho e enviá-los para o stdin do FFmpeg
    childWs.on('message', (message) => {
        // Certifique-se de que a mensagem é um Buffer (dados binários)
        if (typeof message === 'object' && message instanceof Buffer) {
            if (ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(message);
            } else {
                // Se o stdin não estiver mais gravável, podemos querer armazenar em buffer
                // ou logar um erro, dependendo do comportamento desejado.
                // console.warn(`[FFMPEG] stdin não gravável para ${childId}. Bufferizando.`);
                ffmpegProcesses.get(childId)?.buffer.push(message);
            }
        }
    });

    ffmpeg.stderr.on('data', (data) => {
        // FFmpeg imprime informações de status e erros no stderr
        console.error(`[FFMPEG][${childId}] stderr: ${data}`);
    });

    ffmpeg.on('close', (code) => {
        console.log(`[FFMPEG][${childId}] Processo FFmpeg finalizado com código ${code}`);
        if (ffmpegProcesses.has(childId)) {
            const { ffmpegProcess, buffer } = ffmpegProcesses.get(childId);
            ffmpegProcess.stdin.end(); // Fechar o stdin
            ffmpegProcesses.delete(childId);

            // Notificar pais que estão ouvindo que o stream terminou (opcional, pode ser via WebSocket)
            parentConnections.forEach((conn, parentId) => {
                if (conn.activeChildStreamUrl === clientStreamUrl) {
                    // Enviar uma mensagem para o pai que o stream parou
                    console.log(`[WS] Notificando pai ${parentId} que o stream de ${childId} parou.`);
                    conn.ws.send(JSON.stringify({ type: 'stream_ended', childId: childId }));
                    conn.activeChildStreamUrl = null; // Limpar a URL ativa
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

    return clientStreamUrl; // Retorna a URL HLS para o cliente pai
}

// Rota para receber dados do filho
app.post('/api/child_data', async (req, res) => {
    // ... sua lógica para autenticação do filho e obtenção do childId
    // Esta rota parece ser para dados REST, não para streaming de áudio
    console.warn('[HTTP] Rota /api/child_data chamada (esta rota é para dados, não áudio stream)');
    res.status(200).send('OK');
});

// Endpoint WebSocket para o filho enviar áudio
wss.on('connection', (ws, req) => {
    const childId = req.url.slice(1); // Assume que a URL é "/childId"
    if (!childId) {
        console.error('[WS] Conexão WebSocket de filho sem ID.');
        ws.close(1008, 'ID do filho ausente');
        return;
    }

    console.log(`[WS] Filho ${childId} conectado.`);

    childConnections.set(childId, { ws: ws, ffmpegProcess: null, currentParentWs: null });

    // Inicia o processo FFmpeg para este filho
    const streamUrlForParent = startFfmpegStream(childId, ws);

    // Associa o processo FFmpeg à conexão do filho
    childConnections.get(childId).ffmpegProcess = ffmpegProcesses.get(childId).ffmpegProcess;

    ws.on('close', () => {
        console.log(`[WS] Filho ${childId} desconectado.`);
        if (childConnections.has(childId)) {
            const { ffmpegProcess } = childConnections.get(childId);
            if (ffmpegProcess && !ffmpegProcess.killed) {
                console.log(`[FFMPEG] Matando processo FFmpeg para ${childId} devido à desconexão do filho.`);
                ffmpegProcess.kill('SIGKILL'); // Força a interrupção do FFmpeg
            }
            ffmpegProcesses.delete(childId); // Garante que também é removido do map de processos
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
});

// Endpoint WebSocket para o pai solicitar o stream de um filho
app.ws('/parent', (ws, req) => { // Usando app.ws do express-ws, se estiver usando ele
    // Ou usando wss.on('connection') se não estiver usando express-ws
});

// Exemplo de como um pai solicitaria um stream (isso deve ser adaptado ao seu frontend)
// Isso é uma simulação, você precisará de uma API real para isso.
app.post('/api/start_listening', async (req, res) => {
    const { parentId, childId } = req.body; // Supondo que você envia parentId e childId no corpo
    if (!parentId || !childId) {
        return res.status(400).json({ success: false, message: 'ID do pai e do filho são obrigatórios.' });
    }

    console.log(`[API] Pai ${parentId} solicitou stream do filho ${childId}.`);

    const childConn = childConnections.get(childId);
    if (!childConn || !childConn.ffmpegProcess) {
        // Child not connected or FFmpeg not running
        return res.status(404).json({ success: false, message: 'Filho não conectado ou stream não disponível.' });
    }

    // A URL do stream para o pai é a que o FFmpeg está publicando via Nginx
    const streamUrl = `${CLIENT_STREAM_HTTP_URL_BASE}${childId}${CLIENT_STREAM_FORMAT_EXTENSION}`;

    // Atualiza a conexão do pai com a URL do stream ativa
    parentConnections.set(parentId, { ws: null, activeChildStreamUrl: streamUrl }); // ws: null porque este é um endpoint HTTP

    // Envia a URL do stream de volta para o pai
    res.json({ success: true, streamUrl: streamUrl, childId: childId });
});

// Outras rotas da sua aplicação (AWS S3, DynamoDB, etc.)
app.use(bodyParser.json());
app.use(cors()); // Para permitir requisições de diferentes origens

// Exemplo de rota de teste
app.get('/test', (req, res) => {
    res.send('Servidor de monitoramento parental está online!');
});

// Rotas de autenticação (simplificado, implemente a lógica real)
app.post('/api/register_parent', async (req, res) => {
    // ... sua lógica de registro de pai
    res.status(200).send('Registro de pai (placeholder)');
});

app.post('/api/register_child', async (req, res) => {
    // ... sua lógica de registro de filho
    res.status(200).send('Registro de filho (placeholder)');
});

app.post('/api/login_parent', async (req, res) => {
    // ... sua lógica de login de pai
    res.status(200).send('Login de pai (placeholder)');
});

app.post('/api/login_child', async (req, res) => {
    // ... sua lógica de login de filho
    res.status(200).send('Login de filho (placeholder)');
});

// Rota para obter crianças associadas a um pai (exemplo)
app.get('/api/parent/:parentId/children', async (req, res) => {
    const { parentId } = req.params;
    // Lógica para buscar as crianças no DynamoDB
    console.log(`[API] Buscando crianças para o pai ${parentId}`);
    res.json({ children: [{ id: 'child1', name: 'Filho Teste' }] });
});

// Rota para upload de áudio (se ainda usar S3 para mensagens gravadas)
const upload = multer({
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
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
        const audioKey = `audios/${uuidv4()}.mp3`; // Salvar como MP3 (ou o formato real)

        const uploadParams = {
            Bucket: S3_BUCKET_NAME,
            Key: audioKey,
            Body: audioBuffer,
            ContentType: req.file.mimetype // Usar o mimetype original do arquivo
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
                    content: audioUrl, // URL do áudio no S3
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


// Rota para obter conversas (exemplo)
app.get('/api/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    // Lógica para buscar mensagens no DynamoDB
    console.log(`[API] Buscando mensagens para conversa ${conversationId}`);
    res.json({ messages: [] }); // Retornar mensagens reais
});


// Middleware de erro e 404
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});

app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT, '0.0.0.0', () => { // Usando a variável PORT que pode vir do env
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`FFmpeg RTMP Publish URL Base: ${FFMPEG_PUBLISH_RTMP_URL_BASE}`);
    console.log(`Client HLS Stream HTTP URL Base: ${CLIENT_STREAM_HTTP_URL_BASE}`);
});