const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio'); // Se Twilio for usado, mantenha. Caso contrário, pode remover.
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
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations'; // Sua tabela de conversas
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Sua tabela de localização
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

// --- Variável para controle de WebSockets ---
// Usaremos wsClientsMap para todos os clientes conectados, identificando-os como filhos ou pais.
// Chave: childId ou parentId -> Valor: Objeto contendo o WebSocket e sua rota (audio/commands)
const wsClientsMap = new Map(); // Mapa para armazenar clientes WebSocket (key: childId/parentId, value: {ws: WebSocket, type: 'child'/'parent', route: '/audio-stream'/'/ws-commands'})

// --- TWILIO CONFIG (Mantenha se estiver usando, senão remova) ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
// const clientTwilio = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); // Descomente se for usar Twilio

// --- Middlewares ---
app.use(bodyParser.json()); // Para JSON bodies
app.use(bodyParser.urlencoded({ extended: true })); // Para URL-encoded bodies
app.use(cors()); // Habilita CORS para todas as origens (ajuste em produção para origens específicas)

// --- Rotas HTTP ---

// Nova rota para o app filho se registrar e criar/atualizar uma conversa no DynamoDB
app.post('/register-child', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /register-child');
    const { childId, childName } = req.body;

    if (!childId || !childName) {
        console.warn('[HTTP_ERROR] Dados incompletos para registro de sessão do filho. childId ou childName ausente.');
        return res.status(400).json({ error: 'childId e childName são obrigatórios.' });
    }

    try {
        // Verificar se já existe uma conversa para este childId
        const existingConversation = await docClient.query({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            IndexName: 'childId-index', // Certifique-se de ter um GSI chamado 'childId-index' com childId como PK
            KeyConditionExpression: 'childId = :id',
            ExpressionAttributeValues: {
                ':id': childId
            }
        }).promise();

        let conversationId;
        const timestamp = new Date().toISOString();

        if (existingConversation.Items && existingConversation.Items.length > 0) {
            // Se já existe, usa o conversationId existente e atualiza a última atividade
            const latestConversation = existingConversation.Items[0]; // Pega a primeira, ou a mais recente se ordenado
            conversationId = latestConversation.conversationId;
            console.log(`[DYNAMODB] Conversa existente encontrada para ${childId}. Atualizando lastActivity.`);

            const updateParams = {
                TableName: DYNAMODB_TABLE_CONVERSATIONS,
                Key: {
                    conversationId: conversationId,
                    // Se sua chave primária for composta (conversationId, childId), adicione childId aqui
                    // Ex: conversationId: conversationId, childId: childId
                },
                UpdateExpression: 'SET childName = :cn, lastActivity = :la',
                ExpressionAttributeValues: {
                    ':cn': childName,
                    ':la': timestamp
                },
                ReturnValues: 'UPDATED_NEW'
            };
            await docClient.update(updateParams).promise();

        } else {
            // Se não existe, cria uma nova conversa
            conversationId = uuidv4(); // Gera um novo ID para a conversa
            console.log(`[DYNAMODB] Criando nova conversa para ${childId} com conversationId: ${conversationId}`);

            const newConversationItem = {
                conversationId: conversationId,
                childId: childId,
                childName: childName,
                createdAt: timestamp,
                lastActivity: timestamp,
                // parentId: parentId, // Removido conforme sua solicitação
            };

            const params = {
                TableName: DYNAMODB_TABLE_CONVERSATIONS,
                Item: newConversationItem
            };
            await docClient.put(params).promise();
        }

        res.status(200).json({ message: 'Sessão registrada/atualizada com sucesso!', conversationId: conversationId, childId: childId });
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao registrar/atualizar sessão do filho no DynamoDB:', error);
        // Adiciona detalhes do erro para depuração
        res.status(500).json({ error: 'Erro ao registrar sessão.', details: error.message });
    }
});


// Rota para upload de áudio do filho
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /upload-audio');
    const { childId, conversationId, timestamp } = req.body;
    const audioFile = req.file;

    if (!audioFile || !childId || !conversationId || !timestamp) {
        console.warn('[HTTP_ERROR] Dados incompletos para upload de áudio.');
        return res.status(400).send('Arquivo de áudio, childId, conversationId e timestamp são obrigatórios.');
    }

    const s3Key = `audio/${childId}/${conversationId}/${timestamp}.mp3`; // Caminho no S3

    const s3Params = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Body: audioFile.buffer,
        ContentType: audioFile.mimetype,
        ACL: 'private' // Mantenha privado para maior segurança
    };

    try {
        await s3.upload(s3Params).promise();
        console.log(`[S3] Áudio ${s3Key} enviado para S3 com sucesso.`);

        const messageItem = {
            messageId: uuidv4(), // ID único para a mensagem
            conversationId: conversationId,
            sender: childId,
            type: 'audio',
            timestamp: timestamp,
            s3Key: s3Key,
            read: false
        };

        const dynamoDbParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: messageItem
        };

        await docClient.put(dynamoDbParams).promise();
        console.log(`[DYNAMODB] Detalhes do áudio salvos no DynamoDB para conversationId: ${conversationId}.`);

        // Notificar o app pai (se conectado via WebSocket) sobre o novo áudio
        const messageToParents = JSON.stringify({
            type: 'new_audio_message',
            childId: childId,
            conversationId: conversationId,
            s3Key: s3Key,
            timestamp: timestamp
        });

        // Itera sobre wsClientsMap para encontrar todos os pais conectados e enviar a notificação
        wsClientsMap.forEach(clientWsInfo => {
            if (clientWsInfo.type === 'parent' && clientWsInfo.ws.readyState === WebSocket.OPEN) {
                try {
                    clientWsInfo.ws.send(messageToParents);
                    console.log(`[WSS_COMMANDS] Notificação de novo áudio enviada para pai: ${clientWsInfo.id}.`);
                } catch (sendError) {
                    console.error(`[WSS_COMMANDS] Erro ao enviar notificação de áudio para pai ${clientWsInfo.id}:`, sendError);
                }
            }
        });


        res.status(200).send('Áudio recebido e salvo com sucesso.');
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao processar upload de áudio:', error);
        res.status(500).send('Erro ao processar upload de áudio. Detalhes: ' + error.message);
    }
});


// Rota para enviar mensagens de texto
app.post('/message', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /message');
    const { conversationId, sender, text, timestamp } = req.body;

    if (!conversationId || !sender || !text || !timestamp) {
        console.warn('[HTTP_ERROR] Dados incompletos para envio de mensagem de texto.');
        return res.status(400).send('conversationId, sender, text e timestamp são obrigatórios.');
    }

    const messageItem = {
        messageId: uuidv4(),
        conversationId: conversationId,
        sender: sender,
        type: 'text',
        content: text,
        timestamp: timestamp,
        read: false
    };

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: messageItem
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Mensagem de texto salva no DynamoDB para conversationId: ${conversationId}.`);

        // Notificar o outro lado da conversa via WebSocket (se aplicável)
        const messageToClient = JSON.stringify({
            type: 'new_message',
            conversationId: conversationId,
            sender: sender,
            content: text,
            timestamp: timestamp
        });

        // Enviar para o filho se o pai mandou, ou para o pai se o filho mandou
        const recipientId = wsClientsMap.get(sender)?.type === 'child' ? wsClientsMap.get(sender)?.parentId : sender; // Lógica para encontrar o destinatário
        
        wsClientsMap.forEach(clientWsInfo => {
            // Se o sender for o filho, notifica os pais. Se o sender for o pai, notifica o filho.
            if (clientWsInfo.ws.readyState === WebSocket.OPEN) {
                 if (clientWsInfo.id === sender && clientWsInfo.type === 'parent') { // Se o pai enviou, notifica o filho
                    const childWs = Array.from(wsClientsMap.values()).find(c => c.childId === clientWsInfo.childId && c.type === 'child');
                    if (childWs) {
                        childWs.ws.send(messageToClient);
                        console.log(`[WSS_COMMANDS] Mensagem enviada para filho ${childWs.childId} via WebSocket.`);
                    }
                } else if (clientWsInfo.id === sender && clientWsInfo.type === 'child') { // Se o filho enviou, notifica os pais
                    const parentWs = Array.from(wsClientsMap.values()).filter(c => c.type === 'parent');
                    parentWs.forEach(parent => {
                        parent.ws.send(messageToClient);
                        console.log(`[WSS_COMMANDS] Mensagem enviada para pai ${parent.id} via WebSocket.`);
                    });
                }
            }
        });

        res.status(200).send('Mensagem recebida e salva com sucesso.');
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao salvar mensagem de texto no DynamoDB:', error);
        res.status(500).send('Erro ao salvar mensagem de texto. Detalhes: ' + error.message);
    }
});

// Rota para receber atualizações de localização
app.post('/location', async (req, res) => {
    console.log('[HTTP_REQUEST] Requisição recebida: POST /location');
    const { childId, latitude, longitude, timestamp } = req.body;

    if (!childId || !latitude || !longitude || !timestamp) {
        console.warn('[HTTP_ERROR] Dados incompletos para atualização de localização. childId, latitude, longitude ou timestamp ausente.');
        return res.status(400).send('childId, latitude, longitude e timestamp são obrigatórios.');
    }

    try {
        const locationData = {
            childId: childId,
            timestamp: timestamp, // Usar o timestamp do cliente para consistência
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude)
        };

        const params = {
            TableName: DYNAMODB_TABLE_LOCATIONS,
            Item: locationData
        };

        await docClient.put(params).promise();
        console.log(`[DYNAMODB] Localização do filho ${childId} salva no DynamoDB com sucesso.`);

        // Notificar clientes WebSocket (pais) sobre a nova localização
        const messageToParents = JSON.stringify({
            type: 'location_update',
            childId: childId,
            latitude: latitude,
            longitude: longitude,
            timestamp: timestamp
        });

        wsClientsMap.forEach(clientWsInfo => {
            // Notificar apenas pais (que podem estar esperando no /ws-commands)
            if (clientWsInfo.type === 'parent' && clientWsInfo.ws.readyState === WebSocket.OPEN) {
                try {
                    clientWsInfo.ws.send(messageToParents);
                    console.log(`[WSS_COMMANDS] Notificação de localização enviada para pai ${clientWsInfo.id}.`);
                } catch (sendError) {
                    console.error(`[WSS_COMMANDS] Erro ao enviar notificação de localização para pai ${clientWsInfo.id}:`, sendError);
                }
            }
        });

        res.status(200).send('Localização recebida e salva com sucesso.');
    } catch (error) {
        console.error('[SERVER_ERROR] Erro ao salvar localização no DynamoDB:', error);
        // Loga o erro completo para depuração
        res.status(500).send(`Erro ao processar localização. Detalhes: ${error.message}`);
    }
});


// --- Configuração do Servidor HTTP e WebSockets ---
const server = http.createServer(app);

// WebSocket Server para streaming de áudio
const wssAudio = new WebSocket.Server({ noServer: true });

wssAudio.on('connection', ws => {
    console.log('[WSS_AUDIO_CONNECT] Novo cliente WebSocket (audio-stream) conectado.');

    ws.on('message', message => {
        // A primeira mensagem deve ser para identificação
        if (typeof message === 'string' && message.startsWith('CHILD_ID:')) {
            const childId = message.split(':')[1];
            ws.id = childId; // Adiciona ID ao WebSocket para fácil referência
            ws.type = 'child';
            ws.route = '/audio-stream';
            wsClientsMap.set(childId, { ws: ws, id: childId, type: 'child', route: '/audio-stream' });
            console.log(`[WSS_AUDIO_MSG] Filho conectado e ID "${childId}" registrado no wsClientsMap (audio-stream).`);

            // Notificar pais sobre novo filho online (opcional)
            const notification = JSON.stringify({
                type: 'child_online',
                childId: childId,
                timestamp: new Date().toISOString()
            });
            wsClientsMap.forEach(clientWsInfo => {
                if (clientWsInfo.type === 'parent' && clientWsInfo.ws.readyState === WebSocket.OPEN) {
                    clientWsInfo.ws.send(notification);
                    console.log(`[WSS_COMMANDS] Notificação de filho online enviada para pai: ${clientWsInfo.id}.`);
                }
            });

        } else if (ws.id && typeof message !== 'string') { // Mensagens de áudio devem ser binárias
            // Se o cliente já está identificado, trata como streaming de áudio
            const childId = ws.id;
            // console.log(`[WSS_AUDIO_MSG] Recebendo áudio do filho ${childId}. Tamanho: ${message.length} bytes.`);

            // Encaminha o áudio para todos os clientes pais que estão conectados e esperando áudio
            wsClientsMap.forEach(clientWsInfo => {
                if (clientWsInfo.type === 'parent' && clientWsInfo.ws.readyState === WebSocket.OPEN) {
                    // Aqui você pode adicionar lógica para enviar áudio apenas para pais que 'solicitaram' este childId
                    // Por enquanto, enviará para todos os pais conectados na rota de comandos
                    // Se você tiver uma rota de áudio específica para pais, precisaria de outro mapa/lógica.
                    // Para simplificar, vou enviar para todos os pais conectados na rota de comandos que tenham uma flag 'isListeningAudio'
                    if (clientWsInfo.isListeningAudio === childId) { // Exemplo de lógica de filtragem
                         try {
                            clientWsInfo.ws.send(message); // Reencaminha o buffer de áudio
                        } catch (sendError) {
                            console.error(`[WSS_COMMANDS] Erro ao reencaminhar áudio para pai ${clientWsInfo.id}:`, sendError);
                        }
                    }
                }
            });

        } else {
            console.warn('[WSS_AUDIO_MSG] Mensagem inesperada no WebSocket de áudio:', message);
            ws.close(1003, 'Mensagem inicial inválida ou formato inesperado.'); // Código 1003: Unsupported Data
        }
    });

    ws.on('close', (code, reason) => {
        if (ws.id) {
            wsClientsMap.delete(ws.id);
            console.log(`[WSS_AUDIO_DISCONNECT] Cliente WebSocket (audio-stream) desconectado: ${ws.id}. Código: ${code}, Razão: ${reason}`);
            // Notificar pais que o filho ficou offline
            const notification = JSON.stringify({
                type: 'child_offline',
                childId: ws.id,
                timestamp: new Date().toISOString()
            });
            wsClientsMap.forEach(clientWsInfo => {
                if (clientWsInfo.type === 'parent' && clientWsInfo.ws.readyState === WebSocket.OPEN) {
                    clientWsInfo.ws.send(notification);
                    console.log(`[WSS_COMMANDS] Notificação de filho offline enviada para pai: ${clientWsInfo.id}.`);
                }
            });
        } else {
            console.log(`[WSS_AUDIO_DISCONNECT] Cliente WebSocket (audio-stream) desconectado antes da identificação. Código: ${code}, Razão: ${reason}`);
        }
    });

    ws.on('error', error => {
        console.error('[WSS_AUDIO_ERROR] Erro no WebSocket de áudio:', error);
    });
});

// WebSocket Server para comandos e status
const wssCommands = new WebSocket.Server({ noServer: true });

wssCommands.on('connection', ws => {
    console.log('[WSS_COMMANDS_CONNECT] Novo cliente WebSocket (ws-commands) conectado.');

    ws.on('message', message => {
        let msgParsed;
        try {
            msgParsed = JSON.parse(message); // Espera-se JSON para comandos
        } catch (e) {
            console.warn('[WSS_COMMANDS_MSG] Mensagem não JSON ou inválida recebida:', message.toString());
            ws.close(1003, 'Mensagem não JSON ou inválida.');
            return;
        }

        // Primeira mensagem deve ser para identificação
        if (msgParsed.type === 'CHILD_ID' && msgParsed.id) {
            const childId = msgParsed.id;
            ws.id = childId; // Adiciona ID ao WebSocket para fácil referência
            ws.type = 'child';
            ws.route = '/ws-commands';
            wsClientsMap.set(childId, { ws: ws, id: childId, type: 'child', route: '/ws-commands' });
            console.log(`[WSS_COMMANDS_MSG] Filho conectado (ws-commands) e ID "${childId}" registrado no wsClientsMap.`);

            // Notificar pais sobre novo filho online (se ainda não notificado pelo áudio WS)
            // Lógica para evitar duplicidade de notificação pode ser adicionada aqui
            const notification = JSON.stringify({
                type: 'child_online',
                childId: childId,
                timestamp: new Date().toISOString()
            });
            wsClientsMap.forEach(clientWsInfo => {
                if (clientWsInfo.type === 'parent' && clientWsInfo.ws.readyState === WebSocket.OPEN) {
                    clientWsInfo.ws.send(notification);
                    console.log(`[WSS_COMMANDS] Notificação de filho online enviada para pai: ${clientWsInfo.id}.`);
                }
            });

        } else if (msgParsed.type === 'PARENT_ID' && msgParsed.id) {
            const parentId = msgParsed.id;
            ws.id = parentId; // Adiciona ID ao WebSocket para fácil referência
            ws.type = 'parent';
            ws.route = '/ws-commands';
            wsClientsMap.set(parentId, { ws: ws, id: parentId, type: 'parent', route: '/ws-commands' });
            console.log(`[WSS_COMMANDS_MSG] Pai conectado (ws-commands) com ID: ${parentId}.`);

            // Ao conectar, um pai pode querer a lista de filhos online
            const onlineChildren = Array.from(wsClientsMap.values())
                                        .filter(client => client.type === 'child')
                                        .map(client => ({ childId: client.id }));

            if (onlineChildren.length > 0) {
                ws.send(JSON.stringify({
                    type: 'CHILD_IDS_ONLINE_LIST',
                    children: onlineChildren
                }));
                console.log(`[WSS_COMMANDS] Lista de filhos online enviada para o pai ${parentId}.`);
            } else {
                ws.send(JSON.stringify({
                    type: 'CHILD_IDS_ONLINE_LIST',
                    children: []
                }));
                 console.log(`[WSS_COMMANDS] Nenhum filho online para o pai ${parentId}.`);
            }
        }
        // Comandos do pai para o filho
        else if (ws.type === 'parent' && msgParsed.type === 'command' && msgParsed.targetChildId && msgParsed.command) {
            const targetChildId = msgParsed.targetChildId;
            const command = msgParsed.command; // Ex: 'START_AUDIO', 'STOP_AUDIO', 'GET_LOCATION'

            const childWsInfo = wsClientsMap.get(targetChildId);
            if (childWsInfo && childWsInfo.ws.readyState === WebSocket.OPEN) {
                childWsInfo.ws.send(JSON.stringify({ type: 'command', command: command }));
                console.log(`[WSS_COMMANDS] Comando "${command}" enviado para o filho ${targetChildId} pelo pai ${ws.id}.`);

                // Lógica para controle de escuta de áudio (se o comando for START_AUDIO)
                if (command === 'START_AUDIO') {
                    ws.isListeningAudio = targetChildId; // Marca que este pai está ouvindo o áudio deste filho
                    console.log(`[WSS_COMMANDS] Pai ${ws.id} agora está ouvindo áudio do filho ${targetChildId}.`);
                } else if (command === 'STOP_AUDIO') {
                    ws.isListeningAudio = null; // Para de ouvir
                    console.log(`[WSS_COMMANDS] Pai ${ws.id} parou de ouvir áudio.`);
                }

            } else {
                console.warn(`[WSS_COMMANDS] Filho ${targetChildId} não encontrado ou não conectado para receber comando "${command}".`);
                ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildId} offline ou não encontrado.` }));
            }
        }
        // Respostas do filho para o pai (se necessário)
        else if (ws.type === 'child' && msgParsed.type === 'response' && msgParsed.originalCommand) {
            const parentId = msgParsed.targetParentId; // O filho envia para qual pai responder
            const response = msgParsed.response;
            const originalCommand = msgParsed.originalCommand;

            const parentWsInfo = wsClientsMap.get(parentId);
            if (parentWsInfo && parentWsInfo.ws.readyState === WebSocket.OPEN) {
                parentWsInfo.ws.send(JSON.stringify({
                    type: 'child_response',
                    childId: ws.id,
                    originalCommand: originalCommand,
                    response: response
                }));
                console.log(`[WSS_COMMANDS] Resposta do filho ${ws.id} para o pai ${parentId} sobre comando "${originalCommand}".`);
            } else {
                console.warn(`[WSS_COMMANDS] Pai ${parentId} não encontrado ou não conectado para receber resposta do filho ${ws.id}.`);
            }
        }
        else {
            console.warn('[WSS_COMMANDS_MSG] Mensagem não identificada no WebSocket de comandos:', msgParsed);
            ws.close(1003, 'Mensagem não identificada.');
        }
    });

    ws.on('close', (code, reason) => {
        if (ws.id) {
            wsClientsMap.delete(ws.id);
            console.log(`[WSS_COMMANDS_DISCONNECT] Cliente WebSocket (ws-commands) desconectado: ${ws.id}. Código: ${code}, Razão: ${reason}`);

            // Se for um filho que desconectou, notificar os pais
            if (ws.type === 'child') {
                const notification = JSON.stringify({
                    type: 'child_offline',
                    childId: ws.id,
                    timestamp: new Date().toISOString()
                });
                wsClientsMap.forEach(clientWsInfo => {
                    if (clientWsInfo.type === 'parent' && clientWsInfo.ws.readyState === WebSocket.OPEN) {
                        clientWsInfo.ws.send(notification);
                        console.log(`[WSS_COMMANDS] Notificação de filho offline enviada para pai: ${clientWsInfo.id}.`);
                    }
                });
            }
        } else {
            console.log(`[WSS_COMMANDS_DISCONNECT] Cliente WebSocket (ws-commands) desconectado antes da identificação. Código: ${code}, Razão: ${reason}`);
        }
    });

    ws.on('error', error => {
        console.error('[WSS_COMMANDS_ERROR] Erro no WebSocket de comandos:', error);
    });
});

// Manipula as requisições de upgrade para WebSocket
server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    console.log(`[SERVER] Requisição de upgrade para: ${pathname}`);

    if (pathname === '/audio-stream') {
        wssAudio.handleUpgrade(request, socket, head, ws => {
            wssAudio.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-commands') {
        wssCommands.handleUpgrade(request, socket, head, ws => {
            wssCommands.emit('connection', ws, request);
        });
    } else {
        socket.destroy(); // Destrói a conexão se a rota não for reconhecida
        console.warn(`[SERVER] Tentativa de upgrade para rota desconhecida: ${pathname}`);
    }
});

// --- ERROS ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor. Detalhes: ' + err.message);
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
    console.log('Servidor iniciado com sucesso!');
});