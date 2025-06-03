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
    res.send('Servidor Online!');
});

// Rota para registrar um novo filho
app.post('/register-child', async (req, res) => {
    const { childId, parentId, childName } = req.body; // childId é passado do app Android

    if (!childId || !parentId || !childName) {
        return res.status(400).send('childId, parentId e childName são obrigatórios.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: childId,
            parentId: parentId,
            childName: childName,
            connected: false, // Inicialmente false
            lastActivity: new Date().toISOString(),
            childToken: 'no token' // Pode ser atualizado depois se usar FCM
        }
    };

    try {
        await docClient.put(params).promise(); // Usa PUT para criar/sobrescrever
        console.log(`[DynamoDB] Filho ${childName} (ID: ${childId}) registrado com sucesso para o pai ${parentId}.`);
        res.status(200).send('Filho registrado com sucesso!');
    } catch (error) {
        console.error('Erro ao registrar filho no DynamoDB:', error);
        res.status(500).send('Erro ao registrar filho.');
    }
});

// Rota para obter a lista de filhos de um pai (usando parentId como filtro)
app.get('/children/:parentId', async (req, res) => {
    const parentId = req.params.parentId;

    if (!parentId) {
        return res.status(400).send('ID do pai é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        FilterExpression: 'parentId = :parentId',
        ExpressionAttributeValues: {
            ':parentId': parentId
        }
    };

    try {
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados (filtrada por pai) solicitada da tabela 'Children'. Encontrados ${data.Items.length} filhos.`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao obter lista de filhos (filtrada):', error);
        res.status(500).send('Erro ao obter lista de filhos (filtrada).');
    }
});

// Rota para listar TODOS os filhos registrados (Essa é a rota que você pediu para reincorporar)
app.get('/get-registered-children', async (req, res) => {
    try {
        const params = {
            TableName: DYNAMODB_TABLE_CHILDREN
        };
        const data = await docClient.scan(params).promise();
        console.log(`[DynamoDB] Lista de filhos registrados (completa) solicitada da tabela 'Children'. Encontrados ${data.Items.length} filhos.`);
        res.status(200).json(data.Items);
    } catch (error) {
        console.error('Erro ao buscar filhos registrados no DynamoDB:', error);
        res.status(500).send('Erro interno do servidor ao buscar filhos registrados.');
    }
});

// Rota para deletar um filho
app.delete('/child/:childId', async (req, res) => {
    const { childId } = req.params;
    if (!childId) {
        return res.status(400).send('ID do filho é obrigatório.');
    }

    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Key: {
            childId: childId
        }
    };

    try {
        await docClient.delete(params).promise();
        console.log(`[DynamoDB] Filho com ID ${childId} deletado com sucesso.`);
        res.status(200).send(`Filho ${childId} deletado com sucesso.`);
    } catch (error) {
        console.error(`Erro ao deletar filho ${childId} no DynamoDB:`, error);
        res.status(500).send('Erro ao deletar filho.');
    }
});

// Rota para upload de mídia (não alterada, só para referência)
app.post('/upload-media', upload.single('media'), async (req, res) => {
    const { childId, type, timestamp, parentId } = req.body;
    const file = req.file;

    if (!file || !childId || !type || !timestamp || !parentId) {
        return res.status(400).send('Dados de mídia incompletos.');
    }

    const s3BucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'; // Nome do seu bucket S3

    const key = `media/${parentId}/${childId}/${type}/${timestamp}-${file.originalname}`;

    const params = {
        Bucket: s3BucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype
    };

    try {
        await s3.upload(params).promise();
        console.log(`[S3] Mídia ${key} enviada com sucesso.`);

        // Opcional: registrar no DynamoDB, se você tiver uma tabela para mídias
        // ...

        res.status(200).send('Mídia enviada com sucesso!');
    } catch (error) {
        console.error('Erro ao fazer upload da mídia:', error);
        res.status(500).send('Erro ao enviar mídia.');
    }
});


// --- WEBSOCKET SERVERS ---
const server = http.createServer(app);
const wssCommands = new WebSocket.Server({ noServer: true }); // Para comandos (GPS, chat)
const wssAudio = new WebSocket.Server({ noServer: true });    // Para streaming de áudio

const wsConnections = new Map(); // Mapa para armazenar {id: {ws, parentId, type, name, wsAudio?}}

// WebSocket de Comandos (GPS, Chat, etc.)
wssCommands.on('connection', ws => {
    let clientInfo = { id: uuidv4(), type: 'unknown', ws: ws }; // ID temporário até identificação
    ws.id = clientInfo.id; // Adiciona o ID ao objeto WebSocket para fácil lookup

    wsConnections.set(ws.id, clientInfo);
    console.log(`[WebSocket-Commands] Novo cliente conectado. Total de entradas: ${wsConnections.size}`);

    ws.on('message', async message => {
        console.log(`[WebSocket-Commands] Mensagem bruta recebida: ${message}`); // Para depurar o conteúdo exato
        let parsedMessage;
        try {
            // Buffer.isBuffer(message) verifica se a mensagem é um Buffer binário
            if (Buffer.isBuffer(message)) {
                parsedMessage = JSON.parse(message.toString('utf8'));
            } else {
                parsedMessage = JSON.parse(message);
            }

            // MOVIDO: Desestruturação deve vir IMEDIATAMENTE após o parsing bem-sucedido.
            // As variáveis type, parentId, childId, childName e data agora estarão disponíveis aqui.
            const { type, parentId, childId, childName, data } = parsedMessage;

            // Antes do switch, verifique o clientType e currentParentId
            const currentParentId = clientInfo.type === 'parent' ? clientInfo.id : clientInfo.parentId;
            const clientType = clientInfo.type;

            console.log(`[WebSocket-Commands] Desestruturado - type: ${type}, parentId: ${parentId}, childId (top-level): ${childId}, childName (top-level): ${childName}`);
            console.log(`[WebSocket-Commands] Mensagem JSON recebida (APÓS LÓGICA DE PARSE E VALIDAÇÃO FINAL): ${JSON.stringify(parsedMessage)}`);
            console.log(`[WebSocket-Commands] DEBUG (before switch) - currentParentId: ${currentParentId}, clientType: ${clientType}`);

            switch (type) {
                case 'parentConnect':
                    if (parentId) {
                        clientInfo.type = 'parent';
                        clientInfo.id = parentId; // Atualiza o ID do cliente para o parentId
                        wsConnections.set(parentId, clientInfo); // Armazena com o parentId como chave
                        wsConnections.delete(ws.id); // Remove a entrada temporária de uuid
                        ws.id = parentId; // Atualiza o ID do WebSocket
                        console.log(`[WebSocket-Manager] Conexão parent ${parentId} atualizada. Total de entradas: ${wsConnections.size}`);
                        console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${parentId}, ouvindo filho: ${clientInfo.listeningToChildId || 'nenhum'}`);
                        // Enviar lista de filhos ao pai
                        const params = {
                            TableName: DYNAMODB_TABLE_CHILDREN,
                            FilterExpression: 'parentId = :parentId',
                            ExpressionAttributeValues: { ':parentId': parentId }
                        };
                        const childrenData = await docClient.scan(params).promise();
                        ws.send(JSON.stringify({ type: 'childrenList', children: childrenData.Items }));
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem parentConnect inválida: parentId faltando.');
                    }
                    break;

                case 'childConnect':
                    if (childId && parentId) {
                        // Store WebSocket connection
                        clientInfo.type = 'child';
                        clientInfo.id = childId;
                        clientInfo.parentId = parentId;
                        clientInfo.name = childName || 'Desconhecido';
                        wsConnections.set(childId, clientInfo); // Usa o childId como chave
                        wsConnections.delete(ws.id); // Remove a entrada temporária de uuid
                        ws.id = childId; // Atualiza o ID do WebSocket

                        // Atualizar status de conexão no DynamoDB
                        await docClient.update({
                            TableName: DYNAMODB_TABLE_CHILDREN,
                            Key: { childId: childId },
                            UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity, parentId = :parentId, childName = :childName', // Inclui parentId e childName
                            ExpressionAttributeValues: {
                                ':connected': true,
                                ':lastActivity': new Date().toISOString(),
                                ':parentId': parentId,
                                ':childName': childName
                            }
                        }).promise();
                        console.log(`[DynamoDB] Filho ${childName} (${childId}) status de conexão atualizado para 'true'.`);
                        console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${childId}, Parent ID: ${parentId}, Nome: ${childName}`);

                        // Notificar o pai (se houver) que o filho está online
                        const parentWs = wsConnections.get(parentId);
                        if (parentWs && parentWs.ws && parentWs.ws.readyState === WebSocket.OPEN) {
                            parentWs.ws.send(JSON.stringify({ type: 'childStatus', childId: childId, status: 'online', name: childName }));
                            // Reenvia a lista de filhos atualizada para o pai
                            const params = {
                                TableName: DYNAMODB_TABLE_CHILDREN,
                                FilterExpression: 'parentId = :parentId',
                                ExpressionAttributeValues: { ':parentId': parentId }
                            };
                            const childrenData = await docClient.scan(params).promise();
                            parentWs.ws.send(JSON.stringify({ type: 'childrenList', children: childrenData.Items }));
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Mensagem childConnect inválida: childId ou parentId faltando.', parsedMessage);
                    }
                    break;

                case 'updateLocation':
                    if (childId && data && data.latitude && data.longitude) {
                        // console.log(`[Location] Recebida localização do filho ${childId}: Lat ${data.latitude}, Lng ${data.longitude}`);
                        const locationData = {
                            locationId: uuidv4(),
                            childId: childId,
                            timestamp: new Date().toISOString(),
                            latitude: data.latitude,
                            longitude: data.longitude,
                            accuracy: data.accuracy,
                            speed: data.speed,
                            bearing: data.bearing
                        };
                        const params = {
                            TableName: DYNAMODB_TABLE_LOCATIONS,
                            Item: locationData
                        };
                        await docClient.put(params).promise();
                        // console.log('[DynamoDB] Localização salva no DynamoDB.');

                        // Reencaminhar para o pai
                        const parentWs = wsConnections.get(clientInfo.parentId);
                        if (parentWs && parentWs.ws && parentWs.ws.readyState === WebSocket.OPEN && parentWs.listeningToChildId === childId) {
                            parentWs.ws.send(JSON.stringify({ type: 'locationUpdate', childId: childId, location: data }));
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Dados de localização incompletos ou childId faltando.');
                    }
                    break;

                case 'startAudioStream':
                    if (data && data.childId) {
                        const targetChildId = data.childId;
                        const child = wsConnections.get(targetChildId);

                        console.log(`[Audio-Debug] Recebido 'startAudioStream' do pai ${currentParentId} para filho ${targetChildId}. ClientType: ${clientType}`);
                        console.log(`[WebSocket-Commands] Conteúdo de 'data':`, data);

                        if (child && child.wsAudio && child.wsAudio.readyState === WebSocket.OPEN) {
                            // Envia um comando para o próprio cliente filho conectado via WS de áudio
                            child.wsAudio.send(JSON.stringify({ type: 'startAudioStream' }));
                            console.log(`[Audio] Comando 'startAudioStream' enviado para o filho ${targetChildId} via WS de áudio.`);
                            ws.send(JSON.stringify({ type: 'audioCommandStatus', success: true, message: `Comando de áudio enviado para ${targetChildId}` }));
                        } else {
                            console.log(`[Audio-Debug] Tentando encontrar WS do filho ${targetChildId}. Encontrado: ${!!child}. WS de Áudio Aberto: ${!!child?.wsAudio?.readyState === WebSocket.OPEN}`);
                            console.log(`[Audio] Filho ${targetChildId} não encontrado ou offline para comando de áudio.`);
                            ws.send(JSON.stringify({ type: 'audioCommandStatus', success: false, message: `Filho ${targetChildId} não encontrado ou offline.` }));
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Comando startAudioStream inválido: childId faltando na data.');
                    }
                    break;

                case 'stopAudioStream':
                    if (data && data.childId) {
                        const targetChildId = data.childId;
                        const child = wsConnections.get(targetChildId);
                        if (child && child.wsAudio && child.wsAudio.readyState === WebSocket.OPEN) {
                            child.wsAudio.send(JSON.stringify({ type: 'stopAudioStream' }));
                            console.log(`[Audio] Comando 'stopAudioStream' enviado para o filho ${targetChildId} via WS de áudio.`);
                            ws.send(JSON.stringify({ type: 'audioCommandStatus', success: true, message: `Comando de parada de áudio enviado para ${targetChildId}` }));
                        } else {
                            console.warn(`[Audio] Filho ${targetChildId} não encontrado ou offline para comando de parada de áudio.`);
                            ws.send(JSON.stringify({ type: 'audioCommandStatus', success: false, message: `Filho ${targetChildId} não encontrado ou offline.` }));
                        }
                    } else {
                        console.warn('[WebSocket-Commands] Comando stopAudioStream inválido: childId faltando na data.');
                    }
                    break;

                case 'listeningToChild':
                    if (childId) {
                        clientInfo.listeningToChildId = childId;
                        console.log(`[WebSocket-Commands] Pai ${clientInfo.id} agora está ouvindo o filho ${childId}.`);
                        ws.send(JSON.stringify({ type: 'listeningConfirmed', childId: childId }));
                    } else {
                        console.warn('[WebSocket-Commands] Comando listeningToChild inválido: childId faltando.');
                    }
                    break;

                case 'sendMessage':
                    if (data && data.childId && data.message && data.parentId) {
                        // Salvar no DynamoDB
                        const messageItem = {
                            messageId: uuidv4(),
                            childId: data.childId,
                            parentId: data.parentId,
                            timestamp: new Date().toISOString(),
                            content: data.message,
                            sender: 'parent' // Ou 'child' se a mensagem viesse do filho
                        };
                        await docClient.put({
                            TableName: DYNAMODB_TABLE_MESSAGES,
                            Item: messageItem
                        }).promise();
                        console.log(`[DynamoDB] Mensagem salva: ${messageItem.messageId}`);

                        // Encaminhar para o filho se online
                        const targetChild = wsConnections.get(data.childId);
                        if (targetChild && targetChild.ws && targetChild.ws.readyState === WebSocket.OPEN) {
                            targetChild.ws.send(JSON.stringify({ type: 'newMessage', message: messageItem }));
                            console.log(`[WebSocket-Commands] Mensagem encaminhada para o filho ${data.childId}.`);
                        } else {
                            console.warn(`[WebSocket-Commands] Filho ${data.childId} offline, mensagem não encaminhada imediatamente.`);
                        }
                        ws.send(JSON.stringify({ type: 'messageStatus', success: true, message: 'Mensagem enviada com sucesso.' }));
                    } else {
                        console.warn('[WebSocket-Commands] Dados de mensagem incompletos.');
                    }
                    break;

                default:
                    console.log(`[WebSocket-Commands] Tipo de mensagem desconhecido: ${type}`);
                    break;
            }
        } catch (e) {
            console.error(`[WebSocket-Commands] ERRO ao processar mensagem: ${e.message}. Mensagem recebida (não JSON ou malformada): ${message}`);
            // Você pode adicionar lógica aqui para ignorar ou tratar mensagens não JSON
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WebSocket-Commands] Cliente desconectado (ID: ${ws.id}). Código: ${code}, Razão: ${reason || ''}`);
        // Atualizar status de conexão no DynamoDB se for um filho
        if (clientInfo.type === 'child' && clientInfo.id) {
            try {
                await docClient.update({
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: clientInfo.id },
                    UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
                    ExpressionAttributeValues: {
                        ':connected': false,
                        ':lastActivity': new Date().toISOString()
                    }
                }).promise();
                console.log(`[DynamoDB] Filho ${clientInfo.id} status de conexão atualizado para 'false'.`);

                // Notificar o pai que o filho está offline
                const parentWs = wsConnections.get(clientInfo.parentId);
                if (parentWs && parentWs.ws && parentWs.ws.readyState === WebSocket.OPEN) {
                    parentWs.ws.send(JSON.stringify({ type: 'childStatus', childId: clientInfo.id, status: 'offline', name: clientInfo.name }));
                    // Reenvia a lista de filhos atualizada para o pai
                    const params = {
                        TableName: DYNAMODB_TABLE_CHILDREN,
                        FilterExpression: 'parentId = :parentId',
                        ExpressionAttributeValues: { ':parentId': clientInfo.parentId }
                    };
                    const childrenData = await docClient.scan(params).promise();
                    parentWs.ws.send(JSON.stringify({ type: 'childrenList', children: childrenData.Items }));
                }

            } catch (error) {
                console.error(`[DynamoDB] Erro ao atualizar status de desconexão para ${clientInfo.id}:`, error);
            }
        }
        wsConnections.delete(ws.id);
        console.log(`[WebSocket-Commands] Total de entradas ativas: ${wsConnections.size}`);
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no WebSocket:', error);
    });
});

// WebSocket de Áudio
wssAudio.on('connection', async (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const childId = parameters.childId; // O childId vem da URL aqui

    if (!childId) {
        console.error('[Audio-WS] Conexão de áudio sem childId na URL.');
        ws.close(1008, 'childId is required for audio WebSocket');
        return;
    }

    console.log(`[Audio-WS] Tentativa de conexão de áudio para childId: ${childId}`);

    let clientInfo = wsConnections.get(childId); // Tenta encontrar o clientInfo existente

    // Se o clientInfo NÃO existe no wsConnections, ou o tipo não é 'child' (o que indica que o WS de comandos não está ativo)
    if (!clientInfo || clientInfo.type !== 'child') {
        // Buscar no DynamoDB para ter certeza que o registro completo existe
        try {
            const result = await docClient.get({
                TableName: DYNAMODB_TABLE_CHILDREN,
                Key: { childId: childId }
            }).promise();

            // SÓ PROSSIGA SE ENCONTROU O ITEM E ELE TIVER childName E parentId
            if (result.Item && result.Item.childName && result.Item.parentId) {
                // Se existe no DB e está completo, mas não no wsConnections, recrie o clientInfo para áudio
                // Isso pode acontecer se o serviço de comandos caiu mas o áudio tentou reconectar
                clientInfo = {
                    id: childId,
                    parentId: result.Item.parentId,
                    type: 'child', // Definimos como 'child' para consistência
                    name: result.Item.childName,
                    wsAudio: ws // Armazena a conexão de áudio aqui
                };
                wsConnections.set(childId, clientInfo); // Adiciona/atualiza no mapa de conexões
                console.log(`[Audio-WS] Child ${childId} encontrado no DB e adicionado ao wsConnections (áudio).`);

                // Atualizar status de conexão no DynamoDB (garantir que está conectado)
                await docClient.update({
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Key: { childId: childId },
                    UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
                    ExpressionAttributeValues: {
                        ':connected': true,
                        ':lastActivity': new Date().toISOString()
                    }
                }).promise();
                console.log(`[DynamoDB] Filho ${childId} (áudio) status de conexão atualizado para 'true'.`);

            } else {
                // SE NÃO ENCONTROU NO DB ou o registro está INCOMPLETO (falta childName/parentId), feche a conexão.
                console.warn(`[Audio-WS] childId ${childId} tentou conectar no áudio mas não foi encontrado ou está incompleto no DynamoDB. Fechando conexão.`);
                ws.close(1008, 'Child ID not registered or incomplete.'); // Código 1008 para Política de Violação
                return; // Importante para não continuar a execução
            }
        } catch (error) {
            console.error(`[Audio-WS] Erro ao buscar childId ${childId} no DynamoDB:`, error);
            ws.close(1008, 'Server error during child check');
            return;
        }
    } else {
        // Se o clientInfo já existe (já conectado no ws-commands), apenas atualiza o WS de áudio
        clientInfo.wsAudio = ws; // Adiciona o WebSocket de áudio ao clientInfo existente
        console.log(`[Audio-WS] Child ${childId} já conectado (comando), adicionando WS de áudio.`);
        // Garante que o status 'connected' esteja true no DB
        try {
            await docClient.update({
                TableName: DYNAMODB_TABLE_CHILDREN,
                Key: { childId: childId },
                UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
                ExpressionAttributeValues: {
                    ':connected': true,
                    ':lastActivity': new Date().toISOString()
                }
            }).promise();
            console.log(`[DynamoDB] Filho ${childId} (áudio) status de conexão (garantido) atualizado para 'true'.`);
        } catch (error) {
            console.error(`[DynamoDB] Erro ao garantir status conectado para ${childId} no WS de áudio:`, error);
        }
    }

    // Lógica para receber chunks de áudio
    ws.on('message', message => {
        // console.log(`[Audio-WS] Recebido chunk de áudio do filho ${childId}. Tamanho: ${message.length}`);
        // Encaminhar o chunk de áudio para o pai que está escutando
        wsConnections.forEach(client => {
            if (client.type === 'parent' && client.listeningToChildId === childId && client.ws && client.ws.readyState === WebSocket.OPEN) {
                // console.log(`[Audio-WS] Encaminhando áudio para o pai ${client.id}`);
                client.ws.send(message); // Envia o buffer de áudio diretamente
            }
        });
    });

    ws.on('close', async (code, reason) => {
        console.log(`[Audio-WS] Conexão de áudio fechada para ${childId}. Código: ${code}, Razão: ${reason || ''}`);
        // Remover a referência ao WebSocket de áudio do clientInfo
        const client = wsConnections.get(childId);
        if (client) {
            delete client.wsAudio;
            console.log(`[Audio-WS] wsAudio removido do clientInfo para ${childId}.`);
            // Se o WS de comandos também estiver fechado, marque como offline no DB
            if (!client.ws || client.ws.readyState !== WebSocket.OPEN) {
                try {
                    await docClient.update({
                        TableName: DYNAMODB_TABLE_CHILDREN,
                        Key: { childId: childId },
                        UpdateExpression: 'SET connected = :connected, lastActivity = :lastActivity',
                        ExpressionAttributeValues: {
                            ':connected': false,
                            ':lastActivity': new Date().toISOString()
                        }
                    }).promise();
                    console.log(`[DynamoDB] Filho ${childId} (áudio) status de conexão atualizado para 'false' após desconexão total.`);
                } catch (error) {
                    console.error(`[DynamoDB] Erro ao atualizar status de desconexão de áudio para ${childId}:`, error);
                }
            }
        }
    });

    ws.on('error', error => {
        console.error(`[Audio-WS] Erro no WebSocket de áudio para ${childId}:`, error);
    });
});


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