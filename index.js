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

const wsClientsMap = new Map(); // Mapa para armazenar clientes WebSocket
// --- Variáveis para Controle de WebSockets (AGORA COM ADIÇÕES) ---
const parentListeningSockets = new Map(); // Mapa: childId -> WebSocket do pai que está ouvindo o áudio
const activeChildWebSockets = new Map(); // Mapa: childId -> WebSocket do filho ativo (usado por ambas as rotas WS para comandos e status)


// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(upload.any()); // Para lidar com multipart/form-data, incluindo arquivos e outros campos

// Middleware para log de requisições
app.use((req, res, next) => {
    console.log(`[HTTP_REQ] ${req.method} ${req.url}`);
    next();
});

// --- FUNÇÃO AUXILIAR PARA DYNAMODB ---
async function saveMessageToDynamoDB(message) {
    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: message
    };
    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Mensagem salva no DynamoDB: ${message.messageId}`);
    } catch (error) {
        console.error('[DYNAMODB] Erro ao salvar mensagem no DynamoDB:', error);
    }
}

async function updateConversationInDynamoDB(conversationId, latestMessage, senderId, receiverId) {
    const timestamp = Date.now();
    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        Key: { conversationId },
        UpdateExpression: 'SET latestMessage = :lm, lastUpdated = :lu, #s = :s, #r = :r ADD messageCount :inc',
        ExpressionAttributeNames: {
            '#s': 'senderId',
            '#r': 'receiverId',
        },
        ExpressionAttributeValues: {
            ':lm': latestMessage,
            ':lu': timestamp,
            ':s': senderId,
            ':r': receiverId,
            ':inc': 1
        },
        ReturnValues: 'UPDATED_NEW'
    };
    try {
        await docClient.update(params).promise();
        console.log(`[DYNAMODB] Conversa ${conversationId} atualizada.`);
    } catch (error) {
        console.error(`[DYNAMODB] Erro ao atualizar conversa ${conversationId}:`, error);
    }
}

// --- FUNÇÃO AUXILIAR PARA ENVIAR MENSAGEM VIA WS ---
function sendMessageToWebSocketClient(clientId, message) {
    const clientWs = wsClientsMap.get(clientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(message));
        console.log(`[WS_SEND] Mensagem enviada via WebSocket para ${clientId}.`);
    } else {
        console.warn(`[WS_SEND] Cliente ${clientId} não encontrado ou WebSocket não está OPEN para enviar mensagem.`);
    }
}

// --- ROTAS HTTP ---
app.post('/send-message', upload.single('media'), async (req, res) => {
    try {
        const { senderId, receiverId, messageText, messageType = 'text', conversationId } = req.body;
        const mediaFile = req.file;

        if (!senderId || !receiverId || (!messageText && !mediaFile)) {
            console.warn('[HTTP_API] Erro: Dados incompletos para enviar mensagem.');
            return res.status(400).json({ message: 'Dados incompletos para enviar mensagem.' });
        }

        const messageId = uuidv4();
        const timestamp = Date.now();
        let mediaUrl = null;

        if (mediaFile) {
            const mediaFileName = `${uuidv4()}-${mediaFile.originalname}`;
            const uploadParams = {
                Bucket: S3_BUCKET_NAME,
                Key: mediaFileName,
                Body: mediaFile.buffer,
                ContentType: mediaFile.mimetype,
                ACL: 'public-read' // Ou 'private' se for gerado um link assinado
            };
            console.log(`[S3] Tentando upload de arquivo ${mediaFileName} para o bucket ${S3_BUCKET_NAME}`);
            try {
                const s3UploadResult = await s3.upload(uploadParams).promise();
                mediaUrl = s3UploadResult.Location;
                console.log(`[S3] Upload bem-sucedido. URL: ${mediaUrl}`);
            } catch (s3Error) {
                console.error('[S3] Erro ao fazer upload para S3:', s3Error);
                return res.status(500).json({ message: 'Erro ao fazer upload da mídia.', error: s3Error.message });
            }
        }

        const message = {
            messageId,
            conversationId: conversationId || `${senderId}_${receiverId}`, // Gera um ID de conversa simples se não for fornecido
            senderId,
            receiverId,
            messageText: messageText || (mediaUrl ? `[${mediaFile.mimetype.split('/')[0]} media]` : null),
            messageType: mediaFile ? mediaFile.mimetype.split('/')[0] : messageType,
            mediaUrl,
            timestamp
        };

        await saveMessageToDynamoDB(message);
        await updateConversationInDynamoDB(message.conversationId, message.messageText, senderId, receiverId);

        // Envia a mensagem para o destinatário via WebSocket se ele estiver conectado
        sendMessageToWebSocketClient(receiverId, { type: 'new_message', message });

        res.status(200).json({ message: 'Mensagem enviada com sucesso!', messageId });
    } catch (error) {
        console.error('[HTTP_API] Erro na rota /send-message:', error);
        res.status(500).json({ message: 'Erro interno do servidor.', error: error.message });
    }
});

app.post('/send-sms', async (req, res) => {
    const { to, body } = req.body;

    if (!to || !body) {
        console.warn('[HTTP_API] Erro: "to" e "body" são obrigatórios para enviar SMS.');
        return res.status(400).json({ message: '"to" e "body" são obrigatórios.' });
    }

    try {
        console.log(`[SMS] Tentando enviar SMS para: ${to} com mensagem: "${body}"`);
        const message = await twilioClient.messages.create({
            body: body,
            to: to,
            from: TWILIO_PHONE_NUMBER
        });
        console.log(`[SMS] SMS enviado com sucesso. SID: ${message.sid}`);
        res.status(200).json({ success: true, sid: message.sid });
    } catch (error) {
        console.error('[SMS] Erro ao enviar SMS:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/save-location', async (req, res) => {
    const { childId, latitude, longitude, timestamp } = req.body;

    if (!childId || !latitude || !longitude || !timestamp) {
        console.warn('[HTTP_API] Erro: Dados de localização incompletos.');
        return res.status(400).json({ message: 'Dados de localização (childId, latitude, longitude, timestamp) são obrigatórios.' });
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            childId: childId,
            timestamp: parseInt(timestamp), // Garante que o timestamp é um número
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude)
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Localização salva para ${childId}: Lat ${latitude}, Lng ${longitude}`);
        res.status(200).json({ message: 'Localização salva com sucesso!' });
    } catch (error) {
        console.error('[DYNAMODB] Erro ao salvar localização no DynamoDB:', error);
        res.status(500).json({ message: 'Erro ao salvar localização.', error: error.message });
    }
});

app.get('/get-locations/:childId', async (req, res) => {
    const { childId } = req.params;
    const { limit, startTimestamp, endTimestamp } = req.query;

    if (!childId) {
        return res.status(400).json({ message: 'childId é obrigatório.' });
    }

    let params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        KeyConditionExpression: 'childId = :cid',
        ExpressionAttributeValues: {
            ':cid': childId
        },
        ScanIndexForward: false, // Últimas localizações primeiro
        Limit: limit ? parseInt(limit) : undefined // Limite de resultados
    };

    // Adiciona filtros de tempo se fornecidos
    if (startTimestamp || endTimestamp) {
        params.KeyConditionExpression += ' AND #ts BETWEEN :startTs AND :endTs';
        params.ExpressionAttributeNames = { '#ts': 'timestamp' };
        params.ExpressionAttributeValues[':startTs'] = startTimestamp ? parseInt(startTimestamp) : 0;
        params.ExpressionAttributeValues[':endTs'] = endTimestamp ? parseInt(endTimestamp) : Date.now();
    }

    try {
        const data = await docClient.query(params).promise();
        console.log(`[DYNAMODB] ${data.Items.length} localizações encontradas para ${childId}.`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[DYNAMODB] Erro ao buscar localizações no DynamoDB:', error);
        res.status(500).json({ message: 'Erro ao buscar localizações.', error: error.message });
    }
});

// --- FUNÇÃO AUXILIAR PARA WEBSOCKETS ---
// Esta função agora usará 'activeChildWebSockets' que armazena WSS de COMANDOS
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
// Essas rotas agora enviará comandos para a conexão de comando do filho
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
            const command = JSON.stringify({ type: 'START_AUDIO' }); // Comando para o filho
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
            const command = JSON.stringify({ type: 'STOP_AUDIO' }); // Comando para o filho
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


// --- Configuração do servidor HTTP ---
const server = http.createServer(app);

// --- WebSocket Existente (AGORA PARA AUDIO-STREAM: /audio-stream) ---
const wssAudio = new WebSocket.Server({ server, path: '/audio-stream' });

wssAudio.on('connection', (ws, req) => { // Adicionado 'req' aqui para logar o caminho
    console.log(`[WS-AUDIO] Novo cliente conectado no caminho: ${req.url}`);
    ws.id = uuidv4();
    console.log(`[WS_CONNECT] Novo cliente WebSocket conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wssAudio.clients.size}`); // Log

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
                // activeChildWebSockets.set(ws.clientId, ws); // ESTA LINHA É REMOVIDA DESTE WSS (FICA APENAS NO wssCommands)
                console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado no WSS_AUDIO.`);

                // A LÓGICA DE START_AUDIO AQUI É MOVÍDA PARA O wssCommands
                // parentListeningSockets.get(ws.clientId) é relevante para o WSS_AUDIO
                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou. Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. *Aguardando comando START_AUDIO do wssCommands*.`);
                } else {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado, mas nenhum pai está ouvindo ativamente neste momento.`);
                }
                processedAsText = true;
            } else if (messageString.startsWith('PARENT_ID:')) {
                ws.isParent = true;
                ws.parentId = messageString.substring('PARENT_ID:'.length);
                // wsClientsMap.set(ws.parentId, ws); // ESTA LINHA É REMOVIDA DESTE WSS (FICA APENAS NO wssCommands)
                console.log(`[WS_MSG] [Conexão ${ws.id}] Pai conectado com ID: ${ws.parentId || 'desconhecido'} no WSS_AUDIO.`);
                processedAsText = true;
            } else if (messageString.startsWith('LISTEN_TO_CHILD:')) { // ESTE TIPO DE MENSAGEM É MOVIDO PARA O wssCommands
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando LISTEN_TO_CHILD deve ser enviado para /ws-commands.' }));
                console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando LISTEN_TO_CHILD enviado para /audio-stream. Mensagem: ${messageString}`);
                processedAsText = true;
            } else if (messageString.startsWith('STOP_LISTENING_TO_CHILD:')) { // ESTE TIPO DE MENSAGEM É MOVIDO PARA O wssCommands
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando STOP_LISTENING_TO_CHILD deve ser enviado para /ws-commands.' }));
                console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando STOP_LISTENING_TO_CHILD enviado para /audio-stream. Mensagem: ${messageString}`);
                processedAsText = true;
            } else if (ws.isParent && messageString.startsWith('COMMAND:')) { // ESTE TIPO DE MENSAGEM É MOVIDO PARA O wssCommands
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comandos de texto devem ser enviados para /ws-commands.' }));
                console.warn(`[WS_MSG] [${messageOrigin}] Comando de pai recebido no /audio-stream. Mensagem: ${messageString}`);
                processedAsText = true;
            } else {
                console.warn(`[WS_MSG] [${messageOrigin}] Mensagem de texto desconhecida ou inesperada no /audio-stream: ${displayMessage}`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de texto desconhecido ou não permitido nesta rota.' }));
                processedAsText = true;
            }
        }

        // Se não foi processada como string, tenta decodificar como UTF-8 se for binário
        if (!processedAsText && (message instanceof Buffer || message instanceof ArrayBuffer)) {
            try {
                // Tenta decodificar como texto para verificar se é um comando (embora esperado no wssCommands)
                const decodedMessage = message.toString('utf8');
                const displayDecodedMessage = decodedMessage.length > 100 ? decodedMessage.substring(0, 100) + '...' : decodedMessage;
                // console.log(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida. Tentando decodificar como UTF-8: "${displayDecodedMessage}"`); // Removido log excessivo

                if (decodedMessage.startsWith('CHILD_ID:')) { // Ainda pode vir aqui em conexões binárias, mas o registro no mapa de ativos é para wssCommands
                    ws.clientId = decodedMessage.substring('CHILD_ID:'.length);
                    ws.isParent = false;
                    // activeChildWebSockets.set(ws.clientId, ws); // Removido daqui
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado (via binário decodificado) e ID "${ws.clientId}" registrado no WSS_AUDIO.`);
                } else if (ws.clientId && !ws.isParent) {
                    // Se já tiver um clientId e não for um pai, assume que é áudio
                    const parentWs = parentListeningSockets.get(ws.clientId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        // AQUI É ONDE O AUDIO_STREAM_DATA É REENCAMINHADO
                        parentWs.send(message); // Retransmite o Buffer original diretamente para o pai
                        // console.log(`[WS_MSG] [${messageOrigin}] Bytes de áudio retransmitidos para o pai de ${ws.clientId}: ${message.length} bytes.`);
                    } else {
                        // console.log(`[WS_MSG] [${messageOrigin}] Pai não está ouvindo o filho ${ws.clientId}, descartando ${message.length} bytes de áudio.`);
                    }
                } else {
                    console.warn(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida que não é CHILD_ID e não é esperada para áudio neste contexto. Tamanho: ${message.length} bytes.`);
                }
            } catch (e) {
                console.error(`${messageOrigin} Erro ao decodificar mensagem binária como UTF-8: ${e.message}`, e);
                console.warn(`${messageOrigin} Mensagem binária recebida inesperada (não pôde ser decodificada como UTF-8): ${message.length} bytes.`);
            }
        } else if (!processedAsText) { // Se não foi string e não foi Buffer/ArrayBuffer
            console.warn(`[WS_MSG] [${messageOrigin}] Mensagem recebida não é string nem binária esperada. Tipo: ${typeof message}, Tamanho: ${message ? message.length : 'N/A'}`);
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.log(`[WS_CLOSE] [${messageOrigin}] Cliente WebSocket de ÁUDIO desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}. Total de conexões ativas de áudio: ${wssAudio.clients.size -1}`); // Log

        if (ws.clientId) {
            console.log(`[WS_CLOSE] [${messageOrigin}] Tentando remover Filho com ID ${ws.clientId} do mapa activeChildWebSockets.`);
            // A remoção de activeChildWebSockets deve ocorrer APENAS quando a conexão /ws-commands for fechada
            // parentListeningSockets.delete(ws.clientId); // Isso é para quando o PAI para de ouvir
            // A notificação de CHILD_DISCONNECTED é feita pelo wssCommands agora
        } else if (ws.isParent && ws.parentId) {
            console.log(`[WS_CLOSE] [${messageOrigin}] Pai com ID ${ws.parentId} desconectado do stream de áudio.`);
            // Para de retransmitir áudio se o pai desconectar da rota de áudio
            for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                if (parentWsListening === ws) {
                    parentListeningSockets.delete(childIdBeingListened);
                    console.log(`[WS_CLOSE] [${messageOrigin}] Pai ${ws.parentId} parou de ouvir o filho: ${childIdBeingListened}.`);

                    // Se não houver mais pais ouvindo este filho, manda STOP_AUDIO via wssCommands
                    let anotherParentStillListening = false;
                    for (const [cId, pWs] of parentListeningSockets.entries()) {
                        if (cId === childIdBeingListened && pWs.readyState === WebSocket.OPEN) {
                            anotherParentStillListening = true;
                            break;
                        }
                    }

                    if (!anotherParentStillListening) {
                        const childWsCommands = activeChildWebSockets.get(childIdBeingListened); // Pega a conexão de COMANDOS do filho
                        if (childWsCommands && childWsCommands.readyState === WebSocket.OPEN) {
                            childWsCommands.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                            console.log(`[WS_CLOSE] [Conexão ${childWsCommands.id}] Sinal STOP_AUDIO enviado para o filho ${childIdBeingListened} (nenhum pai mais ouvindo ÁUDIO após desconexão do pai).`);
                        }
                    }
                }
            }
        } else {
            console.log(`[WS_CLOSE] [Conexão ${ws.id}] Cliente WebSocket de ÁUDIO desconectado sem ID de filho ou pai.`);
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);
        console.error(`[WS_ERROR] [${messageOrigin}] Erro no WebSocket de ÁUDIO:`, error);
        if (ws.clientId) {
            // Remoção de activeChildWebSockets deve ocorrer apenas no wssCommands.
            // Aqui, apenas logs ou limpezas relacionadas ao stream de áudio.
        }
        if (ws.isParent && ws.parentId) {
           for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
               if (parentWsListening === ws) {
                   parentListeningSockets.delete(childIdBeingListened);
                   console.log(`[WS_ERROR] [${messageOrigin}] Pai ${ws.parentId} removido do mapa de ouvintes de ÁUDIO para ${childIdBeingListened} devido a um erro.`);

                   let anotherParentStillListening = false;
                   for (const [cId, pWs] of parentListeningSockets.entries()) {
                       if (cId === childIdBeingListened && pWs.readyState === WebSocket.OPEN) {
                           anotherParentStillListening = true;
                           break;
                       }
                   }
                   if (!anotherParentStillListening) {
                       const childWsCommands = activeChildWebSockets.get(childIdBeingListened);
                       if (childWsCommands && childWsCommands.readyState === WebSocket.OPEN) {
                           childWsCommands.send(JSON.stringify({ type: 'STOP_AUDIO' }));
                           console.log(`[WS_ERROR] [Conexão ${childWsCommands.id}] Sinal STOP_AUDIO enviado para o filho ${childIdBeingListened} (nenhum pai mais ouvindo ÁUDIO após erro).`);
                       }
                   }
               }
           }
        }
    });
});

// --- NOVO: Configuração do WebSocket para Comandos e Status (/ws-commands) ---
const wssCommands = new WebSocket.Server({ server, path: '/ws-commands' });

wssCommands.on('connection', (ws, req) => {
    console.log(`[WS-COMMANDS] Novo cliente conectado no caminho: ${req.url}`);

    ws.clientId = null; // ID do cliente (pai ou filho)
    ws.clientType = null; // Tipo de cliente ('parent' ou 'child')

    ws.on('message', async (message) => {
        const messageString = message.toString();
        try {
            const parsedMessage = JSON.parse(messageString);

            // Identificação do cliente (pai ou filho) para o canal de COMANDOS
            if (parsedMessage.type === 'parent_id' && parsedMessage.id) {
                ws.clientId = parsedMessage.id;
                ws.clientType = 'parent';
                wsClientsMap.set(parsedMessage.id, ws); // Adiciona/atualiza no mapa principal
                console.log(`[WS-COMMANDS] Pai conectado e identificado: ${ws.clientId}`);
            } else if (parsedMessage.type === 'child_id' && parsedMessage.id) {
                ws.clientId = parsedMessage.id;
                ws.clientType = 'child';
                wsClientsMap.set(parsedMessage.id, ws); // Adiciona/atualiza no mapa principal (geral)
                activeChildWebSockets.set(parsedMessage.id, ws); // Adiciona/atualiza no mapa de filhos ativos para comandos
                console.log(`[WS-COMMANDS] Filho conectado e identificado: ${ws.clientId}. activeChildWebSockets: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);
                // Notificar pais sobre filho online (via conexão de comandos)
                wsClientsMap.forEach((clientWs) => {
                    // Garante que é um pai e que está na conexão de comandos
                    if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN && clientWs.path === '/ws-commands') {
                        clientWs.send(JSON.stringify({
                            type: 'child_online_status',
                            childId: ws.clientId,
                            isOnline: true
                        }));
                    }
                });
            } else if (!ws.clientId) {
                console.warn(`[WS-COMMANDS] Mensagem recebida de cliente não identificado: ${messageString}`);
                ws.send(JSON.stringify({ type: 'error', message: 'Cliente não identificado. Por favor, envie seu ID.' }));
                return;
            }

            // Lógica específica para o canal de COMANDOS
            if (ws.clientType === 'parent') {
                if (parsedMessage.type === 'request_current_location' && parsedMessage.childId) {
                    console.log(`[WS-COMMANDS] Pai ${ws.clientId} solicitou localização do filho ${parsedMessage.childId}`);
                    const targetChildWs = activeChildWebSockets.get(parsedMessage.childId); // Usa o mapa de filhos ativos
                    if (targetChildWs && targetChildWs.readyState === WebSocket.OPEN) {
                        targetChildWs.send(JSON.stringify({ type: 'request_location_update' }));
                    } else {
                        console.warn(`[WS-COMMANDS] Filho ${parsedMessage.childId} não encontrado ou offline para solicitação de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${parsedMessage.childId} offline ou não conectado.` }));
                    }
                } else if (parsedMessage.type === 'request_audio_stream' && parsedMessage.childId) {
                    console.log(`[WS-COMMANDS] Pai ${ws.clientId} solicitou stream de áudio do filho ${parsedMessage.childId}`);
                    const targetChildWs = activeChildWebSockets.get(parsedMessage.childId); // Usa o mapa de filhos ativos (conexão de comandos)
                    if (targetChildWs && targetChildWs.readyState === WebSocket.OPEN) {
                        // Registra o pai para receber o stream NA CONEXÃO DE ÁUDIO do pai
                        // Percorrer wssAudio.clients para encontrar a conexão de áudio do PAI
                        let parentAudioWs = null;
                        for (const client of wssAudio.clients) {
                            if (client.parentId === ws.clientId && client.isParent && client.readyState === WebSocket.OPEN) {
                                parentAudioWs = client;
                                break;
                            }
                        }
                        if (parentAudioWs) {
                            parentListeningSockets.set(parsedMessage.childId, parentAudioWs);
                            console.log(`[WS-COMMANDS] Pai ${ws.clientId} (conexão de comandos) registrou a conexão de ÁUDIO para ouvir ${parsedMessage.childId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);
                            targetChildWs.send(JSON.stringify({ type: 'start_audio_stream' })); // Manda comando para filho (via ws-commands)
                        } else {
                             console.warn(`[WS-COMMANDS] Pai ${ws.clientId} solicitou áudio, mas não tem uma conexão ativa em /audio-stream para receber.`);
                             ws.send(JSON.stringify({ type: 'error', message: 'Você precisa estar conectado na rota /audio-stream para receber áudio.' }));
                        }
                    } else {
                        console.warn(`[WS-COMMANDS] Filho ${parsedMessage.childId} não encontrado ou offline para solicitação de áudio.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${parsedMessage.childId} offline ou não conectado para áudio.` }));
                    }
                } else if (parsedMessage.type === 'stop_audio_stream' && parsedMessage.childId) {
                    console.log(`[WS-COMMANDS] Pai ${ws.clientId} solicitou para parar stream de áudio do filho ${parsedMessage.childId}`);
                    const targetChildWs = activeChildWebSockets.get(parsedMessage.childId); // Usa o mapa de filhos ativos
                    // Remove a escuta do pai de parentListeningSockets, independentemente da conexão de áudio estar ativa
                    let parentAudioWsForChild = null;
                    for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                        if (childIdInMap === parsedMessage.childId && parentWsInMap.parentId === ws.clientId && parentWsInMap.readyState === WebSocket.OPEN) {
                            parentAudioWsForChild = parentWsInMap;
                            parentListeningSockets.delete(parsedMessage.childId); // Remove a entrada específica
                            console.log(`[WS-COMMANDS] Pai ${ws.clientId} (conexão de comandos) removeu a escuta de áudio do filho ${parsedMessage.childId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);
                            break;
                        }
                    }
                    if (targetChildWs && targetChildWs.readyState === WebSocket.OPEN) {
                        // Verifica se algum outro pai ainda está ouvindo este filho
                        let anotherParentListeningToThisChild = false;
                        for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                            if (childIdInMap === parsedMessage.childId && parentWsInMap.readyState === WebSocket.OPEN) {
                                anotherParentListeningToThisChild = true;
                                break;
                            }
                        }

                        if (!anotherParentListeningToThisChild) {
                            targetChildWs.send(JSON.stringify({ type: 'stop_audio_stream' })); // Manda comando para filho (via ws-commands)
                            console.log(`[WS-COMMANDS] Ninguém mais ouvindo o filho ${parsedMessage.childId}. Enviando STOP_AUDIO_STREAM.`);
                        } else {
                            console.log(`[WS-COMMANDS] Outros pais ainda estão ouvindo o filho ${parsedMessage.childId}. Não enviando STOP_AUDIO_STREAM.`);
                        }
                    } else {
                        console.warn(`[WS-COMMANDS] Filho ${parsedMessage.childId} não encontrado ou offline para parar stream de áudio.`);
                    }
                }
            } else if (ws.clientType === 'child') {
                if (parsedMessage.type === 'location_update' && parsedMessage.location) {
                    const childId = ws.clientId;
                    // Enviar atualização de localização para todos os pais conectados (no canal de comandos)
                    wsClientsMap.forEach((clientWs) => {
                        // Garante que é um pai e que está na conexão de comandos
                        if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN && clientWs.path === '/ws-commands') {
                            clientWs.send(JSON.stringify({
                                type: 'child_location_update',
                                childId: childId,
                                location: parsedMessage.location,
                                timestamp: parsedMessage.timestamp || Date.now()
                            }));
                        }
                    });
                     // Salvar localização no DynamoDB
                    const locationData = {
                        childId: childId,
                        timestamp: parsedMessage.timestamp || Date.now(),
                        latitude: parsedMessage.location.latitude,
                        longitude: parsedMessage.location.longitude
                    };
                    try {
                        const params = {
                            TableName: DYNAMODB_TABLE_LOCATIONS,
                            Item: locationData
                        };
                        await docClient.put(params).promise();
                        console.log(`[DYNAMODB] Localização do filho ${childId} salva (via WS-COMMANDS).`);
                    } catch (dbError) {
                        console.error('[DYNAMODB] Erro ao salvar localização via WS-COMMANDS:', dbError);
                    }
                } else if (parsedMessage.type === 'send_location_to_parents' && parsedMessage.location) {
                    const childId = ws.clientId;
                    wsClientsMap.forEach((clientWs) => {
                        // Garante que é um pai e que está na conexão de comandos
                        if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN && clientWs.path === '/ws-commands') {
                            clientWs.send(JSON.stringify({
                                type: 'child_location_update',
                                childId: childId,
                                location: parsedMessage.location,
                                timestamp: parsedMessage.timestamp || Date.now()
                            }));
                        }
                    });
                     // Salvar localização no DynamoDB (duplicação, mas garante que seja salva)
                    const locationData = {
                        childId: childId,
                        timestamp: parsedMessage.timestamp || Date.now(),
                        latitude: parsedMessage.location.latitude,
                        longitude: parsedMessage.location.longitude
                    };
                    try {
                        const params = {
                            TableName: DYNAMODB_TABLE_LOCATIONS,
                            Item: locationData
                        };
                        await docClient.put(params).promise();
                        console.log(`[DYNAMODB] Localização do filho ${childId} salva (via WS-COMMANDS com send_location_to_parents).`);
                    } catch (dbError) {
                        console.error('[DYNAMODB] Erro ao salvar localização via WS-COMMANDS (send_location_to_parents):', dbError);
                    }
                } else if (parsedMessage.type === 'audio_stream_data') {
                    console.warn(`[WS-COMMANDS] Recebida mensagem de áudio na rota /ws-commands. Por favor, envie dados de áudio para /audio-stream.`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Dados de áudio devem ser enviados para a rota /audio-stream.' }));
                    }
                } else {
                    console.warn(`[WS-COMMANDS] Filho ${ws.clientId} enviou mensagem de comando desconhecida: ${messageString}`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Comando desconhecido.' }));
                    }
                }
            }
        } catch (e) {
            console.error(`[WS-COMMANDS] Erro ao processar mensagem JSON: ${e.message}, Mensagem original: ${messageString}`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem inválido.' }));
            }
        }
    });

    ws.on('close', (code, reason) => {
        const messageOrigin = ws.clientId ? `Cliente ${ws.clientId} (Conexão ${ws.id})` : `Conexão ${ws.id}`;
        console.log(`[WS-COMMANDS] Cliente desconectado: ${messageOrigin}. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        if (ws.clientId) {
            // Remove o cliente do mapa principal wsClientsMap
            wsClientsMap.delete(ws.clientId);
            console.log(`[WS-COMMANDS] Cliente ${ws.clientId} removido do wsClientsMap.`);

            if (ws.clientType === 'child') {
                activeChildWebSockets.delete(ws.clientId);
                console.log(`[WS-COMMANDS] Filho ${ws.clientId} removido do activeChildWebSockets. activeChildWebSockets: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                // Notificar pais sobre filho offline (via conexão de comandos)
                wsClientsMap.forEach((clientWs) => {
                    if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN && clientWs.path === '/ws-commands') {
                        clientWs.send(JSON.stringify({
                            type: 'child_online_status',
                            childId: ws.clientId,
                            isOnline: false
                        }));
                    }
                });

                // Se o filho se desconectou do canal de comandos, pare todos os pais de ouvirem o áudio dele
                for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                    if (childIdBeingListened === ws.clientId) {
                        parentListeningSockets.delete(childIdBeingListened);
                        console.log(`[WS-COMMANDS] Filho ${ws.clientId} desconectado da rota de comandos, removendo-o da escuta de áudio dos pais.`);
                        // Não há necessidade de enviar STOP_AUDIO para o filho, pois a conexão de comandos já caiu.
                    }
                }
            } else if (ws.clientType === 'parent') {
                // Se o pai se desconectou do canal de comandos, remove-o de quaisquer escutas de áudio ativas
                for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                    if (parentWsListening.parentId === ws.clientId) { // Verifica pelo parentId associado ao WebSocket
                        parentListeningSockets.delete(childIdBeingListened);
                        console.log(`[WS-COMMANDS] Pai ${ws.clientId} desconectado da rota de comandos, removendo-o da escuta de áudio do filho ${childIdBeingListened}.`);

                        // Verifica se outro pai ainda está ouvindo este filho
                        let anotherParentStillListening = false;
                        for (const [cId, pWs] of parentListeningSockets.entries()) {
                            if (cId === childIdBeingListened && pWs.readyState === WebSocket.OPEN) {
                                anotherParentStillListening = true;
                                break;
                            }
                        }
                        if (!anotherParentStillListening) {
                            const childWsCommands = activeChildWebSockets.get(childIdBeingListened);
                            if (childWsCommands && childWsCommands.readyState === WebSocket.OPEN) {
                                childWsCommands.send(JSON.stringify({ type: 'stop_audio_stream' }));
                                console.log(`[WS-COMMANDS] Sinal STOP_AUDIO enviado para o filho ${childIdBeingListened} (nenhum pai mais ouvindo ÁUDIO).`);
                            }
                        }
                    }
                }
            }
        }
    });

    ws.on('error', error => {
        const messageOrigin = ws.clientId ? `Cliente ${ws.clientId} (Conexão ${ws.id})` : `Conexão ${ws.id}`;
        console.error(`[WS-COMMANDS] Erro no WebSocket para ${messageOrigin}:`, error);
        // Limpeza similar ao 'close' para garantir a consistência dos mapas
        if (ws.clientId) {
            wsClientsMap.delete(ws.clientId);
            if (ws.clientType === 'child') {
                activeChildWebSockets.delete(ws.clientId);
                wsClientsMap.forEach((clientWs) => {
                    if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN && clientWs.path === '/ws-commands') {
                        clientWs.send(JSON.stringify({
                            type: 'child_online_status',
                            childId: ws.clientId,
                            isOnline: false
                        }));
                    }
                });
                for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                    if (childIdBeingListened === ws.clientId) {
                        parentListeningSockets.delete(childIdBeingListened);
                    }
                }
            } else if (ws.clientType === 'parent') {
                for (const [childIdBeingListened, parentWsListening] of parentListeningSockets.entries()) {
                    if (parentWsListening.parentId === ws.clientId) {
                        parentListeningSockets.delete(childIdBeingListened);
                        let anotherParentStillListening = false;
                        for (const [cId, pWs] of parentListeningSockets.entries()) {
                            if (cId === childIdBeingListened && pWs.readyState === WebSocket.OPEN) {
                                anotherParentStillListening = true;
                                break;
                            }
                        }
                        if (!anotherParentStillListening) {
                            const childWsCommands = activeChildWebSockets.get(childIdBeingListened);
                            if (childWsCommands && childWsCommands.readyState === WebSocket.OPEN) {
                                childWsCommands.send(JSON.stringify({ type: 'stop_audio_stream' }));
                            }
                        }
                    }
                }
            }
        }
    });
});


// Middleware de tratamento de erros gerais
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
    console.log(`Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'Configurado' : 'Não Configurado'}`);
    console.log(`Twilio Auth Token: ${TWILIO_AUTH_TOKEN ? 'Configurado' : 'Não Configurado'}`);
    console.log(`Twilio Phone Number: ${TWILIO_PHONE_NUMBER || 'Não Configurado'}`);
    console.log(`Servidor WebSocket de ÁUDIO (original) configurado para escutar na rota: /audio-stream`);
    console.log(`Servidor WebSocket de COMANDOS (novo) configurado para escutar na rota: /ws-commands`);
});