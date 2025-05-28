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
const DYNAMODB_TABLE_NOTIFICATION_TOKENS = 'NotificationTokens'; // Nova tabela para tokens de notificação

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'; // Nome do bucket S3 para mídias

// --- Variáveis para Controle de WebSockets ---
// Mapas para os WebSockets de COMANDOS/GPS/MENSAGENS
const wsClientsMap = new Map(); // Chave: (childId ou parentId) -> Valor: WebSocket do cliente
const wssCommands = new WebSocket.Server({ noServer: true }); // WebSocket Server para comandos e GPS
const wssAudio = new WebSocket.Server({ noServer: true });    // WebSocket Server para streaming de áudio

// --- Middlewares ---
app.use(cors()); // Habilita CORS para todas as rotas
app.use(bodyParser.json()); // Habilita o parsing de JSON no corpo das requisições
app.use(express.json()); // Garante que o body JSON seja parseado (redundante com bodyParser.json mas boa prática)

// --- Rotas HTTP ---

// Rota de teste
app.get('/', (req, res) => {
    res.send('Servidor do Parental Monitor está ativo!');
});

// Rota para registrar uma nova criança/dispositivo
// Esta rota é chamada pelo aplicativo "filho"
app.post('/register-child', async (req, res) => {
    console.log('[REGISTER_CHILD_REQUEST] Recebido pedido de registro de filho:', req.body);
    const { childName, parentId, childToken, childId: existingChildId } = req.body; // childToken é para Firebase/FCM

    // Se o childId já existe no corpo, usa ele. Caso contrário, gera um novo.
    const childId = existingChildId || uuidv4(); 

    if (!childName) {
        console.error('[REGISTER_CHILD_ERROR] Nome da Criança é obrigatório.');
        return res.status(400).json({ error: 'Nome da Criança é obrigatório.' });
    }

    const childrenTableParams = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId, // A chave primária da tabela Children no DynamoDB
            childName: childName,
            parentId: parentId || 'not_set', // parentId pode ser 'not_set' inicialmente
            childToken: childToken || null, // Armazena o token para notificações push
            registrationDate: new Date().toISOString()
        }
    };

    // CORREÇÃO: Adicionando 'contactOrGroup' que é a chave primária da tabela Conversations
    const conversationTableParams = {
        TableName: DYNAMODB_TABLE_CONVERSATIONS,
        Item: {
            contactOrGroup: childId, // <-- CORRIGIDO: Usando childId como a chave primária esperada
            conversationId: childId, // Mantendo conversationId para consistência com o ID da "conversa"
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
// Esta rota corresponde ao GET /get-child-ids que estava dando erro.
app.get('/get-registered-children', async (req, res) => {
    console.log('[HTTP] Recebida requisição GET /get-registered-children');
    // Você pode querer filtrar por parentId aqui se a autenticação do pai for implementada
    // const { parentId } = req.query;  // Exemplo de como pegar o parentId da query

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN, // Busca da tabela Children
        ProjectionExpression: "childId, childName, parentId" // Especificar campos para otimizar
    };

    try {
        const result = await docClient.scan(params).promise(); // Scan para buscar todos os filhos
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela '${DYNAMODB_TABLE_CHILDREN}'. Encontrados ${result.Items.length} filhos.`);
        res.status(200).json(result.Items.map(item => ({
            childId: item.childId,
            childName: item.childName,
            parentId: item.parentId
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
        // wsClientsMap deve armazenar pais por parentId, e eles devem indicar qual childId estão ouvindo.
        wsClientsMap.forEach((ws, id) => {
            // A lógica aqui depende de como você estrutura os clientes no wsClientsMap.
            // Se um pai está conectado e "ouvindo" um childId específico:
            if (ws.type === 'parent' && ws.listeningToChildId === childId && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'locationUpdate',
                    data: { childId, latitude, longitude, timestamp }
                }));
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
                // CORREÇÃO: Usar a chave primária correta da tabela Messages
                // Assumindo que Messages usa conversationId e messageId como chave composta.
                // Se for diferente, ajuste aqui.
                conversationId: childId, // Ou o ID da conversa real (childId ou parentId)
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

// Nova rota para registrar/atualizar tokens de notificação (ex: FCM tokens)
// Esta rota resolve o erro "Rota não encontrada: POST /notifications" que apareceu nos logs
app.post('/notifications/register-token', async (req, res) => {
    const { userId, token, platform } = req.body; // userId pode ser parentId ou childId
    console.log(`[HTTP] Recebida requisição POST /notifications/register-token para userId: ${userId}, platform: ${platform}`);

    if (!userId || !token || !platform) {
        return res.status(400).send('userId, token e platform são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_NOTIFICATION_TOKENS,
        Item: {
            userId: userId, // Pode ser parentId ou childId
            token: token,
            platform: platform, // Ex: 'android', 'ios'
            timestamp: Date.now()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Token de notificação registrado/atualizado com sucesso para ${userId} na tabela '${DYNAMODB_TABLE_NOTIFICATION_TOKENS}'.`);
        res.status(200).send('Token de notificação registrado com sucesso.');
    } catch (error) {
        console.error('[DynamoDB] Erro ao registrar token de notificação:', error);
        res.status(500).send('Erro interno do servidor ao registrar token de notificação.');
    }
});

// Rota de Notificações (requisitada pelo Android, mas não implementada no seu código)
// Mantida para compatibilidade, mas o registro de tokens deve ir para /notifications/register-token
app.post('/notifications', (req, res) => {
    console.warn('[HTTP] Rota /notifications foi chamada. Por favor, use /notifications/register-token para registrar tokens.');
    // TODO: Se esta rota tiver outra finalidade além de registrar tokens, implemente-a aqui.
    // Exemplo: { "childId": "xyz", "message": "Olá, filho!" }
    // Enviar notificação push usando o token salvo previamente.
    res.status(200).json({ message: 'Rota de notificações recebida (sem implementação completa para envio).' });
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
            // Removi 'data' da desestruturação aqui, pois agora latitude/longitude/timestamp
            // são esperados diretamente na mensagem de nível superior para 'locationUpdate'.
            const { type, childId, parentId } = parsedMessage; 

            switch (type) {
                case 'childConnect': // Novo tipo de mensagem para o app filho se identificar
                    if (childId) {
                        wsClientsMap.set(childId, ws);
                        ws.id = childId;
                        ws.type = 'child';
                        ws.parentId = parentId; // Armazena o parentId associado
                        ws.send(JSON.stringify({ type: 'status', message: `Conectado como filho ${childId}.` }));
                        console.log(`[WebSocket-Commands] Filho conectado e identificado: Child ID ${childId}, Parent ID ${parentId}`);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'childId ausente na mensagem childConnect.' }));
                        console.warn('[WebSocket-Commands] Mensagem childConnect sem childId.');
                    }
                    break;

                case 'parentConnect': // Tipo de mensagem para o app pai se identificar
                    // Aqui 'data' ainda é esperado para 'listeningToChildId'
                    if (parentId && parsedMessage.data && parsedMessage.data.listeningToChildId) {
                        wsClientsMap.set(parentId, ws); // Mapeia o pai
                        ws.id = parentId;
                        ws.type = 'parent';
                        ws.listeningToChildId = parsedMessage.data.listeningToChildId; // Pai está ouvindo um filho específico
                        ws.send(JSON.stringify({ type: 'status', message: `Conectado como pai ${parentId}, ouvindo ${parsedMessage.data.listeningToChildId}.` }));
                        console.log(`[WebSocket-Commands] Pai conectado: ${parentId}, ouvindo filho: ${parsedMessage.data.listeningToChildId}`);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'ID (parentId ou listeningToChildId) ausente na mensagem parentConnect.' }));
                        console.warn('[WebSocket-Commands] Cliente conectado sem ID válido na mensagem parentConnect.');
                    }
                    break;

                case 'locationUpdate':
                    // Recebe atualização de localização de um filho via WebSocket
                    // Desestrutura diretamente da parsedMessage
                    const { latitude, longitude, timestamp, accuracy, speed } = parsedMessage; // <--- ALTERADO AQUI
                    if (childId && parentId && latitude != null && longitude != null && timestamp != null) { // Verificação mais robusta
                        const params = {
                            TableName: DYNAMODB_TABLE_LOCATIONS, // Sua tabela GPSintegracao
                            Item: {
                                locationId: uuidv4(),                                
								childId: childId,
                                parentId: parentId, // Incluir parentId aqui também
                                latitude: latitude, // <--- ALTERADO AQUI
                                longitude: longitude, // <--- ALTERADO AQUI
                                timestamp: timestamp, // <--- ALTERADO AQUI
                                accuracy: accuracy || null, // <--- Pegando diretamente também
                                speed: speed || null, // <--- Pegando diretamente também
                                createdAt: new Date().toISOString()
                            }
                        };
                        try {
                            await docClient.put(params).promise();
                            console.log(`[WebSocket-Commands] Localização WS de ${childId} salva: Lat=${latitude}, Lng=${longitude}`);

                            // Reencaminha a localização para o pai que está ouvindo este filho
                            wsClientsMap.forEach((clientWs, id) => {
                                if (clientWs.type === 'parent' && clientWs.listeningToChildId === childId && clientWs.readyState === WebSocket.OPEN) {
                                    // Reencaminha a mensagem original (ou um novo objeto com os dados corretos)
                                    // Certifique-se que o 'data' encapsula as informações de localização para o pai
                                    clientWs.send(JSON.stringify({ type: 'locationUpdate', data: { childId, parentId, latitude, longitude, timestamp, accuracy, speed } }));
                                    console.log(`[WebSocket-Commands] Localização de ${childId} encaminhada para o pai ${id}.`);
                                }
                            });
                        } catch (err) {
                            console.error('[DynamoDB_ERROR] Erro ao salvar localização via WS:', err);
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem locationUpdate incompleta ou com dados inválidos:', parsedMessage); // Mensagem de log mais clara
                    }
                    break;

                case 'requestLocation':
                    // Pai solicitando localização de um filho
                    // Aqui 'data' ainda é esperado
                    if (parentId && parsedMessage.data && parsedMessage.data.targetChildId) {
                        // NOVO LOG ESPECÍFICO PARA O COMANDO GETLOCATION (OU requestLocation)
                        console.log(`[WebSocket-Commands] Ação: Pai ${parentId} solicitou localização do filho ${parsedMessage.data.targetChildId}.`); // << ADICIONADO AQUI
                        const targetChildWs = wsClientsMap.get(parsedMessage.data.targetChildId);
                        if (targetChildWs && targetChildWs.type === 'child' && targetChildWs.readyState === WebSocket.OPEN) {
                            targetChildWs.send(JSON.stringify({ type: 'requestLocation', senderId: parentId }));
                            console.log(`[WebSocket-Commands] Comando 'requestLocation' enviado para ${parsedMessage.data.targetChildId}.`);
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Filho offline ou não encontrado.', targetChildId: parsedMessage.data.targetChildId }));
                            console.warn(`[WebSocket-Commands] Filho ${parsedMessage.data.targetChildId} não encontrado para requisição de localização.`);
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem requestLocation incompleta:', parsedMessage);
                    }
                    break;

                case 'chatMessage':
                    // Recebe mensagem de chat
                    // Aqui 'data' ainda é esperado
                    if (parsedMessage.data) {
                        const { senderId, receiverId, content, mediaUrl, timestamp: msgTimestamp } = parsedMessage.data;
                        if (!senderId || !receiverId || !content) {
                            console.warn('[WebSocket-Commands] Mensagem de chat incompleta:', parsedMessage);
                            return;
                        }

                        const messageId = uuidv4();
                        const now = new Date().toISOString();

                        const messageItem = {
                            // CORREÇÃO: A chave 'conversationId' aqui é a chave de partição da tabela Messages.
                            // Assumindo que a conversa é entre o remetente e o receptor.
                            // Se 'Messages' usa 'contactOrGroup' como PK, ajuste aqui também.
                            conversationId: receiverId === ws.id ? senderId : receiverId, // ID do outro lado da conversa
                            messageId: messageId, // Sort key para Messages
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
                            // CORREÇÃO: Usar 'contactOrGroup' como a chave primária da tabela Conversations
                            const conversationToUpdateKey = messageItem.conversationId; // O ID do outro lado da conversa

                            await docClient.update({
                                TableName: DYNAMODB_TABLE_CONVERSATIONS,
                                Key: { 'contactOrGroup': conversationToUpdateKey }, // <-- CORRIGIDO AQUI
                                UpdateExpression: 'SET lastMessageContent = :lmc, lastMessageTimestamp = :lmt',
                                ExpressionAttributeValues: {
                                    ':lmc': content,
                                    ':lmt': messageItem.timestamp
                                },
                                ReturnValues: 'UPDATED_NEW'
                            }).promise();
                            console.log(`[DynamoDB] Conversa ${conversationToUpdateKey} atualizada com última mensagem.`);


                            // Reencaminha a mensagem para o receptor se ele estiver online
                            const receiverWs = wsClientsMap.get(receiverId);
                            if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                                receiverWs.send(JSON.stringify({ type: 'newMessage', data: messageItem }));
                                console.log(`[WebSocket-Commands] Mensagem de chat encaminhada para ${receiverId}.`);
                            }
                        } catch (error) {
                            console.error('[DynamoDB] Erro ao salvar/reencaminhar mensagem de chat:', error);
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem chatMessage sem objeto data:', parsedMessage);
                    }
                    break;

                case 'audioControl':
                    // Comando para iniciar/parar streaming de áudio do filho
                    // Aqui 'data' ainda é esperado
                    if (parentId && parsedMessage.data && parsedMessage.data.targetChildId && parsedMessage.data.action) {
                        const targetChildWs = wsClientsMap.get(parsedMessage.data.targetChildId);
                        if (targetChildWs && targetChildWs.type === 'child' && targetChildWs.readyState === WebSocket.OPEN) {
                            targetChildWs.send(JSON.stringify({ type: 'audioControl', action: parsedMessage.data.action }));
                            console.log(`[WebSocket-Commands] Comando de áudio '${parsedMessage.data.action}' enviado para ${parsedMessage.data.targetChildId} por ${parentId}.`);
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Filho offline ou não encontrado para controle de áudio.', targetChildId: parsedMessage.data.targetChildId }));
                            console.warn(`[WebSocket-Commands] Filho ${parsedMessage.data.targetChildId} não encontrado para comando de áudio.`);
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
            console.error('[WebSocket-Commands] Erro ao processar mensagem JSON ou lógica:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Erro ao processar mensagem.' }));
        }
    });

    ws.on('close', () => {
        if (ws.id) {
            wsClientsMap.delete(ws.id);
            console.log(`[WebSocket-Commands] Cliente ${ws.id} (${ws.type || 'tipo não especificado'}) desconectado.`);
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
    // Você precisa de um mecanismo para que o cliente de áudio se identifique
    // Ex: O cliente envia a primeira mensagem como {type: "initAudio", childId: "xyz"}
    let childIdForAudio = 'unknown_audio_client'; // Valor padrão, deve ser atualizado pelo cliente

    ws.on('message', message => {
        // Se a primeira mensagem for uma string de identificação (initAudio)
        if (typeof message === 'string') {
            try {
                const parsedMessage = JSON.parse(message);
                if (parsedMessage.type === 'initAudio' && parsedMessage.childId) {
                    childIdForAudio = parsedMessage.childId;
                    ws.childIdForAudio = childIdForAudio; // Armazena no objeto WS para referência futura
                    console.log(`[WebSocket-Audio] Cliente de áudio identificado como filho: ${childIdForAudio}`);
                    ws.send(JSON.stringify({ type: 'status', message: `Conectado para áudio como filho ${childIdForAudio}.` }));
                } else {
                    console.warn('[WebSocket-Audio] Mensagem inicial de áudio inesperada ou incompleta:', parsedMessage);
                }
            } catch (e) {
                console.warn('[WebSocket-Audio] Mensagem de áudio não JSON ou mal formatada, tratando como binário:', message.toString().substring(0, 50), '...'); // Logar parte da mensagem
                // Se não for JSON, tratar como dados binários de áudio
                if (typeof message !== 'string') {
                    // Reencaminha o buffer de áudio para pais ouvindo este childId
                    wssCommands.clients.forEach(clientWs => { // Percorre os clientes do wssCommands
                        if (clientWs.type === 'parent' && clientWs.listeningToChildId === ws.childIdForAudio && clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(message); // Reencaminha o buffer de áudio diretamente
                        }
                    });
                }
            }
        } else { // Se não for string, é tratado como dados binários de áudio
            // Reencaminha o buffer de áudio para pais ouvindo este childId
            wssCommands.clients.forEach(clientWs => { // Percorre os clientes do wssCommands
                if (clientWs.type === 'parent' && clientWs.listeningToChildId === ws.childIdForAudio && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(message); // Reencaminha o buffer de áudio diretamente
                }
            });
        }
    });

    ws.on('close', () => {
        console.log(`[WebSocket-Audio] Cliente de áudio desconectado (Filho: ${ws.childIdForAudio || 'não identificado'}).`);
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
    console.log(`Constante DYNAMODB_TABLE_NOTIFICATION_TOKENS: ${DYNAMODB_TABLE_NOTIFICATION_TOKENS}`);
});