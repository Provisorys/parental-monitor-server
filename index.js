const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const http = require('http'); // Já deve estar aí
const WebSocket = require('ws'); // Já deve estar aí
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT;

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_CHILDREN = 'Children'; // Você pode remover esta constante se não for mais usar a tabela Children
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Usando sua tabela existente
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

const twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Aumentado para lidar com possíveis mídias grandes
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
const upload = multer(); // Para lidar com 'multipart/form-data'

// --- HTTP SERVER PARA WEBSOCKET ---
const server = http.createServer(app); // Associa o Express com o servidor HTTP
const wss = new WebSocket.Server({ server }); // Cria o servidor WebSocket sobre o HTTP

// =====================================================================================================
// NOVO CÓDIGO AQUI: MAPA PARA ARMAZENAR CONEXÕES WEBSOCKET DE FILHOS
// Coloque esta linha logo abaixo das outras constantes globais.
// =====================================================================================================
const connectedChildren = new Map(); // childId -> wsClient

// =====================================================================================================
// CÓDIGO WEBSOCKET AQUI:
// Coloque este bloco wss.on('connection', ...) logo abaixo da criação de 'wss'.
// =====================================================================================================
wss.on('connection', ws => {
    console.log('Cliente WebSocket conectado');

    ws.on('message', message => {
        try {
            const parsedMessage = JSON.parse(message);
            // Verifica se a mensagem é para registrar o childId
            if (parsedMessage.type === 'REGISTER_CHILD_ID' && parsedMessage.childId) {
                ws.childId = parsedMessage.childId;
                connectedChildren.set(ws.childId, ws);
                console.log(`[WEBSOCKET] ChildId ${ws.childId} registrado e conectado.`);
            } else {
                // Aqui você pode lidar com outras mensagens do cliente, se houver
                console.log('Mensagem WebSocket recebida:', parsedMessage);
                // Exemplo: se o app filho envia a localização em resposta a uma solicitação
                if (parsedMessage.type === 'CURRENT_LOCATION_RESPONSE' && parsedMessage.childId) {
                    const { childId, latitude, longitude, timestamp } = parsedMessage;
                    console.log(`[LOCATION_RESPONSE] Localização atual recebida de ${childId}: Lat ${latitude}, Lon ${longitude}`);
                    
                    // Salvar esta localização no DynamoDB
                    const params = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            childId: childId,
                            timestamp: timestamp, // Usar o timestamp enviado pelo cliente
                            latitude: latitude,
                            longitude: longitude
                        }
                    };

                    docClient.put(params).promise()
                        .then(() => {
                            console.log(`[LOCATION_SAVE_SUCCESS] Localização de ${childId} salva no DynamoDB.`);
                        })
                        .catch(error => {
                            console.error(`[LOCATION_SAVE_ERROR] Erro ao salvar localização de ${childId}:`, error.message);
                            // Pode adicionar um log mais detalhado do erro AWS aqui se precisar para depuração
                            if (error.code && error.statusCode) {
                                console.error(`AWS Error: Code - ${error.code}, Status - ${error.statusCode}, RequestId - ${error.requestId}`);
                            }
                        });
                }
            }
        } catch (e) {
            console.error('[WEBSOCKET_ERROR] Erro ao analisar mensagem WebSocket ou tipo desconhecido:', e);
            console.log(`Mensagem RAW: ${message}`);
        }
    });

    ws.on('close', () => {
        if (ws.childId) {
            connectedChildren.delete(ws.childId);
            console.log(`[WEBSOCKET] ChildId ${ws.childId} desconectado.`);
        }
        console.log('Cliente WebSocket desconectado');
    });

    ws.on('error', error => {
        console.error('Erro no WebSocket:', error);
    });
});

// =====================================================================================================
// NOVA ROTA HTTP PARA SOLICITAR LOCALIZAÇÃO:
// Coloque esta rota junto com suas outras rotas HTTP (como /twilio-token, /notifications, etc.).
// =====================================================================================================
app.post('/request-current-location/:childId', async (req, res) => {
    const childIdToRequest = req.params.childId;
    console.log(`[LOCATION_REQUEST] Requisição do app pai para localização de: ${childIdToRequest}`);

    if (!childIdToRequest) {
        return res.status(400).send('childId é obrigatório para solicitar a localização.');
    }

    const wsClient = connectedChildren.get(childIdToRequest);

    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        // Enviar uma mensagem WebSocket para o cliente filho solicitando a localização
        wsClient.send(JSON.stringify({ type: 'REQUEST_CURRENT_LOCATION' }));
        console.log(`[WEBSOCKET] Enviada instrução REQUEST_CURRENT_LOCATION para ${childIdToRequest}`);
        res.status(200).send(`Solicitação de localização enviada para ${childIdToRequest}`);
    } else {
        console.warn(`[WEBSOCKET] Filho ${childIdToRequest} não conectado via WebSocket para solicitação de localização.`);
        res.status(404).send(`Filho ${childIdToRequest} não encontrado ou desconectado.`);
    }
});


// =====================================================================================================
// REMOVA ESTA ROTA HTTP:
// Você deve remover a rota app.post('/location-update', ...) inteira, pois agora a comunicação
// de localização será via WebSocket, em resposta a uma solicitação.
// =====================================================================================================
// app.post('/location-update', async (req, res) => { /* ... REMOVA ESTA ROTA COMPLETA ... */ });


// --- OUTRAS ROTAS EXISTENTES (coloque-as aqui) ---
// Exemplo (mantenha suas rotas /twilio-token, /notifications, etc. aqui)

// app.post('/twilio-token', (req, res) => { /* ... */ });
// app.post('/send-message', upload.single('media'), async (req, res) => { /* ... */ });
// etc.

// --- TRATAMENTO DE ERROS E INÍCIO DO SERVIDOR ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO DO SERVIDOR (DEVE SER server.listen, não app.listen) ---
server.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
});