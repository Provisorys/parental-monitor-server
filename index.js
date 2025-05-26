const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio'); // Importado, mas não utilizado no código fornecido. Manter por compatibilidade.
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT;
const upload = multer(); // Instancia o multer, mas não aplica globalmente aqui

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
const DYNAMODB_TABLE_CHILDREN = 'Children'; // Adicionando a tabela de filhos

const wsClientsMap = new Map(); // Mapa para armazenar clientes WebSocket

// --- Rotas HTTP ---
app.use(bodyParser.json()); // Para JSON bodies
app.use(bodyParser.urlencoded({ extended: true })); // Para URL-encoded bodies (se necessário)
app.use(cors()); // Configure CORS adequadamente para sua aplicação

// Rota para receber arquivos de áudio
// Aplica o multer.single('audio') APENAS nesta rota POST
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

        // Este wsClientsMap não está sendo populado para clientes WebSocket do tipo 'parent_'.
        // Se você pretende usar wsClientsMap para enviar notificações de localização para pais,
        // você precisa garantir que os pais se registrem no wsClientsMap na conexão WebSocket.
        // Por enquanto, apenas o wsClientsMap é declarado, mas não tem lógica de adição de pais.
        // Se os pais se conectarem via /ws-commands e você quiser notificar, pode usar o wssCommands.clients.
        // Ou, se os pais se conectam via /audio-stream e se identificam como pais, você pode retransmitir por lá.
        // Removendo a iteração sobre wsClientsMap aqui para evitar confusão, já que ela não é populada no seu código atual para 'parent_'.
        // Se precisar notificar pais via WebSocket, o wssCommands.clients (abaixo para localização) seria mais apropriado,
        // ou adaptar a lógica de identificação de pais em wss.
        wssCommands.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isParent) {
                // Você pode adicionar uma lógica aqui para filtrar qual pai deve receber a mensagem de qual filho
                client.send(messageToParents);
                console.log(`[WSS_COMMANDS] Notificação de nova mensagem de áudio enviada para pai ${client.parentId} via /ws-commands.`);
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

        wssCommands.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isParent) {
                // Você pode adicionar uma lógica aqui para filtrar qual pai deve receber a mensagem de qual filho
                client.send(messageToParents);
                console.log(`[WSS_COMMANDS] Notificação de nova mensagem de texto enviada para pai ${client.parentId} via /ws-commands.`);
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

// --- ROTA GET /get-child-ids (para listar todos os filhos) ---
app.get('/get-child-ids', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /get-child-ids (para listar todos os filhos)');
    try {
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN, // Supondo que você tem uma tabela 'Children'
        };
        const data = await docClient.scan(params).promise(); // Usar scan para listar todos
        console.log(`[DYNAMODB] Dados de todos os filhos recuperados com sucesso. Total: ${data.Items.length}`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao obter dados de todos os filhos:', error);
        res.status(500).send('Erro ao obter dados dos filhos.');
    }
});

// --- ROTA GET /get-child-ids/:childId (para buscar um filho específico) ---
app.get('/get-child-ids/:childId', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: GET /get-child-ids/:childId');
    const { childId } = req.params;

    if (!childId) { // Esta verificação é redundante aqui devido ao ':childId' na rota, mas não prejudica.
        console.warn('[HTTP_ERROR] childId não fornecido na requisição GET /get-child-ids.');
        return res.status(400).send('childId é obrigatório.');
    }

    try {
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN, // Supondo que você tem uma tabela 'Children'
            Key: {
                childId: childId
            }
        };
        const data = await docClient.get(params).promise();

        if (data.Item) {
            console.log(`[DYNAMODB] Dados do filho ${childId} recuperados com sucesso.`);
            res.status(200).json(data.Item);
        } else {
            console.log(`[DYNAMODB] Filho ${childId} não encontrado.`);
            res.status(404).send('Filho não encontrado.');
        }
    } catch (error) {
        console.error('[DYNAMODB_ERROR] Erro ao obter dados do filho:', error);
        res.status(500).send('Erro ao obter dados do filho.');
    }
});


// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/audio-stream' });
const wssCommands = new WebSocket.Server({ server, path: '/ws-commands' });

const parentListeningSockets = new Map(); // Mapa: childId -> WebSocket do pai que está ouvindo
const activeChildWebSockets = new Map(); // Mapa: childId -> WebSocket do filho ativo (usado por ambas as rotas WS)

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

// Lógica de WebSocket para /audio-stream (variável wss)
wss.on('connection', ws => {
    ws.id = uuidv4();
    console.log(`[WSS_AUDIO_CONNECT] Novo cliente WebSocket (audio-stream) conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wss.clients.size}`);

    ws.isParent = false;
    ws.clientId = null;
    ws.parentId = null;

    ws.on('message', message => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);

        let processedAsText = false;

        if (typeof message === 'string') {
            const messageString = message.toString();
            const displayMessage = messageString.length > 100 ? messageString.substring(0, 100) + '...' : messageString;
            console.log(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem WebSocket de TEXTO recebida: "${displayMessage}"`);

            if (messageString.startsWith('CHILD_ID:')) {
                ws.clientId = messageString.substring('CHILD_ID:'.length);
                ws.isParent = false;
                activeChildWebSockets.set(ws.clientId, ws);
                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou. Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                    ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                } else {
                    console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado, mas nenhum pai está ouvindo ativamente neste momento.`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('PARENT_ID:')) {
                ws.isParent = true;
                ws.parentId = messageString.substring('PARENT_ID:'.length);
                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai conectado com ID: ${ws.parentId || 'desconhecido'}`);
                processedAsText = true;
            } else if (messageString.startsWith('LISTEN_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('LISTEN_TO_CHILD:'.length);
                    parentListeningSockets.set(targetChildId, ws);
                    console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                    const childWs = findChildWebSocket(targetChildId);
                    if (childWs) {
                        childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                        console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Sinal START_AUDIO enviado para o filho ${targetChildId} via WebSocket (pedido de escuta do pai).`);
                    } else {
                        console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não encontrado no mapa activeChildWebSockets, mas pai (ID: ${ws.parentId || 'desconhecido'}) está esperando.`);
                    }
                    ws.send(JSON.stringify({ type: 'STATUS', message: `Você está ouvindo ${targetChildId}` }));
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de escuta apenas para pais.' }));
                    console.warn(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Tentativa de comando LISTEN_TO_CHILD de um cliente não-pai. Mensagem: ${messageString}`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('STOP_LISTENING_TO_CHILD:')) {
                if (ws.isParent) {
                    const targetChildId = messageString.substring('STOP_LISTENING_TO_CHILD:'.length);
                    if (parentListeningSockets.has(targetChildId) && parentListeningSockets.get(targetChildId) === ws) {
                        parentListeningSockets.delete(targetChildId);
                        console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

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
                                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Sinal STOP_AUDIO enviado para o filho ${targetChildId} (nenhum pai mais ouvindo).`);
                            }
                        }
                        ws.send(JSON.stringify({ type: 'STATUS', message: `Você parou de ouvir ${targetChildId}` }));
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Você não estava ouvindo este filho.' }));
                        console.warn(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai tentou parar de ouvir ${targetChildId} mas não estava registrado como ouvinte.`);
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de parada de escuta apenas para pais.' }));
                    console.warn(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Tentativa de comando STOP_LISTENING_TO_CHILD de um cliente não-pai. Mensagem: ${messageString}`);
                }
                processedAsText = true;
            } else if (ws.isParent && messageString.startsWith('COMMAND:')) {
                const command = messageString.substring('COMMAND:'.length);
                console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Comando de pai recebido na rota de áudio (deveria ser em /ws-commands): ${command}`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando enviado na rota de áudio. Use /ws-commands para comandos.' }));
                processedAsText = true;
            } else {
                console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem de texto desconhecida ou inesperada: ${displayMessage}`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de texto desconhecido ou não permitido.' }));
                processedAsText = true;
            }
        }

        if (!processedAsText && (message instanceof Buffer || message instanceof ArrayBuffer)) {
            try {
                const decodedMessage = Buffer.from(message).toString('utf8');
                if (decodedMessage.startsWith('CHILD_ID:') ||
                    decodedMessage.startsWith('PARENT_ID:') ||
                    decodedMessage.startsWith('LISTEN_TO_CHILD:') ||
                    decodedMessage.startsWith('STOP_LISTENING_TO_CHILD:')) { // Removido COMMAND: daqui, pois comandos vão para wssCommands
                    
                    console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem binária decodificada como texto, mas deveria ser áudio. Tratando como comando de rota de áudio: "${decodedMessage.substring(0, 100)}..."`);
                    
                    if (decodedMessage.startsWith('CHILD_ID:')) {
                        ws.clientId = decodedMessage.substring('CHILD_ID:'.length);
                        ws.isParent = false;
                        activeChildWebSockets.set(ws.clientId, ws);
                        console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho conectado (via binário decodificado como texto) e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                        const parentWs = parentListeningSockets.get(ws.clientId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou (via binário decodificado como texto). Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                            ws.send(JSON.stringify({ type: 'START_AUDIO' }));
                        } else {
                            console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado (via binário decodificado como texto), mas nenhum pai está ouvindo ativamente neste momento.`);
                        }
                    } else if (decodedMessage.startsWith('PARENT_ID:')) {
                        ws.isParent = true;
                        ws.parentId = decodedMessage.substring('PARENT_ID:'.length);
                        console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai conectado (via binário decodificado como texto) com ID: ${ws.parentId || 'desconhecido'}`);
                    } else if (decodedMessage.startsWith('LISTEN_TO_CHILD:')) {
                        if (ws.isParent) {
                            const targetChildId = decodedMessage.substring('LISTEN_TO_CHILD:'.length);
                            parentListeningSockets.set(targetChildId, ws);
                            console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId} (via binário decodificado como texto). Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                            const childWs = findChildWebSocket(targetChildId);
                            if (childWs) {
                                childWs.send(JSON.stringify({ type: 'START_AUDIO' }));
                                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Sinal START_AUDIO enviado para o filho ${targetChildId} via WebSocket (pedido de escuta do pai via binário decodificado como texto).`);
                            } else {
                                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não encontrado no mapa activeChildWebSockets, mas pai (ID: ${ws.parentId || 'desconhecido'}) está esperando (via binário decodificado como texto).`);
                            }
                            ws.send(JSON.stringify({ type: 'STATUS', message: `Você está ouvindo ${targetChildId}` }));
                        } else {
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de escuta apenas para pais.' }));
                            console.warn(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Tentativa de comando LISTEN_TO_CHILD de um cliente não-pai (via binário decodificado como texto). Mensagem: ${decodedMessage}`);
                        }
                    } else if (decodedMessage.startsWith('STOP_LISTENING_TO_CHILD:')) {
                        if (ws.isParent) {
                            const targetChildId = decodedMessage.substring('STOP_LISTENING_TO_CHILD:'.length);
                            if (parentListeningSockets.has(targetChildId) && parentListeningSockets.get(targetChildId) === ws) {
                                parentListeningSockets.delete(targetChildId);
                                console.log(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId} (via binário decodificado como texto). Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

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
                                        console.log(`[WSS_AUDIO_MSG] [Conexão ${childWs.id}] Sinal STOP_AUDIO enviado para o filho ${targetChildId} (nenhum pai mais ouvindo via binário decodificado como texto).`);
                                    }
                                }
                                ws.send(JSON.stringify({ type: 'STATUS', message: `Você parou de ouvir ${targetChildId}` }));
                            } else {
                                ws.send(JSON.stringify({ type: 'ERROR', message: 'Você não estava ouvindo este filho.' }));
                                console.warn(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Pai tentou parar de ouvir ${targetChildId} mas não estava registrado como ouvinte (via binário decodificado como texto).`);
                            }
                        } else {
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de parada de escuta apenas para pais.' }));
                            console.warn(`[WSS_AUDIO_MSG] [Conexão ${ws.id}] Tentativa de comando STOP_LISTENING_TO_CHILD de um cliente não-pai (via binário decodificado como texto). Mensagem: ${decodedMessage}`);
                        }
                    }
                } else if (ws.clientId && !ws.isParent) {
                    // Se já tiver um clientId e não for um pai, assume que é áudio
                    const parentWs = parentListeningSockets.get(ws.clientId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(message); // Retransmite o Buffer original
                        // console.log(`[WSS_AUDIO_MSG] [${messageOrigin}] Bytes de áudio retransmitidos para o pai de ${ws.clientId}: ${message.length} bytes.`);
                    } else {
                        // console.log(`[WSS_AUDIO_MSG] [${messageOrigin}] Pai não está ouvindo o filho ${ws.clientId}, descartando ${message.length} bytes de áudio.`);
                    }
                } else {
                    console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem binária recebida que não é CHILD_ID e não é esperada para áudio neste contexto. Tamanho: ${message.length} bytes.`);
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem binária desconhecida ou não permitida.' }));
                }
            } catch (e) {
                console.error(`${messageOrigin} Erro ao decodificar mensagem binária como UTF-8: ${e.message}`, e);
                console.warn(`${messageOrigin} Mensagem binária recebida inesperada (não pôde ser decodificada como UTF-8): ${message.length} bytes.`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Erro ao processar mensagem binária.' }));
            }
        } else if (!processedAsText) {
            console.warn(`[WSS_AUDIO_MSG] [${messageOrigin}] Mensagem recebida não é string nem binária esperada. Tipo: ${typeof message}, Tamanho: ${message ? message.length : 'N/A'}`);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Tipo de mensagem não suportado.' }));
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Cliente WebSocket (audio-stream) desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}. Total de conexões ativas: ${wss.clients.size - 1}`);

        if (ws.clientId) {
            console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

            let hadActiveParent = false;
            for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                if (childIdInMap === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                    parentWsInMap.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId }));
                    console.log(`[WSS_AUDIO_CLOSE] [${parentWsInMap.id}] Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${ws.clientId}.`);
                    parentListeningSockets.delete(childIdInMap);
                    hadActiveParent = true;
                }
            }
            if (hadActiveParent) {
                console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Removida a escuta de pais para o filho desconectado ${ws.clientId}.`);
            }
        } else if (ws.isParent && ws.parentId) {
            console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado.`);
            const childIdsStoppedListening = [];
            for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                if (parentWsListening === ws) {
                    childIdsStoppedListening.push(childIdBeingListened);
                }
            }

            for (const childId of childIdsStoppedListening) {
                parentListeningSockets.delete(childId);
                console.log(`[WSS_AUDIO_CLOSE] [${messageOrigin}] Pai ${ws.parentId} parou de ouvir o filho: ${childId}.`);

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
                        console.log(`[WSS_AUDIO_CLOSE] [Conexão ${childWs.id}] Sinal STOP_AUDIO enviado para o filho ${childId} (nenhum pai mais ouvindo).`);
                    }
                }
            }
        } else {
            console.log(`[WSS_AUDIO_CLOSE] [Conexão ${ws.id}] Cliente WebSocket (audio-stream) desconectado sem ID de filho ou pai.`);
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.error(`[WSS_AUDIO_ERROR] [${messageOrigin}] Erro no WebSocket (audio-stream):`, error);
        if (ws.clientId) {
            console.log(`[WSS_AUDIO_ERROR] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets devido a um erro.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WSS_AUDIO_ERROR] [${messageOrigin}] Filho com ID ${ws.clientId} removido. Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

            let hadActiveParent = false;
            for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                if (childIdInMap === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                    parentWsInMap.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId, reason: 'error' }));
                    console.log(`[WSS_AUDIO_ERROR] [${parentWsInMap.id}] Sinal CHILD_DISCONNECTED enviado para o pai ouvindo ${ws.clientId} devido a um erro.`);
                    parentListeningSockets.delete(childIdInMap);
                    hadActiveParent = true;
                }
            }
            if (hadActiveParent) {
                console.log(`[WSS_AUDIO_ERROR] [${messageOrigin}] Removida a escuta de pais para o filho ${ws.clientId} devido a um erro.`);
            }
        } else if (ws.isParent && ws.parentId) {
            console.log(`[WSS_AUDIO_ERROR] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado devido a um erro.`);
            const childIdsStoppedListening = [];
            for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                if (parentWsListening === ws) {
                    childIdsStoppedListening.push(childIdBeingListened);
                }
            }

            for (const childId of childIdsStoppedListening) {
                parentListeningSockets.delete(childId);
                console.log(`[WSS_AUDIO_ERROR] [${messageOrigin}] Pai ${ws.parentId} removido do mapa de ouvintes para ${childId} devido a um erro.`);

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
                        console.log(`[WSS_AUDIO_ERROR] [Conexão ${childWs.id}] Sinal STOP_AUDIO enviado para o filho ${childId} (nenhum pai mais ouvindo após erro).`);
                    }
                }
            }
        }
    });
});


// Lógica de WebSocket para /ws-commands (variável wssCommands)
wssCommands.on('connection', ws => {
    ws.id = uuidv4();
    console.log(`[WSS_COMMANDS_CONNECT] Novo cliente WebSocket (ws-commands) conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wssCommands.clients.size}`);

    ws.isParent = false; // Pode ser um filho ou pai enviando/recebendo comandos
    ws.clientId = null;
    ws.parentId = null;

    ws.on('message', message => {
        const messageString = message.toString();
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WSS_COMMANDS_MSG] [${messageOrigin}] Mensagem de TEXTO (ws-commands) recebida: "${messageString.substring(0, 100)}..."`);

        try {
            const parsedMessage = JSON.parse(messageString);

            if (parsedMessage.type === 'CHILD_ID') {
                ws.clientId = parsedMessage.id;
                ws.isParent = false;
                activeChildWebSockets.set(ws.clientId, ws); // Registra na lista de WS ativos para comandos
                console.log(`[WSS_COMMANDS_MSG] [Conexão ${ws.id}] Filho conectado (ws-commands) e ID "${ws.clientId}" registrado.`);
            } else if (parsedMessage.type === 'PARENT_ID') {
                ws.parentId = parsedMessage.id;
                ws.isParent = true;
                // wsClientsMap.set(`parent_${ws.parentId}`, ws); // Se precisar mapear pais por ID também para comandos
                console.log(`[WSS_COMMANDS_MSG] [Conexão ${ws.id}] Pai conectado (ws-commands) com ID: ${ws.parentId}`);
            } else if (parsedMessage.type === 'COMMAND' && ws.isParent) {
                const { targetChildId, commandType, data } = parsedMessage.payload;
                console.log(`[WSS_COMMANDS_MSG] [Pai ${ws.parentId}] Recebido comando para filho ${targetChildId}: ${commandType} com dados:`, data);
                
                const childWs = findChildWebSocket(targetChildId); // Busca na lista de filhos ativos (com ws-commands)
                if (childWs) {
                    childWs.send(JSON.stringify({ type: commandType, data: data }));
                    console.log(`[WSS_COMMANDS_MSG] Comando '${commandType}' enviado via WebSocket (ws-commands) para o filho: ${targetChildId}`);
                    ws.send(JSON.stringify({ status: 'success', message: `Comando ${commandType} enviado para ${targetChildId}.` }));
                } else {
                    console.warn(`[WSS_COMMANDS_MSG] Nenhuma conexão WebSocket (ws-commands) ativa encontrada para o filho: ${targetChildId}.`);
                    ws.send(JSON.stringify({ status: 'error', message: `Filho ${targetChildId} não está conectado para comandos.` }));
                }
            } else if (parsedMessage.type === 'ACK_COMMAND' && !ws.isParent) {
                // Mensagem de confirmação de comando do filho para o pai
                const { commandId, status, details } = parsedMessage.payload;
                console.log(`[WSS_COMMANDS_MSG] [Filho ${ws.clientId}] Confirmação de comando: ${commandId}, Status: ${status}, Detalhes: ${details}`);
                // Aqui você pode encaminhar isso para o pai que enviou o comando original
                // Ex: encontrar o pai no wsClientsMap e enviar a confirmação
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

        if (ws.clientId) {
            console.log(`[WSS_COMMANDS_CLOSE] [${messageOrigin}] Removendo Filho com ID ${ws.clientId} do mapa activeChildWebSockets (ws-commands).`);
            // Remover do mapa activeChildWebSockets, pois este mapa é usado por ambas as rotas para encontrar o WebSocket do filho
            // O ideal seria ter um mapa separado para cada tipo de conexão se o cliente tiver 2 conexões distintas,
            // mas manter apenas uma para simplificar a busca do filho.
            activeChildWebSockets.delete(ws.clientId); 
            console.log(`[WSS_COMMANDS_CLOSE] [${messageOrigin}] Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.error(`[WSS_COMMANDS_ERROR] [${messageOrigin}] Erro no WebSocket (ws-commands):`, error);
        if (ws.clientId) {
            console.log(`[WSS_COMMANDS_ERROR] [${messageOrigin}] Removendo Filho com ID ${ws.clientId} do mapa activeChildWebSockets (ws-commands) devido a um erro.`);
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WSS_COMMANDS_ERROR] [${messageOrigin}] Mapa activeChildWebSockets após remoção: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);
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

        // Notificar pais conectados via rota /ws-commands
        wssCommands.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isParent) {
                // Você pode adicionar uma lógica aqui para filtrar qual pai deve receber a localização de qual filho
                // Ou enviar para todos os pais conectados na rota de comandos
                client.send(messageToParents);
                console.log(`[WSS_COMMANDS] Localização de ${childId} enviada para pai ${client.parentId} via /ws-commands.`);
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
    console.warn(`[HTTP_ERROR] Parâmetros da requisição:`, req.params); // Novo log
    console.warn(`[HTTP_ERROR] Query da requisição:`, req.query); // Novo log
    console.warn(`[HTTP_ERROR] Corpo da requisição:`, req.body); // Novo log
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
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`); // Novo log
    console.log(`Twilio Account SID configurado via env: ${process.env.TWILIO_ACCOUNT_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key SID configurada via env: ${process.env.TWILIO_API_KEY_SID ? 'Sim' : 'Não'}`);
    console.log(`Twilio API Key Secret configurada via env: ${process.env.TWILIO_API_KEY_SECRET ? 'Sim' : 'Não'}`);
});