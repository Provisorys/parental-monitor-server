const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url'); // Adicione esta linha para usar url.parse

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

// --- Variáveis para Controle de WebSockets ---
// Mapas para os WebSockets de COMANDOS/GPS/MENSAGENS
const wsClientsMap = new Map(); // Chave: (childId ou parentId) -> Valor: WebSocket do cliente
// Mapas para os WebSockets de ÁUDIO
const audioWsClientsMap = new Map(); // Mapa: childId -> WebSocket do cliente (para áudio)

// --- Variáveis para Controle de WebSockets (AGORA COM ADIÇÕES) ---
const parentListeningSockets = new Map(); // Mapa: childId -> WebSocket do pai que está ouvindo (para áudio)

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rota de teste
app.get('/', (req, res) => {
    res.send('Servidor do Parental Monitor está ativo!');
});

// Rota para registrar uma nova criança
app.post('/register-child', async (req, res) => {
    const { parentId, childName, childToken, childImage } = req.body; // childToken é para Firebase/FCM

    if (!parentId || !childName) {
        return res.status(400).send('Parent ID e Nome da Criança são obrigatórios.');
    }

    const childId = uuidv4(); // Gera um ID único para a criança

    const params = {
        TableName: 'Children', // Tabela para armazenar informações das crianças
        Item: {
            childId: childId,
            parentId: parentId,
            childName: childName,
            childToken: childToken, // Armazena o token para notificações
            childImage: childImage, // Opcional
            registrationDate: new Date().toISOString()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Criança registrada com sucesso: ${childName} (ID: ${childId})`);
        res.status(200).json({ message: 'Criança registrada com sucesso!', childId: childId });
    } catch (error) {
        console.error('[DynamoDB] Erro ao registrar criança:', error);
        res.status(500).send('Erro ao registrar criança.');
    }
});


// Rota para upload de mídias (áudio, fotos, etc.)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file || !req.body.childId || !req.body.type) {
        return res.status(400).send('Dados incompletos para upload de mídia.');
    }

    const { childId, type, timestamp } = req.body;
    const file = req.file;
    const mediaId = uuidv4();
    const fileName = `${childId}/${type}/${mediaId}-${timestamp || Date.now()}.${file.originalname.split('.').pop()}`;

    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype
    };

    try {
        const data = await s3.upload(params).promise();
        console.log(`[S3] Mídia ${fileName} enviada com sucesso para S3: ${data.Location}`);

        // Opcional: Salvar metadados da mídia no DynamoDB se necessário para indexação
        // Exemplo:
        // const mediaMetadataParams = {
        //     TableName: 'ChildMedia',
        //     Item: {
        //         mediaId: mediaId,
        //         childId: childId,
        //         type: type,
        //         s3Url: data.Location,
        //         timestamp: timestamp || Date.now()
        //     }
        // };
        // await docClient.put(mediaMetadataParams).promise();
        // console.log(`[DynamoDB] Metadados da mídia ${mediaId} salvos.`);

        res.status(200).json({ message: 'Mídia enviada com sucesso!', url: data.Location });
    } catch (error) {
        console.error('[S3] Erro ao enviar mídia para S3:', error);
        res.status(500).send('Erro ao enviar mídia.');
    }
});

// Criar servidor HTTP para Express e WebSockets
const server = http.createServer(app);

// WebSocket Server para COMANDOS (GPS, Chat, etc.)
const wssCommands = new WebSocket.Server({ noServer: true });

wssCommands.on('connection', ws => {
    console.log('[WebSocket-Commands] Cliente conectado.');

    ws.on('message', async message => {
        try {
            const parsedMessage = JSON.parse(message);
            const { type, childId, parentId, data } = parsedMessage;

            switch (type) {
                case 'init':
                    // Um cliente (pai ou filho) se inicializa
                    if (childId) {
                        wsClientsMap.set(childId, ws);
                        console.log(`[WebSocket-Commands] Filho conectado: ${childId}`);
                        // Enviar confirmação ou status para o cliente filho
                        ws.send(JSON.stringify({ type: 'status', message: 'Conectado como filho.' }));
                    } else if (parentId) {
                        // Um pai se conectou, mas ainda não está "ouvindo" um filho específico
                        // O parentId pode ser usado para futuras comunicações diretas com o pai
                        console.log(`[WebSocket-Commands] Pai conectado: ${parentId}`);
                        ws.send(JSON.stringify({ type: 'status', message: 'Conectado como pai.' }));
                    }
                    break;

                case 'locationUpdate':
                    // Receber atualização de localização de um filho
                    if (childId && data && data.latitude && data.longitude) {
                        const locationParams = {
                            TableName: DYNAMODB_TABLE_LOCATIONS,
                            Item: {
                                childId: childId,
                                timestamp: new Date().toISOString(), // ou data.timestamp se vier do cliente
                                latitude: data.latitude,
                                longitude: data.longitude,
                                accuracy: data.accuracy, // Adicionar precisão
                                speed: data.speed // Adicionar velocidade
                            }
                        };
                        try {
                            await docClient.put(locationParams).promise();
                            console.log(`[DynamoDB] Localização do filho ${childId} salva.`);

                            // Enviar localização para pais que estão ouvindo este childId
                            const parentSocket = parentListeningSockets.get(childId);
                            if (parentSocket && parentSocket.readyState === WebSocket.OPEN) {
                                parentSocket.send(JSON.stringify({
                                    type: 'locationUpdate',
                                    data: locationParams.Item
                                }));
                                console.log(`[WebSocket-Commands] Localização de ${childId} enviada ao pai.`);
                            }
                        } catch (error) {
                            console.error('[DynamoDB] Erro ao salvar localização:', error);
                        }
                    }
                    break;

                case 'requestLocation':
                    // Pai requisita localização de um filho
                    if (childId && parentId) {
                        const childSocket = wsClientsMap.get(childId);
                        if (childSocket && childSocket.readyState === WebSocket.OPEN) {
                            childSocket.send(JSON.stringify({ type: 'requestLocation' }));
                            console.log(`[WebSocket-Commands] Requisição de localização para ${childId} enviada.`);
                            // Opcional: Adicionar o pai à lista de ouvintes de localização para este filho
                            parentListeningSockets.set(childId, wsClientsMap.get(parentId || childId)); // Assumindo que o WS do pai está no wsClientsMap ou usando o childId para o pai que requisitou
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Filho offline ou não conectado.' }));
                            console.warn(`[WebSocket-Commands] Filho ${childId} não encontrado para requisição de localização.`);
                        }
                    }
                    break;

                case 'sendMessage':
                    // Receber mensagem de chat (filho -> pai ou pai -> filho)
                    const { senderId, receiverId, content, mediaUrl } = data;
                    if (senderId && receiverId && content) {
                        const messageParams = {
                            TableName: DYNAMODB_TABLE_MESSAGES,
                            Item: {
                                messageId: uuidv4(),
                                conversationId: [senderId, receiverId].sort().join('-'), // Garante ID de conversa único para par
                                senderId: senderId,
                                receiverId: receiverId,
                                content: content,
                                mediaUrl: mediaUrl, // Opcional
                                timestamp: new Date().toISOString()
                            }
                        };
                        try {
                            await docClient.put(messageParams).promise();
                            console.log(`[DynamoDB] Mensagem de ${senderId} para ${receiverId} salva.`);

                            // Enviar mensagem para o destinatário via WebSocket se estiver online
                            const receiverSocket = wsClientsMap.get(receiverId);
                            if (receiverSocket && receiverSocket.readyState === WebSocket.OPEN) {
                                receiverSocket.send(JSON.stringify({
                                    type: 'newMessage',
                                    data: messageParams.Item
                                }));
                                console.log(`[WebSocket-Commands] Mensagem enviada via WS para ${receiverId}.`);
                            } else {
                                console.warn(`[WebSocket-Commands] Destinatário ${receiverId} offline. Mensagem salva, mas não entregue via WS.`);
                                // TODO: Implementar notificação push (FCM) para destinatários offline
                            }
                        } catch (error) {
                            console.error('[DynamoDB] Erro ao salvar mensagem:', error);
                        }
                    }
                    break;

                case 'requestMessages':
                    // Pai/Filho requisita histórico de mensagens para uma conversa
                    const { user1Id, user2Id } = data; // user1Id e user2Id são os IDs dos participantes da conversa
                    if (user1Id && user2Id) {
                        const conversationId = [user1Id, user2Id].sort().join('-');
                        const params = {
                            TableName: DYNAMODB_TABLE_MESSAGES,
                            KeyConditionExpression: 'conversationId = :cid',
                            ExpressionAttributeValues: {
                                ':cid': conversationId
                            },
                            ScanIndexForward: true // Ordena por timestamp crescente
                        };
                        try {
                            const result = await docClient.query(params).promise();
                            ws.send(JSON.stringify({
                                type: 'messagesHistory',
                                data: { conversationId: conversationId, messages: result.Items }
                            }));
                            console.log(`[DynamoDB] Histórico de mensagens para ${conversationId} enviado.`);
                        } catch (error) {
                            console.error('[DynamoDB] Erro ao buscar histórico de mensagens:', error);
                        }
                    }
                    break;

                case 'audioCommand':
                    // Comando para iniciar/parar streaming de áudio
                    const { action, targetChildId, parentListeningId } = data; // parentListeningId é o ID do pai que quer ouvir
                    if (targetChildId) {
                        const childAudioSocket = audioWsClientsMap.get(targetChildId);
                        if (childAudioSocket && childAudioSocket.readyState === WebSocket.OPEN) {
                            childAudioSocket.send(JSON.stringify({ type: 'audioControl', action: action }));
                            console.log(`[WebSocket-Commands] Comando de áudio '${action}' enviado para ${targetChildId}.`);

                            if (action === 'start' && parentListeningId) {
                                parentListeningSockets.set(targetChildId, wsClientsMap.get(parentListeningId)); // Armazena o socket do pai para enviar áudio diretamente
                                console.log(`[WebSocket-Commands] Pai ${parentListeningId} agora ouvindo áudio de ${targetChildId}.`);
                            } else if (action === 'stop') {
                                parentListeningSockets.delete(targetChildId);
                                console.log(`[WebSocket-Commands] Pai parou de ouvir áudio de ${targetChildId}.`);
                            }

                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Filho offline ou sem conexão de áudio.' }));
                            console.warn(`[WebSocket-Commands] Filho ${targetChildId} não encontrado para comando de áudio.`);
                        }
                    }
                    break;

                default:
                    console.warn(`[WebSocket-Commands] Tipo de mensagem desconhecido: ${type}`);
            }
        } catch (error) {
            console.error('[WebSocket-Commands] Erro ao processar mensagem JSON:', error);
        }
    });

    ws.on('close', () => {
        // Remover cliente do mapa quando a conexão é fechada
        for (let [id, clientWs] of wsClientsMap.entries()) {
            if (clientWs === ws) {
                wsClientsMap.delete(id);
                console.log(`[WebSocket-Commands] Cliente ${id} desconectado.`);
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no WebSocket:', error);
    });
});

// WebSocket Server para ÁUDIO
const wssAudio = new WebSocket.Server({ noServer: true });

wssAudio.on('connection', ws => {
    // Quando um cliente de áudio se conecta, ele deve enviar um 'init' com childId
    let currentChildId = null;
    console.log('[WebSocket-Audio] Cliente de áudio conectado.');

    ws.on('message', message => {
        if (typeof message === 'string') {
            try {
                const parsedMessage = JSON.parse(message);
                if (parsedMessage.type === 'init' && parsedMessage.childId) {
                    currentChildId = parsedMessage.childId;
                    audioWsClientsMap.set(currentChildId, ws);
                    console.log(`[WebSocket-Audio] Filho ${currentChildId} conectado para streaming de áudio.`);
                    ws.send(JSON.stringify({ type: 'status', message: 'Conectado para áudio.' }));
                } else {
                    console.warn(`[WebSocket-Audio] Mensagem JSON inesperada: ${message}`);
                }
            } catch (e) {
                console.error('[WebSocket-Audio] Erro ao analisar JSON de áudio:', e);
            }
        } else if (message instanceof Buffer && currentChildId) {
            // Reencaminhar dados de áudio para o pai que está ouvindo
            const parentSocket = parentListeningSockets.get(currentChildId);
            if (parentSocket && parentSocket.readyState === WebSocket.OPEN) {
                parentSocket.send(message); // Envia o buffer de áudio diretamente
                // console.log(`[WebSocket-Audio] Áudio de ${currentChildId} encaminhado para o pai.`);
            } else {
                // console.warn(`[WebSocket-Audio] Pai não está ouvindo áudio de ${currentChildId}.`);
            }
        }
    });

    ws.on('close', () => {
        if (currentChildId) {
            audioWsClientsMap.delete(currentChildId);
            parentListeningSockets.delete(currentChildId); // Garante que o pai não está mais ouvindo
            console.log(`[WebSocket-Audio] Filho ${currentChildId} desconectado do streaming de áudio.`);
        } else {
            console.log('[WebSocket-Audio] Cliente de áudio desconectado (ID desconhecido).');
        }
    });

    ws.on('error', error => {
        console.error('[WebSocket-Audio] Erro no WebSocket de áudio:', error);
    });
});


// Upgrade HTTP server para lidar com diferentes caminhos de WebSocket
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


// Middleware para tratamento de rotas não encontradas
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
server.listen(PORT || 10000, '0.0.0.0', () => { // AGORA USA 'server' AO INVÉS DE 'app'
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT || 10000}`);
    console.log(`WebSocket de comandos (GPS, Chat) em: ws://localhost:${PORT || 10000}/ws-commands`);
    console.log(`WebSocket de áudio em: ws://localhost:${PORT || 10000}/ws-audio`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
    console.log(`AWS Access Key ID configurada via env: ${process.env.AWS_ACCESS_KEY_ID ? 'Sim' : 'Não'}`);
    console.log(`AWS Secret Access Key configurada via env: ${process.env.AWS_SECRET_ACCESS_KEY ? 'Sim' : 'Não'}`);    
    console.log(`Constante DYNAMODB_TABLE_MESSAGES: ${DYNAMODB_TABLE_MESSAGES}`);
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
});