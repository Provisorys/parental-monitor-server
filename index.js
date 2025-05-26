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
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

const wsClientsMap = new Map(); // Mapa para armazenar clientes WebSocket

// --- Rotas HTTP ---
app.use(bodyParser.json());
app.use(cors()); // Configure CORS adequadamente para sua aplicação
app.use(upload.array()); // Para lidar com form-data se necessário

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

const twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID });

// Rota para receber arquivos de áudio
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /upload-audio');
    const { childId, conversationId } = req.body;
    const audioFile = req.file;

    if (!audioFile || !childId || !conversationId) {
        console.warn('[HTTP_ERROR] Dados de upload incompletos:', { hasFile: !!audioFile, childId: childId, conversationId: conversationId });
        return res.status(400).send('Dados incompletos. Requer arquivo de áudio, childId e conversationId.');
    }

    const timestamp = new Date().toISOString();
    const fileName = `audio/${childId}/${conversationId}/${timestamp}.ogg`; // Formato Ogg para áudio

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: fileName,
        Body: audioFile.buffer,
        ContentType: audioFile.mimetype // 'audio/ogg'
    };

    try {
        const s3UploadResult = await s3.upload(params).promise();
        console.log(`[S3] Áudio de ${childId} salvo no S3: ${s3UploadResult.Location}`);

        const messageData = {
            messageId: uuidv4(),
            conversationId: conversationId,
            senderId: childId, // O filho é o remetente
            timestamp: timestamp,
            type: 'audio',
            content: s3UploadResult.Location // URL do arquivo de áudio no S3
        };

        await docClient.put({
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageData
        }).promise();
        console.log(`[DYNAMODB] Mensagem de áudio salva no DynamoDB para conversa ${conversationId}.`);

        // Notificar o cliente WebSocket (pai) sobre a nova mensagem de áudio
        const messageToParents = JSON.stringify({
            type: 'new_audio_message',
            message: messageData
        });

        wsClientsMap.forEach((ws, clientId) => {
            // Verifica se é um cliente pai e se está interessado nesta conversa ou no filho
            if (clientId.startsWith('parent_')) { // Exemplo: Pai com ID 'parent_PAI123'
                try {
                    ws.send(messageToParents);
                    console.log(`[WS] Notificação de nova mensagem de áudio enviada para cliente WS pai (ID: ${clientId}).`);
                } catch (wsError) {
                    console.error('[WS_ERROR] Erro ao enviar notificação WS para pai:', wsError);
                }
            }
        });

        res.status(200).json({ message: 'Áudio enviado e salvo com sucesso.', url: s3UploadResult.Location });
    } catch (error) {
        console.error('[S3_ERROR] Erro ao fazer upload de áudio para o S3 ou salvar no DynamoDB:', error);
        res.status(500).send('Erro ao processar o upload do áudio.');
    }
});

// Rota para receber mensagens de texto (APP FILHO -> SERVIDOR)
app.post('/message', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /message');
    const { childId, conversationId, text, type } = req.body;

    if (!childId || !conversationId || !text) {
        console.warn('[HTTP_ERROR] Dados de mensagem incompletos:', req.body);
        return res.status(400).send('Dados incompletos. Requer childId, conversationId e text.');
    }

    const timestamp = new Date().toISOString();

    const messageData = {
        messageId: uuidv4(),
        conversationId: conversationId,
        senderId: childId,
        timestamp: timestamp,
        type: type || 'text',
        content: text
    };

    try {
        await docClient.put({
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageData
        }).promise();
        console.log(`[DYNAMODB] Mensagem de texto salva no DynamoDB para conversa ${conversationId}.`);

        // Notificar clientes WebSocket (pais) sobre a nova mensagem de texto
        const messageToParents = JSON.stringify({
            type: 'new_message',
            message: messageData
        });

        wsClientsMap.forEach((ws, clientId) => {
            if (ws.readyState === WebSocket.OPEN) {
                // Supondo que você pode ter um ID para identificar pais no seu wsClientsMap
                if (clientId.startsWith('parent_')) { // Exemplo: Pai com ID 'parent_PAI123'
                    try {
                        ws.send(messageToParents);
                        console.log(`[WS] Notificação de nova mensagem de texto enviada para cliente WS pai (ID: ${clientId}).`);
                    } catch (wsError) {
                        console.error('[WS_ERROR] Erro ao enviar notificação WS para pai:', wsError);
                    }
                }
            }
        });

        res.status(200).send('Mensagem recebida e salva com sucesso.');
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao salvar mensagem no DynamoDB:', error);
        res.status(500).send('Erro ao processar a mensagem.');
    }
});

// Rota para criar/obter uma conversa (APP PAI -> SERVIDOR)
app.post('/conversation', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /conversation');
    const { parentId, childId } = req.body;

    if (!parentId || !childId) {
        console.warn('[HTTP_ERROR] IDs de conversa incompletos:', req.body);
        return res.status(400).send('IDs de pai e filho são obrigatórios.');
    }

    const conversationId = `${parentId}_${childId}`; // Ou uma lógica mais robusta para IDs de conversa

    try {
        // Tenta obter a conversa existente
        const existingConversation = await docClient.get({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: { conversationId: conversationId }
        }).promise();

        if (existingConversation.Item) {
            console.log(`[DYNAMODB] Conversa existente encontrada: ${conversationId}`);
            return res.status(200).json(existingConversation.Item);
        } else {
            // Se não existir, cria uma nova
            const newConversation = {
                conversationId: conversationId,
                parentId: parentId,
                childId: childId,
                createdAt: new Date().toISOString()
            };
            await docClient.put({
                TableName: DYNAMODB_TABLE_CONVERSATIONS,
                Item: newConversation
            }).promise();
            console.log(`[DYNAMODB] Nova conversa criada: ${conversationId}`);
            return res.status(201).json(newConversation);
        }
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao criar/obter conversa:', error);
        res.status(500).send('Erro ao processar a conversa.');
    }
});

// Rota para obter histórico de mensagens (APP PAI -> SERVIDOR)
app.get('/messages/:conversationId', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /messages/:conversationId');
    const { conversationId } = req.params;

    if (!conversationId) {
        console.warn('[HTTP_ERROR] conversationId não fornecido na requisição GET /messages.');
        return res.status(400).send('conversationId é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        KeyConditionExpression: 'conversationId = :cid',
        ExpressionAttributeValues: {
            ':cid': conversationId
        },
        ScanIndexForward: true // Ordenar por timestamp crescente
    };

    try {
        const data = await docClient.query(params).promise();
        console.log(`[DYNAMODB] Histórico de mensagens para ${conversationId} recuperado. Total: ${data.Items.length}`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao obter histórico de mensagens:', error);
        res.status(500).send('Erro ao obter histórico de mensagens.');
    }
});

// Rota para receber mensagens de comando (APP PAI -> SERVIDOR -> APP FILHO)
app.post('/send-command', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /send-command');
    const { childId, commandType, data } = req.body;

    if (!childId || !commandType) {
        console.warn('[HTTP_ERROR] Dados de comando incompletos:', req.body);
        return res.status(400).json({ message: 'childId e commandType são obrigatórios.' });
    }

    const childWs = findChildWebSocket(childId);

    if (childWs) {
        try {
            const command = JSON.stringify({ type: commandType, data: data });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando '${commandType}' enviado via WebSocket para o filho: ${childId}`);
            res.status(200).json({ message: `Comando ${commandType} enviado para ${childId}.` });
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando via WebSocket para ${childId}:`, error);
            res.status(500).json({ message: 'Erro ao enviar comando para o filho.', error: error.message });
        }
    } else {
        console.warn(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando ${commandType} NÃO PODE ser enviado.`);
        res.status(404).json({ message: `Filho ${childId} não está conectado via WebSocket.` });
    }
});

// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/audio-stream' });
const wssCommands = new WebSocket.Server({ server, path: '/ws-commands' });

const parentListeningSockets = new Map(); // Mapa: childId -> WebSocket do pai que está ouvindo
const activeChildWebSockets = new Map(); // Mapa: childId -> WebSocket do filho ativo

// --- FUNÇÃO AUXILIAR PARA WEBSOCKETS ---
function findChildWebSocket(childId) {
    const targetClient = activeChildWebSockets.get(childId);
    console.log(`[WS_FIND] Buscando WebSocket para childId: ${childId}. Estado atual do mapa activeChildWebSockets: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`); // Log de debug
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
        console.log(`[WS_FIND] WebSocket ENCONTRADO e ABERTO para childId: ${childId}`); // Log de debug
        return targetClient;
    }
    console.log(`[WS_FIND] WebSocket NÃO ENCONTRADO ou FECHADO para childId: ${childId}. readyState: ${targetClient ? targetClient.readyState : 'N/A'}`); // Log de debug
    return null;
}

// --- NOVAS ROTAS PARA LIGAR/DESLIGAR MICROFONE (via HTTP do app pai) ---
app.post('/start-microphone', async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /start-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /start-microphone para o filho: ${childId}`);

    const childWs = findChildWebSocket(childId); // Esta função já tem logs de debug

    if (childWs) {
        try {
            const command = JSON.stringify({ type: 'START_AUDIO' });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando '${command}' enviado via WebSocket para o filho: ${childId}`);
            res.status(200).json({ message: `Comando START_AUDIO enviado para ${childId}.` });
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando START_AUDIO via WebSocket para ${childId}:`, error);
            res.status(500).json({ message: 'Erro ao enviar comando para o filho.', error: error.message });
        }
    } else {
        console.warn(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando START_AUDIO NÃO PODE ser enviado.`);
        res.status(404).json({ message: `Filho ${childId} não está conectado via WebSocket.` });
    }
});

app.post('/stop-microphone', async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /stop-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /stop-microphone para o filho: ${childId}`);

    const childWs = findChildWebSocket(childId); // Esta função já tem logs de debug

    if (childWs) {
        try {
            const command = JSON.stringify({ type: 'STOP_AUDIO' });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando '${command}' enviado via WebSocket para o filho: ${childId}`);
            res.status(200).json({ message: `Comando STOP_AUDIO enviado para ${childId}.` });
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando STOP_AUDIO via WebSocket para ${childId}:`, error);
            res.status(500).json({ message: 'Erro ao enviar comando para o filho.', error: error.message });
        }
    } else {
        console.warn(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${childId}. O comando STOP_AUDIO NÃO PODE ser enviado.`);
        res.status(404).json({ message: `Filho ${childId} não está conectado via WebSocket.` });
    }
});


wss.on('connection', ws => {
    ws.id = uuidv4();
    console.log(`[WS_CONNECT] Novo cliente WebSocket conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wss.clients.size}`); // Log

    ws.isParent = false;
    ws.clientId = null;
    ws.parentId = null;

    ws.on('message', message => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);

        let processedAsText = false; // Flag para controlar se a mensagem foi processada como texto

        // Tenta processar como string primeiro
        if (typeof message === 'string') {
            const messageString = message.toString();
            const displayMessage = messageString.length > 100 ? messageString.substring(0, 100) + '...' : messageString;
            console.log(`[WS_MSG] [${messageOrigin}] Mensagem WebSocket de TEXTO recebida: "${displayMessage}"`);

            if (messageString.startsWith('CHILD_ID:')) {
                ws.clientId = messageString.substring('CHILD_ID:'.length);
                ws.isParent = false;
                activeChildWebSockets.set(ws.clientId, ws);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou. Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                    ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                } else {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado, mas nenhum pai está ouvindo ativamente neste momento.`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('PARENT_ID:')) {
                ws.isParent = true;
                ws.parentId = messageString.substring('PARENT_ID:'.length);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Pai conectado com ID: ${ws.parentId || 'desconhecido'}`);
                processedAsText = true;
            } else if (messageString.startsWith('LISTEN_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('LISTEN_TO_CHILD:'.length);
                    parentListeningSockets.set(targetChildId, ws);
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                    const childWs = findChildWebSocket(targetChildId);
                    if (childWs) {
                        childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal START_AUDIO enviado para o filho ${targetChildId} via WebSocket (pedido de escuta do pai).`);
                    } else {
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não encontrado no mapa activeChildWebSockets, mas pai (ID: ${ws.parentId || 'desconhecido'}) está esperando.`);
                    }
                    ws.send(JSON.stringify({ type: 'STATUS', message: `Você está ouvindo ${targetChildId}` }));
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de escuta apenas para pais.' }));
                    console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando LISTEN_TO_CHILD de um cliente não-pai. Mensagem: ${messageString}`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('STOP_LISTENING_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('STOP_LISTENING_TO_CHILD:'.length);
                    if (parentListeningSockets.has(targetChildId) && parentListeningSockets.get(targetChildId) === ws) {
                        parentListeningSockets.delete(targetChildId);
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                        let anotherParentListening = false;
                        for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                            if (childIdInMap === targetChildId && parentWsInMap.readyState === WebSocket.OPEN) {
                                anotherParentListening = true;
                                break;
                            }
                        }

                        if (!anotherParentListening) {
                            const childWs = findChildWebSocket(targetChildId);
                            if (childWs) {
                                childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                                console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal STOP_AUDIO enviado para o filho ${targetChildId} (nenhum pai mais ouvindo).`);
                            }
                        }
                        ws.send(JSON.stringify({ type: 'STATUS', message: `Você parou de ouvir ${targetChildId}` }));
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Você não estava ouvindo este filho.' }));
                        console.warn(`[WS_MSG] [Conexão ${ws.id}] Pai tentou parar de ouvir ${targetChildId} mas não estava registrado como ouvinte.`);
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de parada de escuta apenas para pais.' }));
                    console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando STOP_LISTENING_TO_CHILD de um cliente não-pai. Mensagem: ${messageString}`);
                }
                processedAsText = true;
            } else if (ws.isParent && messageString.startsWith('COMMAND:')) {
                const command = messageString.substring('COMMAND:'.length);
                console.log(`[WS_MSG] [${messageOrigin}] Comando de pai recebido: ${command}`);
                processedAsText = true;
            } else {
                console.warn(`[WS_MSG] [${messageOrigin}] Mensagem de texto desconhecida ou inesperada: ${displayMessage}`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de texto desconhecido ou não permitido.' }));
                processedAsText = true;
            }
        }

        // Se não foi processada como string, tente decodificar como UTF-8 se for binário
        if (!processedAsText && (message instanceof Buffer || message instanceof ArrayBuffer)) {
            try {
                // Tenta decodificar como UTF-8 para verificar se é um comando em formato de texto.
                // Isso é útil se o cliente enviar "CHILD_ID:xyz" como um Buffer.
                const decodedMessage = Buffer.from(message).toString('utf8');
                if (decodedMessage.startsWith('CHILD_ID:') ||
                    decodedMessage.startsWith('PARENT_ID:') ||
                    decodedMessage.startsWith('LISTEN_TO_CHILD:') ||
                    decodedMessage.startsWith('STOP_LISTENING_TO_CHILD:') ||
                    decodedMessage.startsWith('COMMAND:')) {
                    
                    console.log(`[WS_MSG] [${messageOrigin}] Mensagem binária decodificada como texto: "${decodedMessage.substring(0, 100)}..."`);
                    // Se for um comando de texto, processe como se fosse uma string.
                    // Isso evita duplicar a lógica de tratamento de comandos.
                    // Recurse a função ou chame a lógica específica aqui, ou refatore.
                    // Para simplificar e evitar recursão, vamos refatorar para chamar a lógica existente.
                    // Como estamos dentro do `ws.on('message')`, podemos chamar a lógica diretamente.

                    if (decodedMessage.startsWith('CHILD_ID:')) {
                        ws.clientId = decodedMessage.substring('CHILD_ID:'.length);
                        ws.isParent = false;
                        activeChildWebSockets.set(ws.clientId, ws);
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado (via binário decodificado como texto) e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                        const parentWs = parentListeningSockets.get(ws.clientId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou (via binário decodificado como texto). Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                            ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                        } else {
                            console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado (via binário decodificado como texto), mas nenhum pai está ouvindo ativamente neste momento.`);
                        }
                    } else if (decodedMessage.startsWith('PARENT_ID:')) {
                        ws.isParent = true;
                        ws.parentId = decodedMessage.substring('PARENT_ID:'.length);
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Pai conectado (via binário decodificado como texto) com ID: ${ws.parentId || 'desconhecido'}`);
                    } else if (decodedMessage.startsWith('LISTEN_TO_CHILD:')) {
                        if (ws.isParent) {
                            const targetChildId = decodedMessage.substring('LISTEN_TO_CHILD:'.length);
                            parentListeningSockets.set(targetChildId, ws);
                            console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId} (via binário decodificado como texto). Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                            const childWs = findChildWebSocket(targetChildId);
                            if (childWs) {
                                childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                                console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal START_AUDIO enviado para o filho ${targetChildId} via WebSocket (pedido de escuta do pai via binário decodificado como texto).`);
                            } else {
                                console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não encontrado no mapa activeChildWebSockets, mas pai (ID: ${ws.parentId || 'desconhecido'}) está esperando (via binário decodificado como texto).`);
                            }
                            ws.send(JSON.stringify({ type: 'STATUS', message: `Você está ouvindo ${targetChildId}` }));
                        } else {
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de escuta apenas para pais.' }));
                            console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando LISTEN_TO_CHILD de um cliente não-pai (via binário decodificado como texto). Mensagem: ${decodedMessage}`);
                        }
                    } else if (decodedMessage.startsWith('STOP_LISTENING_TO_CHILD:')) {
                        if (ws.isParent) {
                            const targetChildId = decodedMessage.substring('STOP_LISTENING_TO_CHILD:'.length);
                            if (parentListeningSockets.has(targetChildId) && parentListeningSockets.get(targetChildId) === ws) {
                                parentListeningSockets.delete(targetChildId);
                                console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId} (via binário decodificado como texto). Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                                let anotherParentListening = false;
                                for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                                    if (childIdInMap === targetChildId && parentWsInMap.readyState === WebSocket.OPEN) {
                                        anotherParentListening = true;
                                        break;
                                    }
                                }

                                if (!anotherParentListening) {
                                    const childWs = findChildWebSocket(targetChildId);
                                    if (childWs) {
                                        childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                                        console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal STOP_AUDIO enviado para o filho ${targetChildId} (nenhum pai mais ouvindo via binário decodificado como texto).`);
                                    }
                                }
                                ws.send(JSON.stringify({ type: 'STATUS', message: `Você parou de ouvir ${targetChildId}` }));
                            } else {
                                ws.send(JSON.stringify({ type: 'ERROR', message: 'Você não estava ouvindo este filho.' }));
                                console.warn(`[WS_MSG] [Conexão ${ws.id}] Pai tentou parar de ouvir ${targetChildId} mas não estava registrado como ouvinte (via binário decodificado como texto).`);
                            }
                        } else {
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de parada de escuta apenas para pais.' }));
                            console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando STOP_LISTENING_TO_CHILD de um cliente não-pai (via binário decodificado como texto). Mensagem: ${decodedMessage}`);
                        }
                    } else if (ws.isParent && decodedMessage.startsWith('COMMAND:')) {
                        const command = decodedMessage.substring('COMMAND:'.length);
                        console.log(`[WS_MSG] [${messageOrigin}] Comando de pai recebido (via binário decodificado como texto): ${command}`);
                    }
                } else if (ws.clientId && !ws.isParent) {
                    // Se já tiver um clientId e não for um pai, assume que é áudio
                    const parentWs = parentListeningSockets.get(ws.clientId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(message); // Retransmite o Buffer original
                        // console.log(`[WS_MSG] [${messageOrigin}] Bytes de áudio retransmitidos para o pai de ${ws.clientId}: ${message.length} bytes.`);
                    } else {
                        // console.log(`[WS_MSG] [${messageOrigin}] Pai não está ouvindo o filho ${ws.clientId}, descartando ${message.length} bytes de áudio.`);
                    }
                } else {
                    console.warn(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida que não é CHILD_ID e não é esperada para áudio neste contexto. Tamanho: ${message.length} bytes.`);
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem binária desconhecida ou não permitida.' }));
                }
            } catch (e) {
                console.error(`${messageOrigin} Erro ao decodificar mensagem binária como UTF-8: ${e.message}`, e);
                console.warn(`${messageOrigin} Mensagem binária recebida inesperada (não pôde ser decodificada como UTF-8): ${message.length} bytes.`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Erro ao processar mensagem binária.' }));
            }
        } else if (!processedAsText) { // Se não foi string e não foi Buffer/ArrayBuffer
            console.warn(`[WS_MSG] [${messageOrigin}] Mensagem recebida não é string nem binária esperada. Tipo: ${typeof message}, Tamanho: ${message ? message.length : 'N/A'}`);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Tipo de mensagem não suportado.' }));
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WS_CLOSE] [${messageOrigin}] Cliente WebSocket desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}. Total de conexões ativas: ${wss.clients.size - 1}`); // Log

        if (ws.clientId) {
            console.log(`[WS_CLOSE] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WS_CLOSE] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`); // Log crucial

            let hadActiveParent = false;
            // Verifica se algum pai estava ouvindo este filho e o notifica
            for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                // Cuidado: Um filho pode ter mais de um pai ouvindo.
                // A lógica atual de parentListeningSockets armazena apenas um pai por childId.
                // Se múltiplos pais puderem ouvir, o mapa deveria ser childId -> Set<WebSocket_Pai>.
                // Para a estrutura atual (um pai por childId), basta verificar se o pai que estava ouvindo é este.
                if (childIdInMap === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                    parentWsInMap.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId }));
                    console.log(`[WS_CLOSE] [${parentWsInMap.id}] Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${ws.clientId}.`);
                    parentListeningSockets.delete(childIdInMap); // Remove a entrada, pois o filho se desconectou
                    hadActiveParent = true;
                }
            }
            if (hadActiveParent) {
                console.log(`[WS_CLOSE] [${messageOrigin}] Removida a escuta de pais para o filho desconectado ${ws.clientId}.`);
            }
        } else if (ws.isParent && ws.parentId) {
            console.log(`[WS_CLOSE] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado.`);
            // Itera sobre parentListeningSockets para remover as entradas onde este pai era o ouvinte
            const childIdsStoppedListening = [];
            for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                if (parentWsListening === ws) {
                    childIdsStoppedListening.push(childIdBeingListened);
                }
            }

            for (const childId of childIdsStoppedListening) {
                parentListeningSockets.delete(childId);
                console.log(`[WS_CLOSE] [${messageOrigin}] Pai ${ws.parentId} parou de ouvir o filho: ${childId}.`);

                // Verifica se há outros pais ainda ouvindo este filho
                let anotherParentStillListening = false;
                for (const [cId, pWs] of parentListeningSockets.entries()) {
                    if (cId === childId && pWs.readyState === WebSocket.OPEN) {
                        anotherParentStillListening = true;
                        break;
                    }
                }

                if (!anotherParentStillListening) {
                    const childWs = findChildWebSocket(childId);
                    if (childWs) {
                        childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                        console.log(`[WS_CLOSE] [Conexão ${childWs.id}] Sinal STOP_AUDIO enviado para o filho ${childId} (nenhum pai mais ouvindo após desconexão).`);
                    }
                }
            }
        } else {
            console.log(`[WS_CLOSE] [Conexão ${ws.id}] Cliente WebSocket desconectado sem ID de filho ou pai.`);
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.error(`[WS_ERROR] [${messageOrigin}] Erro no WebSocket:`, error);
        if (ws.clientId) {
            console.log(`[WS_ERROR] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets devido a um erro.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WS_ERROR] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`); // Log crucial

            // Notifica pais que estavam ouvindo, se houver
            let hadActiveParent = false;
            for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                if (childIdInMap === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                    parentWsInMap.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId, reason: 'error' }));
                    console.log(`[WS_ERROR] [${parentWsInMap.id}] Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${ws.clientId} devido a um erro.`);
                    parentListeningSockets.delete(childIdInMap);
                    hadActiveParent = true;
                }
            }
            if (hadActiveParent) {
                console.log(`[WS_ERROR] [${messageOrigin}] Removida a escuta de pais para o filho ${ws.clientId} devido a um erro.`);
            }
        } else if (ws.isParent && ws.parentId) {
            console.log(`[WS_ERROR] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado devido a um erro.`);
            const childIdsStoppedListening = [];
            for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                if (parentWsListening === ws) {
                    childIdsStoppedListening.push(childIdBeingListened);
                }
            }

            for (const childId of childIdsStoppedListening) {
                parentListeningSockets.delete(childId);
                console.log(`[WS_ERROR] [${messageOrigin}] Pai ${ws.parentId} removido do mapa de ouvintes para ${childId} devido a um erro.`);

                let anotherParentStillListening = false;
                for (const [cId, pWs] of parentListeningSockets.entries()) {
                    if (cId === childId && pWs.readyState === WebSocket.OPEN) {
                        anotherParentStillListening = true;
                        break;
                    }
                }
                if (!anotherParentStillListening) {
                    const childWs = findChildWebSocket(childId);
                    if (childWs) {
                        childWs.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                        console.log(`[WS_ERROR] [Conexão ${childWs.id}] Sinal STOP_AUDIO enviado para o filho ${childId} (nenhum pai mais ouvindo após erro).`);
                    }
                }
            }
        }
    });
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
        // Mantenha ou ajuste isso com base na sua tabela GPSintegracao.
        // Se 'indi1' for a Partition Key, use: indi1: childId,
        indi1: childId,
		childId: childId,
        timestamp: timestamp,
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

        const messageToParents = JSON.stringify({
            type: 'location_update',
            childId: childId,
            latitude: latitude,
            longitude: longitude,
            timestamp: timestamp
        });

        wsClientsMap.forEach((ws, clientId) => {
            if (ws.readyState === WebSocket.OPEN) {
                if (clientId.startsWith('parent_')) {
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
    console.log(`Twilio Account SID configurado via env: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurada via env: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurada via env: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
});