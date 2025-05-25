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
const PORT = process.env.PORT || 10000; // Define um valor padrão para PORT

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
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET; // CORRIGIDO AQUI!
const TWILIO_APP_SID = process.env.TWILIO_APP_SID; // Certifique-se que esta também esteja definida

const twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID }); // E AQUI!

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const upload = multer();

// --- HTTP ROUTES ---
app.get('/twilio-token', (req, res) => {
    try {
        const identity = uuidv4();
        const AccessToken = twilio.jwt.AccessToken;
        const VoiceGrant = AccessToken.VoiceGrant;

        const voiceGrant = new VoiceGrant({
            outgoingApplicationSid: TWILIO_APP_SID,
            incomingAllow: true,
        });

        const token = new AccessToken(
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID,
            TWILIO_API_KEY_SECRET, // CORRIGIDO AQUI!
            { identity: identity }
        );
        token.addGrant(voiceGrant);

        res.json({ token: token.toJwt() });
        console.log('Token Twilio gerado com sucesso.');
    } catch (error) {
        console.error('Erro ao gerar token Twilio:', error);
        res.status(500).send('Erro interno do servidor ao gerar token Twilio.');
    }
});

// Rota para registrar dispositivo
app.post('/register', async (req, res) => {
    const { childId, deviceId } = req.body;
    console.log(`[HTTP_REGISTER] Requisição de registro recebida - Child ID: ${childId}, Device ID: ${deviceId}`);

    if (!childId || !deviceId) {
        return res.status(400).send('ChildId e DeviceId são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        Item: {
            childId: childId,
            deviceId: deviceId,
            registrationTimestamp: Date.now()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] ChildId ${childId} registrado com sucesso na tabela ${DYNAMODB_TABLE_CONVERSATIONS}.`);
        res.status(200).send('Dispositivo registrado com sucesso.');
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao registrar dispositivo:', error);
        res.status(500).send('Erro interno do servidor ao registrar dispositivo.');
    }
});

app.post('/notify', async (req, res) => {
    const notificationData = req.body;
    console.log('[HTTP_NOTIFY] Notificação recebida:', notificationData);
    if (!notificationData.childId || !notificationData.message) {
        return res.status(400).send('ChildId e message são obrigatórios para notificação.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            messageId: uuidv4(),
            childId: notificationData.childId,
            message: notificationData.message,
            messageType: notificationData.messageType || 'NOTIFICATION',
            timestamp: notificationData.timestamp || Date.now(),
            contactOrGroup: notificationData.contactOrGroup,
            direction: notificationData.direction,
            phoneNumber: notificationData.phoneNumber
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Notificação para ${notificationData.childId} salva com sucesso.`);
        res.status(200).send('Notificação recebida e processada.');
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao salvar notificação:', error);
        res.status(500).send('Erro interno do servidor ao processar notificação.');
    }
});

app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo enviado.');
    }

    const { childId, type, timestamp, metadata } = req.body;
    const fileContent = req.file.buffer;
    const fileName = `${childId}/${type}/${Date.now()}-${uuidv4()}-${req.file.originalname}`;

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: fileName,
        Body: fileContent,
        ContentType: req.file.mimetype
    };

    try {
        await s3.upload(params).promise();
        console.log(`Arquivo ${fileName} enviado para S3 com sucesso.`);

        const dbParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: {
                messageId: uuidv4(),
                childId: childId,
                messageType: 'MEDIA',
                s3Key: fileName,
                timestamp: timestamp || Date.now(),
                metadata: metadata || {}
            }
        };
        await docClient.put(dbParams).promise();
        console.log(`Metadados de mídia para ${childId} salvos no DynamoDB.`);

        res.status(200).send('Mídia e metadados enviados com sucesso.');
    } catch (error) {
        console.error('Erro ao fazer upload para S3 ou salvar metadados:', error);
        res.status(500).send('Erro interno do servidor ao processar mídia.');
    }
});

// Nova rota HTTP para o aplicativo pai requisitar a localização
app.post('/request-current-location/:childId', (req, res) => {
    const childId = req.params.childId;
    console.log(`[HTTP_REQUEST] Recebido pedido de localização para childId: ${childId}`);

    const childWs = connectedChildren.get(childId); // connectedChildren é o Map de WebSockets

    if (childWs && childWs.readyState === WebSocket.OPEN) {
        // Envia o comando REQUEST_CURRENT_LOCATION via WebSocket para o app filho
        childWs.send(JSON.stringify({ type: 'REQUEST_CURRENT_LOCATION' }));
        console.log(`[WEBSOCKET] Comando REQUEST_CURRENT_LOCATION enviado para ${childId} via WebSocket.`);
        res.status(200).send(`Comando de localização enviado para ${childId}.`);
    } else {
        console.warn(`[HTTP_WARNING] ChildId ${childId} não encontrado ou WebSocket não está conectado/aberto.`);
        // Se o WebSocket não estiver conectado, o pai pode tentar novamente ou notificar o usuário
        res.status(404).send(`ChildId ${childId} não encontrado ou não conectado via WebSocket.`);
    }
});


// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const connectedChildren = new Map();

wss.on('connection', ws => {
    console.log('Novo cliente WebSocket conectado.');

    ws.on('message', async (message, isBinary) => {
        if (isBinary) {
            if (ws.childId) {
                console.log(`[WEBSOCKET] Recebido stream de áudio do childId ${ws.childId}. Tamanho: ${message.length} bytes.`);
            } else {
                console.warn('[WEBSOCKET] Recebido dado binário de cliente não registrado (sem childId).');
            }
        } else {
            try {
                const data = JSON.parse(message);
                console.log('[WEBSOCKET] Mensagem JSON recebida:', data);

                switch (data.type) {
                    case 'REGISTER_CHILD_ID':
                        ws.childId = data.childId;
                        connectedChildren.set(ws.childId, ws);
                        console.log(`[WEBSOCKET] ChildId ${ws.childId} registrado para esta conexão WebSocket.`);
                        break;

                    case 'CURRENT_LOCATION_RESPONSE':
                        console.log('[WEBSOCKET] Recebida atualização de localização via WebSocket.');
                        const { childId, latitude, longitude, timestamp } = data;

                        if (!childId || latitude === undefined || longitude === undefined || timestamp === undefined) {
                            console.error('[WEBSOCKET_ERROR] Dados de localização incompletos ou inválidos:', data);
                            return;
                        }

                        const locationItem = {
                            locationId: uuidv4(),
                            childId: childId,
                            latitude: latitude,
                            longitude: longitude,
                            timestamp: timestamp
                        };

                        const locationParams = {
                            TableName: DYNAMODB_TABLE_LOCATIONS,
                            Item: locationItem
                        };

                        try {
                            await docClient.put(locationParams).promise();
                            console.log(`[DYNAMODB] Localização do childId ${childId} salva com sucesso em ${DYNAMODB_TABLE_LOCATIONS}.`);
                            ws.send(JSON.stringify({ type: 'LOCATION_SAVED_ACK', success: true }));
                        } catch (dbError) {
                            console.error('[DYNAMODB_ERROR] Erro ao salvar localização no DynamoDB:', dbError);
                            ws.send(JSON.stringify({ type: 'LOCATION_SAVED_ACK', success: false, error: dbError.message }));
                        }
                        break;

                    case 'REQUEST_CURRENT_LOCATION_COMMAND': // Esta lógica é para comandos recebidos via WebSocket
                        const targetChildId = data.childId;
                        if (targetChildId) {
                            const childWs = connectedChildren.get(targetChildId);
                            if (childWs && childWs.readyState === WebSocket.OPEN) {
                                childWs.send(JSON.stringify({ type: 'REQUEST_CURRENT_LOCATION' }));
                                console.log(`[WEBSOCKET] Comando REQUEST_CURRENT_LOCATION enviado para ${targetChildId}.`);
                            } else {
                                console.warn(`[WEBSOCKET] ChildId ${targetChildId} não encontrado ou WebSocket não está aberto para enviar comando de localização.`);
                            }
                        } else {
                            console.warn('[WEBSOCKET] Comando REQUEST_CURRENT_LOCATION_COMMAND recebido sem childId.');
                        }
                        break;
                    case 'START_AUDIO_COMMAND':
                        const audioTargetChildId = data.childId;
                        if (audioTargetChildId) {
                            const childWs = connectedChildren.get(audioTargetChildId);
                            if (childWs && childWs.readyState === WebSocket.OPEN) {
                                childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                                console.log(`[WEBSOCKET] Comando START_AUDIO enviado para ${audioTargetChildId}.`);
                            } else {
                                console.warn(`[WEBSOCKET] ChildId ${audioTargetChildId} não encontrado ou WebSocket não está aberto para iniciar áudio.`);
                            }
                        }
                        break;
                    case 'STOP_AUDIO_COMMAND':
                        const stopAudioTargetChildId = data.childId;
                        if (stopAudioTargetChildId) {
                            const childWs = connectedChildren.get(stopAudioTargetChildId);
                            if (childWs && childWs.readyState === WebSocket.OPEN) {
                                childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                                console.log(`[WEBSOCKET] Comando STOP_AUDIO enviado para ${stopAudioTargetChildId}.`);
                            } else {
                                console.warn(`[WEBSOCKET] ChildId ${stopAudioTargetChildId} não encontrado ou WebSocket não está aberto para parar áudio.`);
                            }
                        }
                        break;

                    default:
                        console.warn(`[WEBSOCKET] Tipo de mensagem JSON desconhecido: ${data.type}`);
                }
            } catch (e) {
                console.error('[WEBSOCKET_ERROR] Erro ao analisar mensagem WebSocket (não binária) ou tipo desconhecido:', e);
                console.log(`Mensagem RAW: ${message.toString()}`);
            }
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


// --- ERROS ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Twilio Account SID configurado via env: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio Auth Token configurado via env: ${process.env.TWILIO_AUTH_TOKEN ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurado via env: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurado via env: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
    console.log(`Twilio App SID configurado via env: ${process.env.TWILIO_APP_SID ? 'Sim' : 'Não'}`);
});