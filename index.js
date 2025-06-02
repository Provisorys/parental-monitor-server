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
    let clientId = uuidv4(); // ID temporário até ser identificado
    let clientType = 'unknown'; // 'parent' ou 'child'
    let parentId = null;
    let childId = null;

    ws.id = clientId; // Adiciona um ID à instância do WebSocket
    activeConnections.set(ws.id, ws);
    console.log(`[WebSocket-Commands] Novo cliente conectado. Total de entradas: ${activeConnections.size}`);

    ws.on('message', async message => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log('[WebSocket-Commands] Mensagem JSON recebida:', parsedMessage);

            // Desestrutura apenas o 'type' e 'data' do nível superior.
            // parentId está no nível superior, mas também pode ser acessado diretamente.
            const { type, data } = parsedMessage;

            // parentId está no nível superior
            const parentId = parsedMessage.parentId;

            // childId e childName estão dentro do objeto 'data'
            const childId = data && data.childId;
            const childName = data && data.childName; // Adicionado para extrair childName

            console.log(`[WebSocket-Commands] Extracted - type: ${type}, parentId: ${parentId}, childId: ${childId}, childName: ${childName}`);
            // ^ Atualize esta linha para incluir childName no log de extração

            switch (type) {
                case 'parentConnect':
                    parentId = extractedParentId; // Define o parentId para esta conexão
                    clientType = 'parent';
                    parentToWebSocket.set(parentId, ws);
                    activeConnections.set(parentId, ws); // Atualiza activeConnections com o parentId real
                    console.log(`[WebSocket-Manager] Conexão parent ${parentId} atualizada. Total de entradas: ${activeConnections.size}`);
                    console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${parentId}, ouvindo filho: ${childId || 'nenhum'}`);
                    break;
                case 'childConnect':
                    childId = childId; // Define o childId para esta conexão
                    parentId = parentId; // Garante que o parentId também seja definido para o filho
                    clientType = 'child';
                    childToWebSocket.set(childId, ws);
                    activeConnections.set(childId, ws); // Atualiza activeConnections com o childId real
                    console.log(`[WebSocket-Manager] Conexão child ${childId} atualizada. Total de entradas: ${activeConnections.size}`);
                    console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${childId}, Parent ID: ${parentId}, Nome: ${childName}`);

                    // Atualizar status de conexão no DynamoDB
                    await docClient.update({
                        TableName: DYNAMODB_TABLE_CHILDREN,
                        Key: { childId: childId },
                        UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
                        ExpressionAttributeValues: {
                            ':connected': true,
                            ':lastActivity': new Date().toISOString()
                        }
                    }).promise();
                    console.log(`[DynamoDB] Filho ${childName} (${childId}) status de conexão atualizado para 'true'.`);

                    // Se há um parent conectado, avisa que o filho está online
                    const parentWs = parentToWebSocket.get(parentId);
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({
                            type: 'childStatus',
                            childId: childId,
                            status: 'online',
                            childName: childName
                        }));
                    }
                    break;

                case 'locationUpdate':
                    // childId já deve estar definido se foi um childConnect anterior
                    if (!childId) {
                        console.warn('[WebSocket-Commands] Mensagem de localização recebida de cliente não identificado.');
                        return;
                    }
                    console.log(`[Location] Localização recebida do filho ${childId}: Lat ${data.latitude}, Lng ${data.longitude}`);

                    // Salvar no DynamoDB
                    const locationParams = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            locationId: uuidv4(),
                            childId: childId,
                            latitude: data.latitude,
                            longitude: data.longitude,
                            timestamp: new Date().toISOString()
                        }
                    };
                    await docClient.put(locationParams).promise();

                    // Encaminhar para o pai
                    const connectedParentWs = parentToWebSocket.get(parentId); // Usa o parentId da conexão do filho
                    if (connectedParentWs && connectedParentWs.readyState === WebSocket.OPEN) {
                        connectedParentWs.send(JSON.stringify({
                            type: 'locationUpdate',
                            childId: childId,
                            latitude: data.latitude,
                            longitude: data.longitude,
                            timestamp: new Date().toISOString()
                        }));
                    }
                    break;

                case 'chatMessage':
                    // childId ou parentId deve estar definido
                    const senderId = clientType === 'child' ? childId : parentId;
                    const receiverId = clientType === 'child' ? parentId : data.childId; // Se for filho, receptor é o pai. Se for pai, receptor é o filho (data.childId)
                    const senderName = clientType === 'child' ? childName : 'Pai'; // Nome do remetente
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
                    if (clientType !== 'parent' || !childId) { // Use childId do parsedMessage.data
                        console.warn('[WebSocket-Commands] Requisição de localização inválida: não é pai ou childId ausente.');
                        return;
                    }
                    const targetChildWs = childToWebSocket.get(childId);
                    if (targetChildWs && targetChildWs.readyState === WebSocket.OPEN) {
                        targetChildWs.send(JSON.stringify({ type: 'requestLocation' }));
                        console.log(`[Location] Requisição de localização enviada para filho ${childId}.`);
                    } else {
                        console.warn(`[Location] Filho ${childId} não encontrado ou offline para requisição de localização.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${childId} offline.` }));
                    }
                    break;

                case 'startAudioStream':
                    // Pai solicitando início de streaming de áudio de um filho específico
                    if (clientType !== 'parent' || !childId) { // Use childId do parsedMessage.data
                        console.warn('[WebSocket-Commands] Requisição de áudio inválida: não é pai ou childId ausente.');
                        return;
                    }
                    const targetChildWsAudio = childToWebSocket.get(childId); // Acha a conexão de COMANDO do filho
                    if (targetChildWsAudio && targetChildWsAudio.readyState === WebSocket.OPEN) {
                        targetChildWsAudio.send(JSON.stringify({ type: 'startAudioStream' }));
                        console.log(`[Audio] Comando 'startAudioStream' enviado para filho ${childId}.`);
                    } else {
                        console.warn(`[Audio] Filho ${childId} não encontrado ou offline para comando de áudio.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${childId} offline.` }));
                    }
                    break;

                case 'stopAudioStream':
                    // Pai solicitando parada de streaming de áudio de um filho específico
                    if (clientType !== 'parent' || !childId) { // Use childId do parsedMessage.data
                        console.warn('[WebSocket-Commands] Requisição de parada de áudio inválida: não é pai ou childId ausente.');
                        return;
                    }
                    const targetChildWsStopAudio = childToWebSocket.get(childId);
                    if (targetChildWsStopAudio && targetChildWsStopAudio.readyState === WebSocket.OPEN) {
                        targetChildWsStopAudio.send(JSON.stringify({ type: 'stopAudioStream' }));
                        console.log(`[Audio] Comando 'stopAudioStream' enviado para filho ${childId}.`);
                    } else {
                        console.warn(`[Audio] Filho ${childId} não encontrado ou offline para comando de parada de áudio.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Filho ${childId} offline.` }));
                    }
                    break;

                default:
                    console.warn('[WebSocket-Commands] Tipo de mensagem desconhecido:', type);
            }
        } catch (error) {
            console.error('[WebSocket-Commands] Erro ao processar mensagem JSON:', error, 'Mensagem original:', message.toString());
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WebSocket-Commands] Cliente desconectado (ID: ${ws.id || 'desconhecido'}). Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        // Remove a conexão dos mapas
        activeConnections.delete(ws.id);
        if (clientType === 'child' && childId) {
            childToWebSocket.delete(childId);
            // Atualizar status de conexão no DynamoDB
            try {
                await docClient.update({
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: childId },
                    UpdateExpression: 'SET connected = :connected',
                    ExpressionAttributeValues: { ':connected': false }
                }).promise();
                console.log(`[DynamoDB] Filho ${childId} status de conexão atualizado para 'false'.`);

                // Se houver um parent conectado, avisa que o filho está offline
                const parentWs = parentToWebSocket.get(parentId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(JSON.stringify({
                        type: 'childStatus',
                        childId: childId,
                        status: 'offline'
                    }));
                }

            } catch (error) {
                console.error('Erro ao atualizar status de conexão do filho no DynamoDB:', error);
            }
        } else if (clientType === 'parent' && parentId) {
            parentToWebSocket.delete(parentId);
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
        // Tenta parsear a mensagem como JSON para identificação
        try {
            const parsedMessage = JSON.parse(message);
            // console.log('[WebSocket-Audio] Mensagem JSON recebida:', parsedMessage); // Descomente para depurar JSON no WS de áudio

            if (parsedMessage.type === 'childAudioConnect') {
                identifiedChildId = parsedMessage.childId;
                // Opcional: Você pode querer verificar o parentId aqui também
                // identifiedParentId = parsedMessage.parentId; // Se você enviar o parentId na mensagem childAudioConnect
                activeAudioClients.set(ws, { childId: identifiedChildId, parentId: identifiedParentId, isParentAudioClient: false });
                console.log(`[WebSocket-Audio] Cliente de áudio identificado: Child ID: ${identifiedChildId}`);
                return; // Importante: não processe como áudio se for uma mensagem de identificação
            }
        } catch (e) {
            // Se não for JSON, ou for JSON mas não for childAudioConnect, continue para processar como áudio
            // console.log('[WebSocket-Audio] Mensagem não é JSON ou não é identificação, tratando como áudio.');
        }

        // Se a mensagem não é JSON de identificação, ela DEVE ser binária (dados de áudio)
        if (Buffer.isBuffer(message)) {
            if (identifiedChildId) {
                // Encaminha os dados de áudio para o pai(s) que estiver ouvindo este filho
                // AQUI, você precisaria ter uma forma de associar o pai (que está ouvindo) com a conexão de áudio
                // A forma mais robusta seria ter um WebSocket de áudio para o pai também,
                // e o pai se "inscreveria" para ouvir o áudio de um `childId` específico.

                // Por enquanto, vamos retransmitir para todos os pais no canal de comandos (seja cauteloso com isso em escala)
                // ou melhor, para pais que estejam ATIVAMENTE escutando áudio (isso requer mais lógica no servidor)

                // NOVO: Idealmente, você teria um mapa de pais que estão ESCUTANDO áudio:
                // Map<childId, Set<WebSocketParentAudioConnection>>
                // E enviaria o áudio apenas para eles.

                // Para o seu setup atual (onde o pai não tem um WS de áudio separado para recepção),
                // você precisaria que o pai no Kodular estivesse ouvindo o áudio no mesmo WS de comandos
                // ou que o servidor retransmita o áudio para um WS do pai que esteja configurado para receber áudio.

                // Opção 1: Retransmitir para TODOS os pais conectados no WS de comandos (pode ser ineficiente)
                /*
                parentToWebSocket.forEach((parentWs, pId) => {
                    if (parentWs.readyState === WebSocket.OPEN) {
                        // Você precisaria enviar os dados de áudio de volta ao pai, talvez encapsulados
                        // para que o pai saiba de qual filho é o áudio.
                        // Ex: parentWs.send(JSON.stringify({ type: 'audioData', childId: identifiedChildId, data: message.toString('base64') }));
                        // Ou se o pai estiver pronto para receber binário, apenas envie o buffer:
                        // parentWs.send(message); // Isso só funcionaria se o pai souber qual childId é o áudio.
                    }
                });
                */

                // Opção 2: Se o pai se conecta ao `/ws-audio` para OUVIR, ele também precisa se identificar.
                // Isso não está no seu setup atual, mas seria mais robusto.

                // Por enquanto, o log "Mensagem de áudio recebida de cliente não identificado" está acontecendo
                // porque identifiedChildId ainda é null quando os primeiros buffers de áudio chegam.
                // A solução é GARANTIR que a mensagem 'childAudioConnect' é processada primeiro.
                console.log(`[WebSocket-Audio] Áudio recebido de child ID: ${identifiedChildId}. Encaminhando...`);

                // ***** REVISÃO: Lógica de encaminhamento para o pai *****
                // No seu código, você provavelmente quer que o áudio seja enviado de volta para o aplicativo pai.
                // Se o aplicativo pai está usando o mesmo WebSocket de comandos para *receber* áudio (o que é incomum),
                // você precisaria enviar o áudio encapsulado como JSON ou de alguma forma que o pai possa interpretá-lo.
                // Ex:
                parentToWebSocket.forEach((parentWs, pId) => {
                    if (parentWs.readyState === WebSocket.OPEN) {
                        // Envie como um buffer binário ou codifique em base64 se o cliente for JSON-only.
                        // Se o pai tem um Web Audio API (JS), ele pode receber o buffer diretamente.
                        // Se for um aplicativo Android (Kodular), ele provavelmente precisa de uma estrutura.
                        // Para simplificar e mostrar que o áudio está sendo "encaminhado":
                            try {
                                parentWs.send(JSON.stringify({
                                    type: 'audioData',
                                    childId: identifiedChildId,
                                    data: message.toString('base64') // Codifica o buffer em base64 para enviar como JSON
                                }));
                                // console.log(`[WebSocket-Audio] Áudio de ${identifiedChildId} enviado para pai ${pId}.`); // Descomente para depurar
                            } catch (jsonError) {
                                console.error(`[WebSocket-Audio] Erro ao enviar áudio codificado para pai ${pId}:`, jsonError);
                            }
                    }
                });


            } else {
                console.warn('[WebSocket-Audio] Mensagem de áudio recebida de cliente não identificado ou não-filho no WS de áudio.');
            }
        } else {
            console.warn('[WebSocket-Audio] Mensagem não binária e não identificação JSON:', message.toString());
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