const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url'); // Adicionado para parsear a URL do WebSocket

const app = express();
const PORT = process.env.PORT || 10000; // Define um valor padrão para PORT

// CORRIGIDO: Inicializa o multer AQUI, antes de ser usado em app.use()
const upload = multer(); 

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
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Usando sua tabela existente
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

const wsClientsMap = new Map(); // Mapa para armazenar clientes WebSocket

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

// --- HTTP SERVER ---
const server = http.createServer(app);

// --- WEBSOCKET SERVERS ---
const wssAudio = new WebSocket.Server({ noServer: true });
const wssCommands = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    if (pathname === '/audio-stream') {
        wssAudio.handleUpgrade(request, socket, head, ws => {
            wssAudio.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-commands') {
        wssCommands.handleUpgrade(request, socket, head, ws => {
            wssCommands.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wssAudio.on('connection', ws => {
    console.log('[WS_AUDIO] Cliente de áudio conectado.');
    ws.on('message', message => {
        // Encaminha o áudio para outros clientes, se necessário
        wssAudio.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });
    ws.on('close', () => console.log('[WS_AUDIO] Cliente de áudio desconectado.'));
    ws.on('error', error => console.error('[WS_AUDIO_ERROR]', error));
});


wssCommands.on('connection', (ws, req) => {
    const clientId = uuidv4(); // Gera um ID único para cada cliente de comando
    wsClientsMap.set(clientId, ws);
    console.log(`[WS_COMMAND] Cliente de comando conectado (ID: ${clientId}).`);

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log(`[WS_COMMAND] Mensagem recebida de ${clientId}:`, data);

            switch (data.type) {
                case 'register_parent_ws':
                    // Cliente pai está se registrando. Reatribuir o ID para algo mais significativo.
                    const parentId = data.parentId;
                    const newParentClientId = `parent_${parentId}`;
                    wsClientsMap.delete(clientId); // Remove o ID temporário
                    wsClientsMap.set(newParentClientId, ws); // Adiciona com o novo ID
                    console.log(`[WS_COMMAND] Cliente WS ${clientId} re-registrado como pai: ${newParentClientId}`);
                    // Opcional: Enviar confirmação ao pai
                    ws.send(JSON.stringify({ type: 'registration_ack', message: `Registered as ${newParentClientId}` }));
                    break;

                case 'register_child_ws':
                    // Cliente filho está se registrando. Reatribuir o ID para algo mais significativo.
                    const childId = data.childId;
                    const newChildClientId = childId; // Usar o childId diretamente como ID
                    wsClientsMap.delete(clientId); // Remove o ID temporário
                    wsClientsMap.set(newChildClientId, ws); // Adiciona com o novo ID
                    console.log(`[WS_COMMAND] Cliente WS ${clientId} re-registrado como filho: ${newChildClientId}`);
                    // Opcional: Enviar confirmação ao filho
                    ws.send(JSON.stringify({ type: 'registration_ack', message: `Registered as ${newChildClientId}` }));
                    break;
                case 'start_audio_stream':
                    console.log(`[WS_COMMAND] Recebido comando para iniciar áudio para o filho: ${data.childId}`);
                    // Encontrar o WebSocket do filho e enviar comando de áudio
                    const childWsAudio = wsClientsMap.get(data.childId);
                    if (childWsAudio && childWsAudio.readyState === WebSocket.OPEN) {
                        childWsAudio.send(JSON.stringify({ type: 'start_audio' }));
                        console.log(`[WS_COMMAND] Comando 'start_audio' enviado para ${data.childId}`);
                    } else {
                        console.warn(`[WS_COMMAND] Cliente filho ${data.childId} não encontrado ou não está conectado.`);
                    }
                    break;
                case 'stop_audio_stream':
                    console.log(`[WS_COMMAND] Recebido comando para parar áudio para o filho: ${data.childId}`);
                    // Encontrar o WebSocket do filho e enviar comando de áudio
                    const childWsStopAudio = wsClientsMap.get(data.childId);
                    if (childWsStopAudio && childWsStopAudio.readyState === WebSocket.OPEN) {
                        childWsStopAudio.send(JSON.stringify({ type: 'stop_audio' }));
                        console.log(`[WS_COMMAND] Comando 'stop_audio' enviado para ${data.childId}`);
                    } else {
                        console.warn(`[WS_COMMAND] Cliente filho ${data.childId} não encontrado ou não está conectado.`);
                    }
                    break;
                case 'request_current_location':
                    console.log(`[WS_COMMAND] Recebido comando para requisitar localização do filho: ${data.childId}`);
                    // Encontrar o WebSocket do filho e enviar comando para requisitar localização
                    const childWsLocation = wsClientsMap.get(data.childId);
                    if (childWsLocation && childWsLocation.readyState === WebSocket.OPEN) {
                        childWsLocation.send(JSON.stringify({ type: 'request_location_update' }));
                        console.log(`[WS_COMMAND] Comando 'request_location_update' enviado para ${data.childId}`);
                    } else {
                        console.warn(`[WS_COMMAND] Cliente filho ${data.childId} não encontrado ou não está conectado.`);
                    }
                    break;

                default:
                    console.warn('[WS_COMMAND] Tipo de mensagem desconhecido:', data.type);
            }
        } catch (e) {
            console.error('[WS_COMMAND_ERROR] Erro ao parsear mensagem JSON do WebSocket:', e.message);
        }
    });

    ws.on('close', () => {
        // Remover o cliente do mapa ao desconectar
        wsClientsMap.forEach((client, id) => {
            if (client === ws) {
                wsClientsMap.delete(id);
                console.log(`[WS_COMMAND] Cliente de comando desconectado (ID: ${id}).`);
                return;
            }
        });
    });
    ws.on('error', error => console.error('[WS_COMMAND_ERROR]', error));
});

// --- ROTAS HTTP ---
app.use(bodyParser.json());
app.use(cors()); // Configure CORS adequadamente para sua aplicação
app.use(upload.array()); // Para lidar com form-data se necessário (agora 'upload' está definido)

// Rota de registro de filho via HTTP
app.post('/registerChild', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /registerChild');
    const { parentId, childName, childToken, childImage } = req.body;

    if (!parentId || !childName || !childToken) {
        return res.status(400).send('Dados de registro incompletos.');
    }

    const childId = `CHILD_${uuidv4().substring(0, 8)}`; // ID único para o filho

    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS, // Ou uma tabela dedicada para filhos se houver
        Item: {
            parentId: parentId,
            childId: childId,
            childName: childName,
            childToken: childToken, // Firebase Token ou similar
            childImage: childImage || null,
            registeredAt: Date.now()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Filho ${childName} (${childId}) registrado com sucesso para o pai ${parentId}.`);
        res.status(201).json({ message: 'Filho registrado com sucesso!', childId: childId });
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao registrar filho no DynamoDB:', error);
        res.status(500).send('Erro ao registrar filho.');
    }
});


// Rota para obter Twilio Token
app.get('/twilio-token', (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /twilio-token');
    const identity = req.query.identity;

    if (!identity) {
        return res.status(400).send('Identity é necessária para o token Twilio.');
    }

    const accessToken = new AccessToken(
        TWILIO_ACCOUNT_SID,
        TWILIO_API_KEY_SID,
        TWILIO_API_KEY_SECRET,
        { identity: identity }
    );

    // Concede acesso ao Twilio Video
    const videoGrant = new VideoGrant();
    accessToken.addGrant(videoGrant);

    res.json({ token: accessToken.toJwt() });
});

// Rota para enviar notificações (via FCM/Firebase, o servidor precisa implementar o envio)
app.post('/notifications', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /notifications');
    const { recipientToken, title, body, data } = req.body;

    if (!recipientToken || !title || !body) {
        return res.status(400).send('Dados de notificação incompletos.');
    }

    // Aqui você implementaria a lógica para enviar a notificação usando o Firebase Admin SDK
    // Exemplo conceitual:
    /*
    try {
        const message = {
            notification: {
                title: title,
                body: body
            },
            data: data || {},
            token: recipientToken
        };
        const response = await admin.messaging().send(message);
        console.log('Successfully sent message:', response);
        res.status(200).send('Notificação enviada com sucesso!');
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).send('Erro ao enviar notificação.');
    }
    */
    // Por enquanto, apenas um placeholder
    console.log(`[NOTIFICATION_PLACEHOLDER] Notificação para ${recipientToken}: ${title} - ${body}`);
    res.status(200).send('Notificação processada (envio real requer Firebase Admin SDK).');
});


// Rota para receber dados de localização do filho (APP FILHO -> SERVIDOR)
app.post('/location', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /location');
    const { childId, latitude, longitude, timestamp } = req.body;

    if (!childId || latitude === undefined || longitude === undefined || !timestamp) {
        console.warn('[HTTP_ERROR] Dados de localização incompletos:', req.body);
        return res.status(400).send('Dados de localização incompletos. Requer childId, latitude, longitude e timestamp.');
    }

    const locationData = {
        childId: childId,
        timestamp: timestamp, // Chave de ordenação
        latitude: latitude,
        longitude: longitude,
    };

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: locationData
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Localização de ${childId} salva com sucesso.`);

        // --- Lógica para enviar a localização para o aplicativo pai via WebSocket ---
        const messageToParents = JSON.stringify({
            type: 'location_update',
            childId: childId,
            latitude: latitude,
            longitude: longitude,
            timestamp: timestamp
        });

        wsClientsMap.forEach((ws, clientId) => {
            if (ws.readyState === WebSocket.OPEN) {
                // Filtro para enviar apenas para clientes pais
                if (clientId.startsWith('parent_')) { // Assume que o ID do pai começa com 'parent_'
                    try {
                        ws.send(messageToParents);
                        console.log(`[WS] Localização enviada para cliente WS pai (ID: ${clientId}).`);
                    } catch (wsError) {
                        console.error('[WS_ERROR] Erro ao enviar mensagem WS para pai:', wsError);
                    }
                }
            }
        });

        res.status(200).send('Localização recebida e salva com sucesso.');

    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao salvar localização no DynamoDB:', error);
        res.status(500).send('Erro ao processar localização.');
    }
});


// --- ERROS ---
// Middleware para rotas não encontradas (404)
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});

// Middleware de tratamento de erros global (500)
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
});