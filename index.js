const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');

// SDK do Agora para geração de tokens
const { RtcTokenBuilder, RtcRole } = require('agora-access-token'); // Ou 'agora-token'

const app = express();
const PORT = process.env.PORT;

// --- AWS CONFIG ---
// ATENÇÃO: Credenciais hard-coded são inseguras em produção.
// Mantenha-as aqui apenas enquanto o Render não resolve a injeção de variáveis de ambiente.
AWS.config.update({
    accessKeyId: 'AKIA2EMP3DRMLNLXF4K7',
    secretAccessKey: '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',
    region: 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_CHILDREN = 'Children';
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const S3_BUCKET_NAME = 'parental-monitor-midias-provisory';

// --- AGORA.IO CONFIG ---
// ATENÇÃO: Estas credenciais também devem ser variáveis de ambiente!
const AGORA_APP_ID = '2537397539f642e1b6e955ed09d6ab49'; // <-- Substitua pelo seu App ID do Agora
const AGORA_APP_CERTIFICATE = '4472585332d446e48c2f36bc55f63f8c'; // <-- Substitua pelo seu App Certificate do Agora

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

// --- ROTA: /notifications ---
app.post('/notifications', async (req, res) => {
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

        res.status(200).json({ message: 'Notificação recebida e salva com sucesso' });
    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ message: 'Erro interno', error: error.message });
    }
});

// --- ROTA: /media ---
app.post('/media', upload.single('file'), async (req, res) => {
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

// --- ROTA: /get-conversations/:childId ---
app.get('/get-conversations/:childId', async (req, res) => {
    const { childId } = req.params;
    if (!childId) return res.status(400).json({ message: 'childId é obrigatório' });

    try {
        const convData = await docClient.query({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: {
                ':cid': childId
            }
        }).promise();

        const groupedConversations = [];

        for (const conv of convData.Items) {
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

// --- ROTA: /get-child-ids ---
app.get('/get-child-ids', async (req, res) => {
    try {
        const data = await docClient.scan({
            TableName: DYNAMODB_TABLE_CHILDREN,
            ProjectionExpression: 'childId'
        }).promise();

        const childIds = [...new Set(data.Items.map(item => item.childId))];
        res.status(200).json(childIds);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao listar child IDs', error: error.message });
    }
});

// --- ROTA: /rename-child-id (não implementada) ---
app.post('/rename-child-id/:oldChildId/:newChildId', async (req, res) => {
    return res.status(501).json({
        message: 'Funcionalidade de renomear childId não está implementada'
    });
});

// --- NOVA ROTA: /agora-token ---
// Esta rota gera um token para o Agora.io
app.get('/agora-token', (req, res) => {
    const { channelName, uid, role, expiry } = req.query; // channelName é essencial, uid opcional, role/expiry com defaults

    if (!channelName) {
        return res.status(400).json({ error: 'channelName é obrigatório.' });
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + (parseInt(expiry) || 3600); // Token válido por 1 hora (3600 segundos) por padrão

    // UID pode ser um número ou 0 para Agora, ou uma string para o novo SDK (agora-token)
    // Para RtcTokenBuilder, geralmente UID é um número (uid = 0 para guest)
    const numericUid = parseInt(uid) || 0; // Converte UID para número, ou usa 0

    // RtcRole.PUBLISHER para quem vai enviar áudio (celular do filho)
    // RtcRole.SUBSCRIBER para quem vai receber áudio (seu app de monitoramento)
    // Por padrão, quem solicita o token para se conectar a um canal para ouvir o microfone de alguém, é SUBSCRIBER.
    // Mas se o celular do filho for se conectar para ENVIAR áudio, ele precisará de PUBLISHER.
    // Você pode parametrizar isso se tiver múltiplos clientes no futuro.
    const tokenRole = (role === 'publisher') ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    try {
        const token = RtcTokenBuilder.buildTokenWithUid(
            AGORA_APP_ID,
            AGORA_APP_CERTIFICATE,
            channelName,
            numericUid,
            tokenRole,
            privilegeExpiredTs
        );

        res.status(200).json({ token: token });
    } catch (error) {
        console.error('Erro ao gerar token Agora:', error);
        res.status(500).json({ error: 'Erro ao gerar token Agora.io', details: error.message });
    }
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
app.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    // Logs de inicialização das credenciais hard-coded para verificação
    console.log(`Região AWS configurada (hard-coded): ${AWS.config.region}`);
    console.log(`Bucket S3 configurado (hard-coded): ${S3_BUCKET_NAME}`);
    console.log(`Access Key ID AWS configurada (hard-coded): ${AWS.config.accessKeyId ? 'Sim' : 'Não'}`);
    console.log(`Secret Access Key AWS configurada (hard-coded): ${AWS.config.secretAccessKey ? 'Sim' : 'Não'}`);
    console.log(`Tabelas DynamoDB: Children=${DYNAMODB_TABLE_CHILDREN}, Messages=${DYNAMODB_TABLE_MESSAGES}, Conversations=${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Agora App ID configurado (hard-coded): ${AGORA_APP_ID ? 'Sim' : 'Não'}`);
    console.log(`Agora App Certificate configurado (hard-coded): ${AGORA_APP_CERTIFICATE ? 'Sim' : 'Não'}`);
});