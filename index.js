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

// --- Rota para Registrar um Filho via HTTP (Mantida, mas a prioridade é o WS) ---
app.post('/register-child', async (req, res) => {
    const { id, childName, parentId } = req.body; // childName já vem do body

    if (!id || !childName || !parentId) {
        return res.status(400).send('ID do filho, nome e ID do pai são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: id, // CORRIGIDO: Usando 'childId' como a chave primária
            childName: childName, // CORRIGIDO: Alterado 'name' para 'childName'
            parentId: parentId,
            registrationDate: new Date().toISOString(),
            connected: false // Assume que não está conectado via WS no momento do registro HTTP
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Filho registrado/atualizado via HTTP: ${childName} (ID: ${id}) para o pai ${parentId}`); // CORRIGIDO: Usando 'childName' no log
        res.status(200).send('Filho registrado com sucesso via HTTP.');
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao registrar filho via HTTP:', error);
        res.status(500).send('Erro ao registrar filho via HTTP.');
    }
});

// --- Rota para Listar Filhos Registrados por Parent ID ---
app.get('/get-registered-children', async (req, res) => {
    const { parentId } = req.query;

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
    };

    if (parentId) {
        params.FilterExpression = 'parentId = :parentId';
        params.ExpressionAttributeValues = { ':parentId': parentId };
    }

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
    const audioFileName = `audio-${uuidv4()}.opus`;
    const s3Key = `conversations/${conversationId}/${audioFileName}`;

    const params = {
        Bucket: s3BucketName,
        Key: s3Key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype
    };

    try {
        await s3.upload(params).promise();
        const audioUrl = `https://${s3BucketName}.s3.${AWS.config.region}.amazonaws.com/${s3Key}`;

        const messageParams = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: {
                messageId: uuidv4(),
                conversationId: conversationId,
                senderId: childId,
                receiverId: parentId,
                type: 'audio',
                content: audioUrl,
                timestamp: new Date().toISOString()
            }
        };
        await docClient.put(messageParams).promise();

        const conversationParams = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: { conversationId: conversationId },
            UpdateExpression: 'SET lastMessage = :lm, lastMessageTimestamp = :lmt',
            ExpressionAttributeValues: {
                ':lm': 'Mensagem de áudio',
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
const server = http.createServer(app);
const wssCommands = new WebSocket.Server({ noServer: true });
const wssAudio = new WebSocket.Server({ noServer: true });

const activeConnections = new Map();

function addActiveConnection(id, type, ws) {
    if (!id || !type || !ws) return;
    ws.id = id;
    ws.type = type;
    activeConnections.set(id, ws);
    console.log(`[WebSocket-Manager] Conexão ${type} adicionada/atualizada: ${id}. Total de conexões ativas: ${activeConnections.size}`);
}

async function removeActiveConnection(id) {
    if (activeConnections.has(id)) {
        const ws = activeConnections.get(id);
        if (ws && ws.type === 'child') {
            const params = {
                TableName: DYNAMODB_TABLE_CHILDREN,
                Key: { childId: ws.id }, // CORRIGIDO: Usando 'childId' como a chave primária
                UpdateExpression: 'SET connected = :connected, lastConnected = :lastConnected',
                ExpressionAttributeValues: {
                    ':connected': false,
                    ':lastConnected': new Date().toISOString()
                },
                ReturnValues: 'UPDATED_NEW'
            };
            try {
                await docClient.update(params).promise();
                console.log(`[DynamoDB] Status de conexão do filho ${ws.id} atualizado para 'false'.`);
            } catch (err) {
                console.error(`[DynamoDB_ERROR] Erro ao atualizar status de desconexão do filho ${ws.id}: ${err.message}`, err);
            }
        }
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

        const { type, childId, parentId, childName, data } = parsedMessage;

        if (type === 'childConnect' && childId && parentId && childName) {
            ws.id = childId;
            ws.type = 'child';
            addActiveConnection(childId, 'child', ws);
            console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${childId}, Parent ID: ${parentId}, Nome: ${childName}`);
            ws.parentId = parentId;

            const params = {
                TableName: DYNAMODB_TABLE_CHILDREN,
                Item: {
                    childId: childId, // CORRIGIDO: Usando 'childId' como a chave primária
                    childName: childName, // CORRIGIDO: Alterado 'name' para 'childName'
                    parentId: parentId,
                    lastConnected: new Date().toISOString(),
                    connected: true
                }
            };
            try {
                await docClient.put(params).promise();
                console.log(`[DynamoDB] Filho ${childName} (${childId}) atualizado/salvo via WS na tabela '${DYNAMODB_TABLE_CHILDREN}'.`);
            } catch (err) {
                console.error(`[DynamoDB_ERROR] Erro ao salvar dados do filho via WS no DynamoDB: ${err.message}`, err);
            }

        } else if (type === 'parentConnect' && parentId && data && data.listeningToChildId) {
            ws.id = parentId;
            ws.type = 'parent';
            ws.listeningToChildId = data.listeningToChildId;
            addActiveConnection(parentId, 'parent', ws);
            console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${parentId}, ouvindo filho: ${ws.listeningToChildId}`);
        } else {
             if (!ws.id) {
                console.warn(`[WebSocket-Commands] Mensagem recebida antes da identificação da conexão: ${JSON.stringify(parsedMessage)}`);
             }
        }

        switch (type) {
            case 'locationUpdate':
                if (childId && data && data.latitude !== undefined && data.longitude !== undefined) {
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

            case 'parentConnect': 
                console.log(`[WebSocket-Commands] Pai ${ws.id} reafirmou conexão, ouvindo filho: ${ws.listeningToChildId}`);
                break;

            case 'childConnect': 
                console.log(`[WebSocket-Commands] Filho ${ws.id} reafirmou conexão (após registro inicial).`);
                break;
            
            case 'requestLocation':
                const requestedChildId = data.childId;
                const requestingParentId = ws.id;

                if (requestedChildId && requestingParentId) {
                    console.log(`[WebSocket-Commands] Pai ${requestingParentId} solicitou localização do filho ${requestedChildId}.`);

                    const childSocket = activeConnections.get(requestedChildId);

                    if (childSocket && childSocket.type === 'child' && childSocket.readyState === WebSocket.OPEN) {
                        childSocket.send(JSON.stringify({
                            type: 'getLocation',
                            requestedBy: requestingParentId
                        }));
                        console.log(`[WebSocket-Commands] Mensagem 'getLocation' enviada para o filho ${requestedChildId}.`);
                        ws.send(JSON.stringify({
                            type: 'locationRequestStatus',
                            childId: requestedChildId,
                            status: 'success',
                            message: 'Solicitação de localização enviada ao filho.'
                        }));
                    } else {
                        console.warn(`[WebSocket-Commands] Filho ${requestedChildId} não encontrado ou não online para responder à solicitação de localização.`);
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

            default:
                console.warn(`[WebSocket-Commands] Tipo de mensagem desconhecido: ${type}`);
                break;
        }
    });

    ws.on('close', async () => {
        if (ws.id) {
            console.log(`[WebSocket-Commands] Cliente desconectado: ID: ${ws.id}, Tipo: ${ws.type || 'desconhecido'}`);
            await removeActiveConnection(ws.id);
        } else {
            console.log('[WebSocket-Commands] Cliente desconectado (ID não definido).');
        }
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no WebSocket:', error);
        if (ws.id) {
            removeActiveConnection(ws.id);
        }
    });
});

// --- WebSocket de Áudio (mantido como está, pode ser removido se não for usar) ---
wssAudio.on('connection', ws => {
    console.log('[WebSocket-Audio] Cliente conectado.');
    ws.on('message', message => {
        console.log('[WebSocket-Audio] Recebida mensagem de áudio (tamanho):', message.length);
        wssAudio.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
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
server.listen(PORT, '0.0.0.0', () => {
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