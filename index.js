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

// --- Constantes para Nomes de Tabelas DynamoDB ---
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const DYNAMODB_TABLE_CHILDREN = 'Children';

// --- Configuração do Express (middlewares) ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Rota de Teste ---
app.get('/', (req, res) => {
    res.send('Servidor de Monitoramento Parental Online!');
});

// --- Rota para Registrar um Filho via HTTP ---
app.post('/register-child', async (req, res) => {
    const { id, childName, parentId } = req.body;

    if (!id || !childName || !parentId) {
        return res.status(400).send('ID do filho, nome e ID do pai são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: id,
            childName: childName,
            parentId: parentId,
            registrationDate: new Date().toISOString(),
            connected: false
        }
    };

    try {
        await docClient.put(params).promise();
        console.log(`[DynamoDB] Filho registrado/atualizado via HTTP: ${childName} (ID: ${id}) para o pai ${parentId}`);
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

// <<< AJUSTE: Mudar a estrutura de activeConnections
// Agora, armazena um objeto para cada cliente com suas conexões de comando e áudio.
const activeConnections = new Map(); // Map<ID, { wsCommands?: WebSocket, wsAudio?: WebSocket, type: string, listeningToChildId?: string, childName?: string, parentId?: string }>

// <<< AJUSTE: Função para atualizar/adicionar conexões
function updateConnection(id, connectionType, ws, additionalProps = {}) {
    let entry = activeConnections.get(id);

    if (!entry) { // Se a entrada não existe, cria uma nova
        entry = { type: connectionType };
        activeConnections.set(id, entry);
    } else { // Se já existe, garante que o tipo está correto
        entry.type = connectionType;
    }

    // Associa o WebSocket correto
    if (ws.url && ws.url.includes('/ws-commands')) {
        entry.wsCommands = ws;
        ws.id = id; // Define o ID diretamente no objeto WS para referência rápida
        ws.type = connectionType;
    } else if (ws.url && ws.url.includes('/ws-audio')) {
        entry.wsAudio = ws;
        ws.id = id; // Define o ID diretamente no objeto WS para referência rápida
        ws.type = connectionType;
    }

    // Adiciona propriedades adicionais
    Object.assign(entry, additionalProps);

    console.log(`[WebSocket-Manager] Conexão ${connectionType} ${id} atualizada. Total de entradas: ${activeConnections.size}`);
    // console.log("Current activeConnections state:", Array.from(activeConnections.entries())); // Para debug aprofundado
}

// <<< AJUSTE: Função para remover conexões
async function removeActiveConnection(wsToClose) {
    let foundId = null;
    let entryToUpdate = null;

    // Encontra a entrada correspondente ao WebSocket que está fechando
    for (let [id, entry] of activeConnections.entries()) {
        if (entry.wsCommands === wsToClose) {
            foundId = id;
            entryToUpdate = entry;
            delete entryToUpdate.wsCommands; // Remove a referência ao WebSocket de comandos
            console.log(`[WebSocket-Commands] Fechou conexão de comandos para ${id}.`);
            break;
        } else if (entry.wsAudio === wsToClose) {
            foundId = id;
            entryToUpdate = entry;
            delete entryToUpdate.wsAudio; // Remove a referência ao WebSocket de áudio
            console.log(`[WebSocket-Audio] Fechou conexão de áudio para ${id}.`);
            break;
        }
    }

    if (foundId && entryToUpdate) {
        // Se ambos os WebSockets (commands e audio) estiverem fechados para esta entrada, remove a entrada completa
        if (!entryToUpdate.wsCommands && !entryToUpdate.wsAudio) {
            activeConnections.delete(foundId);
            console.log(`[WebSocket-Manager] Entrada de conexão removida para: ${foundId} (ambas as WSs fechadas).`);

            // Se for um filho e a conexão de comandos foi a última a fechar, atualiza o status no DynamoDB
            if (entryToUpdate.type === 'child') {
                const params = {
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: foundId },
                    UpdateExpression: 'SET connected = :connected, lastConnected = :lastConnected',
                    ExpressionAttributeValues: {
                        ':connected': false,
                        ':lastConnected': new Date().toISOString()
                    },
                    ReturnValues: 'UPDATED_NEW'
                };
                try {
                    await docClient.update(params).promise();
                    console.log(`[DynamoDB] Status de conexão do filho ${foundId} atualizado para 'false'.`);
                } catch (err) {
                    console.error(`[DynamoDB_ERROR] Erro ao atualizar status de desconexão do filho ${foundId}: ${err.message}`, err);
                }
            }
        }
    } else {
        console.log('[WebSocket-Manager] Cliente desconectado (ID ou WS não encontrado em activeConnections).');
    }
    console.log(`[WebSocket-Manager] Total de entradas ativas: ${activeConnections.size}`);
}


// --- WebSocket de Comandos (GPS, Chat) ---
wssCommands.on('connection', ws => {
    console.log('[WebSocket-Commands] Cliente conectado.');
    ws.url = '/ws-commands'; // <<< AJUSTE: Atribui a URL para uso em updateConnection

    ws.on('message', async message => {
        let parsedMessage;
        try {
            const messageString = message.toString();
            parsedMessage = JSON.parse(messageString);
            console.log(`[WebSocket-Commands] Mensagem recebida: ${messageString}`);
        } catch (e) {
            console.error('[WebSocket-Commands] Erro ao analisar mensagem JSON:', e);
            return;
        }

        const { type, parentId, childName, data } = parsedMessage;
        const childId = parsedMessage.childId || (data && data.childId);

        console.log(`[WebSocket-Commands] Extracted - type: ${type}, parentId: ${parentId}, childId: ${childId}`);

        // Lógica de identificação de conexão (parentConnect, childConnect)
        if (type === 'childConnect' && childId && parentId && childName) {
            // <<< AJUSTE: Usar updateConnection
            updateConnection(childId, 'child', ws, { childName: childName, parentId: parentId });
            console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${childId}, Parent ID: ${parentId}, Nome: ${childName}`);

            const params = {
                TableName: DYNAMODB_TABLE_CHILDREN,
                Item: {
                    childId: childId,
                    childName: childName,
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

        } else if (type === 'parentConnect' && parentId) {
            // <<< AJUSTE: Usar updateConnection
            const listeningToChildId = (data && data.listeningToChildId) ? data.listeningToChildId : null;
            updateConnection(parentId, 'parent', ws, { listeningToChildId: listeningToChildId });
            console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${parentId}, ouvindo filho: ${listeningToChildId || 'nenhum'}`);
        } else {
            // Se o WS ainda não tem ID (conexão nova sem identificação)
            if (!ws.id) {
                console.warn(`[WebSocket-Commands] Mensagem recebida antes da identificação da conexão: ${JSON.stringify(parsedMessage)}`);
            }
        }

        // Lógica para processar comandos após a identificação
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
                        // <<< AJUSTE: Iterar sobre activeConnections (mapa de entradas)
                        for (let [id, entry] of activeConnections.entries()) {
                            if (entry.type === 'parent' && entry.wsCommands && entry.wsCommands.readyState === WebSocket.OPEN && entry.listeningToChildId === childId) {
                                entry.wsCommands.send(JSON.stringify({
                                    type: 'locationUpdate',
                                    childId: childId,
                                    latitude: data.latitude,
                                    longitude: data.longitude,
                                    timestamp: new Date().toISOString()
                                }));
                                console.log(`[WebSocket-Commands] Localização de ${childId} encaminhada para o pai ${id}.`);
                                parentFoundAndListening = true;
                            }
                        }
                        if (!parentFoundAndListening) {
                            console.log(`[WebSocket-Commands] NENHUM pai encontrado online ou ouvindo o filho ${childId} para encaminhar a localização.`);
                        }

                    } catch (error) {
                        console.error('[DynamoDB_ERROR] Erro ao salvar localização no DynamoDB:', error);
                    }
                }
                break;

            case 'parentConnect':
                // ws.id já foi definido acima
                console.log(`[WebSocket-Commands] Pai ${ws.id} reafirmou conexão, ouvindo filho: ${activeConnections.get(ws.id)?.listeningToChildId || 'nenhum'}`);
                break;

            case 'childConnect':
                // ws.id já foi definido acima
                console.log(`[WebSocket-Commands] Filho ${ws.id} reafirmou conexão (após registro inicial).`);
                break;

            case 'requestLocation':
                const requestedChildId = childId;
                const requestingParentId = ws.id; // ws.id já deve estar definido aqui

                if (requestedChildId && requestingParentId) {
                    console.log(`[WebSocket-Commands] Pai ${requestingParentId} solicitou localização do filho ${requestedChildId}.`);

                    // <<< AJUSTE: Buscar o WebSocket de comandos do filho na activeConnections
                    const childEntry = activeConnections.get(requestedChildId);

                    if (childEntry && childEntry.type === 'child' && childEntry.wsCommands && childEntry.wsCommands.readyState === WebSocket.OPEN) {
                        childEntry.wsCommands.send(JSON.stringify({
                            type: 'getLocation',
                            childId: requestedChildId,
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
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Comando requestLocation inválido. childId e parentId são obrigatórios.'
                    }));
                }
                break;

            // <<< NOVO AJUSTE: Lidar com requestAudioStream do pai
            case 'requestAudioStream':
                if (ws.type === 'parent') { // Garante que é um pai enviando
                    const requestedChildIdForAudio = parsedMessage.data.childId;
                    if (requestedChildIdForAudio) {
                        // Atualiza a entrada do pai para indicar qual filho ele está ouvindo
                        updateConnection(ws.id, 'parent', ws, { listeningToChildId: requestedChildIdForAudio });
                        console.log(`[WebSocket-Commands] Pai ${ws.id} solicitou streaming de áudio do filho ${requestedChildIdForAudio}.`);

                        // Enviar comando ao filho para iniciar streaming (via ws-commands do filho)
                        const childEntry = activeConnections.get(requestedChildIdForAudio);
                        if (childEntry && childEntry.wsCommands && childEntry.wsCommands.readyState === WebSocket.OPEN) {
                            childEntry.wsCommands.send(JSON.stringify({ type: 'startAudioStream' }));
                            console.log(`[WebSocket-Commands] Comando 'startAudioStream' enviado para o filho ${requestedChildIdForAudio}.`);
                        } else {
                            console.warn(`[WebSocket-Commands] Filho ${requestedChildIdForAudio} não encontrado/online via comandos para iniciar streaming de áudio.`);
                        }

                        ws.send(JSON.stringify({ type: 'audioStreamStatus', status: 'requested', childId: requestedChildIdForAudio }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Comando requestAudioStream inválido: childId ausente.' }));
                    }
                }
                break;

            // <<< NOVO AJUSTE: Lidar com stopAudioStream do pai
            case 'stopAudioStream':
                if (ws.type === 'parent') { // Garante que é um pai enviando
                    const stoppedChildIdForAudio = parsedMessage.data.childId;
                    // Verifica se o pai estava realmente ouvindo este filho
                    if (activeConnections.get(ws.id)?.listeningToChildId === stoppedChildIdForAudio) {
                        // Limpa a propriedade listeningToChildId da entrada do pai
                        updateConnection(ws.id, 'parent', ws, { listeningToChildId: null });
                        console.log(`[WebSocket-Commands] Pai ${ws.id} parou de ouvir áudio do filho ${stoppedChildIdForAudio}.`);

                        // Enviar comando ao filho para parar streaming (via ws-commands do filho)
                        const childEntry = activeConnections.get(stoppedChildIdForAudio);
                        if (childEntry && childEntry.wsCommands && childEntry.wsCommands.readyState === WebSocket.OPEN) {
                            childEntry.wsCommands.send(JSON.stringify({ type: 'stopAudioStream' }));
                            console.log(`[WebSocket-Commands] Comando 'stopAudioStream' enviado para o filho ${stoppedChildIdForAudio}.`);
                        }
                        ws.send(JSON.stringify({ type: 'audioStreamStatus', status: 'stopped', childId: stoppedChildIdForAudio }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Comando stopAudioStream inválido ou pai não estava ouvindo este filho.' }));
                    }
                }
                break;

            default:
                console.warn(`[WebSocket-Commands] Tipo de mensagem desconhecido: ${type}`);
                break;
        }
    });

    ws.on('close', async () => {
        // <<< AJUSTE: Usar a nova removeActiveConnection
        await removeActiveConnection(ws);
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no WebSocket:', error);
        // <<< AJUSTE: Usar a nova removeActiveConnection para lidar com erros de fechamento
        removeActiveConnection(ws); // removeActiveConnection também pode lidar com o erro no fechamento
    });
});


// --- WebSocket de Áudio ---
// <<< AJUSTE: O Bloco principal de áudio
wssAudio.on('connection', ws => {
    console.log('[WebSocket-Audio] Cliente conectado.');
    ws.url = '/ws-audio'; // <<< AJUSTE: Atribui a URL para uso em updateConnection

    ws.on('message', message => {
        // Tenta analisar como JSON para identificação inicial (childAudioConnect, parentAudioConnect)
        let parsed = null;
        try {
            parsed = JSON.parse(message.toString());
            // console.log(`[WebSocket-Audio] Mensagem JSON recebida: ${JSON.stringify(parsed)}`); // Debug
        } catch (e) {
            // console.log('[WebSocket-Audio] Mensagem não é JSON, assumindo dados de áudio binários.'); // Debug
        }

        if (parsed) {
            // Se é uma mensagem de identificação JSON
            if (parsed.type === 'childAudioConnect' && parsed.childId) {
                // <<< AJUSTE: Usar updateConnection para associar este wsAudio ao filho
                updateConnection(parsed.childId, 'child', ws);
                console.log(`[WebSocket-Audio] Filho ${parsed.childId} conectado ao WS de Áudio.`);
                return; // Já processou esta mensagem de identificação
            }
            if (parsed.type === 'parentAudioConnect' && parsed.parentId) {
                // <<< AJUSTE: Usar updateConnection para associar este wsAudio ao pai
                updateConnection(parsed.parentId, 'parent', ws);
                console.log(`[WebSocket-Audio] Pai ${parsed.parentId} conectado ao WS de Áudio.`);
                return; // Já processou esta mensagem de identificação
            }
        }

        // Se não foi uma mensagem JSON de identificação, assume que é o fluxo de áudio
        // Precisa que o 'ws' de áudio já tenha sido identificado (ws.id e ws.type)
        if (ws.type === 'child' && ws.id) { // Verifica se este WebSocket de áudio é de um filho identificado
            // console.log(`[WebSocket-Audio] Áudio recebido do filho: ${ws.id}. Retransmitindo...`);
            let parentFoundAndListening = false;
            // Percorre todas as entradas em activeConnections para encontrar pais ouvindo este filho
            for (let [parentId, parentEntry] of activeConnections.entries()) {
                if (parentEntry.type === 'parent' && parentEntry.wsAudio && parentEntry.wsAudio.readyState === WebSocket.OPEN && parentEntry.listeningToChildId === ws.id) {
                    // Retransmite o áudio diretamente para o WebSocket de áudio do pai
                    parentEntry.wsAudio.send(message);
                    // console.log(`[WebSocket-Audio] Retransmitindo áudio do filho ${ws.id} para o pai ${parentId}.`); // Debug
                    parentFoundAndListening = true;
                }
            }
            if (!parentFoundAndListening) {
                // console.log(`[WebSocket-Audio] NENHUM pai online ou ouvindo o filho ${ws.id} para receber áudio.`); // Debug
            }
        } else {
            console.warn('[WebSocket-Audio] Mensagem de áudio recebida de cliente não identificado ou não-filho no WS de áudio.');
        }
    });

    ws.on('close', () => {
        // <<< AJUSTE: Usar a nova removeActiveConnection
        removeActiveConnection(ws);
    });

    ws.on('error', error => {
        console.error('[WebSocket-Audio] Erro no WebSocket de áudio:', error);
        // <<< AJUSTE: Usar a nova removeActiveConnection
        removeActiveConnection(ws);
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