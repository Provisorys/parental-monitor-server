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
const PORT = process.env.PORT;
const upload = multer(); // Configuração do Multer

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Nova tabela para localizações GPS
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

const wsClientsMap = new Map(); // Mapa para armazenar clientes WebSocket

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

// --- Middlewares HTTP ---
app.use(bodyParser.json());
app.use(cors()); // Configure CORS adequadamente para sua aplicação
app.use(upload.array()); // Para lidar com form-data se necessário

// --- Rotas HTTP (Express) ---
app.get('/', (req, res) => {
    res.send('Servidor Parental Monitor está online!');
});

// Rota para receber localização do cliente filho
app.post('/location', async (req, res) => {
    const { childId, latitude, longitude, timestamp } = req.body;
    console.log(`[HTTP_REQUEST] Requisição recebida: POST /location para childId: ${childId}`);

    if (!childId || !latitude || !longitude || !timestamp) {
        console.warn('[HTTP_REQUEST] Dados de localização incompletos.');
        return res.status(400).send('Dados de localização incompletos.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            childId: childId,
            timestamp: timestamp, // Usar o timestamp fornecido pelo cliente
            latitude: latitude,
            longitude: longitude
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Localização de ${childId} salva com sucesso.`);

        // Enviar atualização de localização via WebSocket para os clientes pai
        wsClientsMap.forEach((ws, clientId) => {
            if (clientId.startsWith('parent_') && ws.readyState === WebSocket.OPEN) {
                const message = JSON.stringify({
                    type: 'location_update',
                    childId: childId,
                    latitude: latitude,
                    longitude: longitude,
                    timestamp: timestamp
                });
                ws.send(message);
                console.log(`[WS] Localização enviada para cliente WS pai (ID: ${clientId}).`);
            }
        });

        res.status(200).send('Localização recebida e salva com sucesso.');
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao salvar localização no DynamoDB:', error);
        res.status(500).send('Erro ao processar localização.');
    }
});

// --- WEB SOCKETS ---
const server = http.createServer(app); // Crie o servidor HTTP a partir do app Express
const wss = new WebSocket.Server({ noServer: true }); // Usar `noServer: true` para integrar com o servidor HTTP

wss.on('connection', ws => {
    console.log('[WS] Novo cliente WebSocket conectado.');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            console.log(`[WS_MSG] Mensagem recebida: ${message}`);

            if (data.type === 'client_init') {
                const clientId = data.clientId || uuidv4();
                wsClientsMap.set(clientId, ws);
                ws.clientId = clientId; // Armazena o clientId no objeto ws para referência futura
                console.log(`[WS_INIT] Cliente ${clientId} inicializado e conectado.`);
            } else if (data.type === 'request_current_location') {
                console.log(`[WS_COMMAND] Recebido comando para requisitar localização do filho: ${data.childId}`);
                // Encontrar o cliente filho correspondente para enviar a requisição
                const childWsLocation = wsClientsMap.get(data.childId);
                if (childWsLocation && childWsLocation.readyState === WebSocket.OPEN) {
                    childWsLocation.send(JSON.stringify({ type: 'request_location_update' }));
                    console.log(`[WS_COMMAND] Comando 'request_location_update' enviado para ${data.childId}`);
                } else {
                    console.warn(`[WS_COMMAND] Cliente filho ${data.childId} não encontrado ou não está conectado.`);
                }
            } else if (data.type === 'message') { // Exemplo: para mensagens de chat
                // ... Sua lógica para mensagens de chat ...
                console.log(`[WS_CHAT] Mensagem de chat de ${data.senderId} para ${data.receiverId}: ${data.content}`);
                // Exemplo de reenvio:
                const receiverWs = wsClientsMap.get(data.receiverId);
                if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                    receiverWs.send(JSON.stringify(data));
                }
            } else if (data.type === 'audio_chunk') { // Exemplo: para chunks de áudio
                // ... Sua lógica para chunks de áudio ...
                console.log(`[WS_AUDIO] Chunk de áudio de ${data.senderId} para ${data.receiverId}, tamanho: ${data.chunk.length}`);
                // Exemplo de reenvio:
                const receiverWs = wsClientsMap.get(data.receiverId);
                if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                    receiverWs.send(JSON.stringify(data));
                }
            }
        } catch (error) {
            console.error('[WS_ERROR] Erro ao analisar mensagem WebSocket:', error);
        }
    });

    ws.on('close', () => {
        if (ws.clientId) {
            wsClientsMap.delete(ws.clientId);
            console.log(`[WS_CLOSE] Cliente ${ws.clientId} desconectado.`);
        } else {
            console.log('[WS_CLOSE] Cliente WebSocket desconectado (ID não definido).');
        }
    });

    ws.on('error', error => {
        console.error(`[WS_ERROR] Erro no WebSocket para ${ws.clientId || 'cliente sem ID'}:`, error);
    });
});

server.on('upgrade', (request, socket, head) => {
    // Apenas aceite upgrades para o caminho raiz '/'
    if (request.url === '/') { // <<< LINHA MODIFICADA AQUI!
        wss.handleUpgrade(request, socket, head, ws => {
            wss.emit('connection', ws, request);
            console.log('[WS_UPGRADE] Conexão WebSocket no / estabelecida.'); // Log ajustado
        });
    } else {
        socket.destroy(); // Rejeita outras conexões de upgrade
        console.warn(`[WS_UPGRADE_REJECT] Tentativa de conexão WebSocket em rota inválida: ${request.url}`);
    }
});


// --- ERROS ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);    
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`S3 Bucket Name: ${S3_BUCKET_NAME}`);
    console.log(`Twilio Account SID configurado: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio Auth Token configurado: ${process.env.TWILIO_AUTH_TOKEN ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurado: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurado: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
});