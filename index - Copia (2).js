const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const AWS = require('aws-sdk');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

// --- DECLARAÇÕES DE MAPS DE CONEXÃO ---
// Mapa para armazenar todas as conexões WebSocket ativas (temporárias ou por ID)
const wsConnections = new Map();
// Mapeia childId para a instância WebSocket do filho no canal de COMANDOS GERAIS
const childToWebSocket = new Map();
// Mapeia parentId para a instância WebSocket do pai no canal de COMANDOS GERAIS
const parentToWebSocket = new Map();
// Mapeia instâncias WebSocket de áudio de DADOS para informações do cliente
const activeAudioDataClients = new Map();
// NOVO MAPA: Mapeia childId para a instância WebSocket do filho no canal de CONTROLE DE ÁUDIO
const activeAudioControlClients = new Map();
// Mapa para manter todas as conexões ativas com seus IDs (temporários ou reais)
const activeConnections = new Map();

const app = express();
const PORT = process.env.PORT || 10000;

const upload = multer();

// Configuração da AWS usando variáveis de ambiente
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1'
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const DYNAMODB_TABLE_CHILDREN = 'Children';

app.use(cors());
app.use(bodyParser.json());

// --- ROTAS HTTP ---
app.get('/', (req, res) => {
    res.send('Servidor está rodando e pronto para conexões WebSocket.');
});

// Endpoint para upload de áudio (se usar HTTP para isso)
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Nenhum arquivo de áudio enviado.');
    }

    const { childId, parentId, timestamp } = req.body;
    const bucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';
    const key = `audio/${parentId}/${childId}/${timestamp}.mp3`; // Ou .wav, .aac etc.

    const params = {
        Bucket: bucketName,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype
    };

    try {
        await s3.upload(params).promise();
        res.status(200).send('Áudio salvo com sucesso no S3.');
    } catch (error) {
        console.error('Erro ao salvar áudio no S3:', error);
        res.status(500).send('Erro ao salvar áudio.');
    }
});

// Endpoint para envio de mensagem de chat para um filho
app.post('/send-chat-message', async (req, res) => {
    const { parentId, childId, message } = req.body;

    if (!parentId || !childId || !message) {
        return res.status(400).send('Dados incompletos para enviar mensagem de chat.');
    }

    const chatMessage = {
        type: 'chatMessage',
        parentId,
        childId,
        message,
        timestamp: Date.now()
    };

    // Tenta enviar via WebSocket
    const childWs = childToWebSocket.get(childId);
    if (childWs && childWs.readyState === WebSocket.OPEN) {
        childWs.send(JSON.stringify(chatMessage));
        console.log(`[Chat-Server] Mensagem de chat enviada via WS para ${childId}.`);
        res.status(200).send('Mensagem enviada via WebSocket.');
    } else {
        console.warn(`[Chat-Server] Filho ${childId} não conectado via WS. Tentando salvar no DynamoDB.`);
        // Salva no DynamoDB para que o filho possa buscar depois (se for o caso)
        const params = {
            TableName: DYNAMODB_TABLE_MESSAGES,
            Item: {
                messageId: uuidv4(),
                parentId,
                childId,
                message,
                timestamp: chatMessage.timestamp,
                status: 'pending' // Ou 'delivered' quando o filho confirmar
            }
        };
        try {
            await docClient.put(params).promise();
            res.status(200).send('Mensagem salva no banco de dados para entrega posterior.');
        } catch (error) {
            console.error('Erro ao salvar mensagem de chat no DynamoDB:', error);
            res.status(500).send('Erro ao enviar mensagem de chat.');
        }
    }
});

// --- Configuração WebSocket ---
const server = http.createServer(app);

// WebSocket para Comandos Gerais (GPS, Chat)
const wssGeneralCommands = new WebSocket.Server({ noServer: true });
// WebSocket para Dados de Áudio (streaming de áudio do filho para o pai)
const wssAudioData = new WebSocket.Server({ noServer: true });
// WebSocket para Controle de Áudio (comandos de áudio do pai para o filho)
const wssAudioControl = new WebSocket.Server({ noServer: true });

// Função para atualizar o status de conexão no DynamoDB
async function updateChildConnectionStatus(childId, isConnected) {
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Key: { childId: childId },
        UpdateExpression: 'SET isConnected = :val',
        ExpressionAttributeValues: { ':val': isConnected }
    };
    try {
        await docClient.update(params).promise();
        console.log(`[DynamoDB-Helper] Status de conexão do filho ${childId} atualizado para ${isConnected}.`);
    } catch (error) {
        console.error(`[DynamoDB-Helper] Erro ao atualizar status de conexão para ${childId}:`, error);
    }
}

server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    console.log(`[HTTP-Upgrade] Tentativa de upgrade para pathname: ${pathname}`);

    if (pathname === '/ws-general-commands') {
        wssGeneralCommands.handleUpgrade(request, socket, head, ws => {
            wssGeneralCommands.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio-data') { // Canal para dados de áudio
        wssAudioData.handleUpgrade(request, socket, head, ws => {
            wssAudioData.emit('connection', ws, request);
        });
    } else if (pathname === '/ws-audio-control') { // NOVO canal para controle de áudio
        wssAudioControl.handleUpgrade(request, socket, head, ws => {
            wssAudioControl.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// --- LÓGICA DE WEBSOCKETS ---

// WebSocket de Comandos Gerais (/ws-general-commands)
wssGeneralCommands.on('connection', ws => {
    const connectionId = uuidv4(); // Gerar um ID para esta conexão WS individual
    activeConnections.set(connectionId, { ws, clientType: 'unknown', currentParentId: null, currentChildId: null });
    console.log(`[WS-GENERAL-COMMANDS-CONN] Nova conexão WS de comandos gerais: ID=${connectionId}, Estado inicial: clientType=unknown`);

    ws.on('message', message => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            console.log(`[WebSocket-General] Mensagem JSON recebida: ${message}`);
        } catch (e) {
            console.error("[WebSocket-General] Erro ao parsear JSON:", e);
            return;
        }

        const { type, parentId, childId, message: chatMsg, latitude, longitude, timestamp } = parsedMessage;

        // Debugging do estado da conexão
        const currentConnState = activeConnections.get(connectionId);
        console.log(`[WS-General] Desestruturado - type: ${type}, parentId: ${parentId}, childId (effective): ${childId}, childName (effective): ${parsedMessage.childName}`);


        if (type === 'parentConnect' && parentId) {
            parentToWebSocket.set(parentId, ws); // Mapeia parentId para o WebSocket
            activeConnections.set(connectionId, { ...currentConnState, clientType: 'parent', currentParentId: parentId });
            console.log(`[WS-General] Pai conectado e identificado: ID: ${parentId}`);
            ws.send(JSON.stringify({ type: 'parentConnectedSuccess', message: 'Conectado como pai.' }));
            return;
        }

        if (type === 'childConnect' && childId) {
            childToWebSocket.set(childId, ws); // Mapeia childId para o WebSocket
            activeConnections.set(connectionId, { ...currentConnState, clientType: 'child', currentChildId: childId });
            updateChildConnectionStatus(childId, true); // Atualiza status no DynamoDB
            console.log(`[WS-General] Filho conectado e identificado: ID: ${childId}`);
            ws.send(JSON.stringify({ type: 'childConnectedSuccess', message: 'Conectado como filho.' }));
            return;
        }

        if (type === 'locationUpdate' && childId && latitude != null && longitude != null && timestamp != null) {
            const params = {
                TableName: DYNAMODB_TABLE_LOCATIONS,
                Item: {
                    locationId: uuidv4(),
                    childId,
                    latitude,
                    longitude,
                    timestamp
                }
            };
            docClient.put(params, function(err, data) {
                if (err) {
                    console.error("Erro ao adicionar localização no DynamoDB:", JSON.stringify(err, null, 2));
                } else {
                    console.log("Localização adicionada no DynamoDB:", JSON.stringify(data, null, 2));
                }
            });

            // Encaminha para o pai
            if (parentId) {
                const parentWs = parentToWebSocket.get(parentId);
                if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                    parentWs.send(JSON.stringify(parsedMessage));
                    console.log(`[Location] Localização do filho ${childId} encaminhada para o pai ${parentId}.`);
                } else {
                    console.warn(`[Location] Pai ${parentId} não encontrado ou offline para encaminhar localização.`);
                }
            } else {
                console.warn(`[Location] parentId não especificado na mensagem de localização do filho ${childId}.`);
            }
            return;
        }

        if (type === 'chatMessage' && childId && parentId && chatMsg) {
            const targetWs = activeConnections.get(connectionId).clientType === 'parent' ? childToWebSocket.get(childId) : parentToWebSocket.get(parentId);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(JSON.stringify(parsedMessage));
                console.log(`[Chat] Mensagem de chat de ${activeConnections.get(connectionId).clientType === 'parent' ? 'pai' : 'filho'} (${activeConnections.get(connectionId).clientType === 'parent' ? parentId : childId}) para ${activeConnections.get(connectionId).clientType === 'parent' ? 'filho' : 'pai'} (${activeConnections.get(connectionId).clientType === 'parent' ? childId : parentId}) encaminhada.`);
            } else {
                console.warn(`[Chat] Destinatário ${activeConnections.get(connectionId).clientType === 'parent' ? childId : parentId} não encontrado ou offline.`);
            }
            return;
        }

        console.warn(`[WS-General] Tipo de mensagem desconhecido ou dados inválidos: ${type}`);
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-General] Conexão Fechada. ID: ${connectionId}, Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        // Remover do activeConnections
        activeConnections.delete(connectionId);

        // Se for um filho que desconectou, remova do childToWebSocket e atualize o status no DynamoDB
        for (let [childIdKey, clientWs] of childToWebSocket.entries()) {
            if (clientWs === ws) {
                childToWebSocket.delete(childIdKey);
                updateChildConnectionStatus(childIdKey, false); // Atualiza status no DynamoDB
                console.log(`[WS-General] Cliente filho ${childIdKey} removido devido a desconexão.`);
                break;
            }
        }
        // Se for um pai que desconectou, remova do parentToWebSocket
        for (let [parentIdKey, clientWs] of parentToWebSocket.entries()) {
            if (clientWs === ws) {
                parentToWebSocket.delete(parentIdKey);
                console.log(`[WS-General] Cliente pai ${parentIdKey} removido devido a desconexão.`);
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error(`[WS-General] Erro na conexão WS para ID ${connectionId}:`, error);
    });
});

// WebSocket de Dados de Áudio (/ws-audio-data)
wssAudioData.on('connection', (ws, req) => {
    const connectionId = uuidv4();
    activeConnections.set(connectionId, { ws, clientType: 'unknown', currentParentId: null, currentChildId: null });
    console.log(`[WS-AUDIO-DATA-CONN] Nova conexão WS de dados de áudio: ID=${connectionId}`);

    // Extrair childId e parentId da query string
    const { query } = url.parse(req.url, true);
    const childId = query.childId;
    const parentId = query.parentId;

    if (childId) {
        // Mapeia este WebSocket de dados de áudio para o childId.
        // Isto é crucial para que o servidor saiba quem está enviando áudio.
        activeAudioDataClients.set(childId, { ws, parentId, timestamp: Date.now() });
        activeConnections.set(connectionId, { ...activeConnections.get(connectionId), clientType: 'child-audio-data', currentChildId: childId, currentParentId: parentId });
        console.log(`[WS-AudioData] Cliente de dados de áudio do filho ${childId} conectado.`);
    } else {
        console.warn("[WS-AudioData] Conexão de dados de áudio sem childId na query string. Ignorando mapeamento.");
    }

    ws.on('message', message => {
        let parsedMessage;
        try {
            // Supondo que as mensagens de áudio não JSON (Base64) ou JSON
            parsedMessage = JSON.parse(message);
            // console.log(`[WebSocket-AudioData] Mensagem JSON recebida: ${message}`); // Muito verboso para áudio
        } catch (e) {
            // Se não for JSON, assumimos que é o dado de áudio Base64 puro ou binário
            // console.log(`[WebSocket-AudioData] Mensagem NÃO-JSON (provável áudio) recebida. Length: ${message.length}`);
            parsedMessage = { type: 'audioData', childId: childId, data: message.toString('base64') }; // Se for buffer binário
            // Ou se já for uma string base64: parsedMessage = { type: 'audioData', childId: childId, data: message.toString() };
        }

        if (parsedMessage.type === 'audioData' && parsedMessage.childId && parsedMessage.data) {
            const targetParentId = activeAudioDataClients.get(parsedMessage.childId)?.parentId || parentId; // Pega o parentId mapeado
            const parentWs = parentToWebSocket.get(targetParentId); // Pega o WS de comandos gerais do pai para enviar áudio

            if (parentWs && parentWs.readyState === WebSocket.OPEN) {
                // Encaminha os dados de áudio para o pai no canal de comandos gerais.
                // O pai deve estar preparado para receber 'audioData' neste canal.
                parentWs.send(JSON.stringify(parsedMessage));
                // console.log(`[AudioData] Chunk de áudio de ${parsedMessage.childId} encaminhado para o pai ${targetParentId}.`);
            } else {
                // console.warn(`[AudioData] Pai ${targetParentId} não encontrado ou offline para receber dados de áudio.`);
                // Poderíamos armazenar o áudio em S3 aqui se o pai não estiver conectado
            }
            return;
        }

        console.warn(`[WS-AudioData] Tipo de mensagem desconhecido ou dados inválidos: ${parsedMessage.type}`);
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-AudioData] Conexão Fechada. ID: ${connectionId}, Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        activeConnections.delete(connectionId);
        // Remover do activeAudioDataClients se for um filho
        for (let [childIdKey, clientInfo] of activeAudioDataClients.entries()) {
            if (clientInfo.ws === ws) {
                activeAudioDataClients.delete(childIdKey);
                console.log(`[WS-AudioData] Cliente de dados de áudio do filho ${childIdKey} removido devido a desconexão.`);
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error(`[WS-AudioData] Erro na conexão WS para ID ${connectionId}:`, error);
    });
});


// WebSocket de Controle de Áudio (/ws-audio-control)
wssAudioControl.on('connection', ws => {
    const connectionId = uuidv4(); // Gerar um ID para esta conexão WS individual
    activeConnections.set(connectionId, { ws, clientType: 'unknown', currentParentId: null, currentChildId: null });
    console.log(`[WS-AUDIO-CONTROL-CONN] Nova conexão WS de controle de áudio: ID=${connectionId}, Estado inicial: clientType=unknown`);

    ws.on('message', message => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            console.log(`[WebSocket-AudioControl] Mensagem JSON recebida: ${message}`);
        } catch (e) {
            console.error("[WebSocket-AudioControl] Erro ao parsear JSON:", e);
            return;
        }

        const { type, parentId, childId, data } = parsedMessage;

        // Debugging do estado da conexão
        const currentConnState = activeConnections.get(connectionId);
        console.log(`[WS-AudioControl-DEBUG] Estado da conexão que enviou: clientType=${currentConnState?.clientType}, currentParentId=${currentConnState?.currentParentId}, ID=${connectionId}`);

        // === MODIFICAÇÃO AQUI: TRATAR A MENSAGEM DE IDENTIFICAÇÃO DO FILHO NO CANAL DE ÁUDIO ===
        if (type === 'childConnectAudioControl' && childId) {
            activeConnections.set(connectionId, { ...currentConnState, clientType: 'child-audio-control', currentChildId: childId });
            activeAudioControlClients.set(childId, ws); // Mapeia o childId para o WebSocket DE CONTROLE DE ÁUDIO
            console.log(`[WS-AudioControl] Filho conectado e identificado para controle de áudio: ID: ${childId}`);
            return;
        }

        // Processar 'startAudioStream' (do pai para o servidor)
        if (type === 'startAudioStream' && parentId && data && data.childId) {
            const targetChildId = data.childId;
            // === MODIFICAÇÃO AQUI: BUSCA NO MAP ESPECÍFICO DE CONTROLE DE ÁUDIO ===
            const childWsAudioControl = activeAudioControlClients.get(targetChildId);
            if (childWsAudioControl && childWsAudioControl.readyState === WebSocket.OPEN) {
                childWsAudioControl.send(JSON.stringify({ type: 'startRecording' })); // Envia para o FILHO NO CANAL DE ÁUDIO
                console.log(`[Audio-Control-Server] Comando 'startRecording' enviado para filho ${targetChildId} via WS de CONTROLE DE ÁUDIO.`);
                // Enviar status de volta para o pai
                ws.send(JSON.stringify({
                    type: 'audioCommandStatus',
                    childId: targetChildId,
                    message: `Comando 'startRecording' enviado para ${targetChildId}.`,
                    status: 'sent'
                }));
            } else {
                console.warn(`[Audio-Control-Server] Filho ${targetChildId} não encontrado ou offline no canal de controle de áudio para startRecording.`);
                // Enviar status de volta para o pai informando falha
                ws.send(JSON.stringify({
                    type: 'audioCommandStatus',
                    childId: targetChildId,
                    message: `Filho ${targetChildId} não encontrado ou offline no canal de controle de áudio.`,
                    status: 'failed'
                }));
            }
            return;
        }

        // Processar 'stopAudioStream' (do pai para o servidor)
        if (type === 'stopAudioStream' && parentId && data && data.childId) {
            const targetChildId = data.childId;
            // === MODIFICAÇÃO AQUI: BUSCA NO MAP ESPECÍFICO DE CONTROLE DE ÁUDIO ===
            const childWsAudioControl = activeAudioControlClients.get(targetChildId);
            if (childWsAudioControl && childWsAudioControl.readyState === WebSocket.OPEN) {
                childWsAudioControl.send(JSON.stringify({ type: 'stopAudioStreamFromServer' })); // Envia para o FILHO NO CANAL DE ÁUDIO
                console.log(`[Audio-Control-Server] Comando 'stopAudioStreamFromServer' enviado para filho ${targetChildId} via WS de CONTROLE DE ÁUDIO.`);
                // Enviar status de volta para o pai
                ws.send(JSON.stringify({
                    type: 'audioCommandStatus',
                    childId: targetChildId,
                    message: `Comando 'stopAudioStreamFromServer' enviado para ${targetChildId}.`,
                    status: 'sent'
                }));
            } else {
                console.warn(`[Audio-Control-Server] Filho ${targetChildId} não encontrado ou offline no canal de controle de áudio para stopAudioStreamFromServer.`);
                // Enviar status de volta para o pai informando falha
                ws.send(JSON.stringify({
                    type: 'audioCommandStatus',
                    childId: targetChildId,
                    message: `Filho ${targetChildId} não encontrado ou offline no canal de controle de áudio.`,
                    status: 'failed'
                }));
            }
            return;
        }

        // Outras mensagens de áudio (como audioData do filho para o servidor)
        if (type === 'audioData') {
            console.warn(`[WS-AudioControl] Mensagem 'audioData' recebida inesperadamente no canal de controle de áudio. Deve ir para /ws-audio-data.`);
            return;
        }

        console.warn(`[WS-AudioControl] Tipo de mensagem desconhecido ou dados inválidos no canal de controle de áudio: ${type}`);
    });

    ws.on('close', (code, reason) => {
        console.log(`[WS-AudioControl] Conexão Fechada. ID: ${connectionId}, Código: ${code}, Razão: ${reason ? reason.toString() : 'N/A'}`);
        // Remover do activeConnections
        activeConnections.delete(connectionId);
        // Remover do activeAudioControlClients se for um filho
        for (let [childIdKey, clientWs] of activeAudioControlClients.entries()) {
            if (clientWs === ws) {
                activeAudioControlClients.delete(childIdKey);
                console.log(`[WS-AudioControl] Cliente de áudio do filho ${childIdKey} removido devido a desconexão.`);
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error(`[WS-AudioControl] Erro na conexão WS para ID ${connectionId}:`, error);
    });
});

// --- INICIO DO SERVIDOR ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP/WebSocket rodando na porta ${PORT}`);
    console.log(`WebSocket de comandos gerais em: ws://localhost:${PORT}/ws-general-commands`);
    console.log(`WebSocket de dados de áudio em: ws://localhost:${PORT}/ws-audio-data`);
    console.log(`WebSocket de controle de áudio em: ws://localhost:${PORT}/ws-audio-control`);
    console.log(`Região AWS configurada via env: ${process.env.AWS_REGION || 'Não definida'}`);
    console.log(`Bucket S3 configurado via env: ${process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'}`);
});
