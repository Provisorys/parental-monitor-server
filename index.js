const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const http = require('http');
const WebSocket = require('ws');

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

const DYNAMODB_TABLE_CHILDREN = 'Children';  // Não vamos usar diretamente para obter childIds
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`Requisição recebida: ${req.method} ${req.url}`);
    next();
});

app.get('/', (req, res) => {
    res.status(200).send('Servidor Parental Monitor rodando!');
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});

// --- ROTAS DE API ---
app.post('/notifications', async (req, res) => {
    // ... (seu código para /notifications permanece o mesmo)
    const { childId, message, messageType, timestamp, contactOrGroup, direction, phoneNumber } = req.body;
    const timestampValue = timestamp || Date.now();
    const messageTypeString = messageType || 'TEXT_MESSAGE';

    if (!childId || !message) {
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
        console.log('Mensagem salva com sucesso no DynamoDB.');

        console.log('Tentando atualizar conversa no DynamoDB:', { childId: childId, contactOrGroup: contactOrGroupValue });
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
                ':lastMessage': message,
                ':phoneNumber': phoneNumberValue,
                ':direction': messageDirection
            }
        }).promise();
        console.log('Conversa atualizada com sucesso no DynamoDB.');

        res.status(200).json({ message: 'Notificação recebida e salva com sucesso' });
    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ message: 'Erro interno', error: error.message });
    }
});

app.post('/media', upload.single('file'), async (req, res) => {
    // ... (seu código para /media permanece o mesmo)
    const { childId, type, timestamp, direction, contactOrGroup, phoneNumber } = req.body;
    const file = req.file;
    const timestampValue = timestamp || Date.now();

    if (!file) return res.status(400).json({ message: 'Arquivo é obrigatório' });
    if (!direction || !['sent', 'received'].includes(direction)) {
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

        res.status(200).json({ message: 'Mídia recebida com sucesso', s3Url: messageItem.s3Url });

    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ message: 'Erro ao processar mídia', error: error.message });
    }
});

app.get('/get-conversations/:childId', async (req, res) => {
    // ... (seu código para /get-conversations/:childId permanece o mesmo)
    const { childId } = req.params;
    if (!childId) return res.status(400).json({ message: 'childId é obrigatório' });

    try {
        console.log(`Buscando conversas para childId: ${childId} na tabela ${DYNAMODB_TABLE_CONVERSATIONS}`); // Log adicionado
        const convData = await docClient.query({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: {
                ':cid': childId
            }
        }).promise();

        console.log(`Conversas encontradas para ${childId}: ${convData.Items.length} itens.`); // Log adicionado

        const groupedConversations = [];

        for (const conv of convData.Items) {
            console.log(`Buscando mensagens para conversa: ${conv.contactOrGroup} (childId: ${childId})`); // Log adicionado
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
            console.log(`Mensagens encontradas para ${conv.contactOrGroup}: ${messages.length} itens.`); // Log adicionado

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
        console.error('Erro ao buscar conversas:', error);
        res.status(500).json({ message: 'Erro ao buscar conversas', error: error.message });
    }
});

app.get('/get-child-ids', async (req, res) => {
    try {
        console.log(`Tentando escanear child IDs na tabela ${DYNAMODB_TABLE_CONVERSATIONS} do DynamoDB.`); // Log adicionado
        const data = await docClient.scan({
            TableName: DYNAMODB_TABLE_CONVERSATIONS, // Alterado para CONVERSATIONS
            ProjectionExpression: 'childId',        // Pegamos o childId
        }).promise();

        // Extrai os childIds únicos do resultado
        const childIds = [...new Set(data.Items.map(item => item.childId))];
        console.log('childIDs encontrados no DynamoDB (GET /get-child-ids):', childIds); // Log adicionado
        
        res.status(200).json(childIds);
    } catch (error) {
        console.error('Erro ao listar child IDs:', error);
        res.status(500).json({ message: 'Erro ao listar child IDs', error: error.message });
    }
});

app.post('/rename-child-id/:oldChildId/:newChildId', async (req, res) => {
    return res.status(501).json({
        message: 'Funcionalidade de renomear childId não está implementada'
    });
});

app.get('/twilio-token', (req, res) => {
    // ... (seu código para /twilio-token permanece o mesmo)
    const { identity } = req.query;

    if (!identity) {
        return res.status(400).send('A identidade (identity) é obrigatória.');
    }

    try {
        // Crie um token de acesso
        const accessToken = new twilio.jwt.AccessToken(
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID, // Use API Key SID
            TWILIO_API_KEY_SECRET, // Use API Key Secret
            { identity: identity }
        );

        // Crie uma permissão para o Video
        const grant = new twilio.jwt.AccessToken.VideoGrant();
        accessToken.addGrant(grant);

        // Envie o token de volta como JSON
        res.json({ token: accessToken.toJwt() });

        console.log(`Token Twilio gerado para identidade: ${identity}`);
    } catch (error) {
        console.error('Erro ao gerar token Twilio:', error);
        res.status(500).json({ error: 'Erro ao gerar token Twilio', details: error.message });
    }
});

// --- ROTAS PARA STREAMING DE ÁUDIO ---
const listeningParents = new Map(); // Mapa para armazenar os WebSockets dos pais ouvintes

app.post('/start-listening/:childId', (req, res) => {
    const childId = req.params.childId;
    // Implementação temporária para encontrar a primeira conexão de pai
    let parentFound = false;
    wss.clients.forEach(client => {
        if (client.isParent && client.readyState === WebSocket.OPEN) { // Garante que o cliente é um pai e está conectado
            listeningParents.set(childId, client);
            console.log(`Pai conectado com ID: ${client.clientId} começou a ouvir o filho: ${childId}`); // Log mais detalhado
            res.sendStatus(200);
            parentFound = true;
            // Notificar o filho para começar a transmitir (via WebSocket)
            wss.clients.forEach(childClient => {
                if (childClient.clientId === childId && childClient.readyState === WebSocket.OPEN) {
                    childClient.send(JSON.stringify({ type: 'START_AUDIO' }));
                    console.log(`Sinal START_AUDIO enviado para o filho: ${childId}`); // Log de sinal
                }
            });
            // Assumimos que apenas um pai pode ouvir um filho por vez nesta implementação simplificada
            return; 
        }
    });
    if (!parentFound) { // Se nenhum pai foi encontrado
        console.log(`Nenhum pai conectado para ouvir o filho: ${childId}`); // Log de erro
        res.status(400).send('Nenhum pai conectado para ouvir.');
    }
});

app.post('/stop-listening/:childId', (req, res) => {
    const childId = req.params.childId;
    if (listeningParents.has(childId)) {
        listeningParents.delete(childId);
        console.log(`Pai parou de ouvir o filho: ${childId}`);
        res.sendStatus(200);
        // Opcional: Notificar o filho para parar de transmitir (via WebSocket)
        wss.clients.forEach(childClient => {
            if (childClient.clientId === childId && childClient.readyState === WebSocket.OPEN) {
                childClient.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                console.log(`Sinal STOP_AUDIO enviado para o filho: ${childId}`); // Log de sinal
            }
        });
    } else {
        console.log(`Nenhum pai estava ouvindo o filho: ${childId}`); // Log de aviso
        res.status(400).send('Nenhum pai estava ouvindo este childId.');
    }
});

// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/audio-stream' });

wss.on('connection', ws => {
    console.log('Novo cliente WebSocket conectado');

    ws.isParent = false;
    ws.clientId = null; // Para clientes filhos
    ws.parentId = null; // Para clientes pais, se você quiser identificar o pai

    ws.on('message', message => {
        const messageString = message.toString();
        // console.log(`Mensagem WebSocket recebida: ${messageString.substring(0, 50)}...`); // Limita o log para não inundar com dados binários

        if (messageString.startsWith('CHILD_ID:')) {
            ws.clientId = messageString.substring('CHILD_ID:'.length);
            console.log(`Filho conectado com ID: ${ws.clientId}`);
            // Se houver um pai esperando para ouvir este filho, conecte-os (sinalizando via WebSocket)
            const parentWs = listeningParents.get(ws.clientId);
            if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                console.log(`Sinal START_AUDIO enviado para o filho ${ws.clientId} via WebSocket.`);
            }
        } else if (messageString.startsWith('PARENT_ID:')) {
            ws.isParent = true;
            ws.parentId = messageString.substring('PARENT_ID:'.length); // Se o pai tiver um ID
            console.log(`Pai conectado (ID: ${ws.parentId || 'desconhecido'})`);
        } else if (ws.clientId && !ws.isParent) {
            // Relay dos dados de áudio para o pai ouvinte
            const parentWs = listeningParents.get(ws.clientId);
            if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                parentWs.send(message);
            }
        } else if (ws.isParent && messageString.startsWith('COMMAND:')) {
            // Exemplo: Pai pode enviar comandos ao servidor via WebSocket
            const command = messageString.substring('COMMAND:'.length);
            console.log(`Comando de pai recebido: ${command}`);
            // Você pode adicionar lógica aqui para lidar com comandos do pai (ex: pausar áudio)
        }
    });

    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado');
        if (ws.clientId) {
            console.log(`Filho com ID ${ws.clientId} desconectado.`);
            // Se este filho estava sendo ouvido por um pai, remove a entrada e sinaliza o pai
            listeningParents.forEach((parentWs, childId) => {
                if (childId === ws.clientId) {
                    listeningParents.delete(childId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId }));
                        console.log(`Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${childId}.`);
                    }
                }
            });
        } else if (ws.isParent) {
            console.log(`Pai com ID ${ws.parentId || 'desconhecido'} desconectado.`);
            // Se este pai estava ouvindo algum filho, remove a entrada
            listeningParents.forEach((parentWs, childId) => {
                if (parentWs === ws) {
                    listeningParents.delete(childId);
                    console.log(`Pai que ouvia ${childId} desconectado. Parando escuta.`);
                }
            });
        }
    });

    ws.on('error', error => {
        console.error('Erro no WebSocket:', error);
        // Lógica de tratamento de erro
    });
});

// --- ERROS ---
app.use((req, res) => {
    res.status(404).send('Rota não encontrada');
});
app.use((err, req, res, next) => {
    console.error('Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    // Logs de inicialização das credenciais via variáveis de ambiente
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    // NOVOS LOGS PARA CONSTANTES DE TABELA
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    // FIM DOS NOVOS LOGS
    console.log(`Twilio Account SID configurado via env: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurada via env: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurada via env: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
});