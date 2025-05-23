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
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Usando sua tabela existente
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

// --- MULTER CONFIG (para upload de arquivos) ---
const upload = multer();

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json()); // Para analisar JSON bodies
app.use(bodyParser.urlencoded({ extended: true })); // Para analisar URL-encoded bodies

// --- ROTAS DA API ---

// Rota de teste
app.get('/', (req, res) => {
    res.send('Servidor Parental Monitor Online!');
});

// Rota para enviar notificações (já existente)
app.post('/notifications', async (req, res) => {
    console.log('[NOTIFICATIONS] Requisição de notificação recebida.');
    const { childId, message, messageType, timestamp, contactOrGroup, direction, phoneNumber } = req.body;

    if (!childId || !message) {
        console.warn('[NOTIFICATIONS_ERROR] Dados de notificação incompletos:', req.body);
        return res.status(400).send('Child ID e mensagem são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            childId: childId,
            messageId: uuidv4(), // Gera um ID único para a mensagem
            message: message,
            messageType: messageType || 'GENERIC', // Tipo de mensagem padrão
            timestamp: timestamp || Date.now(), // Usar timestamp fornecido ou o atual
            contactOrGroup: contactOrGroup || 'N/A',
            direction: direction || 'N/A',
            phoneNumber: phoneNumber || 'N/A',
            receivedAt: new Date().toISOString() // Quando o servidor recebeu
        }
    };

    try {
        await docClient.put(params).promise();
        console.log('[NOTIFICATIONS] Mensagem salva com sucesso no DynamoDB.');
        res.status(200).send('Notificação recebida e salva com sucesso.');
    } catch (error) {
        console.error('[NOTIFICATIONS_DB_ERROR] Erro ao salvar notificação no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor ao salvar notificação.');
    }
});

// Rota para obter token Twilio (já existente)
app.get('/twilio-token', (req, res) => {
    console.log('[TWILIO] Requisição de token Twilio recebida.');
    const identity = req.query.identity || 'monitor-app-user'; // Identidade do usuário
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET) {
        console.error('[TWILIO_ERROR] Credenciais Twilio incompletas. Verifique as variáveis de ambiente.');
        return res.status(500).send('Credenciais Twilio incompletas.');
    }

    const token = new AccessToken(
        TWILIO_ACCOUNT_SID,
        TWILIO_API_KEY_SID,
        TWILIO_API_KEY_SECRET,
        { identity: identity }
    );

    const voiceGrant = new VoiceGrant({
        incomingAllow: true, // Permitir chamadas de entrada
        outgoingApplicationSid: process.env.TWILIO_APP_SID // SID do seu TwiML App
    });

    token.addGrant(voiceGrant);

    console.log(`[TWILIO] Token gerado para identidade: ${identity}`);
    res.json({ token: token.toJwt() });
});

// Rota para iniciar escuta (áudio unidirecional - já existente)
app.post('/start-listening/:childId', async (req, res) => {
    const { childId } = req.params;
    console.log(`[AUDIO_STREAMING] Requisição para iniciar escuta recebida para childId: ${childId}`);
    // Implementar a lógica para iniciar a escuta do áudio do dispositivo da criança.
    // Isso pode envolver:
    // 1. Notificar o dispositivo da criança (via FCM, WebSocket ou outra forma) para iniciar o streaming.
    // 2. Preparar um endpoint no servidor para receber o fluxo de áudio.
    // 3. Autenticação/Autorização para garantir que apenas pais autorizados possam iniciar a escuta.

    // Por enquanto, apenas um placeholder:
    try {
        // Exemplo: Enviar uma notificação para o dispositivo da criança via DynamoDB (ou FCM)
        const params = {
            TableName: DYNAMODB_TABLE_MESSAGES, // Reutilizando a tabela de mensagens para comandos
            Item: {
                childId: childId,
                messageId: uuidv4(),
                message: "Comando: Iniciar streaming de áudio",
                messageType: "COMMAND_START_AUDIO_STREAM",
                timestamp: Date.now(),
                receivedAt: new Date().toISOString()
            }
        };
        await docClient.put(params).promise();
        console.log(`[AUDIO_STREAMING] Comando 'Iniciar streaming de áudio' enviado para ${childId}.`);
        res.status(200).send(`Comando para iniciar escuta enviado para ${childId}.`);
    } catch (error) {
        console.error('[AUDIO_STREAMING_ERROR] Erro ao enviar comando de áudio:', error);
        res.status(500).send('Erro interno do servidor ao iniciar escuta.');
    }
});

// Rota para parar escuta (áudio unidirecional - já existente)
app.post('/stop-listening/:childId', async (req, res) => {
    const { childId } = req.params;
    console.log(`[AUDIO_STREAMING] Requisição para parar escuta recebida para childId: ${childId}`);
    // Implementar a lógica para parar a escuta do áudio.
    try {
        const params = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: {
                childId: childId,
                messageId: uuidv4(),
                message: "Comando: Parar streaming de áudio",
                messageType: "COMMAND_STOP_AUDIO_STREAM",
                timestamp: Date.now(),
                receivedAt: new Date().toISOString()
            }
        };
        await docClient.put(params).promise();
        console.log(`[AUDIO_STREAMING] Comando 'Parar streaming de áudio' enviado para ${childId}.`);
        res.status(200).send(`Comando para parar escuta enviado para ${childId}.`);
    } catch (error) {
        console.error('[AUDIO_STREAMING_ERROR] Erro ao enviar comando de áudio (parar):', error);
        res.status(500).send('Erro interno do servidor ao parar escuta.');
    }
});


// ====================================================================
// NOVA ROTA PARA RECEBER ATUALIZAÇÕES DE LOCALIZAÇÃO (ADICIONADA AQUI)
// ====================================================================
app.post('/location-update', async (req, res) => {
    console.log('[LOCATION_UPDATE] Requisição de localização recebida.');
    const { childId, latitude, longitude, timestamp } = req.body;

    if (!childId || latitude === undefined || longitude === undefined || timestamp === undefined) {
        console.warn('[LOCATION_UPDATE_ERROR] Dados de localização incompletos:', req.body);
        return res.status(400).send('Dados de localização incompletos. Requer childId, latitude, longitude, timestamp.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS, // Usando a constante para a tabela 'GPSintegracao'
        Item: {
            childId: childId,
            timestamp: timestamp, // Unix timestamp em milissegundos
            latitude: latitude,
            longitude: longitude,
            recordedAt: new Date(timestamp).toISOString() // Data/hora legível para facilitar a consulta
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[LOCATION_UPDATE_SUCCESS] Localização para ${childId} salva com sucesso no DynamoDB.`);
        res.status(200).send('Localização salva com sucesso.');
    } catch (error) {
        console.error('[LOCATION_UPDATE_DB_ERROR] Erro ao salvar localização no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor ao salvar localização.');
    }
});


// Rota para upload de mídia (já existente)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    console.log('[UPLOAD] Requisição de upload de mídia recebida.');
    const { childId, messageId, timestamp, mediaType, conversationId } = req.body;
    const file = req.file;

    if (!childId || !messageId || !timestamp || !mediaType || !file) {
        console.warn('[UPLOAD_ERROR] Dados de upload incompletos ou arquivo ausente.');
        return res.status(400).send('Dados de upload incompletos ou arquivo de mídia ausente.');
    }

    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${childId}/${mediaType}/${messageId}.${fileExtension}`; // Ex: child123/image/abc-123.jpg

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: 'private' // Ajuste conforme sua política de acesso
    };

    try {
        await s3.upload(params).promise();
        const fileUrl = `https://${S3_BUCKET_NAME}.s3.${AWS.config.region}.amazonaws.com/${fileName}`;
        console.log(`[UPLOAD_SUCCESS] Mídia ${fileName} enviada para S3. URL: ${fileUrl}`);

        // Atualizar a entrada na tabela de mensagens com a URL da mídia
        const updateParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Key: {
                childId: childId,
                messageId: messageId
            },
            UpdateExpression: 'SET mediaUrl = :mediaUrl, mediaUploaded = :mediaUploaded',
            ExpressionAttributeValues: {
                ':mediaUrl': fileUrl,
                ':mediaUploaded': true
            },
            ReturnValues: 'UPDATED_NEW'
        };
        await docClient.update(updateParams).promise();
        console.log(`[UPLOAD_DB_UPDATE] Entrada no DynamoDB atualizada para ${messageId}.`);

        res.status(200).json({ message: 'Mídia carregada e URL salva com sucesso.', url: fileUrl });

    } catch (error) {
        console.error('[UPLOAD_AWS_ERROR] Erro ao carregar mídia para S3 ou atualizar DynamoDB:', error);
        res.status(500).send('Erro ao carregar mídia.');
    }
});

// Manipuladores de erro e rota não encontrada (mantenha-os no final, após todas as rotas)
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});

app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    console.log('Cliente WebSocket conectado');
    ws.on('message', message => {
        console.log(`Recebido via WebSocket: ${message}`);
        // Implemente a lógica para lidar com mensagens WebSocket
        // Por exemplo, encaminhar comandos para dispositivos ou status de volta aos clientes.
    });
    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado');
    });
    ws.on('error', error => {
        console.error('Erro no WebSocket:', error);
    });
});

server.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`); // Adicionado para confirmação
});