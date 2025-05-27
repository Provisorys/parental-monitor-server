const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http'); // Importa o módulo HTTP
const WebSocket = require('ws'); // Importa o módulo WebSocket
const { v4: uuidv4 } = require('uuid'); // Para gerar UUIDs
const url = require('url'); // Adicione esta linha para usar url.parse

const app = express();
const PORT = process.env.PORT || 10000; // Define a porta, padrão 10000

const upload = multer(); // Instancia o multer uma vez

// --- AWS CONFIG ---
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' // Região padrão, pode ser sobrescrita pela variável de ambiente
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

// --- Constantes para Nomes de Tabelas DynamoDB ---
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao'; // Tabela para dados de localização
const DYNAMODB_TABLE_CHILDREN = 'Children'; // Nova tabela para registrar metadados dos filhos

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'; // Nome do bucket S3 para mídias

// --- Variáveis para Controle de WebSockets ---
// Mapas para os WebSockets de COMANDOS/GPS/MENSAGENS
const wsClientsMap = new Map(); // Chave: (childId ou parentId) -> Valor: WebSocket do cliente
const wssCommands = new WebSocket.Server({ noServer: true }); // WebSocket Server para comandos e GPS
const wssAudio = new WebSocket.Server({ noServer: true });    // WebSocket Server para streaming de áudio

// --- Middlewares ---
app.use(cors()); // Habilita CORS para todas as rotas
app.use(bodyParser.json()); // Habilita o parsing de JSON no corpo das requisições

// --- Rotas HTTP ---

// Rota de teste
app.get('/', (req, res) => {
    res.send('Servidor do Parental Monitor está ativo!');
});

// Rota para registrar uma nova criança/dispositivo
// Esta rota é chamada pelo aplicativo "filho"
app.post('/register-child', async (req, res) => {
    const { childName, parentId, childToken } = req.body; // childToken é para Firebase/FCM

    if (!childName) {
        return res.status(400).json({ error: 'Nome da Criança é obrigatório.' });
    }

    const childId = uuidv4(); // Gera um ID único para a criança

    const childrenTableParams = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId,
            childName: childName,
            parentId: parentId || 'not_set', // parentId pode ser 'not_set' inicialmente
            childToken: childToken || null, // Armazena o token para notificações push
            registrationDate: new Date().toISOString()
        }
    };

    const conversationTableParams = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        Item: {
            conversationId: childId, // Usamos o childId como ID da "conversa" inicial do filho
            childId: childId,
            childName: childName,
            // Inicialmente, não há mensagens, mas a entrada existe para ser listada pelo pai
            lastMessageTimestamp: null,
            lastMessageContent: null,
            // Adicione parentId aqui se a conversa for entre pai-filho específico
            parentId: parentId || null
        }
    };

    try {
        // Salva na tabela Children
        await docClient.put(childrenTableParams).promise();
        console.log(`[DynamoDB] Criança/Dispositivo registrado com sucesso na tabela '${DYNAMODB_TABLE_CHILDREN}': ${childName} (ID: ${childId})`);

        // Cria uma entrada inicial na tabela Conversations
        await docClient.put(conversationTableParams).promise();
        console.log(`[DynamoDB] Entrada inicial na tabela '${DYNAMODB_TABLE_CONVERSATIONS}' criada para ${childName} (ID: ${childId})`);

        res.status(200).json({ message: 'Criança registrada com sucesso!', childId: childId, childName: childName });
    } catch (error) {
        console.error('[DynamoDB] Erro ao registrar criança:', error);
        res.status(500).json({ error: 'Erro ao registrar criança.', details: error.message });
    }
});

// Nova rota para o app "Pai" buscar a lista de filhos registrados
app.get('/get-registered-children', async (req, res) => {
    // Você pode querer filtrar por parentId aqui se a autenticação do pai for implementada
    // const { parentId } = req.query;

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN, // Busca da tabela Children
        // Se quiser buscar da Conversations para listar, também é possível
        // TableName: DYNAMODB_TABLE_CONVERSATIONS,
        // ProjectionExpression: "childId, childName, parentId" // Especificar campos se não forem todos necessários
    };

    try {
        const result = await docClient.scan(params).promise(); // Scan para buscar todos os filhos
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela '${DYNAMODB_TABLE_CHILDREN}'.`);
        res.status(200).json(result.Items.map(item => ({
            childId: item.childId,
            childName: item.childName,
            parentId: item.parentId // Incluir parentId se relevante
        })));
    } catch (error) {
        console.error('[DynamoDB] Erro ao buscar lista de filhos:', error);
        res.status(500).json({ error: 'Erro ao buscar lista de filhos.', details: error.message });
    }
});


// Rota para receber atualizações de localização (ainda via HTTP, mas o principal é o WS)
app.post('/location', async (req, res) => {
    const { childId, latitude, longitude, timestamp } = req.body;

    if (!childId || !latitude || !longitude || !timestamp) {
        return res.status(400).json({ error: 'Dados de localização incompletos.' });
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            locationId: uuidv4(), // Gera um ID único para cada entrada de localização
            childId: childId,
            latitude: latitude,
            longitude: longitude,
            timestamp: timestamp,
            createdAt: new Date().toISOString() // Adiciona data de criação no servidor
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Localização de ${childId} salva: Lat=${latitude}, Lng=${longitude}`);

        // Envia a atualização de localização para clientes WebSocket ouvindo para este childId
        wsClientsMap.forEach((ws, id) => {
            if (id === childId || (ws.type === 'parent' && ws.listeningToChildId === childId)) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'locationUpdate',
                        data: { childId, latitude, longitude, timestamp }
                    }));
                }
            }
        });

        res.status(200).json({ message: 'Localização recebida e salva com sucesso.' });
    } catch (error) {
        console.error('[DynamoDB] Erro ao salvar localização:', error);
        res.status(500).json({ error: 'Erro ao salvar localização.', details: error.message });
    }
});

// Rota para upload de mídia (futura implementação)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    const { childId, messageId, contentType } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    if (!childId || !messageId || !contentType) {
        return res.status(400).json({ error: 'Dados da mídia incompletos.' });
    }

    const s3Key = `media/${childId}/${messageId}.${contentType.split('/')[1]}`; // Ex: media/child123/msg456.jpeg

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Body: file.buffer,
        ContentType: contentType, // Tipo MIME do arquivo
        ACL: 'private' // Acesso privado, apenas para leitura autenticada
    };

    try {
        const s3Response = await s3.upload(params).promise();
        console.log(`[S3] Mídia ${messageId} de ${childId} enviada para S3: ${s3Response.Location}`);

        // Opcional: Atualizar a entrada da mensagem no DynamoDB com o URL da mídia no S3
        const updateParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Key: {
                conversationId: childId, // Ou o ID da conversa real
                messageId: messageId
            },
            UpdateExpression: 'SET mediaUrl = :url, mediaType = :type',
            ExpressionAttributeValues: {
                ':url': s3Response.Location,
                ':type': contentType
            },
            ReturnValues: 'UPDATED_NEW'
        };
        await docClient.update(updateParams).promise();
        console.log(`[DynamoDB] Mensagem ${messageId} atualizada com URL da mídia.`);

        res.status(200).json({ message: 'Mídia enviada com sucesso!', url: s3Response.Location });
    } catch (error) {
        console.error('[S3/DynamoDB] Erro ao enviar mídia:', error);
        res.status(500).json({ error: 'Erro ao enviar mídia.', details: error.message });
    }
});

// Rota de Notificações (requisitada pelo Android, mas não implementada no seu código)
app.post('/notifications', (req, res) => {
    console.warn('[HTTP] Rota /notifications foi chamada, mas não está implementada.');
    // TODO: Implementar lógica para lidar com tokens FCM ou notificações push
    // Geralmente envolve salvar o token do dispositivo e usá-lo para enviar notificações
    res.status(200).json({ message: 'Rota de notificações recebida (sem implementação completa).' });
});


// --- Servidor HTTP e WebSocket ---
const server = http.createServer(app);

// Manipulador de upgrade para WebSockets
server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    if (pathname === '/ws-commands') {
        wssCommands.handleUpgrade(request, socket, head, ws => {
            wssCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio') {
        wssAudio.handleUpgrade(request, socket, head, ws => {
            wssAudio.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// --- WebSocket Server para Comandos (GPS, Chat, etc.) ---
wssCommands.on('connection', ws => {
    console.log('[WebSocket-Commands] Cliente conectado.');

    ws.on('message', async message => {
        try {
            const parsedMessage = JSON.parse(message);
            const { type, childId, parentId, data } = parsedMessage;

            switch (type) {
                case 'init':
                    // Um cliente (app filho ou pai) está se identificando
                    if (childId) {
                        wsClientsMap.set(childId, ws);
                        ws.id = childId; // Adiciona o ID ao objeto WebSocket
                        ws.type = 'child'; // Marca o tipo do cliente
                        ws.send(JSON.stringify({ type: 'status', message: `Conectado como filho ${childId}.` }));
                        console.log(`[WebSocket-Commands] Filho conectado: ${childId}`);
                    } else if (parentId && data && data.listeningToChildId) {
                        wsClientsMap.set(parentId, ws);
                        ws.id = parentId; // Adiciona o ID do pai
                        ws.type = 'parent'; // Marca o tipo do cliente
                        ws.listeningToChildId = data.listeningToChildId; // Pai está ouvindo um filho específico
                        ws.send(JSON.stringify({ type: 'status', message: `Conectado como pai ${parentId}, ouvindo ${data.listeningToChildId}.` }));
                        console.log(`[WebSocket-Commands] Pai conectado: ${parentId}, ouvindo filho: ${data.listeningToChildId}`);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'ID (childId ou parentId) ausente na mensagem init.' }));
                        console.warn('[WebSocket-Commands] Cliente conectado sem ID válido na mensagem init.');
                    }
                    break;

                case 'locationUpdate':
                    // Recebe atualização de localização de um filho (principalmente via HTTP POST, mas pode vir por WS)
                    if (childId && data) {
                        const params = {
                            TableName: DYNAMODB_TABLE_LOCATIONS,
                            Item: {
                                locationId: uuidv4(),
                                childId: childId,
                                latitude: data.latitude,
                                longitude: data.longitude,
                                timestamp: data.timestamp,
                                accuracy: data.accuracy || null,
                                speed: data.speed || null,
                                createdAt: new Date().toISOString()
                            }
                        };
                        await docClient.put(params).promise();
                        console.log(`[WebSocket-Commands] Localização WS de ${childId} salva: Lat=${data.latitude}, Lng=${data.longitude}`);

                        // Reencaminha a localização para o pai que está ouvindo este filho
                        wsClientsMap.forEach((clientWs, id) => {
                            if (clientWs.type === 'parent' && clientWs.listeningToChildId === childId && clientWs.readyState === WebSocket.OPEN) {
                                clientWs.send(JSON.stringify({ type: 'locationUpdate', data: { childId, ...data } }));
                                console.log(`[WebSocket-Commands] Localização de ${childId} encaminhada para o pai ${id}.`);
                            }
                        });
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem locationUpdate incompleta:', parsedMessage);
                    }
                    break;

                case 'requestLocation':
                    // Pai solicitando localização de um filho
                    if (parentId && data && data.targetChildId) {
                        const targetChildWs = wsClientsMap.get(data.targetChildId);
                        if (targetChildWs && targetChildWs.type === 'child' && targetChildWs.readyState === WebSocket.OPEN) {
                            targetChildWs.send(JSON.stringify({ type: 'requestLocation', senderId: parentId }));
                            console.log(`[WebSocket-Commands] Requisição de localização de ${parentId} enviada para ${data.targetChildId}.`);
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Filho offline ou não encontrado.', targetChildId: data.targetChildId }));
                            console.warn(`[WebSocket-Commands] Filho ${data.targetChildId} não encontrado para requisição de localização.`);
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem requestLocation incompleta:', parsedMessage);
                    }
                    break;

                case 'chatMessage':
                    // Recebe mensagem de chat
                    const { senderId, receiverId, content, mediaUrl, timestamp: msgTimestamp } = data;
                    if (!senderId || !receiverId || !content) {
                        console.warn('[WebSocket-Commands] Mensagem de chat incompleta:', parsedMessage);
                        return;
                    }

                    const messageId = uuidv4();
                    const now = new Date().toISOString();

                    const messageItem = {
                        conversationId: receiverId === ws.id ? senderId : receiverId, // Simplificação: conversationId pode ser o childId ou uma combinação childId_parentId
                        messageId: messageId,
                        senderId: senderId,
                        receiverId: receiverId,
                        content: content,
                        mediaUrl: mediaUrl || null,
                        timestamp: msgTimestamp || Date.now(), // Usar timestamp do cliente ou do servidor
                        createdAt: now
                    };

                    try {
                        // Salvar mensagem no DynamoDB (tabela Messages)
                        await docClient.put({
                            TableName: DYNAMODB_TABLE_MESSAGES,
                            Item: messageItem
                        }).promise();
                        console.log(`[DynamoDB] Mensagem ${messageId} de ${senderId} para ${receiverId} salva.`);

                        // Atualizar a última mensagem na tabela Conversations
                        const conversationToUpdateId = messageItem.conversationId; // Ajuste conforme sua lógica de conversationId

                        await docClient.update({
                            TableName: DYNAMODB_TABLE_CONVERSATIONS,
                            Key: { 'conversationId': conversationToUpdateId },
                            UpdateExpression: 'SET lastMessageContent = :lmc, lastMessageTimestamp = :lmt',
                            ExpressionAttributeValues: {
                                ':lmc': content,
                                ':lmt': messageItem.timestamp
                            },
                            ReturnValues: 'UPDATED_NEW'
                        }).promise();
                        console.log(`[DynamoDB] Conversa ${conversationToUpdateId} atualizada com última mensagem.`);


                        // Reencaminha a mensagem para o receptor se ele estiver online
                        const receiverWs = wsClientsMap.get(receiverId);
                        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                            receiverWs.send(JSON.stringify({ type: 'newMessage', data: messageItem }));
                            console.log(`[WebSocket-Commands] Mensagem de chat encaminhada para ${receiverId}.`);
                        }
                    } catch (error) {
                        console.error('[DynamoDB] Erro ao salvar/reencaminhar mensagem de chat:', error);
                    }
                    break;

                case 'audioControl':
                    // Comando para iniciar/parar streaming de áudio do filho
                    if (parentId && data && data.targetChildId && data.action) {
                        const targetChildWs = wsClientsMap.get(data.targetChildId);
                        if (targetChildWs && targetChildWs.type === 'child' && targetChildWs.readyState === WebSocket.OPEN) {
                            targetChildWs.send(JSON.stringify({ type: 'audioControl', action: data.action }));
                            console.log(`[WebSocket-Commands] Comando de áudio '${data.action}' enviado para ${data.targetChildId} por ${parentId}.`);
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Filho offline ou não encontrado para controle de áudio.', targetChildId: data.targetChildId }));
                            console.warn(`[WebSocket-Commands] Filho ${data.targetChildId} não encontrado para comando de áudio.`);
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem audioControl incompleta:', parsedMessage);
                    }
                    break;

                default:
                    console.warn(`[WebSocket-Commands] Tipo de mensagem desconhecido: ${type}`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Tipo de mensagem desconhecido.' }));
            }
        } catch (error) {
            console.error('[WebSocket-Commands] Erro ao processar mensagem JSON:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Erro ao processar mensagem.' }));
        }
    });

    ws.on('close', () => {
        if (ws.id) {
            wsClientsMap.delete(ws.id);
            console.log(`[WebSocket-Commands] Cliente ${ws.id} (${ws.type}) desconectado.`);
        } else {
            console.log('[WebSocket-Commands] Cliente desconectado (ID não identificado).');
        }
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no WebSocket:', error);
    });
});


// --- WebSocket Server para Streaming de Áudio ---
wssAudio.on('connection', ws => {
    console.log('[WebSocket-Audio] Cliente de áudio conectado.');
    // Um cliente se conecta aqui, provavelmente um filho
    // Você pode querer que o filho se identifique com childId também aqui
    ws.on('message', message => {
        // Recebe chunks de áudio de um filho
        // E reencaminha para o pai que está ouvindo (se houver)
        if (typeof message !== 'string') { // Verifica se é um Buffer (dados binários)
            // Aqui, você precisaria identificar de qual filho é o áudio
            // e para qual pai deve ser reencaminhado.
            // Isso geralmente envolve uma mensagem 'init' separada no início da conexão de áudio.
            // Por simplicidade, vamos assumir que o áudio pode ser transmitido para um pai 'ouvindo' um childId específico
            // Você precisaria de um mecanismo para associar este WS de áudio a um childId.
            // Por exemplo: o cliente envia {type: "initAudio", childId: "xyz"} primeiro
            wsClientsMap.forEach((clientWs, id) => {
                if (clientWs.type === 'parent' && clientWs.listeningToChildId === ws.childIdForAudio && clientWs.readyState === WebSocket.OPEN) {
                     clientWs.send(message); // Reencaminha o buffer de áudio diretamente
                }
            });
        }
    });

    ws.on('close', () => {
        // Limpar qualquer referência ao WebSocket de áudio
        console.log('[WebSocket-Audio] Cliente de áudio desconectado.');
    });

    ws.on('error', error => {
        console.error('[WebSocket-Audio] Erro no WebSocket de áudio:', error);
    });
});


// --- Middleware de tratamento de rotas não encontradas ---
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});

// Middleware para tratamento de erros gerais
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro de servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO ---
server.listen(PORT, '0.0.0.0', () => { // AGORA USA 'server' AO INVÉS DE 'app'
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos (GPS, Chat) em: ws://localhost:${PORT}/ws-commands`);
    console.log(`WebSocket de áudio em: ws://localhost:${PORT}/ws-audio`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);    
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
    // console.log(`Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'Configurado' : 'Não Configurado'}`); // REMOVIDO
});