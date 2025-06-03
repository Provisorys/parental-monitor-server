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
// Certifique-se de que suas variáveis de ambiente estão configuradas no ambiente de execução (ex: Render, Heroku, local .env)
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

// Rota para registrar ou atualizar um filho
app.post('/register-child', async (req, res) => {
    const { parentId, childName, childToken, childImage, childId } = req.body;

    if (!parentId || !childName) {
        return res.status(400).json({ message: 'Parent ID e Child Name são obrigatórios.' });
    }

    const idToUse = childId || uuidv4(); // Usa childId se fornecido, senão gera um novo

    try {
        // Tenta buscar o item existente para ver se é uma atualização
        const existingItem = await docClient.get({
            TableName: DYNAMODB_TABLE_CHILDREN,
            Key: { childId: idToUse }
        }).promise();

        if (existingItem.Item) {
            // Se o item já existe, atualize-o
            const updateParams = {
                TableName: DYNAMODB_TABLE_CHILDREN,
                Key: { childId: idToUse },
                UpdateExpression: 'SET parentId = :parentId, childName = :childName, childToken = :childToken, childImage = :childImage, lastConnection = :lastConnection',
                ExpressionAttributeValues: {
                    ':parentId': parentId,
                    ':childName': childName,
                    ':childToken': childToken || null, // Garante que seja null se não fornecido
                    ':childImage': childImage || null, // Garante que seja null se não fornecido
                    ':lastConnection': Date.now()
                },
                ReturnValues: 'UPDATED_NEW'
            };
            await docClient.update(updateParams).promise();
            console.log(`[DynamoDB] Filho ${childName} (ID: ${idToUse}) atualizado com sucesso para o pai ${parentId}.`);
            res.status(200).json({ message: 'Filho atualizado com sucesso!', childId: idToUse });
        } else {
            // Se o item não existe, crie um novo
            const putParams = {
                TableName: DYNAMODB_TABLE_CHILDREN,
                Item: {
                    childId: idToUse,
                    parentId: parentId,
                    childName: childName,
                    childToken: childToken || null,
                    childImage: childImage || null,
                    connectionStatus: false, // Inicia como false no registro HTTP
                    lastConnection: Date.now(),
                    registrationDate: Date.now()
                }
            };
            await docClient.put(putParams).promise();
            console.log(`[DynamoDB] Filho ${childName} (ID: ${idToUse}) registrado com sucesso para o pai ${parentId}.`);
            res.status(200).json({ message: 'Filho registrado com sucesso!', childId: idToUse });
        }
    } catch (error) {
        console.error(`[DynamoDB] Erro ao registrar/atualizar filho: ${error.message}`, error);
        res.status(500).json({ message: 'Erro ao registrar/atualizar filho', error: error.message });
    }
});

// Rota para obter detalhes de um filho
app.get('/child/:childId', async (req, res) => {
    const { childId } = req.params;
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Key: { childId }
    };
    try {
        const data = await docClient.get(params).promise();
        if (data.Item) {
            res.status(200).json(data.Item);
        } else {
            res.status(404).json({ message: 'Filho não encontrado.' });
        }
    } catch (error) {
        console.error(`[DynamoDB] Erro ao obter filho: ${error.message}`, error);
        res.status(500).json({ message: 'Erro ao obter detalhes do filho', error: error.message });
    }
});

// Rota para listar filhos de um pai
app.get('/children/:parentId', async (req, res) => {
    const { parentId } = req.params;
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        FilterExpression: 'parentId = :parentId',
        ExpressionAttributeValues: {
            ':parentId': parentId
        }
    };
    try {
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela 'Children'. Encontrados ${data.Items.length} filhos.`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error(`[DynamoDB] Erro ao listar filhos: ${error.message}`, error);
        res.status(500).json({ message: 'Erro ao listar filhos', error: error.message });
    }
});

// Rota para enviar mensagens de texto (ex: pai para filho)
app.post('/send-message', async (req, res) => {
    const { senderId, receiverId, message, type } = req.body; // type pode ser 'text', 'command' etc.

    if (!senderId || !receiverId || !message || !type) {
        return res.status(400).json({ message: 'Sender ID, Receiver ID, Message e Type são obrigatórios.' });
    }

    const messageId = uuidv4();
    const timestamp = Date.now();

    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            messageId,
            senderId,
            receiverId,
            message,
            type,
            timestamp,
            read: false // Nova mensagem não lida por padrão
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Mensagem de ${senderId} para ${receiverId} (${type}) salva com sucesso.`);

        // Enviar mensagem via WebSocket para o receptor se ele estiver conectado
        const receiverSocket = connectedClients.get(receiverId);
        if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
            receiverSocket.send(JSON.stringify({
                type: 'newMessage',
                messageId,
                senderId,
                receiverId,
                message,
                messageType: type,
                timestamp
            }));
            console.log(`[WebSocket] Mensagem ${messageId} enviada para ${receiverId} via WebSocket.`);
        } else {
            console.log(`[WebSocket] Receptor ${receiverId} não conectado ou socket não está aberto. Mensagem ${messageId} apenas salva.`);
        }
        res.status(200).json({ message: 'Mensagem enviada com sucesso!', messageId });
    } catch (error) {
        console.error(`[DynamoDB] Erro ao enviar mensagem: ${error.message}`, error);
        res.status(500).json({ message: 'Erro ao enviar mensagem', error: error.message });
    }
});

// Rota para obter mensagens de um filho
app.get('/messages/:childId', async (req, res) => {
    const { childId } = req.params;
    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        FilterExpression: 'receiverId = :childId',
        ExpressionAttributeValues: {
            ':childId': childId
        }
    };
    try {
        const data = await docClient.scan(params).promise();
        res.status(200).json(data.Items);
    } catch (error) {
        console.error(`[DynamoDB] Erro ao obter mensagens: ${error.message}`, error);
        res.status(500).json({ message: 'Erro ao obter mensagens', error: error.message });
    }
});

// Rotas para localização (você já tem isso, apenas para referência)
app.post('/location', upload.none(), async (req, res) => {
    const { childId, parentId, latitude, longitude, timestamp } = req.body;
    if (!childId || !parentId || typeof latitude === 'undefined' || typeof longitude === 'undefined' || !timestamp) {
        return res.status(400).json({ message: 'Dados de localização incompletos.' });
    }

    const locationId = uuidv4();
    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            locationId,
            childId,
            parentId,
            latitude,
            longitude,
            timestamp: parseInt(timestamp, 10)
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Localização HTTP (${latitude}, ${longitude}) do filho ${childId} salva.`);
        res.status(200).json({ message: 'Localização recebida e salva (endpoint HTTP).', locationId });
    } catch (error) {
        console.error(`[DynamoDB] Erro ao salvar localização HTTP: ${error.message}`, error);
        res.status(500).json({ message: 'Erro ao salvar localização HTTP', error: error.message });
    }
});

// Rotas de upload de áudio (você já tem isso, apenas para referência)
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
    const { childId, parentId } = req.body;
    if (!req.file || !childId || !parentId) {
        return res.status(400).json({ message: 'Nenhum arquivo de áudio ou IDs fornecidos.' });
    }

    const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';
    const fileName = `audio/${childId}_${Date.now()}.mp3`; // Nome do arquivo no S3

    const params = {
        Bucket: bucketName,
        Key: fileName,
        Body: req.file.buffer, // Buffer do arquivo de áudio
        ContentType: req.file.mimetype // Tipo de conteúdo do arquivo (ex: 'audio/mpeg')
    };

    try {
        const data = await s3.upload(params).promise();
        console.log(`[S3] Áudio de ${childId} carregado para ${data.Location}`);
        res.status(200).json({ message: 'Áudio recebido e salvo no S3.', url: data.Location });
    } catch (error) {
        console.error(`[S3] Erro ao fazer upload de áudio para ${childId}: ${error.message}`, error);
        res.status(500).json({ message: 'Erro ao salvar áudio', error: error.message });
    }
});

// --- WEBSOCKET SERVERS ---
const server = http.createServer(app);
const wssCommands = new WebSocket.Server({ noServer: true });
const wssAudio = new WebSocket.Server({ noServer: true });

const connectedClients = new Map(); // childId -> ws, parentId -> ws

wssCommands.on('connection', ws => {
    console.log('[WebSocket-Commands] Novo cliente conectado. Total de entradas: ' + connectedClients.size);

    ws.on('message', async message => {
        let finalParsedMessage;
        try {
            finalParsedMessage = JSON.parse(message.toString());
        } catch (error) {
            console.error(`[WebSocket-Commands] Erro ao fazer parse da mensagem JSON: ${error.message}`);
            return;
        }

        if (typeof finalParsedMessage !== 'object' || finalParsedMessage === null || !finalParsedMessage.type) {
            console.error(`[WebSocket-Commands] Mensagem JSON inválida ou sem 'type': ${message.toString()}`);
            return;
        }

        console.log(`[WebSocket-Commands] Mensagem JSON recebida (APÓS LÓGICA DE PARSE E VALIDAÇÃO FINAL): ${JSON.stringify(finalParsedMessage)}`);

        const { type, parentId: currentParentId, childId: currentChildId, childName: currentChildName } = finalParsedMessage;

        console.log(`[WebSocket-Commands] DEBUG (before switch) - currentParentId: ${currentParentId}, clientType: ${ws.clientType || 'unknown'}`);


        switch (type) {
            case 'parentConnect':
                if (!currentParentId) {
                    console.error('[WebSocket-Commands] Mensagem parentConnect sem parentId.');
                    return;
                }
                ws.clientType = 'parent';
                ws.parentId = currentParentId;
                connectedClients.set(currentParentId, ws);
                console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${currentParentId}, ouvindo filho: ${finalParsedMessage.data && finalParsedMessage.data[1] ? finalParsedMessage.data[1] : 'nenhum'}`);
                break;

            case 'childConnect':
                if (!currentChildId || !currentParentId || !currentChildName) {
                    console.error('[WebSocket-Commands] Mensagem childConnect sem childId, parentId ou childName. Ignorando conexão.');
                    return;
                }
                ws.clientType = 'child';
                ws.childId = currentChildId;
                ws.parentId = currentParentId;
                connectedClients.set(currentChildId, ws);

                const updateParams = {
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: currentChildId },
                    UpdateExpression: 'SET connectionStatus = :status, lastConnection = :timestamp, parentId = :parentId, childName = :childName',
                    ExpressionAttributeValues: {
                        ':status': true,
                        ':timestamp': Date.now(),
                        ':parentId': currentParentId,
                        ':childName': currentChildName
                    },
                    ReturnValues: 'UPDATED_NEW'
                };

                try {
                    await docClient.update(updateParams).promise();
                    console.log(`[DynamoDB] Filho ${currentChildName} (ID: ${currentChildId}) status de conexão atualizado para 'true'.`);
                } catch (error) {
                    console.error(`[DynamoDB] Erro ao atualizar status de conexão do filho ${currentChildId}: ${error.message}. Isso pode indicar que o ID do filho não existe no DynamoDB.`, error);
                }

                console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${currentChildId}, Parent ID: ${currentParentId}, Nome: ${currentChildName}`);
                break;

            case 'updateLocation':
                if (ws.clientType !== 'child' || !ws.childId || !currentParentId) {
                    console.warn('[WebSocket-Commands] Requisição de localização inválida: não é filho ou childId/parentId ausente.');
                    return;
                }
                const { latitude, longitude, timestamp } = finalParsedMessage;
                if (typeof latitude === 'undefined' || typeof longitude === 'undefined' || !timestamp) {
                    console.warn('[WebSocket-Commands] Dados de localização incompletos.');
                    return;
                }

                const locationId = uuidv4();
                const locationParams = {
                    TableName: DYNAMODB_TABLE_LOCATIONS,
                    Item: {
                        locationId,
                        childId: ws.childId,
                        parentId: currentParentId,
                        latitude,
                        longitude,
                        timestamp
                    }
                };
                try {
                    await docClient.put(locationParams).promise();
                    console.log(`[DynamoDB] Localização (${latitude}, ${longitude}) do filho ${ws.childId} salva.`);
                } catch (error) {
                    console.error(`[DynamoDB] Erro ao salvar localização: ${error.message}`, error);
                }

                // Enviar localização para o pai, se conectado
                const parentSocket = connectedClients.get(ws.parentId);
                if (parentSocket && parentSocket.readyState === WebSocket.OPEN) {
                    parentSocket.send(JSON.stringify({
                        type: 'childLocationUpdate',
                        childId: ws.childId,
                        latitude,
                        longitude,
                        timestamp
                    }));
                    console.log(`[WebSocket] Localização do filho ${ws.childId} enviada para o pai ${ws.parentId}.`);
                }
                break;

            case 'requestLocation':
                if (ws.clientType !== 'parent' || !finalParsedMessage.data || finalParsedMessage.data.length < 2 || finalParsedMessage.data[0] !== 'childId') {
                    console.warn('[WebSocket-Commands] Requisição de localização inválida: não é pai ou childId ausente.');
                    return;
                }
                const targetChildId = finalParsedMessage.data[1];
                const childSocket = connectedClients.get(targetChildId);
                if (childSocket && childSocket.readyState === WebSocket.OPEN) {
                    childSocket.send(JSON.stringify({ type: 'getLocation' }));
                    console.log(`[WebSocket] Solicitação de localização enviada para o filho ${targetChildId}.`);
                } else {
                    console.log(`[WebSocket] Filho ${targetChildId} não conectado para solicitar localização.`);
                }
                break;

            case 'sendMessage':
                if (!ws.clientType || (!ws.childId && !ws.parentId)) {
                    console.warn('[WebSocket-Commands] Cliente não identificado tentando enviar mensagem.');
                    return;
                }
                const sender = ws.clientType === 'parent' ? ws.parentId : ws.childId;
                const receiver = finalParsedMessage.receiverId;
                const messageText = finalParsedMessage.message;
                const messageType = finalParsedMessage.messageType || 'text';

                try {
                    const reqBody = {
                        senderId: sender,
                        receiverId: receiver,
                        message: messageText,
                        type: messageType
                    };

                    const response = await new Promise((resolve, reject) => {
                        const httpRequest = http.request({
                            hostname: 'localhost',
                            port: PORT,
                            path: '/send-message',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(JSON.stringify(reqBody))
                            }
                        }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => resolve(JSON.parse(data)));
                        });
                        httpRequest.on('error', reject);
                        httpRequest.write(JSON.stringify(reqBody));
                        httpRequest.end();
                    });

                    if (response && response.messageId) {
                        console.log(`[WebSocket-Commands] Mensagem de ${sender} para ${receiver} processada via rota HTTP interna. Message ID: ${response.messageId}`);
                    } else {
                        console.error(`[WebSocket-Commands] Falha ao processar mensagem de ${sender} para ${receiver} via rota HTTP interna.`);
                    }

                } catch (error) {
                    console.error(`[WebSocket-Commands] Erro ao retransmitir mensagem via HTTP interno: ${error.message}`, error);
                }
                break;

            default:
                console.warn(`[WebSocket-Commands] Tipo de mensagem desconhecido: ${type}`);
        }
    });

    ws.on('close', async (code, reason) => {
        const clientId = ws.childId || ws.parentId || 'N/A';
        console.log(`[WebSocket-Commands] Cliente desconectado (ID: ${clientId}). Código: ${code}, Razão: ${reason}`);
        if (ws.clientType === 'child' && ws.childId) {
            connectedClients.delete(ws.childId);
            const params = {
                TableName: DYNAMODB_TABLE_CHILDREN,
                Key: { childId: ws.childId },
                UpdateExpression: 'SET connectionStatus = :status',
                ExpressionAttributeValues: {
                    ':status': false
                },
                ReturnValues: 'UPDATED_NEW'
            };
            try {
                await docClient.update(params).promise();
                console.log(`[DynamoDB] Filho ${ws.childId} status de conexão atualizado para 'false'.`);
            } catch (error) {
                console.error(`[DynamoDB] Erro ao atualizar status de desconexão do filho ${ws.childId}: ${error.message}`, error);
            }
        } else if (ws.clientType === 'parent' && ws.parentId) {
            connectedClients.delete(ws.parentId);
            // Poderia atualizar o status do pai no DynamoDB também, se necessário
        }
        console.log(`[WebSocket-Manager] Total de entradas ativas: ${connectedClients.size}`);
    });

    ws.on('error', error => {
        console.error(`[WebSocket-Commands] Erro no WebSocket: ${error.message}`);
    });
});

wssAudio.on('connection', ws => {
    console.log('[WebSocket-Audio] Novo cliente de áudio conectado.');

    ws.on('message', message => {
        if (typeof message === 'string') {
            try {
                const data = JSON.parse(message);
                if (data.type === 'audioConnect' && data.childId) {
                    ws.childId = data.childId;
                    console.log(`[WebSocket-Audio] Cliente de áudio identificado: ${ws.childId}`);
                }
            } catch (e) {
                console.error('[WebSocket-Audio] Erro ao parsear mensagem de identificação:', e);
            }
        } else if (ws.childId) {
            const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';
            const fileName = `audio/${ws.childId}_${Date.now()}.mp3`; // Ou outro formato adequado

            const params = {
                Bucket: bucketName,
                Key: fileName,
                Body: message, // O próprio buffer de áudio
                ContentType: 'audio/mpeg' // Ou 'audio/webm', 'audio/aac' etc., dependendo do formato de gravação
            };

            s3.upload(params, (err, data) => {
                if (err) {
                    console.error(`[S3] Erro ao fazer upload de áudio para ${ws.childId}:`, err);
                } else {
                    console.log(`[S3] Áudio de ${ws.childId} carregado para ${data.Location}`);
                }
            });
        }
    });

    ws.on('close', () => {
        console.log(`[WebSocket-Audio] Cliente de áudio desconectado: ${ws.childId || 'N/A'}.`);
    });

    ws.on('error', error => {
        console.error(`[WebSocket-Audio] Erro no WebSocket de áudio: ${error.message}`);
    });
});

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
});