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

const upload = multer(); // Instancia o multer uma vez

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

// --- Variável para controle de WebSockets ---
// Usaremos wsClientsMap para todos os clientes conectados, identificando-os como filhos ou pais.
// Chave: (childId ou parentId) -> Valor: WebSocket do cliente
const wsClientsMap = new Map(); 


// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

// Use a API Key SID e Secret para autenticação
const twilioClient = new twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID });

// --- Rotas HTTP ---
app.use(bodyParser.json()); // Para JSON bodies
app.use(bodyParser.urlencoded({ extended: true })); // Para URL-encoded bodies (se necessário)
app.use(cors()); // Configure CORS adequadamente para sua aplicação

// Rota para receber arquivos de áudio
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /upload-audio');
    const { childId, conversationId } = req.body;
    const audioFile = req.file;

    if (!childId || !conversationId || !audioFile) {
        console.warn('[HTTP_ERROR] Dados incompletos para upload de áudio.');
        return res.status(400).send('childId, conversationId e arquivo de áudio são obrigatórios.');
    }

    const timestamp = new Date().toISOString();
    const audioKey = `audios/${childId}/${conversationId}/${timestamp}_${audioFile.originalname}`;

    const uploadParams = {
        Bucket: S3_BUCKET_NAME,
        Key: audioKey,
        Body: audioFile.buffer,
        ContentType: audioFile.mimetype,
    };

    try {
        await s3.upload(uploadParams).promise();
        console.log(`[S3] Áudio ${audioKey} enviado para S3 com sucesso.`);

        const messageData = {
            messageId: uuidv4(),
            conversationId: conversationId,
            senderId: childId,
            timestamp: timestamp,
            type: 'audio',
            content: audioKey, // Caminho para o áudio no S3
            read: false
        };

        const dynamoParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageData
        };

        await docClient.put(dynamoParams).promise();
        console.log('[DYNAMODB] Mensagem de áudio salva no DynamoDB com sucesso.');

        // Notificar os clientes WebSocket (pais) sobre a nova mensagem de áudio
        const messageToParents = JSON.stringify({
            type: 'new_audio_message',
            message: messageData
        });

        // Itera sobre todos os clientes no wsClientsMap que são pais para enviar a notificação
        wsClientsMap.forEach(clientWs => {
            if (clientWs.readyState === WebSocket.OPEN && clientWs.isParent) {
                // Você pode adicionar uma lógica aqui para filtrar qual pai deve receber a mensagem de qual filho
                clientWs.send(messageToParents);
                console.log(`[WSS_COMMANDS] Notificação de nova mensagem de áudio enviada para pai ${clientWs.parentId} via /ws-commands.`);
            }
        });

        res.status(200).json({ message: 'Áudio e mensagem salvos com sucesso!', audioUrl: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${audioKey}` });
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao fazer upload de áudio ou salvar mensagem:', error);
        res.status(500).send('Erro ao processar áudio.');
    }
});

// Rota para receber mensagens de texto
app.post('/message', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /message');
    const { childId, conversationId, message } = req.body;

    if (!childId || !conversationId || !message) {
        console.warn('[HTTP_ERROR] Dados incompletos para mensagem de texto.');
        return res.status(400).send('childId, conversationId e message são obrigatórios.');
    }

    const timestamp = new Date().toISOString();

    const messageData = {
        messageId: uuidv4(),
        conversationId: conversationId,
        senderId: childId,
        timestamp: timestamp,
        type: 'text',
        content: message,
        read: false
    };

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: messageData
    };

    try {
        await docClient.put(params).promise();
        console.log('[DYNAMODB] Mensagem de texto salva no DynamoDB com sucesso.');

        // Notificar clientes WebSocket (pais) sobre a nova mensagem de texto
        const messageToParents = JSON.stringify({
            type: 'new_message',
            message: messageData
        });

        wsClientsMap.forEach(clientWs => {
            if (clientWs.readyState === WebSocket.OPEN && clientWs.isParent) {
                // Você pode adicionar uma lógica aqui para filtrar qual pai deve receber a mensagem de qual filho
                clientWs.send(messageToParents);
                console.log(`[WSS_COMMANDS] Notificação de nova mensagem de texto enviada para pai ${clientWs.parentId} via /ws-commands.`);
            }
        });

        res.status(200).send('Mensagem salva com sucesso!');
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao salvar mensagem:', error);
        res.status(500).send('Erro ao salvar mensagem.');
    }
});

// Rota para buscar mensagens de uma conversa específica
app.get('/messages/:conversationId', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /messages');
    const { conversationId } = req.params;

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
        console.log(`[DYNAMODB] ${data.Items.length} mensagens encontradas para conversationId: ${conversationId}`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao buscar mensagens:', error);
        res.status(500).send('Erro ao buscar mensagens.');
    }
});

// Rota para iniciar uma nova conversa
app.post('/start-conversation', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /start-conversation');
    const { parentId, childId, initialMessage } = req.body;

    if (!parentId || !childId) {
        console.warn('[HTTP_ERROR] parentId e childId são obrigatórios para iniciar conversa.');
        return res.status(400).send('Parent ID e Child ID são obrigatórios.');
    }

    const conversationId = uuidv4();
    const timestamp = new Date().toISOString();

    const conversationParams = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        Item: {
            conversationId: conversationId,
            parentId: parentId,
            childId: childId,
            createdAt: timestamp,
            lastMessageAt: timestamp
        }
    };

    const initialMessageData = {
        messageId: uuidv4(),
        conversationId: conversationId,
        senderId: parentId, // Pai envia a mensagem inicial
        timestamp: timestamp,
        type: 'text',
        content: initialMessage || 'Conversa iniciada.',
        read: false
    };

    const messageParams = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: initialMessageData
    };

    try {
        await docClient.put(conversationParams).promise();
        await docClient.put(messageParams).promise();
        console.log(`[DYNAMODB] Conversa ${conversationId} iniciada e mensagem inicial salva.`);
        res.status(200).json({ conversationId: conversationId, message: 'Conversa iniciada com sucesso!' });
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao iniciar conversa:', error);
        res.status(500).send('Erro ao iniciar conversa.');
    }
});

// Rota para listar conversas de um pai (Mantida, pois pode ser útil para outras partes do app pai que precisem do histórico)
app.get('/conversations/:parentId', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /conversations');
    const { parentId } = req.params;

    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        IndexName: 'ParentIdIndex', // Certifique-se de ter este GSI no DynamoDB
        KeyConditionExpression: 'parentId = :pid',
        ExpressionAttributeValues: {
            ':pid': parentId
        }
    };

    try {
        const data = await docClient.query(params).promise();
        console.log(`[DYNAMODB] ${data.Items.length} conversas encontradas para parentId: ${parentId}`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao buscar conversas:', error);
        res.status(500).send('Erro ao buscar conversas.');
    }
});

// Rota para o filho buscar suas conversas
app.get('/child-conversations/:childId', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /child-conversations');
    const { childId } = req.params;

    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        IndexName: 'ChildIdIndex', // Você precisará criar este GSI (Global Secondary Index) no seu DynamoDB
        KeyConditionExpression: 'childId = :cid',
        ExpressionAttributeValues: {
            ':cid': childId
        }
    };

    try {
        const data = await docClient.query(params).promise();
        console.log(`[DYNAMODB] ${data.Items.length} conversas encontradas para childId: ${childId}`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao buscar conversas do filho:', error);
        res.status(500).send('Erro ao buscar conversas do filho.');
    }
});

// Rota para o pai enviar comandos (App Pai -> Servidor -> App Filho)
app.post('/send-command', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /send-command');
    const { childId, commandType, data, parentId } = req.body; // Adicionado parentId para rastreamento

    if (!childId || !commandType) {
        console.warn('[HTTP_ERROR] Dados de comando incompletos:', req.body);
        return res.status(400).json({ message: 'childId e commandType são obrigatórios.' });
    }

    const childWs = wsClientsMap.get(childId); // Usa o mapa comum para clientes ativos

    if (childWs && childWs.readyState === WebSocket.OPEN) {
        try {
            const command = JSON.stringify({
                type: commandType,
                data: data,
                commandId: uuidv4(), // ID único para o comando
                senderParentId: parentId // ID do pai que enviou o comando
            });
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

// Rota para iniciar microfone (App Pai -> Servidor -> App Filho)
app.post('/start-microphone', async (req, res) => {
    const { childId, parentId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /start-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /start-microphone para o filho: ${childId}`);

    const childWs = wsClientsMap.get(childId); // Usa o mapa comum para clientes ativos

    if (childWs && childWs.readyState === WebSocket.OPEN) {
        try {
            const command = JSON.stringify({
                type: 'START_AUDIO',
                commandId: uuidv4(),
                senderParentId: parentId // ID do pai que enviou o comando
            });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando 'START_AUDIO' enviado via WebSocket para o filho: ${childId}`);
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

// Rota para parar microfone (App Pai -> Servidor -> App Filho)
app.post('/stop-microphone', async (req, res) => {
    const { childId, parentId } = req.body;

    if (!childId) {
        console.warn('[HTTP_CMD] Erro: childId não fornecido na requisição /stop-microphone.');
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    console.log(`[HTTP_CMD] Recebida requisição POST /stop-microphone para o filho: ${childId}`);

    const childWs = wsClientsMap.get(childId); // Usa o mapa comum para clientes ativos

    if (childWs && childWs.readyState === WebSocket.OPEN) {
        try {
            const command = JSON.stringify({
                type: 'STOP_AUDIO',
                commandId: uuidv4(),
                senderParentId: parentId // ID do pai que enviou o comando
            });
            childWs.send(command);
            console.log(`[HTTP_CMD] Comando 'STOP_AUDIO' enviado via WebSocket para o filho: ${childId}`);
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

// Rota para receber localização do filho
app.post('/location', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /location');
    const { childId, latitude, longitude } = req.body;

    if (!childId || !latitude || !longitude) {
        console.warn('[HTTP_ERROR] Dados de localização incompletos.');
        return res.status(400).send('childId, latitude e longitude são obrigatórios.');
    }

    const timestamp = new Date().toISOString();

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            childId: childId,
            timestamp: timestamp,
            latitude: latitude,
            longitude: longitude,
        },
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

        // Notificar pais conectados via rota /ws-commands
        wsClientsMap.forEach(clientWs => {
            if (clientWs.readyState === WebSocket.OPEN && clientWs.isParent) {
                // Você pode adicionar uma lógica aqui para filtrar qual pai deve receber a localização de qual filho
                // Ou enviar para todos os pais conectados na rota de comandos
                clientWs.send(messageToParents);
                console.log(`[WSS_COMMANDS] Localização de ${childId} enviada para pai ${clientWs.parentId}.`);
            }
        });

        res.status(200).send('Localização salva com sucesso!');
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao salvar localização:', error);
        res.status(500).send('Erro ao processar localização.');
    }
});

// Rota para obter IDs de todos os filhos REGISTRADOS (do DynamoDB)
// Sem filtro de parentId e sem status online
app.get('/get-child-ids', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /get-child-ids (sem parentId)');
    let uniqueChildIds = new Set(); // Usar Set para garantir IDs únicos

    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        ProjectionExpression: 'childId' // Obter apenas o childId para otimizar
    };

    try {
        let items;
        do {
            items = await docClient.scan(params).promise();
            items.Items.forEach(item => uniqueChildIds.add(item.childId));
            params.ExclusiveStartKey = items.LastEvaluatedKey;
        } while (typeof items.LastEvaluatedKey !== "undefined"); // Continua se houver mais itens

        const childIdsArray = Array.from(uniqueChildIds);
        console.log(`[GET_CHILD_IDS] ${childIdsArray.length} childIDs únicos encontrados no DynamoDB (tabela Conversations): [ ${childIdsArray.join(', ')} ]`);
        
        // --- AQUI ESTÁ A MUDANÇA CRUCIAL ---
        res.status(200).json(childIdsArray); // Retorna APENAS o array de strings
        // ------------------------------------

    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao buscar child IDs no DynamoDB:', error);
        res.status(500).json({ message: 'Erro ao buscar IDs de filhos.' });
    }
});


// --- WEBSOCKET SERVER ---
const server = http.createServer(app); // Crie um servidor HTTP para o Express e o WebSocket

// Servidor WebSocket para streaming de áudio
const wssAudio = new WebSocket.Server({ server, path: '/audio-stream' });
// Servidor WebSocket para comandos
const wssCommands = new WebSocket.Server({ server, path: '/ws-commands' });

// --- Lógica de conexão para WSS_AUDIO (/audio-stream) ---
wssAudio.on('connection', ws => {
    ws.id = uuidv4(); // ID único para esta conexão WebSocket
    ws.isParent = false;
    ws.isChild = false; // Adiciona uma flag para identificar se é filho
    ws.clientId = null;
    ws.parentId = null;
    console.log(`[WSS_AUDIO_CONNECT] Novo cliente WebSocket (audio-stream) conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wssAudio.clients.size}`);

    ws.on('message', message => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        let processedAsText = false;

        if (typeof message === 'string') {
            const messageString = message.toString();
            // console.log(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem WebSocket de TEXTO recebida: "${messageString.substring(0, 100)}..."`);

            if (messageString.startsWith('CHILD_ID:')) {
                ws.clientId = messageString.substring('CHILD_ID:'.length);
                ws.isChild = true; // Marca como filho
                wsClientsMap.set(ws.clientId, ws); // Adiciona ao mapa global de clientes
                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado no wsClientsMap (audio-stream).`);
                processedAsText = true;
            } else if (messageString.startsWith('PARENT_ID:')) {
                ws.parentId = messageString.substring('PARENT_ID:'.length);
                ws.isParent = true; // Marca como pai
                wsClientsMap.set(ws.parentId, ws); // Adiciona ao mapa global de clientes
                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai conectado com ID: ${ws.parentId} (audio-stream).`);
                processedAsText = true;
            } else if (messageString.startsWith('LISTEN_TO_CHILD:') && ws.isParent) {
                const targetChildId = messageString.substring('LISTEN_TO_CHILD:'.length);
                ws.listeningToChildId = targetChildId; // Marca qual filho este pai está ouvindo
                console.log(`[WSS_AUDIO_MSG] [Pai ${ws.parentId}] solicitou escuta para filho: ${targetChildId}`);
            } else if (messageString.startsWith('STOP_LISTENING_TO_CHILD:') && ws.isParent) {
                const targetChildId = messageString.substring('STOP_LISTENING_TO_CHILD:'.length);
                if (ws.listeningToChildId === targetChildId) {
                    ws.listeningToChildId = null;
                    console.log(`[WSS_AUDIO_MSG] [Pai ${ws.parentId}] parou de ouvir filho: ${targetChildId}`);
                }
            } else {
                console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem de texto desconhecida ou inesperada na rota de áudio: "${messageString}"`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de texto desconhecido ou não permitido na rota de áudio.' }));
                processedAsText = true;
            }
        }

        if (!processedAsText && (message instanceof Buffer || message instanceof ArrayBuffer)) {
            // Lógica para retransmitir áudio binário
            if (ws.isChild && ws.clientId) {
                // Se é um filho enviando áudio, procure por pais que estejam "escutando" ele.
                wsClientsMap.forEach(clientWs => {
                    if (clientWs.isParent && clientWs.listeningToChildId === ws.clientId && clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(message); // Retransmite o Buffer original para o pai
                        // console.log(`[WSS_AUDIO_MSG] [${messageOrigin}] Bytes de áudio retransmitidos para o pai de ${ws.clientId}: ${message.length} bytes.`);
                    }
                });
            } else {
                console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem binária recebida de cliente inesperado (não é filho ou sem ID). Tamanho: ${message.length} bytes.`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem binária desconhecida ou não permitida.' }));
            }
        } else if (!processedAsText) {
            console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem recebida não é string nem binária esperada. Tipo: ${typeof message}, Tamanho: ${message ? message.length : 'N/A'}`);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Tipo de mensagem não suportado.' }));
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Cliente WebSocket (audio-stream) desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}. Total de conexões ativas: ${wssAudio.clients.size - 1}`);

        // Somente remove do wsClientsMap se for o WebSocket principal para aquele ID
        if (ws.clientId && wsClientsMap.get(ws.clientId) === ws) {
            console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Removendo Filho com ID ${ws.clientId} do mapa wsClientsMap (audio-stream).`);
            wsClientsMap.delete(ws.clientId);
            console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Mapa wsClientsMap após remoção: [${Array.from(wsClientsMap.keys()).join(', ')}]`);

            // Notifica os pais que estavam "escutando" este filho que ele desconectou
            wsClientsMap.forEach(clientWs => {
                if (clientWs.isParent && clientWs.listeningToChildId === ws.clientId && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId }));
                    clientWs.listeningToChildId = null; // Parar de "escutar"
                    console.log(`[WSS_AUDIO_CLOSE] Sinal CHILD_DISCONNECTED enviado para o pai ${clientWs.parentId} que estava ouvindo ${ws.clientId}.`);
                }
            });

        } else if (ws.parentId && wsClientsMap.get(ws.parentId) === ws) {
            console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado (audio-stream). Removendo do wsClientsMap.`);
            wsClientsMap.delete(ws.parentId);
            console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Mapa wsClientsMap após remoção: [${Array.from(wsClientsMap.keys()).join(', ')}]`);
        } else {
            console.log(`[WSS_AUDIO_CLOSE] [Conexão ${ws.id}] Cliente WebSocket (audio-stream) desconectado sem ID de filho ou pai (ou outra conexão com o mesmo ID está ativa).`);
            // Se o WS não se identificou, ou se não é o WS principal, não remove pelo ID de cliente/pai.
            // Para depuração, você pode iterar e remover pelo `ws.id` se necessário, mas geralmente não é preciso.
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.error(`[WSS_AUDIO_ERROR] [${messageOrigin}] Erro no WebSocket (audio-stream):`, error);
        ws.close(); // Tenta fechar a conexão em caso de erro
    });
});

// --- Lógica de conexão para WSS_COMMANDS (/ws-commands) ---
wssCommands.on('connection', ws => {
    ws.id = uuidv4(); // ID único para esta conexão WebSocket
    ws.isParent = false;
    ws.isChild = false; // Adiciona uma flag para identificar se é filho
    ws.clientId = null;
    ws.parentId = null;
    console.log(`[WSS_COMMANDS_CONNECT] Novo cliente WebSocket (ws-commands) conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wssCommands.clients.size}`);

    ws.on('message', message => {
        const messageString = message.toString();
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        // console.log(`[WSS_COMMANDS_MSG] [${messageOrigin}] Mensagem de TEXTO (ws-commands) recebida: "${messageString.substring(0, 100)}..."`);

        try {
            const parsedMessage = JSON.parse(messageString);

            if (parsedMessage.type === 'CHILD_ID') {
                ws.clientId = parsedMessage.id;
                ws.isChild = true; // Marca como filho
                wsClientsMap.set(ws.clientId, ws); // Adiciona ao mapa global de clientes
                console.log(`[WSS_COMMANDS_MSG] [Conexão ${ws.id}] Filho conectado (ws-commands) e ID "${ws.clientId}" registrado no wsClientsMap.`);
            } else if (parsedMessage.type === 'PARENT_ID') {
                ws.parentId = parsedMessage.id;
                ws.isParent = true; // Marca como pai
                wsClientsMap.set(ws.parentId, ws); // Adiciona ao mapa global de clientes
                console.log(`[WSS_COMMANDS_MSG] [Conexão ${ws.id}] Pai conectado (ws-commands) com ID: ${ws.parentId}.`);
            } else if (parsedMessage.type === 'COMMAND' && ws.isParent) {
                const { targetChildId, commandType, data } = parsedMessage.payload;
                console.log(`[WSS_COMMANDS_MSG] [Pai ${ws.parentId}] Recebido comando para filho ${targetChildId}: ${commandType} com dados:`, data);

                const childWs = wsClientsMap.get(targetChildId); // Busca na lista de clientes ativos
                if (childWs && childWs.isChild && childWs.readyState === WebSocket.OPEN) {
                    childWs.send(JSON.stringify({ type: commandType, data: data }));
                    console.log(`[WSS_COMMANDS_MSG] Comando '${commandType}' enviado via WebSocket (ws-commands) para o filho: ${targetChildId}`);
                    ws.send(JSON.stringify({ status: 'success', message: `Comando ${commandType} enviado para ${targetChildId}.` }));
                } else {
                    console.warn(`[WSS_COMMANDS_MSG] Nenhuma conexão WebSocket (ws-commands) ativa encontrada para o filho: ${targetChildId}.`);
                    ws.send(JSON.stringify({ status: 'error', message: `Filho ${targetChildId} não está conectado para comandos.` }));
                }
            } else if (parsedMessage.type === 'ACK_COMMAND' && ws.isChild) {
                // Mensagem de confirmação de comando do filho para o pai
                const { commandId, status, details, senderParentId } = parsedMessage.payload;
                console.log(`[WSS_COMMANDS_MSG] [Filho ${ws.clientId}] Confirmação de comando: ${commandId}, Status: ${status}, Detalhes: ${details}`);

                // Enviar a confirmação para o pai que enviou o comando original
                const parentWs = wsClientsMap.get(senderParentId);
                if (parentWs && parentWs.isParent && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(JSON.stringify({
                        type: 'COMMAND_ACK',
                        payload: {
                            childId: ws.clientId,
                            commandId: commandId,
                            status: status,
                            details: details
                        }
                    }));
                    console.log(`[WSS_COMMANDS_MSG] Confirmação de comando ${commandId} do filho ${ws.clientId} enviada para o pai ${parentWs.parentId}.`);
                } else {
                    console.warn(`[WSS_COMMANDS_MSG] Pai ${senderParentId} não encontrado ou não está online para receber ACK do comando ${commandId}.`);
                }
            } else if (parsedMessage.type === 'GET_CHILD_IDS' && ws.isParent) {
                // Este comando é para o WebSocket, mas a rota HTTP é mais adequada para listar todos.
                // Aqui podemos enviar a lista de filhos *online* para o pai que requisitou via WS
                console.log(`[WSS_COMMANDS_MSG] [Pai ${ws.parentId}] Requisição para obter IDs de filhos conectados via WebSocket (via WS).`);
                const connectedChildIds = Array.from(wsClientsMap.keys()).filter(id => {
                    const clientWs = wsClientsMap.get(id);
                    return clientWs && clientWs.isChild && clientWs.readyState === WebSocket.OPEN;
                });
                ws.send(JSON.stringify({
                    type: 'CHILD_IDS_ONLINE_LIST', // Mudado para diferenciar da HTTP
                    childIds: connectedChildIds
                }));
                console.log(`[WSS_COMMANDS_MSG] Lista de IDs de filhos ONLINE enviada para o pai ${ws.parentId} via WS: ${connectedChildIds.join(', ')}`);
            } else {
                console.warn(`[WSS_COMMANDS_MSG] [${messageOrigin}] Mensagem de comando desconhecida ou não autorizada:`, parsedMessage);
                ws.send(JSON.stringify({ status: 'error', message: 'Mensagem de comando desconhecida ou não autorizada.' }));
            }
        } catch (error) {
            console.error(`[WSS_COMMANDS_ERROR] [${messageOrigin}] Erro ao processar mensagem de comando:`, error);
            ws.send(JSON.stringify({ status: 'error', message: 'Formato de mensagem JSON inválido ou erro interno.' }));
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WSS_COMMANDS_CLOSE] [${messageOrigin}] Cliente WebSocket (ws-commands) desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}. Total de conexões ativas: ${wssCommands.clients.size - 1}`);

        // Somente remove do wsClientsMap se for o WebSocket principal para aquele ID
        if (ws.clientId && wsClientsMap.get(ws.clientId) === ws) {
            console.log(`[WSS_COMMANDS_CLOSE] [${messageOrigin}] Removendo Filho com ID ${ws.clientId} do mapa wsClientsMap (ws-commands).`);
            wsClientsMap.delete(ws.clientId); // Remove do mapa global
            console.log(`[WSS_COMMANDS_CLOSE] [${messageOrigin}] Mapa wsClientsMap após remoção: [${Array.from(wsClientsMap.keys()).join(', ')}]`);
        } else if (ws.parentId && wsClientsMap.get(ws.parentId) === ws) {
            console.log(`[WSS_COMMANDS_CLOSE] [${messageOrigin}] Removendo Pai com ID ${ws.parentId} do mapa wsClientsMap (ws-commands).`);
            wsClientsMap.delete(ws.parentId); // Remove do mapa global
            console.log(`[WSS_COMMANDS_CLOSE] [${messageOrigin}] Mapa wsClientsMap após remoção: [${Array.from(wsClientsMap.keys()).join(', ')}]`);
        } else {
            console.log(`[WSS_COMMANDS_CLOSE] [Conexão ${ws.id}] Cliente WebSocket (ws-commands) desconectado sem ID de filho ou pai (ou outra conexão com o mesmo ID está ativa).`);
            // Se o WS não se identificou, ou se não é o WS principal, não remove pelo ID de cliente/pai.
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.error(`[WSS_COMMANDS_ERROR] [${messageOrigin}] Erro no WebSocket (ws-commands):`, error);
        ws.close(); // Tenta fechar a conexão em caso de erro
    });
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
server.listen(PORT || 10000, '0.0.0.0', () => { // AGORA USA 'server' AO INVÉS DE 'app'
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