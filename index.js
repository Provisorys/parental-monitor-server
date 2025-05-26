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
// Agora, wsClientsMap armazena TODOS os clientes conectados (pais e filhos).
// A chave é o ID do cliente (childId ou parentId), e o valor é o objeto WebSocket.
// O tipo de cliente (child/parent) será armazenado como 'ws.clientType'.
const wsClientsMap = new Map();

// Mapas auxiliares para gerenciar conexões de áudio e pais escutando
const parentListeningAudioSockets = new Map(); // Mapa: childId -> WebSocket do pai QUE ESTÁ OUVINDO O ÁUDIO DE UM FILHO ESPECÍFICO (conexão de comando do pai)
const audioStreamChildSockets = new Map();    // Mapa: childId -> WebSocket do filho que está ENVIANDO ÁUDIO (conexão de áudio do filho)

// --- TWILIO CONFIG ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Rotas HTTP ---
app.use(bodyParser.json()); // Para JSON bodies
app.use(bodyParser.urlencoded({ extended: true })); // Para URL-encoded bodies
app.use(cors()); // Habilita o CORS para todas as rotas

// Rota para verificar o status do servidor
app.get('/', (req, res) => {
    res.send('Servidor Parental Monitor está online e funcionando!');
});

// Rota para registrar um novo pai
app.post('/register-parent', async (req, res) => {
    const { parentId, childId } = req.body;

    if (!parentId || !childId) {
        return res.status(400).send('Parent ID e Child ID são obrigatórios.');
    }

    try {
        // Obter os filhos já associados a este pai
        const parentParams = {
            TableName: 'Parents', // Supondo uma tabela 'Parents' para armazenar pais e seus filhos associados
            Key: { 'parentId': parentId }
        };
        const parentData = await docClient.get(parentParams).promise();
        let associatedChildren = parentData.Item ? new Set(parentData.Item.children) : new Set();

        // Adicionar o novo filho
        associatedChildren.add(childId);

        // Atualizar ou criar o registro do pai com os filhos associados
        const updateParams = {
            TableName: 'Parents',
            Key: { 'parentId': parentId },
            UpdateExpression: 'set children = :c',
            ExpressionAttributeValues: {
                ':c': Array.from(associatedChildren) // Converter Set de volta para Array
            },
            ReturnValues: 'UPDATED_NEW'
        };
        await docClient.update(updateParams).promise();

        res.status(200).send({ message: `Filho ${childId} associado ao pai ${parentId} com sucesso.` });

    } catch (error) {
        console.error('Erro ao registrar pai e associar filho:', error);
        res.status(500).send('Erro ao registrar pai e associar filho.');
    }
});

// Rota para registrar um novo filho
app.post('/register-child', async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
        return res.status(400).send('Child ID é obrigatório.');
    }

    try {
        const params = {
            TableName: 'Children', // Supondo uma tabela 'Children' para registrar filhos
            Item: {
                'childId': childId,
                'registeredAt': Date.now(),
                'status': 'offline' // Estado inicial do filho
            }
        };
        await docClient.put(params).promise();
        res.status(200).send({ message: `Filho ${childId} registrado com sucesso.` });
    } catch (error) {
        console.error('Erro ao registrar filho:', error);
        res.status(500).send('Erro ao registrar filho.');
    }
});


// Rota para obter IDs de filhos associados a um pai
app.get('/get-child-ids/:parentId', async (req, res) => {
    const { parentId } = req.params;

    if (!parentId) {
        return res.status(400).send('Parent ID é obrigatório.');
    }

    try {
        const params = {
            TableName: 'Parents',
            Key: { 'parentId': parentId }
        };
        const data = await docClient.get(params).promise();

        if (data.Item && data.Item.children) {
            res.status(200).json({ childIds: data.Item.children });
        } else {
            res.status(200).json({ childIds: [] }); // Retorna array vazio se não houver filhos
        }
    } catch (error) {
        console.error('Erro ao obter IDs de filhos:', error);
        res.status(500).send('Erro ao obter IDs de filhos.');
    }
});


// Rota para enviar mensagens de texto (SMS) via Twilio
app.post('/send-sms', async (req, res) => {
    const { to, body } = req.body; // 'to' deve ser o número do filho (com código do país, ex: +55119XXXXXXXX)

    if (!to || !body) {
        return res.status(400).send('Destinatário e corpo da mensagem são obrigatórios.');
    }

    try {
        await twilioClient.messages.create({
            to: to,
            from: TWILIO_PHONE_NUMBER,
            body: body
        });
        res.status(200).send('SMS enviado com sucesso!');
    } catch (error) {
        console.error('Erro ao enviar SMS:', error);
        res.status(500).send(`Erro ao enviar SMS: ${error.message}`);
    }
});

// Rota para receber mensagens (webhooks do Twilio)
app.post('/twilio-webhook', (req, res) => {
    // Implemente a lógica para processar mensagens recebidas
    console.log('Mensagem recebida do Twilio:', req.body);
    // Envie uma resposta vazia para o Twilio para evitar retries
    res.status(200).send('');
});

// Rota para upload de mídia (imagens, áudios) para o S3
app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo enviado.');
    }

    const { originalname, buffer, mimetype } = req.file;
    const { conversationId, senderId, receiverId, messageId, mediaType } = req.body;

    if (!conversationId || !senderId || !receiverId || !messageId || !mediaType) {
        return res.status(400).send('Dados da mensagem (conversationId, senderId, receiverId, messageId, mediaType) são obrigatórios.');
    }

    const key = `${conversationId}/${messageId}-${originalname}`;

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        ACL: 'public-read' // Permite acesso público ao arquivo
    };

    try {
        const data = await s3.upload(params).promise();
        const mediaUrl = data.Location; // URL pública do arquivo no S3

        // Atualizar o item da mensagem no DynamoDB com a URL da mídia
        const updateParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Key: { 'conversationId': conversationId, 'messageId': messageId },
            UpdateExpression: 'set mediaUrl = :u, mediaType = :t',
            ExpressionAttributeValues: {
                ':u': mediaUrl,
                ':t': mediaType
            },
            ReturnValues: 'UPDATED_NEW'
        };
        await docClient.update(updateParams).promise();

        res.status(200).json({ message: 'Mídia enviada e registrada com sucesso!', mediaUrl: mediaUrl });
    } catch (error) {
        console.error('Erro ao fazer upload da mídia ou atualizar DynamoDB:', error);
        res.status(500).send('Erro ao processar o upload da mídia.');
    }
});

// Rota para salvar mensagens no DynamoDB
app.post('/save-message', async (req, res) => {
    const { conversationId, messageId, senderId, receiverId, content, timestamp, mediaUrl, mediaType } = req.body;

    if (!conversationId || !messageId || !senderId || !receiverId || !content || !timestamp) {
        return res.status(400).send('Todos os campos obrigatórios da mensagem devem ser fornecidos.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            conversationId: conversationId,
            messageId: messageId,
            senderId: senderId,
            receiverId: receiverId,
            content: content,
            timestamp: timestamp,
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || null
        }
    };

    try {
        await docClient.put(params).promise();

        // Atualizar ou criar a conversa
        const conversationParams = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: { 'conversationId': conversationId },
            UpdateExpression: 'SET #ts = :ts, #p1 = :p1, #p2 = :p2, #lastMsg = :lastMsg',
            ExpressionAttributeNames: {
                '#ts': 'lastMessageTimestamp',
                '#p1': 'participant1Id',
                '#p2': 'participant2Id',
                '#lastMsg': 'lastMessageContent'
            },
            ExpressionAttributeValues: {
                ':ts': timestamp,
                ':p1': senderId,
                ':p2': receiverId,
                ':lastMsg': content
            },
            ReturnValues: 'UPDATED_NEW'
        };
        await docClient.update(conversationParams).promise();

        res.status(200).send('Mensagem salva com sucesso!');
    } catch (error) {
        console.error('Erro ao salvar mensagem ou conversa:', error);
        res.status(500).send('Erro ao salvar mensagem ou conversa.');
    }
});

// Rota para obter histórico de mensagens
app.get('/get-messages/:conversationId', async (req, res) => {
    const { conversationId } = req.params;

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        KeyConditionExpression: 'conversationId = :cid',
        ExpressionAttributeValues: {
            ':cid': conversationId
        },
        ScanIndexForward: true // Ordenar por messageId (timestamp) crescente
    };

    try {
        const data = await docClient.query(params).promise();
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao obter mensagens:', error);
        res.status(500).send('Erro ao obter mensagens.');
    }
});

// Rota para salvar localização de um filho
app.post('/save-location', async (req, res) => {
    const { childId, latitude, longitude, timestamp } = req.body;

    if (!childId || !latitude || !longitude || !timestamp) {
        return res.status(400).send('Child ID, latitude, longitude e timestamp são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            childId: childId,
            timestamp: timestamp, // Usado como Range Key
            latitude: latitude,
            longitude: longitude,
            ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // TTL de 7 dias
        }
    };

    try {
        await docClient.put(params).promise();
        res.status(200).send('Localização salva com sucesso!');
    } catch (error) {
        console.error('Erro ao salvar localização:', error);
        res.status(500).send('Erro ao salvar localização.');
    }
});

// Rota para obter a última localização de um filho
app.get('/get-last-location/:childId', async (req, res) => {
    const { childId } = req.params;

    if (!childId) {
        return res.status(400).send('Child ID é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        KeyConditionExpression: 'childId = :cid',
        ExpressionAttributeValues: {
            ':cid': childId
        },
        ScanIndexForward: false, // Última localização (mais recente)
        Limit: 1 // Apenas 1 item
    };

    try {
        const data = await docClient.query(params).promise();
        if (data.Items && data.Items.length > 0) {
            res.status(200).json(data.Items[0]);
        } else {
            res.status(404).send('Localização não encontrada para o filho.');
        }
    } catch (error) {
        console.error('Erro ao obter última localização:', error);
        res.status(500).send('Erro ao obter última localização.');
    }
});

// --- Configuração do servidor HTTP ---
const server = http.createServer(app);

// --- Configuração do WebSocket para Comandos e Status (/ws-commands) ---
const wssCommands = new WebSocket.Server({ server, path: '/ws-commands' });

wssCommands.on('connection', (ws, req) => {
    console.log(`[WS-COMMANDS] Novo cliente conectado no caminho: ${req.url}`);

    ws.clientId = null; // ID do cliente (pai ou filho)
    ws.clientType = null; // Tipo de cliente ('parent' ou 'child')

    ws.on('message', async (message) => {
        const messageString = message.toString();
        try {
            const parsedMessage = JSON.parse(messageString);

            // Identificação do cliente (pai ou filho)
            if (parsedMessage.type === 'parent_id' && parsedMessage.id) {
                ws.clientId = parsedMessage.id;
                ws.clientType = 'parent';
                wsClientsMap.set(parsedMessage.id, ws);
                console.log(`[WS] Pai conectado e identificado: ${ws.clientId}`);
            } else if (parsedMessage.type === 'child_id' && parsedMessage.id) {
                ws.clientId = parsedMessage.id;
                ws.clientType = 'child';
                wsClientsMap.set(parsedMessage.id, ws);
                console.log(`[WS-COMMANDS] Filho conectado e identificado: ${ws.clientId}`);
                // Notificar pais sobre filho online
                wsClientsMap.forEach((clientWs) => {
                    if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN) {
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

            // Lógica para o cliente identificado
            if (ws.clientType === 'parent') {
                if (parsedMessage.type === 'request_current_location' && parsedMessage.childId) {
                    console.log(`[WS-COMMANDS] Pai ${ws.clientId} solicitou localização do filho ${parsedMessage.childId}`);
                    const targetChildWs = wsClientsMap.get(parsedMessage.childId);
                    if (targetChildWs && targetChildWs.clientType === 'child' && targetChildWs.readyState === WebSocket.OPEN) {
                        targetChildWs.send(JSON.stringify({ type: 'request_location_update' }));
                    } else {
                        console.warn(`[WS-COMMANDS] Filho ${parsedMessage.childId} não encontrado ou offline para solicitação de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${parsedMessage.childId} offline ou não conectado.` }));
                    }
                } else if (parsedMessage.type === 'request_audio_stream' && parsedMessage.childId) {
                    // Busca o WS do filho no mapa principal (wsClientsMap) para enviar o comando
                    const targetChildWs = wsClientsMap.get(parsedMessage.childId);
                    if (targetChildWs && targetChildWs.clientType === 'child' && targetChildWs.readyState === WebSocket.OPEN) {
                        console.log(`[WS-COMMANDS] Pai ${ws.clientId} solicitou stream de áudio do filho ${parsedMessage.childId}`);
                        // Registra o WebSocket do pai que está ouvindo o áudio.
                        // O pai continuará a receber o áudio na SUA CONEXÃO DE COMANDO.
                        parentListeningAudioSockets.set(parsedMessage.childId, ws);
                        targetChildWs.send(JSON.stringify({ type: 'start_audio_stream' })); // Manda comando para filho
                    } else {
                        console.warn(`[WS-COMMANDS] Filho ${parsedMessage.childId} não encontrado ou offline para solicitação de áudio.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${parsedMessage.childId} offline ou não conectado para áudio.` }));
                    }
                } else if (parsedMessage.type === 'stop_audio_stream' && parsedMessage.childId) {
                    // Comando para parar ainda vai pela conexão de comandos do filho
                    const targetChildWs = wsClientsMap.get(parsedMessage.childId);
                    if (targetChildWs && targetChildWs.clientType === 'child' && targetChildWs.readyState === WebSocket.OPEN) {
                        console.log(`[WS-COMMANDS] Pai ${ws.clientId} solicitou para parar stream de áudio do filho ${parsedMessage.childId}`);
                        parentListeningAudioSockets.delete(parsedMessage.childId); // Remove o pai do mapa de escuta de áudio
                        targetChildWs.send(JSON.stringify({ type: 'stop_audio_stream' }));
                    } else {
                        console.warn(`[WS-COMMANDS] Filho ${parsedMessage.childId} não encontrado ou offline para parar stream de áudio.`);
                    }
                }
            } else if (ws.clientType === 'child') {
                if (parsedMessage.type === 'location_update' && parsedMessage.location) {
                    const childId = ws.clientId;
                    // Enviar atualização de localização para todos os pais conectados
                    wsClientsMap.forEach((clientWs) => {
                        if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'child_location_update',
                                childId: childId,
                                location: parsedMessage.location,
                                timestamp: parsedMessage.timestamp || Date.now()
                            }));
                        }
                    });
                } else if (parsedMessage.type === 'send_location_to_parents' && parsedMessage.location) {
                    const childId = ws.clientId;
                    wsClientsMap.forEach((clientWs) => {
                        if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'child_location_update',
                                childId: childId,
                                location: parsedMessage.location,
                                timestamp: parsedMessage.timestamp || Date.now()
                            }));
                        }
                    });
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
        console.log(`[WS-COMMANDS] Cliente desconectado: ${ws.clientId || ws.id}. Código: ${code}, Razão: ${reason}`);
        if (ws.clientId) {
            if (ws.clientType === 'child') {
                wsClientsMap.delete(ws.clientId); // Remove do mapa principal
                // Notificar pais sobre filho offline
                wsClientsMap.forEach((clientWs) => { // Itera sobre wsClientsMap para encontrar pais
                    if (clientWs.clientType === 'parent' && clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'child_online_status',
                            childId: ws.clientId,
                            isOnline: false
                        }));
                    }
                });
                // Se o filho estava sendo escutado por um pai para áudio, remover a escuta
                parentListeningAudioSockets.delete(ws.clientId);
            } else if (ws.clientType === 'parent') {
                wsClientsMap.delete(ws.clientId); // Remove o pai do mapa principal
            }
        }
    });

    ws.on('error', (error) => {
        console.error(`[WS-COMMANDS] Erro no WebSocket para cliente ${ws.clientId || ws.id}:`, error);
    });
});

// --- Configuração do WebSocket para Stream de Áudio (/audio-stream) ---
const wssAudio = new WebSocket.Server({ server, path: '/audio-stream' });

wssAudio.on('connection', (ws, req) => {
    console.log(`[WS-AUDIO] Novo cliente conectado no caminho: ${req.url}`);

    ws.clientId = null; // ID do filho que está enviando áudio nesta conexão

    ws.on('message', async (message) => {
        // Lógica para dados de áudio. Pode ser binário ou JSON com Base64.
        // Por padrão, vamos assumir que o áudio é enviado como Buffer (binário).
        // Se o seu app Kodular enviar como JSON (Base64), ajuste a lógica aqui.

        if (typeof message === 'object' && message instanceof Buffer) {
            // Caso 1: Dados de áudio RAW (binários)
            // console.log(`[WS-AUDIO] Dados de áudio binários recebidos de ${ws.clientId}. Tamanho: ${message.length} bytes`); // Log muito verboso
            if (ws.clientId) { // Certifica-se de que o cliente já se identificou
                const parentWs = parentListeningAudioSockets.get(ws.clientId); // Pega o WS do pai (conexão de comando)
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(message); // Encaminha os dados binários diretamente para o pai
                } else {
                    // console.log(`[WS-AUDIO] Pai não está escutando o áudio do filho ${ws.clientId}.`); // Debug
                }
            }
        } else {
            // Caso 2: Mensagem não binária, tentar JSON (para identificação ou dados base64)
            const messageString = message.toString();
            try {
                const parsedMessage = JSON.parse(messageString);
                if (parsedMessage.type === 'child_id' && parsedMessage.id) {
                    // Quando o app filho inicia a conexão de áudio, ele se identifica aqui.
                    ws.clientId = parsedMessage.id;
                    audioStreamChildSockets.set(parsedMessage.id, ws); // Adiciona este WS de áudio do filho ao mapa
                    console.log(`[WS-AUDIO] Filho identificado para stream de áudio: ${ws.clientId}`);
                } else if (parsedMessage.type === 'audio_stream_data' && parsedMessage.data) {
                    // Se o áudio for enviado como JSON com Base64 (menos eficiente)
                    // console.log(`[WS-AUDIO] Dados de áudio Base64 recebidos de ${ws.clientId}.`); // Log muito verboso
                    if (ws.clientId) { // Certifica-se de que o cliente já se identificou
                        const parentWs = parentListeningAudioSockets.get(ws.clientId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({ // Re-envia como JSON para o pai
                                type: 'audio_stream_data',
                                childId: ws.clientId,
                                data: parsedMessage.data
                            }));
                        }
                    }
                }
                // Outras mensagens de controle para a conexão de áudio, se houver
            } catch (e) {
                console.error(`[WS-AUDIO] Erro ao processar mensagem (JSON inválido ou binária não esperada): ${e.message}, Mensagem original: ${messageString}`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem inválido para stream de áudio.' }));
                }
            }
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-AUDIO] Cliente desconectado do stream de áudio: ${ws.clientId || 'desconhecido'}. Código: ${code}, Razão: ${reason}`);
        if (ws.clientId) {
            audioStreamChildSockets.delete(ws.clientId); // Remove o filho do mapa de áudio sockets
            // Importante: NÃO removemos parentListeningAudioSockets aqui, pois o pai ainda pode estar conectado
            // no WS de COMANDOS e esperando. A lógica de stop_audio_stream cuida disso.
        }
    });

    ws.on('error', (error) => {
        console.error(`[WS-AUDIO] Erro no WebSocket de áudio para cliente ${ws.clientId || 'desconhecido'}:`, error);
    });
});

// Tratamento de rotas não encontradas
app.use((req, res) => {
    console.warn(`[HTTP_ERROR] Rota não encontrada: ${req.method} ${req.url}`); // Log
    res.status(404).send('Rota não encontrada');
});

// Tratamento de erros gerais
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
    console.log(`Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'Configurado' : 'Não Configurado'}`);
    console.log(`Twilio Auth Token: ${TWILIO_AUTH_TOKEN ? 'Configurado' : 'Não Configurado'}`);
    console.log(`Twilio Phone Number: ${TWILIO_PHONE_NUMBER || 'Não Configurado'}`);
    console.log(`Servidor WebSocket de COMANDOS configurado para escutar na rota: /ws-commands`);
    console.log(`Servidor WebSocket de ÁUDIO configurado para escutar na rota: /audio-stream`);
});