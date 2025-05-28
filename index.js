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
const DYNAMODB_TABLE_CHILDREN = 'Children'; // Tabela para informações dos filhos

// --- Configuração do Express (middlewares) ---
app.use(cors()); // Habilita o CORS para todas as rotas
app.use(bodyParser.json()); // Para analisar corpos de requisição JSON
app.use(bodyParser.urlencoded({ extended: true })); // Para analisar corpos de requisição URL-encoded

// --- Rota de Teste ---
app.get('/', (req, res) => {
    res.send('Servidor de Monitoramento Parental Online!');
});

// --- Rota para Registrar um Filho ---
app.post('/register-child', async (req, res) => {
    const { id, name, parentId } = req.body;

    if (!id || !name || !parentId) {
        return res.status(400).send('ID do filho, nome e ID do pai são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            id: id,
            name: name,
            parentId: parentId,
            registrationDate: new Date().toISOString()
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Filho registrado/atualizado: ${name} (ID: ${id}) para o pai ${parentId}`);
        res.status(200).send('Filho registrado com sucesso.');
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao registrar filho:', error);
        res.status(500).send('Erro ao registrar filho.');
    }
});

// --- Rota para Listar Filhos Registrados por Parent ID ---
app.get('/get-registered-children', async (req, res) => {
    // Para listar todos os filhos, ou você pode adicionar um query param `parentId` para filtrar
    // const { parentId } = req.query; // Exemplo de como pegar um parentId do query
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        // Se você quiser filtrar por parentId:
        // FilterExpression: 'parentId = :parentId',
        // ExpressionAttributeValues: { ':parentId': parentId }
    };

    try {
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela '${DYNAMODB_TABLE_CHILDREN}'. Encontrados ${data.Items.length} filhos.`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao listar filhos registrados:', error);
        res.status(500).send('Erro ao listar filhos registrados.');
    }
});

// --- Rotas de Upload de Áudio (mantidas como estão, usando S3) ---
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo de áudio enviado.');
    }

    const { childId, parentId, conversationId } = req.body;
    if (!childId || !parentId || !conversationId) {
        return res.status(400).send('childId, parentId e conversationId são obrigatórios.');
    }

    const s3BucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';
    const audioFileName = `audio-${uuidv4()}.opus`; // Exemplo: usar opus para melhor compatibilidade e compressão
    const s3Key = `conversations/${conversationId}/${audioFileName}`;

    const params = {
        Bucket: s3BucketName,
        Key: s3Key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype // ou 'audio/ogg' se você estiver garantindo que o Kodular envie OGG
    };

    try {
        await s3.upload(params).promise();
        const audioUrl = `https://${s3BucketName}.s3.${AWS.config.region}.amazonaws.com/${s3Key}`;

        // Salvar metadados no DynamoDB (Messages)
        const messageParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: {
                messageId: uuidv4(),
                conversationId: conversationId,
                senderId: childId, // O filho é quem enviou o áudio
                receiverId: parentId, // O pai é o receptor
                type: 'audio',
                content: audioUrl, // URL do áudio no S3
                timestamp: new Date().toISOString()
            }
        };
        await docClient.put(messageParams).promise();

        // Atualizar a última mensagem da conversa (Conversations)
        const conversationParams = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: { conversationId: conversationId },
            UpdateExpression: 'SET lastMessage = :lm, lastMessageTimestamp = :lmt',
            ExpressionAttributeValues: {
                ':lm': 'Mensagem de áudio', // Pode ser mais descritivo
                ':lmt': new Date().toISOString()
            }
        };
        await docClient.update(conversationParams).promise();

        console.log(`[S3] Áudio enviado para S3: ${audioUrl}`);
        res.status(200).json({ message: 'Áudio enviado e registrado com sucesso!', audioUrl: audioUrl });
    } catch (error) {
        console.error('[S3_ERROR] Erro ao fazer upload do áudio ou registrar mensagem:', error);
        res.status(500).send('Erro ao processar o upload do áudio.');
    }
});

// --- Criação do Servidor HTTP e WebSocket ---
const server = http.createServer(app); // Cria um servidor HTTP usando o app Express
const wssCommands = new WebSocket.Server({ noServer: true }); // WebSocket Server para comandos (GPS, Chat)
const wssAudio = new WebSocket.Server({ noServer: true }); // WebSocket Server para áudio (se você quiser stream de áudio, caso contrário, pode remover)

// --- MODIFICAÇÃO NOVA: Mapeamento de Conexões WebSocket ativas ---
// Isso nos permitirá encontrar clientes específicos pelo ID e tipo.
// Usaremos um Map para melhor performance na busca.
const activeConnections = new Map(); // Key: clientId (e.g., childId or parentId), Value: WebSocket instance

// Função auxiliar para adicionar/atualizar conexões
function addActiveConnection(id, type, ws) {
    if (!id || !type || !ws) return;
    ws.id = id; // Atribui o ID ao objeto WebSocket para fácil acesso
    ws.type = type; // Atribui o tipo
    activeConnections.set(id, ws);
    console.log(`[WebSocket-Manager] Conexão ${type} adicionada/atualizada: ${id}. Total de conexões ativas: ${activeConnections.size}`);
}

// Função auxiliar para remover conexões
function removeActiveConnection(id) {
    if (activeConnections.has(id)) {
        activeConnections.delete(id);
        console.log(`[WebSocket-Manager] Conexão removida: ${id}. Total de conexões ativas: ${activeConnections.size}`);
    }
}

// --- WebSocket de Comandos (GPS, Chat) ---
wssCommands.on('connection', ws => {
    console.log('[WebSocket-Commands] Cliente conectado.');

    ws.on('message', async message => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error('[WebSocket-Commands] Erro ao analisar mensagem JSON:', e);
            return;
        }

        const { type, childId, parentId, data } = parsedMessage;

        // --- MODIFICAÇÃO NOVA: Atribui ID e Tipo à conexão na primeira mensagem de identificação ---
        // Isso é crucial para que o `activeConnections` funcione.
        if (type === 'childConnect' && childId) {
            ws.id = childId;
            ws.type = 'child';
            addActiveConnection(childId, 'child', ws);
            console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${childId}, Parent ID: ${parentId}`);
            // Opcional: Se o filho manda o parentId, você pode salvá-lo na conexão também.
            ws.parentId = parentId;
        } else if (type === 'parentConnect' && parentId && data && data.listeningToChildId) {
            ws.id = parentId;
            ws.type = 'parent';
            ws.listeningToChildId = data.listeningToChildId; // Guarda qual filho este pai está ouvindo
            addActiveConnection(parentId, 'parent', ws);
            console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${parentId}, ouvindo filho: ${ws.listeningToChildId}`);
        }

        // --- Processamento de Mensagens ---
        switch (type) {
            case 'locationUpdate':
                if (childId && data && data.latitude !== undefined && data.longitude !== undefined) {
                    // Salvar localização no DynamoDB
                    const params = {
                        TableName: DYNAMODB_TABLE_LOCATIONS,
                        Item: {
                            childId: childId,
                            timestamp: new Date().toISOString(),
                            latitude: data.latitude,
                            longitude: data.longitude
                        }
                    };
                    try {
                        await docClient.put(params).promise();
                        console.log(`[WebSocket-Commands] Localização WS de ${childId} salva: Lat=${data.latitude}, Lng=${data.longitude}`);

                        // --- Tentar encaminhar localização para pais ---
                        console.log(`[DEBUG] Tentando encaminhar localização de ${childId} para pais...`);
                        let parentFoundAndListening = false;
                        activeConnections.forEach(client => {
                            if (client.type === 'parent' && client.listeningToChildId === childId && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'locationUpdate',
                                    childId: childId,
                                    latitude: data.latitude,
                                    longitude: data.longitude,
                                    timestamp: new Date().toISOString()
                                }));
                                console.log(`[WebSocket-Commands] Localização de ${childId} encaminhada para o pai ${client.id}.`);
                                parentFoundAndListening = true;
                            }
                        });
                        if (!parentFoundAndListening) {
                            console.log(`[WebSocket-Commands] NENHUM pai encontrado online ou ouvindo o filho ${childId} para encaminhar a localização.`);
                        }

                    } catch (error) {
                        console.error('[DynamoDB_ERROR] Erro ao salvar localização no DynamoDB:', error);
                    }
                }
                break;

            case 'parentConnect': // Já é tratado na identificação inicial, mas pode ter lógica adicional aqui
                // ws.id, ws.type e ws.listeningToChildId já devem estar definidos.
                console.log(`[WebSocket-Commands] Pai ${ws.id} reafirmou conexão, ouvindo filho: ${ws.listeningToChildId}`);
                break;

            case 'childConnect': // Já é tratado na identificação inicial
                console.log(`[WebSocket-Commands] Filho ${ws.id} reafirmou conexão.`);
                break;

            // --- MODIFICAÇÃO NOVA: Manipulador para solicitação de localização do pai ---
            case 'requestLocation':
                const requestedChildId = data.childId;
                const requestingParentId = ws.id; // O ID do pai que enviou a mensagem

                if (requestedChildId && requestingParentId) {
                    console.log(`[WebSocket-Commands] Pai ${requestingParentId} solicitou localização do filho ${requestedChildId}.`);

                    // Tentar encontrar o WebSocket do filho ativo
                    const childSocket = activeConnections.get(requestedChildId);

                    if (childSocket && childSocket.type === 'child' && childSocket.readyState === WebSocket.OPEN) {
                        // Enviar mensagem para o filho solicitando a localização
                        childSocket.send(JSON.stringify({
                            type: 'getLocation',
                            requestedBy: requestingParentId
                        }));
                        console.log(`[WebSocket-Commands] Mensagem 'getLocation' enviada para o filho ${requestedChildId}.`);
                        // Opcional: Enviar confirmação para o pai
                        ws.send(JSON.stringify({
                            type: 'locationRequestStatus',
                            childId: requestedChildId,
                            status: 'success',
                            message: 'Solicitação de localização enviada ao filho.'
                        }));
                    } else {
                        console.warn(`[WebSocket-Commands] Filho ${requestedChildId} não encontrado ou não online para responder à solicitação de localização.`);
                        // Enviar mensagem de volta para o pai informando que o filho não está online
                        ws.send(JSON.stringify({
                            type: 'locationRequestStatus',
                            childId: requestedChildId,
                            status: 'error',
                            message: 'Filho não está online ou não foi encontrado para responder à solicitação.'
                        }));
                    }
                } else {
                    console.warn('[WebSocket-Commands] Mensagem requestLocation inválida: childId ou parentId ausente.');
                }
                break;
            // --- FIM MODIFICAÇÃO NOVA ---

            // Você pode adicionar outros cases para mensagens de chat, etc.
            default:
                console.warn(`[WebSocket-Commands] Tipo de mensagem desconhecido: ${type}`);
                break;
        }
    });

    ws.on('close', () => {
        if (ws.id) {
            console.log(`[WebSocket-Commands] Cliente desconectado: ID: ${ws.id}, Tipo: ${ws.type || 'desconhecido'}`);
            removeActiveConnection(ws.id);
        } else {
            console.log('[WebSocket-Commands] Cliente desconectado (ID não definido).');
        }
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no WebSocket:', error);
    });
});

// --- WebSocket de Áudio (mantido como está, pode ser removido se não for usar) ---
wssAudio.on('connection', ws => {
    console.log('[WebSocket-Audio] Cliente conectado.');
    ws.on('message', message => {
        // Lógica de manipulação de mensagens de áudio, se necessário
        console.log('[WebSocket-Audio] Recebida mensagem de áudio (tamanho):', message.length);
        // Exemplo: reencaminhar áudio para outro cliente ou processar
        wssAudio.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message); // Reencaminha para todos, exceto o remetente
            }
        });
    });

    ws.on('close', () => {
        console.log('[WebSocket-Audio] Cliente desconectado.');
    });

    ws.on('error', error => {
        console.error('[WebSocket-Audio] Erro no WebSocket de áudio:', error);
    });
});

// --- Roteamento de Upgrade de WebSocket ---
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

// --- Middleware para 404 (rota não encontrada) ---
app.use((req, res) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
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
});