const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url');
const wsConnections = new Map();
const childAudioConnections = new Map();

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

// No index.js - Rota para registrar um novo filho
app.post('/register-child', async (req, res) => {
    const { childId, parentId, childName } = req.body; // <<< PEGA O childId DO CORPO DA REQUISIÇÃO

    if (!childId || !parentId || !childName) {
        return res.status(400).send('childId, parentId e childName são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId, // <<< USA O childId RECEBIDO DA REQUISIÇÃO
            parentId: parentId,
            childName: childName,
            connected: false, // Inicialmente false
            lastActivity: new Date().toISOString()
        }
    };

    try {
        await docClient.put(params).promise(); // <<< COLOCA NO DYNAMODB COM ESSE childId
        console.log(`Filho ${childName} (ID: ${childId}) registrado com sucesso para o pai ${parentId}.`);
        res.status(200).send('Filho registrado com sucesso!');
    } catch (error) {
        console.error('Erro ao registrar filho:', error);
        res.status(500).send('Erro ao registrar filho.');
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
const activeAudioClients = new Map(); // ESTE MAPA SERÁ USADO PARA AS CONEXÕES DE ÁUDIO


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
    // Use wsConnections para gerenciar todas as conexões
    activeConnections.set(ws.id, { ws: ws, type: clientType, id: clientId }); // Usando activeConnections conforme seu código
    console.log(`[WebSocket-Commands] Novo cliente conectado. Total de entradas: ${activeConnections.size}`);

    ws.on('message', async message => {
        let finalParsedMessage = null; // Variável para o objeto final a ser usado
        try {
            console.log(`[WebSocket-Commands] Tipo da variável 'message' recebida (ANTES do parse): ${typeof message}`);
            console.log(`[WebSocket-Commands] message é Buffer? ${Buffer.isBuffer(message)}`);

            let currentMessageContent = message;
            if (Buffer.isBuffer(currentMessageContent)) {
                currentMessageContent = currentMessageContent.toString('utf8');
            }

            // Loop para tentar parsear a mensagem até que seja um objeto JSON válido
            let parseAttempts = 0;
            let parsedResult = null;
            let successfullyParsedToObject = false;

            while (parseAttempts < 5) { // Limita as tentativas de parse para evitar loops infinitos
                try {
                    parsedResult = JSON.parse(currentMessageContent);
                    if (typeof parsedResult === 'object' && parsedResult !== null && !Array.isArray(parsedResult)) {
                        successfullyParsedToObject = true;
                        break; // Sucesso: parseado para um objeto
                    } else {
                        // Se não é um objeto (ex: uma string ou número), tenta parsear novamente
                        // Isso lida com casos como JSON.parse('"{\"key\":\"value\"}"')
                        currentMessageContent = parsedResult;
                        parseAttempts++;
                    }
                } catch (e) {
                    // Falha no parse, não é JSON válido ou não pode ser parseado mais
                    break;
                }
            }
            
            if (successfullyParsedToObject) {
                finalParsedMessage = parsedResult;
            } else {
                // Fallback: se após as tentativas ainda não for um objeto ou falhou no parse,
                // define finalParsedMessage como o último resultado (pode ser string/número)
                // ou null/undefined se nunca foi parseado com sucesso.
                finalParsedMessage = parsedResult; 
                console.error('[WebSocket-Commands] Falha ao parsear a mensagem para um objeto JSON após múltiplas tentativas:', currentMessageContent);
            }

            console.log(`[WebSocket-Commands] Pulando cópia profunda devido a erro persistente; usando rawParsedMessage diretamente.`);

            // --- NOVOS LOGS DE DEPURACAO ---
            console.log(`[WebSocket-Commands] DEBUG - finalParsedMessage antes da validação:`, finalParsedMessage);
            console.log(`[WebSocket-Commands] DEBUG - typeof finalParsedMessage:`, typeof finalParsedMessage);
            console.log(`[WebSocket-Commands] DEBUG - !finalParsedMessage:`, !finalParsedMessage);
            // --- FIM DOS NOVOS LOGS DE DEPURACAO ---

            // A validação agora checa diretamente finalParsedMessage, que já deve ter o objeto parseado/atribuído.
            if (!finalParsedMessage || typeof finalParsedMessage !== 'object' || Array.isArray(finalParsedMessage)) {
                console.error('[WebSocket-Commands] parsedMessage inválido ou não é um objeto JSON esperado APÓS ATRIBUIÇÃO DIRETA:', finalParsedMessage); 
                ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido ou corrompido.' }));
                return;
            }

            console.log('[WebSocket-Commands] Mensagem JSON recebida (APÓS LÓGICA DE PARSE E VALIDAÇÃO FINAL):', finalParsedMessage);

            // NOVO LOG DE DEPURACAO AQUI
            console.log(`[WebSocket-Commands] DEBUG (before switch) - currentParentId: ${currentParentId}, clientType: ${clientType}`);

            // Remova childId e childName da desestruturação de nível superior,
            // eles devem ser extraídos de 'data'.
            const { type, parentId, data } = finalParsedMessage;

            // Declare childId e childName para serem usados no escopo
            let childId = undefined; // Será atribuído de data.childId
            let childName = undefined; // Será atribuído de data.childName

            // Se 'data' existe, extraia childId e childName dela
            if (data) {
                childId = data.childId;
                childName = data.childName;
                console.log(`[WebSocket-Commands] Conteúdo de 'data':`, data);
                console.log(`[WebSocket-Commands] Extracted from data - childId: ${childId}, childName: ${childName}`);
            }

            console.log(`[WebSocket-Commands] Desestruturado - type: ${type}, parentId: ${parentId}, childId (from data): ${childId}, childName (from data): ${childName}`);

            switch (type) {
                case 'parentConnect':
                    currentParentId = parentId; // Atribui à variável de escopo superior
                    clientType = 'parent'; // Atualiza o tipo de cliente
                    // Atualiza a entrada no activeConnections com as informações corretas
                    activeConnections.set(parentId, { ws: ws, type: 'parent', id: parentId });
                    // Remove a entrada temporária do ws.id original se for diferente
                    if (ws.id !== parentId) {
                        activeConnections.delete(ws.id);
                        ws.id = parentId; // Atualiza o ID do WebSocket para o parentId real
                    }
                    // Adiciona ao mapa parentToWebSocket
                    parentToWebSocket.set(parentId, ws);
                    console.log(`[WebSocket-Manager] Conexão parent ${currentParentId} atualizada. Total de entradas: ${activeConnections.size}`);
                    console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${currentParentId}, ouvindo filho: ${childId || 'nenhum'}`);
                    break;
                case 'childConnect':
                    // childId e childName já foram extraídos corretamente do 'data' acima
                    if (childId && parentId) { // Certifica-se de que temos os IDs necessários
                        clientType = 'child'; // Atualiza o tipo de cliente
                        currentChildId = childId; // Atualiza a variável de escopo superior
                        currentParentId = parentId; // Garante que o parentId também esteja no escopo
                        currentChildName = childName || 'Desconhecido'; // Atualiza o nome do filho
                        
                        // Atualiza a entrada no activeConnections com as informações corretas
                        activeConnections.set(childId, { ws: ws, type: 'child', id: childId, parentId: parentId, name: currentChildName });
                        // Remove a entrada temporária do ws.id original se for diferente
                        if (ws.id !== childId) {
                            activeConnections.delete(ws.id);
                            ws.id = childId; // Atualiza o ID do WebSocket para o childId real
                        }
                        // Adiciona ao mapa childToWebSocket
                        childToWebSocket.set(childId, ws);

                        // Atualizar status de conexão no DynamoDB
                        await docClient.update({
                            TableName: DYNAMODB_TABLE_CHILDREN,
                            Key: { childId: childId }, // Usa o childId correto
                            UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity, parentId = :parentId, childName = :childName', // Inclui parentId e childName
                            ExpressionAttributeValues: {
                                ':connected': true,
                                ':lastActivity': new Date().toISOString(),
                                ':parentId': parentId,
                                ':childName': childName // Usa o childName correto
                            }
                        }).promise();
                        console.log(`[DynamoDB] Filho ${childName} (${childId}) status de conexão atualizado para 'true'.`);
                        console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${childId}, Parent ID: ${parentId}, Nome: ${childName}`);
                        
                        // Se há um parent conectado, avisa que o filho está online
                        const parentWs = parentToWebSocket.get(parentId); // Usa parentToWebSocket
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({
                                type: 'childStatus',
                                childId: childId,
                                status: 'online',
                                childName: childName // Envia o nome do filho
                            }));
                            console.log(`[WebSocket-Commands] Notificação de status 'online' enviada para o pai ${parentId} para o filho ${childId}.`);
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem childConnect inválida: childId ou parentId faltando.', finalParsedMessage);
                    }
                    break;
                case 'locationUpdate':
                    // childId e childName já foram extraídos corretamente do 'data' acima
                    const sendingChildInfo = activeConnections.get(ws.id); // Pega a info do cliente que enviou
                    const sendingChildId = sendingChildInfo ? sendingChildInfo.id : null;
                    const childAssociatedParentId = sendingChildInfo ? sendingChildInfo.parentId : null;


                    if (!sendingChildId) {
                        console.warn('[WebSocket-Commands] Mensagem de localização recebida de cliente não identificado.');
                        return;
                    }
                    console.log(`[Location] Localização recebida do filho ${sendingChildId}: Lat ${data.latitude}, Lng ${data.longitude}`);

                    // Salvar no DynamoDB
                    const locationParams = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            locationId: uuidv4(),
                            childId: sendingChildId,
                            latitude: data.latitude,
                            longitude: data.longitude,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(locationParams).promise();

                    // Encaminhar para o pai
                    const connectedParentWsLocation = parentToWebSocket.get(childAssociatedParentId); // Usa parentToWebSocket
                    if (connectedParentWsLocation && connectedParentWsLocation.readyState === WebSocket.OPEN) {
                        connectedParentWsLocation.send(JSON.stringify({
                            type: 'locationUpdate',
                            childId: sendingChildId,
                            latitude: data.latitude,
                            longitude: data.longitude,
                            timestamp: new Date().toISOString()
                        }));
                        console.log(`[Location] Localização do filho ${sendingChildId} encaminhada para o pai ${childAssociatedParentId}.`);
                    }
                    break;
                case 'chatMessage':
                    // childId (targetId) e message já foram extraídos corretamente do 'data' acima
                    const senderClientInfo = activeConnections.get(ws.id);
                    const senderId = senderClientInfo ? senderClientInfo.id : null; // ID de quem está enviando (pai ou filho)
                    const receiverId = data.childId || data.parentId; // ID do receptor (filho ou pai)
                    const senderName = senderClientInfo && senderClientInfo.type === 'child' ? senderClientInfo.name : 'Pai'; // Nome do remetente
                    const receiverClientInfo = activeConnections.get(receiverId); // Usa activeConnections

                    if (!senderId || !receiverId || !data.message) {
                        console.warn('[WebSocket-Commands] Mensagem de chat inválida: IDs ou mensagem ausentes.');
                        return;
                    }
                    console.log(`[Chat] Mensagem de ${senderName} (${senderId}) para ${receiverId}: ${data.message}`);

                    // Salvar no DynamoDB
                    const messageParams = {
                        TableName: DYNAMODB_TABLE_MESSAGES,
                        Item: {
                            conversationId: `${senderClientInfo.type === 'parent' ? senderId : receiverId}-${senderClientInfo.type === 'parent' ? receiverId : senderId}`, // parentId-childId
                            messageId: uuidv4(),
                            parentId: senderClientInfo.type === 'parent' ? senderId : receiverId,
                            childId: senderClientInfo.type === 'child' ? senderId : receiverId,
                            sender: senderId,
                            message: data.message,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(messageParams).promise();
                    console.log(`[DynamoDB] Mensagem de chat salva de ${senderId} para ${receiverId}.`);

                    // Encaminhar para o receptor
                    if (receiverClientInfo && receiverClientInfo.ws && receiverClientInfo.ws.readyState === WebSocket.OPEN) {
                        receiverClientInfo.ws.send(JSON.stringify({
                            type: 'chatMessage',
                            senderId: senderId,
                            receiverId: receiverId,
                            message: data.message,
                            timestamp: new Date().toISOString(),
                            senderName: senderName // Envia o nome do remetente
                        }));
                        console.log(`[Chat] Mensagem encaminhada para ${receiverId}.`);
                    } else {
                        console.warn(`[Chat] Receptor ${receiverId} não encontrado ou offline.`);
                    }
                    break;
                case 'requestLocation':
                    // childId (targetId) já foi extraído corretamente do 'data' acima
                    const requestingClientInfo = activeConnections.get(ws.id);
                    const targetChildIdForLocation = childId;
                    if (!requestingClientInfo || requestingClientInfo.type !== 'parent' || !targetChildIdForLocation) {
                        console.warn('[WebSocket-Commands] Requisição de localização inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de localização inválida.' }));
                        return;
                    }
                    const targetChildClientWsLocation = childToWebSocket.get(targetChildIdForLocation); // Usa childToWebSocket
                    if (targetChildClientWsLocation && targetChildClientWsWsLocation.readyState === WebSocket.OPEN) {
                        targetChildClientWsLocation.send(JSON.stringify({ type: 'requestLocation' }));
                        console.log(`[Location] Requisição de localização enviada para filho ${targetChildIdForLocation}.`);
                        ws.send(JSON.stringify({ type: 'info', message: `Requisição de localização enviada para ${targetChildIdForLocation}.` }));
                    } else {
                        console.warn(`[Location] Filho ${targetChildIdForLocation} não encontrado ou offline para requisição de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${targetChildIdForLocation} offline.` }));
                    }
                    break;
                case 'startAudioStream':
                    // childId (targetId) já foi extraído corretamente do 'data' acima
                    const requestingParentInfo = activeConnections.get(ws.id);
                    const targetChildIdForAudio = childId;
                    console.log(`[Audio-Debug] Recebido 'startAudioStream' do pai ${requestingParentInfo ? requestingParentInfo.id : 'desconhecido'} para filho ${targetChildIdForAudio}. ClientType: ${requestingParentInfo ? requestingParentInfo.type : 'desconhecido'}`);
                    if (!requestingParentInfo || requestingParentInfo.type !== 'parent' || !targetChildIdForAudio) {
                        console.warn('[WebSocket-Commands] Requisição de áudio inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de áudio inválida.' }));
                        return;
                    }
                    
                    // >>> MODIFICAÇÃO CRÍTICA: Procura a conexão de áudio no mapa DEDICADO activeAudioClients
                    let audioWsOfChild = null;
                    for (const [audioWsInstance, clientInfo] of activeAudioClients.entries()) {
                        if (clientInfo.childId === targetChildIdForAudio && !clientInfo.isParentAudioClient) {
                            audioWsOfChild = audioWsInstance;
                            break;
                        }
                    }

                    console.log(`[Audio-Debug] Tentando encontrar WS de áudio do filho ${targetChildIdForAudio}. Encontrado: ${!!audioWsOfChild}. WS de Áudio Aberto: ${!!audioWsOfChild?.readyState === WebSocket.OPEN}`);
                    if (audioWsOfChild && audioWsOfChild.readyState === WebSocket.OPEN) {
                        // Envia um comando JSON para o AudioStreamingService do filho
                        // O Android irá ouvir por { "type": "startRecording" }
                        audioWsOfChild.send(JSON.stringify({ type: 'startRecording' }));
                        console.log(`[Audio-Server] Comando 'startRecording' enviado para o filho ${targetChildIdForAudio} via WS de áudio.`);

                        // Opcional: Notifique o PARENT (quem enviou o comando) que deu certo
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'sent',
                            childId: targetChildIdForAudio,
                            message: `Comando 'startRecording' enviado para ${targetChildIdForAudio}.`
                        }));
                    } else {
                        console.warn(`[Audio-Server] Filho ${targetChildIdForAudio} NÃO ENCONTRADO ou offline para comando de áudio.`);
                        // Para depuração, veja quais IDs estão no mapa activeAudioClients
                        console.log(`[Audio-Server-Debug] Conexões de áudio ativas (IDs): ${Array.from(activeAudioClients.values()).map(c => c.childId).filter(Boolean)}`);

                        // Opcional: Notifique o PARENT que o filho não está disponível
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdForAudio,
                            message: `Filho ${targetChildIdForAudio} offline ou não conectado ao WS de áudio.`
                        }));
                    }
                    break;
                case 'stopAudioStream':
                    // childId (targetId) já foi extraído corretamente do 'data' acima
                    const requestingParentInfoStop = activeConnections.get(ws.id);
                    const targetChildIdForStopAudio = childId;
                    if (!requestingParentInfoStop || requestingParentInfoStop.type !== 'parent' || !targetChildIdForStopAudio) {
                        console.warn('[WebSocket-Commands] Requisição de parada de áudio inválida: não é pai ou childId ausente.');
                        ws.send(JSON.stringify({ type: 'error', message: 'Requisição de parada de áudio inválida.' }));
                        return;
                    }
                    // >>> MODIFICAÇÃO: Procura a conexão de áudio no mapa DEDICADO activeAudioClients
                    let audioWsOfChildStop = null;
                    for (const [audioWsInstance, clientInfo] of activeAudioClients.entries()) {
                        if (clientInfo.childId === targetChildIdForStopAudio && !clientInfo.isParentAudioClient) {
                            audioWsOfChildStop = audioWsInstance;
                            break;
                        }
                    }

                    if (audioWsOfChildStop && audioWsOfChildStop.readyState === WebSocket.OPEN) {
                        audioWsOfChildStop.send(JSON.stringify({ type: 'stopAudioStreamFromServer' }));
                        console.log(`[Audio-Server] Comando 'stopAudioStreamFromServer' enviado para o filho ${targetChildIdForStopAudio} via WS de áudio.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'stopped',
                            childId: targetChildIdForStopAudio,
                            message: `Comando 'stopAudioStreamFromServer' enviado para ${targetChildIdForStopAudio}.`
                        }));
                    } else {
                        console.warn(`[Audio-Server] Filho ${targetChildIdForStopAudio} não encontrado ou offline para comando de parada de áudio.`);
                        ws.send(JSON.stringify({
                            type: 'audioCommandStatus',
                            status: 'childOffline',
                            childId: targetChildIdForStopAudio,
                            message: `Filho ${targetChildIdForStopAudio} offline ou não conectado ao WS de áudio para parada.`
                        }));
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
        
        const disconnectedClientInfo = activeConnections.get(ws.id);
        if (disconnectedClientInfo) {
            clientType = disconnectedClientInfo.type; // Atualiza o clientType com base na info armazenada
            currentChildId = disconnectedClientInfo.id; // Se for filho, pega o ID real
            currentParentId = disconnectedClientInfo.parentId; // Se for filho, pega o parentId
            currentChildName = disconnectedClientInfo.name; // Se for filho, pega o nome

            activeConnections.delete(ws.id); // Remove a conexão do mapa principal
            // Remove do childToWebSocket ou parentToWebSocket
            if (clientType === 'child' && currentChildId) {
                childToWebSocket.delete(currentChildId);
            } else if (clientType === 'parent' && currentParentId) {
                parentToWebSocket.delete(currentParentId);
            }

            if (clientType === 'child' && currentChildId) {
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
                        console.log(`[WebSocket-Commands] Notificação de status 'offline' enviada para o pai ${currentParentId} para o filho ${currentChildId}.`);
                    }

                } catch (error) {
                    console.error('Erro ao atualizar status de conexão do filho no DynamoDB:', error);
                }
            }
        } else {
            console.warn(`[WebSocket-Commands] Cliente desconectado com ID ${ws.id} não encontrado em activeConnections.`);
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas: ${activeConnections.size}`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no cliente WebSocket:', error);
        // Em caso de erro, também é bom remover para evitar referências quebradas
        const erroredClientInfo = activeConnections.get(ws.id);
        if (erroredClientInfo) {
            activeConnections.delete(ws.id);
            if (erroredClientInfo.type === 'child' && erroredClientInfo.id) {
                childToWebSocket.delete(erroredClientInfo.id);
            } else if (erroredClientInfo.type === 'parent' && erroredClientInfo.id) {
                parentToWebSocket.delete(erroredClientInfo.id);
            }
            // Tentar atualizar status no DynamoDB se for um filho
            if (erroredClientInfo.type === 'child' && erroredClientInfo.id) {
                docClient.update({
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: erroredClientInfo.id },
                    UpdateExpression: 'SET connected = :connected',
                    ExpressionAttributeValues: { ':connected': false }
                }).promise().catch(e => console.error('Erro ao atualizar status de conexão do filho após erro WS:', e));
            }
        }
    });
});

// WebSocket Server para Áudio
const wssAudio = new WebSocket.Server({ noServer: true });

wssAudio.on('connection', (ws, req) => { // Adicionado 'req' para acessar os parâmetros da URL
    const parameters = url.parse(req.url, true).query;
    const childId = parameters.childId;
    const parentId = parameters.parentId; // Opcional, para logs ou futura lógica

    if (!childId) {
        console.error("[Audio-WS] Conexão de áudio rejeitada: childId ausente nos parâmetros da URL.");
        ws.close();
        return;
    }

    // >>> MODIFICAÇÃO CRÍTICA: REGISTRA A CONEXÃO DE ÁUDIO NO MAPA DEDICADO activeAudioClients
    // A chave é a instância do WebSocket, o valor é um objeto com os detalhes do cliente
    activeAudioClients.set(ws, { childId: childId, parentId: parentId, isParentAudioClient: false });
    console.log(`[Audio-WS] Filho ${childId} conectado ao WebSocket de áudio. Parent: ${parentId}. Total de conexões de áudio: ${activeAudioClients.size}`);

    ws.on('message', message => {
        // Este `message` DEVE ser o buffer de áudio binário do cliente Android.
        // O servidor vai encaminhar este `message` para os clientes pais que estão ouvindo.
        
        try {
            // Tenta parsear como JSON para verificar se é um comando de controle do cliente de áudio (ex: 'audioStopped')
            const textMessage = message.toString('utf8'); // Converte o buffer para string para tentar parsear JSON
            if (textMessage.startsWith('{') && textMessage.endsWith('}')) {
                const audioControlMessage = JSON.parse(textMessage);
                console.log(`[Audio-WS] Recebida mensagem de controle do filho ${childId}:`, audioControlMessage);
                if (audioControlMessage.type === 'audioStopped') {
                    console.log(`[Audio-WS] Filho ${childId} relatou que parou de transmitir áudio.`);
                    // Lógica para notificar os pais, se necessário
                }
            } else if (Buffer.isBuffer(message)) {
                // É um buffer de áudio binário. Encaminhe para os pais que estão ouvindo.
                // TODO: Implementar a lógica para encaminhar este 'message' (Buffer) para os clientes PAIS.
                // Você precisaria de um mecanismo para saber qual pai está ouvindo qual filho.
                // Exemplo: um mapa como `parentListeningToChildMap: parentId -> childId`
                // Ou iterar sobre `parentToWebSocket` e verificar se o pai está "ouvindo" este childId.
                parentToWebSocket.forEach((parentWs, pId) => {
                    // Aqui você precisaria de uma lógica para saber se este 'pId' está ouvindo 'childId'
                    // Por simplicidade, vamos enviar para TODOS os pais conectados no canal de comando por enquanto.
                    // Em um sistema real, você teria um estado para saber quais pais estão ouvindo qual filho.
                    if (parentWs.readyState === WebSocket.OPEN) {
                        // Envia o áudio como um buffer binário diretamente para o pai
                        parentWs.send(message); 
                        // Ou, se o cliente pai espera JSON com base64:
                        // parentWs.send(JSON.stringify({ type: 'audioData', childId: childId, data: message.toString('base64') }));
                    }
                });
                // console.log(`[Audio-WS] Recebido buffer de áudio do filho ${childId}. Tamanho: ${message.length} bytes. Encaminhando.`);
            }
        } catch (error) {
            console.error(`[Audio-WS] Erro ao processar mensagem do filho ${childId}: ${error.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[Audio-WS] Filho ${childId} desconectado do WebSocket de áudio. Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        // >>> MODIFICAÇÃO CRÍTICA: REMOVE A CONEXÃO DE ÁUDIO QUANDO O FILHO DESCONECTA
        activeAudioClients.delete(ws); // Remove pela instância do WS
        console.log(`[Audio-WS] Conexão de áudio de ${childId} removida. Total: ${activeAudioClients.size}`);
    });

    ws.on('error', error => {
        console.error(`[Audio-WS] Erro no WebSocket de áudio para ${childId}:`, error);
        // >>> MODIFICAÇÃO CRÍTICA: REMOVE EM CASO DE ERRO TAMBÉM
        activeAudioClients.delete(ws); // Remove pela instância do WS
    });
});


// Função auxiliar para atualizar o status de conexão no DynamoDB
// Esta função não foi alterada, mas é chamada pelos manipuladores de WS.
async function updateChildConnectionStatus(childId, connected) {
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Key: { childId: childId },
        UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
        ExpressionAttributeValues: {
            ':connected': connected,
            ':lastActivity': new Date().toISOString()
        }
    };
    try {
        await docClient.update(params).promise();
        console.log(`Status de conexão para ${childId} atualizado para ${connected}.`);
    } catch (error) {
        console.error(`Erro ao atualizar status de conexão para ${childId}:`, error);
    }
}


// Lidar com upgrade de HTTP para WebSocket
server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    console.log(`[HTTP-Upgrade] Tentativa de upgrade para pathname: ${pathname}`);

    if (pathname === '/ws-commands') {
        wssCommands.handleUpgrade(request, socket, head, ws => {
            wssCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio') {
        wssAudio.handleUpgrade(request, socket, head, ws => {
            wssAudio.emit('connection', ws, request); // Passa 'request' para wssAudio.on('connection')
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
});