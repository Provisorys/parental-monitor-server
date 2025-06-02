const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 10000;

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
const DYNAMODB_TABLE_LOCATIONS = 'Locations';
const DYNAMODB_TABLE_CHILDREN = 'Children';

// --- MIDDLEWARE ---
app.use(cors());
app.use(bodyParser.json());

// --- HTTP ROUTES ---
app.get('/', (req, res) => {
    res.send('Servidor Parental Monitor Online!');
});

// Rota para registrar um novo filho
app.post('/register-child', async (req, res) => {
    const { parentId, childName, childToken } = req.body; // childToken é o FCM Token

    if (!parentId || !childName || !childToken) {
        console.error('[HTTP_ERROR] Tentativa de registrar filho com dados incompletos.');
        return res.status(400).send('Dados incompletos para o registro do filho.');
    }

    try {
        // Gerar um UUID para o childId
        const childId = uuidv4();

        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN,
            Item: {
                childId: childId,
                parentId: parentId,
                childName: childName,
                childToken: childToken, // Armazena o FCM Token
                connected: false, // Inicialmente desconectado
                lastActivity: new Date().toISOString()
            }
        };

        await docClient.put(params).promise();
        console.log(`[DynamoDB] Filho ${childName} (ID: ${childId}) registrado com sucesso para o pai ${parentId}.`);
        res.status(200).json({ childId: childId, message: 'Filho registrado com sucesso!' });
    } catch (error) {
        console.error('Erro ao registrar filho no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor ao registrar filho.');
    }
});

// Rota para listar filhos registrados
app.get('/get-registered-children', async (req, res) => {
    try {
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN
        };
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela 'Children'. Encontrados ${data.Items.length} filhos.`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao buscar filhos no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor ao buscar filhos.');
    }
});

// Rota para enviar notificações (via FCM)
app.post('/send-notification', async (req, res) => {
    const { recipientChildId, title, body } = req.body;

    if (!recipientChildId || !title || !body) {
        return res.status(400).send('Dados incompletos para enviar notificação.');
    }

    try {
        // 1. Obter o FCM Token do filho no DynamoDB
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN,
            Key: {
                childId: recipientChildId
            }
        };
        const data = await docClient.get(params).promise();
        const child = data.Item;

        if (!child || !child.childToken) {
            return res.status(404).send('Filho não encontrado ou sem token FCM registrado.');
        }

        const fcmToken = child.childToken;

        // 2. Usar o FCM Token para enviar a notificação (via SDK Admin do Firebase no servidor)
        // ATENÇÃO: Você precisa inicializar o SDK Admin do Firebase aqui.
        // Exemplo (requer 'firebase-admin' npm package e credenciais):
        /*
        const admin = require('firebase-admin');
        const serviceAccount = require('./path/to/your/serviceAccountKey.json'); // Seu arquivo de credenciais Firebase

        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }

        const message = {
            notification: {
                title: title,
                body: body
            },
            token: fcmToken
        };

        admin.messaging().send(message)
            .then((response) => {
                console.log('Notificação FCM enviada com sucesso:', response);
                res.status(200).send('Notificação enviada com sucesso.');
            })
            .catch((error) => {
                console.error('Erro ao enviar notificação FCM:', error);
                res.status(500).send('Erro ao enviar notificação FCM.');
            });
        */
        console.log(`[FCM] Simulação: Notificação '${title}' para ${fcmToken} (${recipientChildId})`);
        res.status(200).send('Notificação processada (requer integração Firebase Admin).');

    } catch (error) {
        console.error('Erro ao enviar notificação:', error);
        res.status(500).send('Erro interno do servidor ao enviar notificação.');
    }
});

// Rota para upload de mídia (S3)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo enviado.');
    }

    const { childId, type } = req.body; // 'type' pode ser 'image', 'video', 'audio'

    if (!childId || !type) {
        return res.status(400).send('childId ou type não fornecidos.');
    }

    const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'; // Use variável de ambiente ou padrão
    const key = `${childId}/${type}/${uuidv4()}-${req.file.originalname}`;

    const params = {
        Bucket: bucketName,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'private' // Ajuste conforme sua política de acesso
    };

    try {
        const data = await s3.upload(params).promise();
        console.log(`[S3] Mídia ${key} (${type}) do filho ${childId} carregada com sucesso.`, data.Location);
        res.status(200).json({ url: data.Location, key: data.Key });
    } catch (error) {
        console.error('Erro ao fazer upload para S3:', error);
        res.status(500).send('Erro no upload do arquivo.');
    }
});

// Rota para download de mídia (S3)
app.get('/download-media/:key', async (req, res) => {
    const key = req.params.key;
    const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';

    const params = {
        Bucket: bucketName,
        Key: key
    };

    try {
        const data = await s3.getObject(params).promise();
        res.setHeader('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
        res.setHeader('Content-Type', data.ContentType);
        res.send(data.Body);
    } catch (error) {
        console.error('Erro ao baixar arquivo do S3:', error);
        res.status(404).send('Arquivo não encontrado ou erro de servidor.');
    }
});


// Middleware para rotas não encontradas
app.use((req, res, next) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).send('Rota não encontrada.');
});

// Middleware de tratamento de erros global
app.use((err, req, res, next) => {
    console.error('Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
});

// --- INICIO DO SERVIDOR HTTP ---
const server = http.createServer(app);

// --- WEBSOCKETS ---

// Mapas para gerenciar conexões ativas
const activeConnections = new Map(); // Mapa de ID -> WebSocket para todos os clientes (Pai e Filho)
const childToWebSocket = new Map(); // Mapa de childId -> WebSocket (somente filhos conectados no canal de comandos)
const parentToWebSocket = new Map(); // Mapa de parentId -> WebSocket (somente pais conectados no canal de comandos)

// NOVO: Mapa para conexões de áudio identificadas
// Chave: WebSocket instance, Valor: { childId: string, parentId: string, isParentAudioClient: boolean }
const activeAudioClients = new Map();


// WebSocket Server para Comandos (GPS, Chat, Comandos de Áudio)
const wssCommands = new WebSocket.Server({ noServer: true });

wssCommands.on('connection', ws => {
    // Declaramos as variáveis no escopo superior do 'connection' para serem atualizadas
    // e acessadas consistentemente.
    let clientId = uuidv4(); // ID temporário até ser identificado
    let clientType = 'unknown'; // 'parent' ou 'child'
    let currentParentId = null; // Renomeado para evitar conflito com 'parentId' da mensagem
    let currentChildId = null;  // Renomeado para evitar conflito com 'childId' da mensagem
    let currentChildName = null; // Para armazenar o nome do filho após childConnect

    ws.id = clientId; // Adiciona um ID à instância do WebSocket
    activeConnections.set(ws.id, ws);
    console.log(`[WebSocket-Commands] Novo cliente conectado. Total de entradas: ${activeConnections.size}`);

    ws.on('message', async message => {
        let rawParsedMessage; // Variável temporária para o resultado do parse
        let finalParsedMessage = null; // Variável para o objeto final a ser usado
        try {
            console.log(`[WebSocket-Commands] Tipo da variável 'message' recebida (ANTES do parse): ${typeof message}`);
            console.log(`[WebSocket-Commands] message é Buffer? ${Buffer.isBuffer(message)}`);

            // --- INÍCIO DA MUDANÇA PROPOSTA ---
            if (typeof message === 'string') {
                rawParsedMessage = JSON.parse(message);
            } else if (Buffer.isBuffer(message)) {
                // Tenta parsear o Buffer como JSON string
                rawParsedMessage = JSON.parse(message.toString('utf8'));
            } else {
                // Se não é string nem Buffer, mas é um objeto, assume que já é o JSON.
                // Esta é a parte que o log indicou ser 'object', então tratamos como tal.
                // Não é mais necessário um JSON.parse aqui se já é um objeto JSON.
                rawParsedMessage = message;
                console.warn('[WebSocket-Commands] Mensagem recebida já é um objeto e não um Buffer/String. Usando diretamente.');
            }

            // Realiza uma cópia profunda (deep copy) para garantir que o objeto não seja mutado posteriormente
            // E valida o tipo imediatamente após o parse/atribuição
            if (rawParsedMessage && typeof rawParsedMessage === 'object' && !Array.isArray(rawParsedMessage)) {
                try {
                    finalParsedMessage = JSON.parse(JSON.stringify(rawParsedMessage)); // Copia profunda
                } catch (copyError) {
                    console.error(`[WebSocket-Commands] Erro durante a cópia profunda de rawParsedMessage: ${copyError.message}`, rawParsedMessage);
                    // Se a cópia profunda falhar, finalParsedMessage permanecerá null, o que será pego na próxima validação.
                }
            }

            // --- NOVO LOGS DE DEPURACAO ---
            console.log(`[WebSocket-Commands] DEBUG - finalParsedMessage antes da validação:`, finalParsedMessage);
            console.log(`[WebSocket-Commands] DEBUG - typeof finalParsedMessage:`, typeof finalParsedMessage);
            console.log(`[WebSocket-Commands] DEBUG - !finalParsedMessage:`, !finalParsedMessage);
            // --- FIM DOS NOVOS LOGS DE DEPURACAO ---

            if (!finalParsedMessage || typeof finalParsedMessage !== 'object') {
                console.error('[WebSocket-Commands] parsedMessage inválido ou não é um objeto JSON esperado APÓS CÓPIA:', rawParsedMessage); // Mantém o rawParsedMessage para comparação
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }

            console.log('[WebSocket-Commands] Mensagem JSON recebida (APÓS LÓGICA DE PARSE E VALIDAÇÃO FINAL):', finalParsedMessage);

            const { type, parentId, childId, childName, data } = finalParsedMessage; // Use finalParsedMessage

            console.log(`[WebSocket-Commands] Desestruturado - type: ${type}, parentId: ${parentId}, childId (top-level): ${childId}, childName (top-level): ${childName}`);
            if (data) {
                console.log(`[WebSocket-Commands] Conteúdo de 'data':`, data);
                if (data.childId) {
                    console.log(`[WebSocket-Commands] Extracted from data - childId: ${data.childId}, childName: ${data.childName}`);
                }
            }

            switch (type) {
                case 'parentConnect':
                    currentParentId = parentId; // Atribui à variável de escopo superior
                    clientType = 'parent';
                    parentToWebSocket.set(currentParentId, ws);
                    activeConnections.set(currentParentId, ws); // Atualiza activeConnections com o parentId real
                    console.log(`[WebSocket-Manager] Conexão parent ${currentParentId} atualizada. Total de entradas: ${activeConnections.size}`);
                    console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${currentParentId}, ouvindo filho: ${childId || 'nenhum'}`);
                    break;
                case 'childConnect':
                    currentChildId = childId; // Atribui à variável de escopo superior
                    currentParentId = parentId; // Garante que o parentId também seja definido para o filho
                    currentChildName = childName; // Armazena o nome do filho
                    clientType = 'child';
                    childToWebSocket.set(currentChildId, ws);
                    activeConnections.set(currentChildId, ws); // Atualiza activeConnections com o childId real
                    console.log(`[WebSocket-Manager] Conexão child ${currentChildId} atualizada. Total de entradas: ${activeConnections.size}`);
                    console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${currentChildId}, Parent ID: ${currentParentId}, Nome: ${currentChildName}`);

                    // Atualizar status de conexão no DynamoDB
                    await docClient.update({
                        TableName: DYNAMODB_TABLE_CHILDREN,
                        Key: { childId: currentChildId },
                        UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
                        ExpressionAttributeValues: {
                            ':connected': true,
                            ':lastActivity': new Date().toISOString()
                        }
                    }).promise();
                    console.log(`[DynamoDB] Filho ${currentChildName} (${currentChildId}) status de conexão atualizado para 'true'.`);

                    // Se há um parent conectado, avisa que o filho está online
                    const parentWs = parentToWebSocket.get(currentParentId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({
                            type: 'childStatus',
                            childId: currentChildId,
                            status: 'online',
                            childName: currentChildName
                        }));
                    }
                    break;

                case 'locationUpdate':
                    // currentChildId já deve estar definido se foi um childConnect anterior
                    if (!currentChildId) {
                        console.warn('[WebSocket-Commands] Mensagem de localização recebida de cliente não identificado.');
                        return;
                    }
                    console.log(`[Location] Localização recebida do filho ${currentChildId}: Lat ${data.latitude}, Lng ${data.longitude}`);

                    // Salvar no DynamoDB
                    const locationParams = {
                        TableName: DYNAMODB_TABLE_TABLE_LOCATIONS,
                        Item: {
                            locationId: uuidv4(),
                            childId: currentChildId,
                            latitude: data.latitude,
                            longitude: data.longitude,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(locationParams).promise();

                    // Encaminhar para o pai
                    const connectedParentWs = parentToWebSocket.get(currentParentId); // Usa o parentId da conexão do filho
                    if (connectedParentWs && connectedParentWs.readyState === WebSocket.OPEN) {
                        connectedParentWs.send(JSON.stringify({
                            type: 'locationUpdate',
                            childId: currentChildId,
                            latitude: data.latitude,
                            longitude: data.longitude,
                            timestamp: new Date().toISOString()
                        }));
                    }
                    break;

                case 'chatMessage':
                    // currentChildId ou currentParentId deve estar definido
                    const senderId = clientType === 'child' ? currentChildId : currentParentId;
                    // Se for pai, o recipientId (childId) vem do 'data' do payload
                    const receiverId = clientType === 'child' ? currentParentId : data.childId;
                    const senderName = clientType === 'child' ? currentChildName : 'Pai'; // Nome do remetente
                    const receiverWs = clientType === 'child' ? parentToWebSocket.get(receiverId) : childToWebSocket.get(receiverId);

                    if (!senderId || !receiverId) {
                        console.warn('[WebSocket-Commands] Mensagem de chat sem IDs de remetente/receptor.');
                        return;
                    }
                    console.log(`[Chat] Mensagem de ${senderName} (${senderId}) para ${receiverId}: ${data.message}`);

                    // Salvar no DynamoDB
                    const messageParams = {
                        TableName: DYNAMODB_TABLE_MESSAGES,
                        Item: {
                            conversationId: `${senderId}-${receiverId}`, // Pode ser algo como childId-parentId
                            messageId: uuidv4(),
                            parentId: clientType === 'parent' ? senderId : receiverId, // ID do pai na conversa
                            childId: clientType === 'child' ? senderId : receiverId, // ID do filho na conversa
                            sender: senderId, // Quem enviou (childId ou parentId)
                            message: data.message,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(messageParams).promise();

                    // Encaminhar para o receptor
                    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                        receiverWs.send(JSON.stringify({
                            type: 'chatMessage',
                            senderId: senderId,
                            receiverId: receiverId,
                            message: data.message,
                            timestamp: new Date().toISOString()
                        }));
                    }
                    break;

                case 'requestLocation':
                    // Pai solicitando localização de um filho específico
                    // O childId para esta requisição está dentro do 'data' objeto
                    const targetChildIdForLocation = data && data.childId;
                    if (clientType !== 'parent' || !targetChildIdForLocation) {
                        console.warn('[WebSocket-Commands] Requisição de localização inválida: não é pai ou childId ausente.');
                        return;
                    }
                    const targetChildWs = childToWebSocket.get(targetChildIdForLocation);
                    if (targetChildWs && targetChildWs.readyState === WebSocket.OPEN) {
                        targetChildWs.send(JSON.stringify({ type: 'requestLocation' }));
                        console.log(`[Location] Requisição de localização enviada para filho ${targetChildIdForLocation}.`);
                    } else {
                        console.warn(`[Location] Filho ${targetChildIdForLocation} não encontrado ou offline para requisição de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildIdForLocation} offline.` }));
                    }
                    break;

                case 'startAudioStream':
                    // Pai solicitando início de streaming de áudio de um filho específico
                    // O childId para esta requisição está dentro do 'data' objeto
                    const targetChildIdForAudio = data && data.childId;
                    console.log(`[Audio-Debug] Recebido 'startAudioStream' do pai ${currentParentId} para filho ${targetChildIdForAudio}. ClientType: ${clientType}`);
                    if (clientType !== 'parent' || !targetChildIdForAudio) {
                        console.warn('[WebSocket-Commands] Requisição de áudio inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de áudio inválida.' }));
                        return;
                    }
                    const targetChildWsAudio = childToWebSocket.get(targetChildIdForAudio); // Acha a conexão de COMANDO do filho
                    console.log(`[Audio-Debug] Tentando encontrar WS do filho ${targetChildIdForAudio}. Encontrado: ${!!targetChildWsAudio}`); // `!!` converte para boolean
                    if (targetChildWsAudio && targetChildWsAudio.readyState === WebSocket.OPEN) {
                        targetChildWsAudio.send(JSON.stringify({ type: 'startAudioStream' }));
                        console.log(`[Audio] Comando 'startAudioStream' enviado para filho ${targetChildIdForAudio}.`);
                        ws.send(JSON.stringify({ type: 'info', message: `Comando 'startAudioStream' enviado para ${targetChildIdForAudio}.` }));
                    } else {
                        console.warn(`[Audio] Filho ${targetChildIdForAudio} não encontrado ou offline para comando de áudio.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildIdForAudio} offline ou conexão de comando não encontrada.` }));
                    }
                    break;

                case 'stopAudioStream':
                    // Pai solicitando parada de streaming de áudio de um filho específico
                    // O childId para esta requisição está dentro do 'data' objeto
                    const targetChildIdForStopAudio = data && data.childId;
                    if (clientType !== 'parent' || !targetChildIdForStopAudio) {
                        console.warn('[WebSocket-Commands] Requisição de parada de áudio inválida: não é pai ou childId ausente.');
                        return;
                    }
                    const targetChildWsStopAudio = childToWebSocket.get(targetChildIdForStopAudio);
                    if (targetChildWsStopAudio && targetChildWsStopAudio.readyState === WebSocket.OPEN) {
                        targetChildWsStopAudio.send(JSON.stringify({ type: 'stopAudioStream' }));
                        console.log(`[Audio] Comando 'stopAudioStream' enviado para filho ${targetChildIdForStopAudio}.`);
                    } else {
                        console.warn(`[Audio] Filho ${targetChildIdForStopAudio} não encontrado ou offline para comando de parada de áudio.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildIdForStopAudio} offline.` }));
                    }
                    break;

                default:
                    console.warn('[WebSocket-Commands] Tipo de mensagem desconhecido:', type);
            }
        } catch (error) {
            console.error('[WebSocket-Commands] Erro crítico ao processar mensagem (JSON.parse ou outro):', error);
            console.error('[WebSocket-Commands] Mensagem original (tentativa toString):', message ? message.toString() : message);
            console.error('[WebSocket-Commands] Tipo de mensagem recebida (no catch):', typeof message);
            ws.send(JSON.stringify({ type: 'error', message: 'Erro interno ao processar sua mensagem.' }));
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WebSocket-Commands] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        // Remove a conexão dos mapas
        activeConnections.delete(ws.id);
        if (clientType === 'child' && currentChildId) {
            childToWebSocket.delete(currentChildId);
            // Atualizar status de conexão no DynamoDB
            try {
                await docClient.update({
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: currentChildId },
                    UpdateExpression: 'SET connected = :connected',
                    ExpressionAttributeValues: { ':connected': false }
                }).promise();
                console.log(`[DynamoDB] Filho ${currentChildId} status de conexão atualizado para 'false'.`);

                // Se houver um parent conectado, avisa que o filho está offline
                const parentWs = parentToWebSocket.get(currentParentId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(JSON.stringify({
                        type: 'childStatus',
                        childId: currentChildId,
                        status: 'offline'
                    }));
                }

            } catch (error) {
                console.error('Erro ao atualizar status de conexão do filho no DynamoDB:', error);
            }
        } else if (clientType === 'parent' && currentParentId) {
            parentToWebSocket.delete(currentParentId);
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas: ${activeConnections.size}`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no cliente WebSocket:', error);
    });
});

// WebSocket Server para Áudio
const wssAudio = new WebSocket.Server({ noServer: true });

wssAudio.on('connection', ws => {
    let identifiedChildId = null; // ID do filho identificado para esta conexão de áudio
    let identifiedParentId = null; // ID do pai identificado para esta conexão de áudio

    console.log('[WebSocket-Audio] Novo cliente conectado.');

    ws.on('message', message => {
        let rawParsedMessage = null;
        let finalParsedMessage = null;
        let isControlMessage = false;

        try {
            console.log(`[WebSocket-Audio] Tipo da variável 'message' recebida (ANTES do parse): ${typeof message}`);
            console.log(`[WebSocket-Audio] message é Buffer? ${Buffer.isBuffer(message)}`);

            if (typeof message === 'string') {
                rawParsedMessage = JSON.parse(message);
                isControlMessage = true;
            } else if (Buffer.isBuffer(message) && message.length > 0) {
                // Tenta parsear como JSON para mensagens de controle
                try {
                    rawParsedMessage = JSON.parse(message.toString('utf8'));
                    isControlMessage = true;
                } catch (e) {
                    // Não é uma string JSON válida, trata como dados de áudio binários
                    isControlMessage = false;
                }
            } else if (typeof message === 'object' && message !== null) {
                rawParsedMessage = message;
                isControlMessage = true;
                console.warn('[WebSocket-Audio] Mensagem recebida já é um objeto. Pulando JSON.parse.');
            } else {
                console.error('[WebSocket-Audio] Tipo de mensagem inesperado ou inválido para áudio:', typeof message, 'Mensagem original:', message);
                return;
            }

            // Validação e cópia profunda para mensagens de controle de áudio
            if (isControlMessage && rawParsedMessage && typeof rawParsedMessage === 'object' && !Array.isArray(rawParsedMessage)) {
                try { // Adicionado try/catch para a cópia profunda aqui também
                    finalParsedMessage = JSON.parse(JSON.stringify(rawParsedMessage)); // Copia profunda
                } catch (copyError) {
                    console.error(`[WebSocket-Audio] Erro durante a cópia profunda de rawParsedMessage (controle): ${copyError.message}`, rawParsedMessage);
                    // Se a cópia profunda falhar, finalParsedMessage permanecerá null.
                }
            }

            // --- NOVO LOGS DE DEPURACAO ---
            console.log(`[WebSocket-Audio] DEBUG - finalParsedMessage (controle) antes da validação:`, finalParsedMessage);
            console.log(`[WebSocket-Audio] DEBUG - typeof finalParsedMessage (controle):`, typeof finalParsedMessage);
            console.log(`[WebSocket-Audio] DEBUG - !finalParsedMessage (controle):`, !finalParsedMessage);
            // --- FIM DOS NOVOS LOGS DE DEPURACAO ---

            if (isControlMessage && (!finalParsedMessage || typeof finalParsedMessage !== 'object')) {
                console.error('[WebSocket-Audio] parsedMessage (controle) inválido ou não é um objeto JSON esperado APÓS CÓPIA:', rawParsedMessage);
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem de controle JSON inválido ou corrompido.' }));
                return;
            }

            if (isControlMessage && finalParsedMessage.type === 'childAudioConnect') {
                identifiedChildId = finalParsedMessage.childId;
                identifiedParentId = finalParsedMessage.parentId; // Se parentId é enviado aqui
                activeAudioClients.set(ws, { childId: identifiedChildId, parentId: identifiedParentId, isParentAudioClient: false });
                console.log(`[WebSocket-Audio] Cliente de áudio identificado: Child ID: ${identifiedChildId}`);
                return; // Importante: não processar como dados de áudio se for uma mensagem de identificação
            }
        } catch (e) {
            console.warn('[WebSocket-Audio] Erro ao tentar parsear mensagem como JSON para identificação:', e.message);
            // Se o parsing falhar, é provável que sejam dados de áudio binários, então continua para o tratamento de áudio
            isControlMessage = false;
        }

        // Se não for uma mensagem de controle, ou o parsing da mensagem de controle falhou, trata como dados de áudio binários
        if (!isControlMessage && Buffer.isBuffer(message) && message.length > 0) {
            if (identifiedChildId) {
                console.log(`[WebSocket-Audio] Áudio recebido de child ID: ${identifiedChildId}. Encaminhando... Tamanho: ${message.length} bytes`);

                // Encaminhar para todos os pais conectados no canal de COMANDOS
                // A interface do pai precisa estar esperando 'audioData' do canal de COMANDOS
                parentToWebSocket.forEach((parentWs, pId) => {
                    if (parentWs.readyState === WebSocket.OPEN) {
                        try {
                            // Envia os dados de áudio como base64 via JSON
                            parentWs.send(JSON.stringify({
                                type: 'audioData',
                                childId: identifiedChildId,
                                data: message.toString('base64')
                            }));
                        } catch (jsonError) {
                            console.error(`[WebSocket-Audio] Erro ao enviar áudio codificado para pai ${pId}:`, jsonError);
                        }
                    }
                });
            } else {
                console.warn('[WebSocket-Audio] Mensagem de áudio binária recebida de cliente não identificado ou não-filho no WS de áudio.');
            }
        } else if (!isControlMessage) { // Loga outras mensagens não-controle e não-binárias
            console.warn('[WebSocket-Audio] Mensagem não binária e não identificação JSON, ignorando:', message.toString());
        }
    });

    ws.on('close', (code, reason) => {
        // Remove a conexão do mapa de áudio
        if (identifiedChildId) {
            activeAudioClients.delete(ws); // Remove pela instância do WS
            console.log(`[WebSocket-Audio] Cliente de áudio ${identifiedChildId} desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        } else {
            console.log(`[WebSocket-Audio] Cliente de áudio não identificado desconectado. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        }
    });

    ws.on('error', error => {
        console.error('[WebSocket-Audio] Erro no WebSocket de áudio:', error);
    });
});


// Lida com o upgrade de HTTP para WebSocket
server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    console.log(`[HTTP-Upgrade] Tentativa de upgrade para pathname: ${pathname}`);

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

// --- INICIO DO SERVIDOR ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos (GPS, Chat) em: ws://localhost:${PORT}/ws-commands`);
    console.log(`WebSocket de áudio em: ws://localhost:${PORT}/ws-audio`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
});