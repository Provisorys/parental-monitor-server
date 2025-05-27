const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const twilio = require('twilio');
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
const activeChildWebSockets = new Map(); // Mapa: childId -> WebSocket do filho (para comandos)

// Mapas para os WebSockets de ÁUDIO
// parentListeningSockets: Para mapear o filho que está sendo ouvido para o WebSocket do pai
const parentListeningSockets = new Map(); // Chave: childId -> WebSocket do pai que está ouvindo o áudio
const childAudioStreamers = new Map(); // Chave: childId -> WebSocket do filho que está enviando áudio


// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// --- FUNÇÕES AUXILIARES ---

// Função para salvar mensagens no DynamoDB
async function saveMessage(parentId, childId, message, isParent) {
    const timestamp = new Date().toISOString();
    const params = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: {
            conversationId: `${parentId}_${childId}`,
            messageId: uuidv4(),
            parentId: parentId,
            childId: childId,
            sender: isParent ? parentId : childId,
            message: message,
            timestamp: timestamp
        }
    };
    try {
        await docClient.put(params).promise();
        console.log('Mensagem salva no DynamoDB:', params.Item);

        // Atualizar lastActivity na tabela Conversations
        await docClient.update({
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: { childId: childId },
            UpdateExpression: 'SET lastActivity = :la, parentIds = :pid',
            ExpressionAttributeNames: {
                '#parentIds': 'parentIds' // Define o alias para o nome do atributo
            },
            ExpressionAttributeValues: {
                ':la': timestamp,
                ':pid': docClient.createSet([parentId]) // Adiciona o parentId ao set
            },
            ReturnValues: 'UPDATED_NEW'
        }).promise();
        console.log(`Last activity e parentIds atualizados para conversationId ${childId}`);

    } catch (error) {
        console.error('Erro ao salvar mensagem ou atualizar conversa no DynamoDB:', error);
    }
}

// Função para salvar dados de localização no DynamoDB
async function saveLocation(childId, latitude, longitude, timestamp, accuracy, speed) {
    const params = {
        TableName: DYNAMODB_TABLE_LOCATIONS,
        Item: {
            locationId: uuidv4(),
            childId: childId,
            latitude: latitude,
            longitude: longitude,
            timestamp: timestamp,
            accuracy: accuracy,
            speed: speed
        }
    };
    try {
        await docClient.put(params).promise();
        console.log('Localização salva no DynamoDB:', params.Item);
    } catch (error) {
        console.error('Erro ao salvar localização no DynamoDB:', error);
    }
}

// Função para fazer upload de arquivo para o S3
async function uploadFileToS3(key, body, contentType) {
    const params = {
        Bucket: S3_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        ACL: 'public-read' // Permite acesso público ao arquivo
    };
    try {
        const data = await s3.upload(params).promise();
        console.log('Arquivo enviado para S3:', data.Location);
        return data.Location; // Retorna a URL pública do arquivo
    } catch (error) {
        console.error('Erro ao enviar arquivo para S3:', error);
        throw error;
    }
}


// --- ROTAS HTTP (REST) ---

// Rota para upload de mídias (áudio, vídeo, imagem)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo enviado.');
    }

    const { parentId, childId, messageType } = req.body;
    const file = req.file;
    const key = `media/${childId}/${Date.now()}_${file.originalname}`;

    try {
        const fileUrl = await uploadFileToS3(key, file.buffer, file.mimetype);

        // Enviar URL para o cliente pai via WebSocket
        const parentWs = wsClientsMap.get(parentId);
        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
            parentWs.send(JSON.stringify({
                type: 'mediaMessage',
                childId: childId,
                url: fileUrl,
                messageType: messageType, // e.g., 'audio', 'image', 'video'
                timestamp: new Date().toISOString()
            }));
            console.log(`URL da mídia enviada para o pai ${parentId}: ${fileUrl}`);
        } else {
            console.warn(`Pai ${parentId} não está online ou conectado via WebSocket para receber a URL da mídia.`);
        }

        res.status(200).send({ message: 'Arquivo enviado e URL processada.', url: fileUrl });
    } catch (error) {
        res.status(500).send('Erro ao processar o upload do arquivo.');
    }
});


// Rota para listar conversas (filhos que o pai interagiu)
app.get('/conversations/:parentId', async (req, res) => {
    const { parentId } = req.params;
    try {
        const params = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            FilterExpression: 'contains(parentIds, :parentId)', // Verifica se o parentId está no set parentIds
            ExpressionAttributeValues: {
                ':parentId': parentId
            }
        };
        const data = await docClient.scan(params).promise();
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao listar conversas:', error);
        res.status(500).send('Erro ao buscar conversas.');
    }
});

// Rota para obter histórico de mensagens de uma conversa
app.get('/messages/:parentId/:childId', async (req, res) => {
    const { parentId, childId } = req.params;
    const conversationId = `${parentId}_${childId}`;
    try {
        const params = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            KeyConditionExpression: 'conversationId = :cid',
            ExpressionAttributeValues: {
                ':cid': conversationId
            },
            ScanIndexForward: true // Mensagens em ordem cronológica
        };
        const data = await docClient.query(params).promise();
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao buscar mensagens:', error);
        res.status(500).send('Erro ao buscar mensagens.');
    }
});

// Rota para obter as últimas N localizações
app.get('/locations/:childId', async (req, res) => {
    const { childId } = req.params;
    const limit = parseInt(req.query.limit || '1', 10); // Pega apenas a última por padrão

    try {
        const params = {
            TableName: DYNAMODB_TABLE_LOCATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: {
                ':cid': childId
            },
            ScanIndexForward: false, // Ordem decrescente de timestamp
            Limit: limit
        };
        const data = await docClient.query(params).promise();
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao buscar localizações:', error);
        res.status(500).send('Erro ao buscar localizações.');
    }
});

// --- Configuração do Servidor HTTP e WebSockets ---
const server = http.createServer(app);

// Crie servidores WebSocket sem anexá-los diretamente ao servidor HTTP
// Eles serão anexados através do evento 'upgrade'
const wssCommands = new WebSocket.Server({ noServer: true });
const wssAudio = new WebSocket.Server({ noServer: true });

// Lidar com o evento 'upgrade' para rotear conexões WebSocket
server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;
    console.log(`[Upgrade] Tentativa de conexão WebSocket na rota: ${pathname}`);

    if (pathname === '/ws-commands') {
        wssCommands.handleUpgrade(request, socket, head, (ws) => {
            wssCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio') {
        wssAudio.handleUpgrade(request, socket, head, (ws) => {
            wssAudio.emit('connection', ws, request);
        });
    } else {
        console.warn(`[Upgrade] Rota WebSocket não reconhecida: ${pathname}. Destruindo socket.`);
        socket.destroy(); // Se a rota não for reconhecida, destrói o socket
    }
});

// --- Lógica do WebSocket para Comandos (GPS, Chat, etc.) ---
wssCommands.on('connection', ws => {
    console.log('[WS-Commands] Novo cliente conectado.');

    ws.on('message', async message => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error('[WS-Commands] Falha ao parsear mensagem WebSocket:', e);
            ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido.' }));
            return;
        }

        const { type, childId, parentId, message: msgContent, command, latitude, longitude, timestamp, accuracy, speed } = parsedMessage;

        switch (type) {
            case 'registerParent':
                if (parentId) {
                    console.log(`[WS-Commands] Pai registrado: ${parentId}`);
                    wsClientsMap.set(parentId, ws); // Mapeia o pai
                }
                break;
            case 'registerChild':
                if (childId) {
                    console.log(`[WS-Commands] Filho registrado: ${childId}`);
                    wsClientsMap.set(childId, ws); // Mapeia o filho para a conexão de comandos
                    activeChildWebSockets.set(childId, ws); // Adiciona ao mapa de filhos ativos

                    // Lógica para adicionar ou atualizar na tabela Conversations:
                    try {
                        await docClient.update({
                            TableName: DYNAMODB_TABLE_CONVERSATIONS,
                            Key: { childId: childId },
                            UpdateExpression: 'SET lastActivity = :la, connected = :c, parentIds = if_not_exists(parentIds, :emptySet)', // Garante que parentIds é um set
                            ExpressionAttributeValues: {
                                ':la': new Date().toISOString(),
                                ':c': true,
                                ':emptySet': docClient.createSet([]) // Cria um set vazio se não existir
                            },
                            ReturnValues: 'UPDATED_NEW'
                        }).promise();
                        console.log(`[DynamoDB] Conversation atualizada/criada para filho ${childId}`);
                    } catch (error) {
                        console.error(`[DynamoDB ERROR] Erro ao atualizar/criar Conversation para ${childId}:`, error);
                    }
                }
                break;
            case 'sendCommand': // Pai envia comando para filho (ex: getLocation, getAudioStream)
                if (childId && command) {
                    const childWs = activeChildWebSockets.get(childId); // Pega o WS do filho (conexão de comandos)
                    if (childWs && childWs.readyState === WebSocket.OPEN) {
                        childWs.send(JSON.stringify({ type: 'command', command: command, parentId: parentId }));
                        console.log(`[WS-Commands] Comando '${command}' enviado para filho ${childId} pelo pai ${parentId}.`);
                    } else {
                        console.warn(`[WS-Commands] Filho ${childId} não online para receber comando '${command}'.`);
                        // Opcional: Enviar feedback ao pai que o filho está offline
                        ws.send(JSON.stringify({ type: 'statusUpdate', childId: childId, status: 'offline', message: `Filho ${childId} está offline.` }));
                    }
                }
                break;
            case 'commandResponse': // Filho envia resposta de comando (ex: localização, status de áudio)
                if (childId && parentId && command) {
                    if (command === 'getLocation' && latitude !== undefined && longitude !== undefined) {
                        const currentTimestamp = new Date().toISOString();
                        await saveLocation(childId, latitude, longitude, currentTimestamp, accuracy, speed);
                        console.log(`[WS-Commands] Localização recebida do filho ${childId}: Lat ${latitude}, Lon ${longitude}`);

                        // Enviar a localização para o pai que solicitou
                        const parentWs = wsClientsMap.get(parentId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({
                                type: 'locationUpdate',
                                childId: childId,
                                latitude: latitude,
                                longitude: longitude,
                                timestamp: currentTimestamp,
                                accuracy: accuracy,
                                speed: speed
                            }));
                            console.log(`[WS-Commands] Localização enviada ao pai ${parentId}.`);
                        } else {
                            console.warn(`[WS-Commands] Pai ${parentId} não online para receber atualização de localização.`);
                        }
                    } else if (command === 'audioStreamStatus' && msgContent) {
                        // Resposta do filho sobre o status do stream de áudio (ex: "started", "failed")
                        const parentWs = wsClientsMap.get(parentId);
                        if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                            parentWs.send(JSON.stringify({
                                type: 'audioStreamStatus',
                                childId: childId,
                                status: msgContent // e.g., "started", "failed"
                            }));
                            console.log(`[WS-Commands] Status de áudio do filho ${childId} enviado ao pai ${parentId}: ${msgContent}`);
                        }
                    }
                    // Adicionar mais tratamentos de comando aqui
                }
                break;
            case 'chatMessage': // Mensagem de chat entre pai e filho
                if (childId && parentId && msgContent) {
                    await saveMessage(parentId, childId, msgContent, type === 'chatMessage'); // isParent é false para mensagens do filho
                    const targetId = parsedMessage.isParent ? childId : parentId; // Enviar para o outro lado da conversa
                    const targetWs = wsClientsMap.get(targetId);

                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify({
                            type: 'chatMessage',
                            childId: childId,
                            parentId: parentId,
                            message: msgContent,
                            sender: parsedMessage.sender, // 'parent' or 'child'
                            timestamp: new Date().toISOString()
                        }));
                        console.log(`[WS-Commands] Mensagem de chat enviada para ${targetId}`);
                    } else {
                        console.warn(`[WS-Commands] Cliente ${targetId} não online para receber mensagem de chat.`);
                    }
                }
                break;
            case 'audioStreamRequest': // Pai solicita stream de áudio, filho responde no canal de áudio
                // Esta mensagem vem do app pai para o servidor (via WS-Commands)
                // O servidor então envia um comando para o app filho (via WS-Commands)
                // para que o filho comece a enviar áudio no WS-Audio.
                if (childId && parentId) {
                    const childWs = activeChildWebSockets.get(childId);
                    if (childWs && childWs.readyState === WebSocket.OPEN) {
                        childWs.send(JSON.stringify({ type: 'command', command: 'startAudioStream', parentId: parentId }));
                        console.log(`[WS-Commands] Comando 'startAudioStream' enviado para filho ${childId}.`);
                        // Mapeia o pai solicitante para o filho, para que os dados de áudio possam ser roteados
                        parentListeningSockets.set(childId, wsClientsMap.get(parentId)); // O WS de comandos do pai
                    } else {
                        console.warn(`[WS-Commands] Filho ${childId} não online para iniciar stream de áudio.`);
                        ws.send(JSON.stringify({ type: 'audioStreamStatus', childId: childId, status: 'offline', message: `Filho ${childId} está offline.` }));
                    }
                }
                break;
            case 'stopAudioStream': // Pai ou servidor solicita para o filho parar o stream de áudio
                if (childId) {
                    const childWs = activeChildWebSockets.get(childId);
                    if (childWs && childWs.readyState === WebSocket.OPEN) {
                        childWs.send(JSON.stringify({ type: 'command', command: 'stopAudioStream' }));
                        console.log(`[WS-Commands] Comando 'stopAudioStream' enviado para filho ${childId}.`);
                    }
                    parentListeningSockets.delete(childId); // Remove o mapeamento do pai
                    childAudioStreamers.delete(childId); // Remove o mapeamento do filho que estava transmitindo
                }
                break;
            // ... adicione mais tipos de mensagens conforme necessário
        }
    });

    ws.on('close', () => {
        console.log('[WS-Commands] Cliente WebSocket de comandos desconectado.');
        // Lógica para remover do mapa wsClientsMap e activeChildWebSockets
        // Identifica e remove o WS fechado
        for (let [id, clientWs] of wsClientsMap.entries()) {
            if (clientWs === ws) {
                wsClientsMap.delete(id);
                console.log(`[WS-Commands] Cliente ${id} removido do mapa de comandos.`);
                // Se for um filho, marcar como desconectado na tabela Conversations
                if (activeChildWebSockets.has(id)) {
                    activeChildWebSockets.delete(id);
                    // Atualizar Conversations para marcar o filho como offline
                    docClient.update({
                        TableName: DYNAMODB_TABLE_CONVERSATIONS,
                        Key: { childId: id },
                        UpdateExpression: 'SET connected = :c',
                        ExpressionAttributeValues: { ':c': false }
                    }).promise().catch(err => console.error('[DynamoDB ERROR] Erro ao marcar filho offline:', err));
                }
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error('[WS-Commands] Erro no WebSocket de comandos:', error);
    });
});

// --- Lógica do WebSocket para Áudio ---
wssAudio.on('connection', ws => {
    console.log('[WS-Audio] Novo cliente conectado.');

    ws.on('message', async message => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error('[WS-Audio] Falha ao parsear mensagem WebSocket:', e);
            ws.send(JSON.stringify({ type: 'error', message: 'Formato de mensagem JSON inválido.' }));
            return;
        }

        const { type, childId, parentId, audioData } = parsedMessage;

        switch (type) {
            case 'registerChildForAudio': // Filho se registra para enviar áudio
                if (childId) {
                    console.log(`[WS-Audio] Filho ${childId} registrado para áudio.`);
                    childAudioStreamers.set(childId, ws);
                    // Opcional: enviar status ao pai se ele está esperando por isso
                    const parentWs = parentListeningSockets.get(childId); // Pega o WS do pai que solicitou o audio
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({ type: 'audioStreamStatus', childId: childId, status: 'started' }));
                    }
                }
                break;
            case 'audioStreamData': // Filho envia dados de áudio
                if (childId && audioData) {
                    const parentWs = parentListeningSockets.get(childId); // Pega o WS do pai que está ouvindo para este childId
                    if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                        parentWs.send(JSON.stringify({ type: 'audioStreamData', childId: childId, audioData: audioData }));
                        // console.log(`[WS-Audio] Dados de áudio enviados para pai do filho ${childId}.`); // Evitar spam de logs
                    } else {
                        console.warn(`[WS-Audio] Pai para filho ${childId} não encontrado ou não está aberto para receber áudio. Parando stream do filho.`);
                        // Enviar comando para o filho parar o stream via canal de comandos
                        const childCommandWs = activeChildWebSockets.get(childId);
                        if (childCommandWs && childCommandWs.readyState === WebSocket.OPEN) {
                            childCommandWs.send(JSON.stringify({ type: 'command', command: 'stopAudioStream' }));
                            console.log(`[WS-Audio] Comando 'stopAudioStream' enviado para filho ${childId} via WS-Commands.`);
                        }
                        parentListeningSockets.delete(childId); // Remove o mapeamento do pai
                        childAudioStreamers.delete(childId); // Remove o mapeamento do filho
                    }
                }
                break;
        }
    });

    ws.on('close', () => {
        console.log('[WS-Audio] Cliente WebSocket de áudio desconectado.');
        // Lógica para remover do mapa childAudioStreamers e parentListeningSockets
        // Identifica e remove o WS fechado
        for (let [childId, clientWs] of childAudioStreamers.entries()) {
            if (clientWs === ws) {
                childAudioStreamers.delete(childId);
                console.log(`[WS-Audio] Filho ${childId} parou de enviar áudio.`);
                // Opcional: Notificar o pai que o stream parou
                const parentWs = parentListeningSockets.get(childId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(JSON.stringify({ type: 'audioStreamStatus', childId: childId, status: 'stopped', message: 'Stream de áudio interrompido.' }));
                }
                parentListeningSockets.delete(childId); // Remove o mapeamento do pai para este filho
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error('[WS-Audio] Erro no WebSocket de áudio:', error);
    });
});


// --- ROTAS NÃO ENCONTRADAS E TRATAMENTO DE ERROS GERAIS ---
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
    console.log(`Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'Configurado' : 'Não Configurado'}`);
    console.log(`Twilio Auth Token: ${TWILIO_AUTH_TOKEN ? 'Configurado' : 'Não Configurado'}`);
});