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
const PORT = process.env.PORT || 10000; // Define uma porta padrão se não estiver nas variáveis de ambiente

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' // Região padrão
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_CHILDREN = 'Children';
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER; // Seu número Twilio

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// --- EXPRESS MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- MULTER CONFIG FOR UPLOADS ---
const upload = multer({ storage: multer.memoryStorage() }); // Armazena o arquivo em memória para upload S3

// --- WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Mapas para gerenciar conexões WebSocket
// activeChildWebSockets: { childId: WebSocket }
const activeChildWebSockets = new Map();
// parentListeningSockets: { childId: WebSocket (do pai que está ouvindo) }
const parentListeningSockets = new Map();
// parentControlSockets: { parentId: WebSocket } - Para comandos gerais do pai (não streaming)
const parentControlSockets = new Map();


// Função auxiliar para encontrar WebSocket de um filho
function findChildWebSocket(childId) {
    const ws = activeChildWebSockets.get(childId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`[WS_FIND] WebSocket ENCONTRADO e ABERTO para childId: ${childId}`);
        return ws;
    } else {
        console.warn(`[WS_FIND] WebSocket NÃO ENCONTRADO ou FECHADO para childId: ${childId}. readyState: ${ws ? ws.readyState : 'N/A'}`);
        if (ws) {
            // Remove a conexão se estiver fechada ou em estado inválido
            activeChildWebSockets.delete(childId);
            console.log(`[WS_FIND] Conexão inválida para ${childId} removida do mapa.`);
        }
        return null;
    }
}

// Função auxiliar para enviar comandos de áudio (reusável)
function sendAudioStreamingCommand(targetChildId, commandType, parentId = 'N/A') {
    const childWs = findChildWebSocket(targetChildId);
    if (childWs) {
        try {
            childWs.send(JSON.stringify({ type: commandType }));
            console.log(`[HTTP_CMD] Comando '${commandType}' enviado via WebSocket para o filho: ${targetChildId} (Iniciado pelo pai: ${parentId})`);
        } catch (error) {
            console.error(`[HTTP_CMD] Erro ao enviar comando WebSocket para ${targetChildId}: ${error.message}`);
        }
    } else {
        console.error(`[HTTP_CMD] ERRO: Nenhuma conexão WebSocket ativa encontrada para o filho: ${targetChildId}. O comando ${commandType} NÃO PODE ser enviado.`);
    }
}

wss.on('connection', ws => {
    ws.id = uuidv4(); // Adiciona um ID único para cada conexão
    console.log(`[WS_CONNECT] Novo cliente WebSocket conectado. ID da conexão: ${ws.id}. Total de conexões ativas: ${wss.clients.size}`);

    ws.isParent = false;
    ws.clientId = null; // Para filhos
    ws.parentId = null; // Para pais
    ws.listeningToChild = null; // Para pais, qual filho está ouvindo

    ws.on('message', message => {
        const messageOrigin = ws.clientId ? `Filho ${ws.clientId} (Conexão ${ws.id})` : (ws.parentId ? `Pai ${ws.parentId} (Conexão ${ws.id})` : `Conexão ${ws.id}`);

        // Tenta processar como string primeiro
        if (typeof message === 'string') {
            const messageString = message.toString();
            const displayMessage = messageString.length > 100 ? messageString.substring(0, 100) + '...' : messageString;
            console.log(`[WS_MSG] [${messageOrigin}] Mensagem WebSocket de TEXTO recebida: "${displayMessage}"`);

            if (messageString.startsWith('CHILD_ID:')) {
                ws.clientId = messageString.substring('CHILD_ID:'.length);
                ws.isParent = false; // Confirma que é um cliente filho
                activeChildWebSockets.set(ws.clientId, ws);
                console.log(`[WS_MSG] [Conexão ${ws.id}] Filho conectado e ID "${ws.clientId}" registrado. Mapa activeChildWebSockets após adição: [${Array.from(activeChildWebSockets.keys()).join(', ')}]`);

                // Verifica se há um pai esperando para ouvir este filho recém-conectado
                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} se conectou. Pai (ID: ${parentWs.parentId || 'desconhecido'}) já está ouvindo. Enviando START_AUDIO.`);
                    ws.send(JSON.stringify({ type: 'START_AUDIO_STREAMING' })); // Envia o comando correto
                } else {
                    console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${ws.clientId} conectado, mas nenhum pai está ouvindo ativamente neste momento.`);
                }
            } else if (messageString.startsWith('PARENT_ID:')) {
                ws.isParent = true; // Confirma que é um cliente pai
                ws.parentId = messageString.substring('PARENT_ID:'.length);
                parentControlSockets.set(ws.parentId, ws); // Adiciona ao mapa de controle de pais
                console.log(`[WS_MSG] [Conexão ${ws.id}] Pai conectado com ID: ${ws.parentId}. Total de pais ativos: ${parentControlSockets.size}`);
                ws.send(JSON.stringify({ type: 'STATUS', message: `Registrado como pai ${ws.parentId}.` }));
            }
            // Comandos JSON de pais para o servidor (se necessário)
            else if (ws.isParent) {
                try {
                    const parsedMessage = JSON.parse(messageString);
                    if (parsedMessage.type === "GET_CHILD_STATUS") {
                        const childId = parsedMessage.childId;
                        const childStatus = activeChildWebSockets.has(childId) && findChildWebSocket(childId) !== null ? "online" : "offline";
                        ws.send(JSON.stringify({ type: "CHILD_STATUS", childId: childId, status: childStatus }));
                        console.log(`[WS_CMD] Status do filho ${childId} (${childStatus}) enviado para o pai ${ws.parentId}.`);
                    } else if (parsedMessage.type === "LIST_CHILDREN") {
                        const childrenIds = Array.from(activeChildWebSockets.keys());
                        ws.send(JSON.stringify({ type: "CHILDREN_LIST", children: childrenIds }));
                        console.log(`[WS_CMD] Lista de filhos (${childrenIds.length}) enviada para o pai ${ws.parentId}.`);
                    } else {
                        console.warn(`[WS_MSG] [${messageOrigin}] Comando JSON de pai desconhecido ou inesperado: ${displayMessage}`);
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando JSON desconhecido.' }));
                    }
                } catch (e) {
                    console.warn(`[WS_MSG] [${messageOrigin}] Mensagem de texto de pai não JSON ou inesperada: ${displayMessage}`);
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem de texto inesperada.' }));
                }
            } else {
                console.warn(`[WS_MSG] [${messageOrigin}] Mensagem de texto desconhecida ou inesperada: ${displayMessage}`);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem de texto desconhecida.' }));
            }
        }
        // MODIFICAÇÃO CHAVE AQUI: Trata mensagens binárias
        else if (message instanceof Buffer || message instanceof ArrayBuffer) {
            const bufferMessage = Buffer.from(message);
            const messageLength = bufferMessage.length;

            try {
                // Tenta decodificar mensagens binárias curtas como UTF-8 para ver se é um comando de texto
                // Isso cobre o cenário do Kodular enviando strings como binário
                const potentialCommand = bufferMessage.toString('utf8');
                const displayPotentialCommand = potentialCommand.length > 100 ? potentialCommand.substring(0, 100) + '...' : potentialCommand;
                console.log(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida. Tamanho: ${messageLength} bytes. Tentando decodificar como UTF-8: "${displayPotentialCommand}"`);

                if (potentialCommand.startsWith('LISTEN_TO_CHILD:')) { // <--- AGORA TRATADO AQUI
                    if (ws.isParent) {
                        const targetChildId = potentialCommand.substring('LISTEN_TO_CHILD:'.length);
                        parentListeningSockets.set(targetChildId, ws); // Associa o pai ao filho que ele quer ouvir
                        ws.listeningToChild = targetChildId; // Marca qual filho este pai está ouvindo
                        console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) está agora ouvindo o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                        // Se o filho já estiver conectado, manda iniciar o áudio
                        const childWs = findChildWebSocket(targetChildId);
                        if (childWs) {
                            childWs.send(JSON.stringify({ type: 'START_AUDIO_STREAMING' }));
                            console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal START_AUDIO_STREAMING enviado para o filho ${targetChildId} via WebSocket (pedido de escuta do pai).`);
                        } else {
                            console.log(`[WS_MSG] [Conexão ${ws.id}] Filho ${targetChildId} não encontrado no mapa activeChildWebSockets, mas pai (ID: ${ws.parentId || 'desconhecido'}) está esperando.`);
                        }
                        ws.send(JSON.stringify({ type: 'STATUS', message: `Você está ouvindo ${targetChildId}` }));
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de escuta apenas para pais.' }));
                        console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando LISTEN_TO_CHILD de um cliente não-pai. Mensagem: ${potentialCommand}`);
                    }
                } else if (potentialCommand.startsWith('STOP_LISTENING_TO_CHILD:')) { // <--- AGORA TRATADO AQUI
                    if (ws.isParent) {
                        const targetChildId = potentialCommand.substring('STOP_LISTENING_TO_CHILD:'.length);
                        if (parentListeningSockets.has(targetChildId) && parentListeningSockets.get(targetChildId) === ws) {
                            parentListeningSockets.delete(targetChildId);
                            ws.listeningToChild = null; // Limpa o filho que este pai estava ouvindo
                            console.log(`[WS_MSG] [Conexão ${ws.id}] Pai (ID: ${ws.parentId || 'desconhecido'}) parou de ouvir o filho: ${targetChildId}. Mapa parentListeningSockets: [${Array.from(parentListeningSockets.keys()).join(', ')}]`);

                            // Verifica se nenhum outro pai está ouvindo este filho para parar o áudio no filho
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
                                    childWs.send(JSON.stringify({ type: 'STOP_AUDIO_STREAMING' }));
                                    console.log(`[WS_MSG] [Conexão ${ws.id}] Sinal STOP_AUDIO_STREAMING enviado para o filho ${targetChildId} (nenhum pai mais ouvindo).`);
                                }
                            }
                            ws.send(JSON.stringify({ type: 'STATUS', message: `Você parou de ouvir ${targetChildId}` }));
                        } else {
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Você não estava ouvindo este filho ou a conexão está inválida.' }));
                            console.warn(`[WS_MSG] [Conexão ${ws.id}] Pai tentou parar de ouvir ${targetChildId} mas não estava registrado como ouvinte ou a conexão é diferente.`);
                        }
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Comando de parada de escuta apenas para pais.' }));
                        console.warn(`[WS_MSG] [Conexão ${ws.id}] Tentativa de comando STOP_LISTENING_TO_CHILD de um cliente não-pai. Mensagem: ${potentialCommand}`);
                    }
                }
                // Se não for um comando de texto reconhecido, e for um cliente filho, assume que é áudio
                else if (ws.clientId && !ws.isParent) {
                    const parentWs = parentListeningSockets.get(ws.clientId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(bufferMessage); // Retransmite o Buffer original (áudio)
                    } else {
                        // Opcional: logar se o áudio estiver sendo descartado
                        // console.log(`[WS_MSG] [${messageOrigin}] Pai não está ouvindo o filho ${ws.clientId}, descartando ${messageLength} bytes de áudio.`);
                    }
                } else {
                    console.warn(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida inesperada (não pôde ser decodificada como comando UTF-8 e não é áudio esperado). Tamanho: ${messageLength} bytes.`);
                }
            } catch (e) {
                console.error(`[WS_MSG] [${messageOrigin}] Erro ao decodificar mensagem binária ou processar: ${e.message}`, e);
                console.warn(`[WS_MSG] [${messageOrigin}] Mensagem binária recebida inesperada (não pôde ser decodificada como UTF-8 ou não é um comando/áudio): ${messageLength} bytes.`);
            }
        } else {
            console.warn(`[WS_MSG] [${messageOrigin}] Tipo de mensagem WebSocket desconhecido: ${typeof message}.`);
        }
    });

    ws.on('close', (code, reason) => {
        if (ws.clientId) {
            activeChildWebSockets.delete(ws.clientId);
            console.log(`[WS_DEREGISTER] Filho desconectado e removido: ${ws.clientId} (ID Conexão: ${ws.id}). Code: ${code}, Reason: ${reason}. Total de filhos ativos: ${activeChildWebSockets.size}`);

            // Se o pai estava ouvindo este filho, ele para de ouvir e pode ser notificado
            // Isso pode ser aprimorado para notificar o pai que o filho se desconectou
            if (parentListeningSockets.has(ws.clientId)) {
                const parentWs = parentListeningSockets.get(ws.clientId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    // Remover o pai da lista de escuta do filho desconectado, se ele estava ouvindo ESSE filho
                    if (parentWs.listeningToChild === ws.clientId) {
                        parentListeningSockets.delete(ws.clientId); // Remove a entrada do mapa para este filho
                        parentWs.listeningToChild = null; // Limpa o estado no pai
                        parentWs.send(JSON.stringify({ type: 'CHILD_DISCONNECTED', childId: ws.clientId, message: `Filho ${ws.clientId} desconectou.` }));
                        console.log(`[WS_DEREGISTER] Pai (ID: ${parentWs.parentId || 'desconhecido'}) notificado sobre a desconexão do filho ${ws.clientId}.`);
                    }
                }
            }
        } else if (ws.parentId) {
            parentControlSockets.delete(ws.parentId); // Remove do mapa de controle de pais
            console.log(`[WS_DEREGISTER] Pai desconectado e removido: ${ws.parentId} (ID Conexão: ${ws.id}). Code: ${code}, Reason: ${reason}. Total de pais ativos: ${parentControlSockets.size}`);
            // Se este pai estava ouvindo um filho, ele deve ser removido da lista de escuta também
            if (ws.listeningToChild) {
                if (parentListeningSockets.has(ws.listeningToChild) && parentListeningSockets.get(ws.listeningToChild) === ws) {
                    parentListeningSockets.delete(ws.listeningToChild);
                    console.log(`[WS_DEREGISTER] Pai ${ws.parentId} (que estava ouvindo ${ws.listeningToChild}) desconectou. Parando streaming de áudio para ${ws.listeningToChild}.`);
                    // Verifica se ainda há pais ouvindo este filho para não parar o áudio se outros estiverem ouvindo
                    let anotherParentListening = false;
                    for (const [childIdInMap, parentWsInMap] of parentListeningSockets.entries()) {
                        if (childIdInMap === ws.listeningToChild && parentWsInMap.readyState === WebSocket.OPEN) {
                            anotherParentListening = true;
                            break;
                        }
                    }
                    if (!anotherParentListening) {
                        sendAudioStreamingCommand(ws.listeningToChild, 'STOP_AUDIO_STREAMING', ws.parentId);
                    }
                }
            }
        } else {
            console.log(`[WS_DEREGISTER] Cliente WebSocket não identificado desconectado (ID Conexão: ${ws.id}). Code: ${code}, Reason: ${reason}. Total de conexões ativas: ${wss.clients.size}`);
        }
    });

    ws.on('error', error => {
        console.error(`[WS_ERROR] Erro no WebSocket (ID Conexão: ${ws.id}):`, error);
    });
});


// --- HTTP ROUTES ---

// Rota para iniciar monitoramento de microfone
app.post('/start-microphone', async (req, res) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: POST /start-microphone`);
    const { childId } = req.body;

    if (!childId) {
        return res.status(400).send('childId é obrigatório.');
    }
    console.log(`[HTTP_CMD] Recebida requisição POST /start-microphone para o filho: ${childId}`);

    // Nota: A lógica de LISTEN_TO_CHILD do pai já lida com o envio de START_AUDIO_STREAMING
    // Esta rota HTTP serve como um fallback ou para testes diretos, ou se o pai não usar WebSocket
    sendAudioStreamingCommand(childId, 'START_AUDIO_STREAMING', 'HTTP_Request');
    res.status(200).send(`Comando START_AUDIO_STREAMING enviado para ${childId}.`);
});

// Rota para parar monitoramento de microfone
app.post('/stop-microphone', async (req, res) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: POST /stop-microphone`);
    const { childId } = req.body;

    if (!childId) {
        return res.status(400).send('childId é obrigatório.');
    }
    console.log(`[HTTP_CMD] Recebida requisição POST /stop-microphone para o filho: ${childId}`);

    // Nota: A lógica de STOP_LISTENING_TO_CHILD do pai já lida com o envio de STOP_AUDIO_STREAMING
    sendAudioStreamingCommand(childId, 'STOP_AUDIO_STREAMING', 'HTTP_Request');
    res.status(200).send(`Comando STOP_AUDIO_STREAMING enviado para ${childId}.`);
});

// NOVO: Rota para obter os IDs dos filhos
app.get('/get-child-ids', async (req, res) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: GET /get-child-ids`);
    try {
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN
        };
        const data = await docClient.scan(params).promise();
        const childIds = data.Items.map(item => item.childId);

        // Adiciona filhos conectados via WebSocket que podem não estar no DynamoDB ainda
        const connectedChildIds = Array.from(activeChildWebSockets.keys());
        const combinedChildIds = Array.from(new Set([...childIds, ...connectedChildIds])); // Remove duplicatas

        console.log(`[HTTP_RESPONSE] Enviando ${combinedChildIds.length} IDs de filhos.`);
        res.status(200).json({ childIds: combinedChildIds });
    } catch (error) {
        console.error('[HTTP_ERROR] Erro ao obter child IDs do DynamoDB:', error);
        res.status(500).send('Erro ao obter child IDs.');
    }
});


// Rota para upload de mensagens (WhatsApp, etc.)
app.post('/messages', upload.single('media'), async (req, res) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: POST /messages`);
    const { childId, type, sender, content, timestamp, contactOrGroup } = req.body;
    const mediaFile = req.file; // Se houver um anexo

    if (!childId || !type || !sender || !content || !timestamp || !contactOrGroup) {
        return res.status(400).send('Dados da mensagem incompletos.');
    }

    let mediaUrl = null;
    if (mediaFile) {
        const uniqueFileName = `${Date.now()}-${mediaFile.originalname}`;
        const params = {
            Bucket: S3_BUCKET_NAME,
            Key: `media/${childId}/${uniqueFileName}`,
            Body: mediaFile.buffer,
            ContentType: mediaFile.mimetype,
            ACL: 'public-read' // Ou outra política de acesso que você preferir
        };

        try {
            const s3upload = await s3.upload(params).promise();
            mediaUrl = s3upload.Location;
            console.log(`[S3_UPLOAD] Mídia ${uniqueFileName} salva no S3: ${mediaUrl}`);
        } catch (s3Error) {
            console.error('[S3_UPLOAD] Erro ao fazer upload para S3:', s3Error);
            return res.status(500).send('Erro ao fazer upload da mídia.');
        }
    }

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            messageId: uuidv4(),
            childId,
            type,
            sender,
            content,
            timestamp: new Date(timestamp).toISOString(), // Garante formato ISO
            contactOrGroup,
            mediaUrl,
            createdAt: new Date().toISOString()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log('[DYNAMODB] Mensagem salva com sucesso no DynamoDB.');

        // Notificar pai via WebSocket se estiver conectado e ouvindo (para notificações gerais)
        // Isso assume que o pai tem uma conexão 'parentControlSockets' para receber notificações
        const parentWsList = Array.from(parentControlSockets.values());
        parentWsList.forEach(parentWs => {
            if (parentWs.readyState === WebSocket.OPEN) {
                parentWs.send(JSON.stringify({
                    type: 'NEW_MESSAGE_NOTIFICATION', // Tipo de notificação para o pai
                    data: {
                        childId, type, sender, content, timestamp, contactOrGroup, mediaUrl
                    }
                }));
                console.log(`[NOTIFICATIONS] Nova mensagem de ${childId} notificada para pai ${parentWs.parentId} via WebSocket.`);
            }
        });


        res.status(200).send('Mensagem recebida e salva.');
    } catch (dbError) {
        console.error('[DYNAMODB] Erro ao salvar mensagem no DynamoDB:', dbError);
        res.status(500).send('Erro ao salvar mensagem.');
    }
});

// Rota para salvar informações de notificação (para evitar duplicação ou para histórico)
app.post('/notifications', async (req, res) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: POST /notifications`);
    const { childId, contactOrGroup, messageContent, timestamp, type, appPackage } = req.body;

    if (!childId || !type || !contactOrGroup || !timestamp) {
        return res.status(400).send('Dados da notificação incompletos.');
    }

    const notificationId = uuidv4();
    const params = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS, // Tabela para gerenciar histórico de conversas/notificações
        Key: {
            childId: childId,
            contactOrGroup: contactOrGroup // Associa notificação a uma conversa específica
        },
        UpdateExpression: 'SET lastMessageContent = :lmc, lastTimestamp = :lt, #type = :t, appPackage = :ap, notificationCount = if_not_exists(notificationCount, :start) + :inc, updatedAt = :ua',
        ExpressionAttributeNames: {
            '#type': 'type' // 'type' é uma palavra reservada, precisa de alias
        },
        ExpressionAttributeValues: {
            ':lmc': messageContent || 'N/A',
            ':lt': new Date(timestamp).toISOString(),
            ':t': type,
            ':ap': appPackage || 'N/A',
            ':start': 0,
            ':inc': 1,
            ':ua': new Date().toISOString()
        }
    };

    try {
        console.log(`[NOTIFICATIONS] Tentando atualizar conversa no DynamoDB: ${JSON.stringify({ childId, contactOrGroup })}`);
        await docClient.update(params).promise();
        console.log('[NOTIFICATIONS] Conversa atualizada com sucesso no DynamoDB.');
        res.status(200).send('Notificação salva/atualizada.');
    } catch (dbError) {
        console.error('[NOTIFICATIONS] Erro ao salvar notificação no DynamoDB:', dbError);
        res.status(500).send('Erro ao salvar notificação.');
    }
});


// Rota para registrar o childId (pode ser usado como fallback ou para configurar inicialmente)
app.post('/register-child', async (req, res) => {
    console.log(`[HTTP_REQUEST] Requisição recebida: POST /register-child`);
    const { childId } = req.body;

    if (!childId) {
        return res.status(400).send('childId é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId,
            lastSeen: new Date().toISOString(),
            status: 'registered'
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Child ${childId} registrado/atualizado no DynamoDB.`);
        res.status(200).send(`Child ${childId} registrado com sucesso.`);
    } catch (dbError) {
        console.error('[DYNAMODB] Erro ao registrar child no DynamoDB:', dbError);
        res.status(500).send('Erro ao registrar child.');
    }
});


// Rotas de teste e saúde do servidor
app.get('/', (req, res) => {
    res.send('Servidor Parental Monitor está online e funcionando!');
});

app.get('/status', (req, res) => {
    const childConnections = Array.from(activeChildWebSockets.keys());
    const parentListeners = Array.from(parentListeningSockets.keys());
    const parentControls = Array.from(parentControlSockets.keys());

    res.json({
        status: 'Online',
        websocketClients: wss.clients.size,
        activeChildConnections: childConnections,
        parentListeningTo: parentListeners,
        parentControlConnections: parentControls
    });
});

// Tratamento de erros
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
    console.log(`Bucket S3 configurado via env: ${S3_BUCKET_NAME}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Twilio configurado: ${twilioClient ? 'Sim' : 'Não'}`);
});