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

// Configuração do Multer para upload de arquivos (sem armazenamento em disco)
const upload = multer();

// --- AWS CONFIG ---
// Configura as credenciais e região da AWS.
// As chaves de acesso devem ser fornecidas via variáveis de ambiente.
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' // Região padrão, pode ser sobrescrita
});

// Inicializa o cliente DynamoDB DocumentClient para interagir com o DynamoDB
const docClient = new AWS.DynamoDB.DocumentClient();
// Inicializa o cliente S3 para interagir com o Amazon S3
const s3 = new AWS.S3();

// --- Constantes para Nomes de Tabelas DynamoDB ---
// Facilita a manutenção e evita erros de digitação nos nomes das tabelas.
const DYNAMODB_TABLE_MESSAGES = 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = 'Conversations';
const DYNAMODB_TABLE_LOCATIONS = 'GPSintegracao';
const DYNAMODB_TABLE_CHILDREN = 'Children'; // Tabela para registrar informações dos filhos

// --- Configuração do Express (middlewares) ---
app.use(cors()); // Habilita CORS para permitir requisições de diferentes origens
app.use(bodyParser.json()); // Habilita o parsing de corpos de requisição JSON
app.use(bodyParser.urlencoded({ extended: true })); // Habilita o parsing de corpos de requisição URL-encoded

// --- Rota de Teste ---
// Rota simples para verificar se o servidor está online
app.get('/', (req, res) => {
    res.send('Servidor de Monitoramento Parental Online!');
});

// --- Rota para Registrar ou Atualizar um Filho via HTTP ---
app.post('/register-child', async (req, res) => {
    const { id, childName, parentId } = req.body;

    // Validação básica dos dados recebidos
    if (!id || !childName || !parentId) {
        console.warn('[HTTP_ERROR] Tentativa de registrar filho com dados incompletos.');
        return res.status(400).send('ID do filho, nome e ID do pai são obrigatórios.');
    }

    // Parâmetros para a operação put no DynamoDB (insere ou atualiza um item)
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        Item: {
            childId: id,
            childName: childName,
            parentId: parentId,
            registrationDate: new Date().toISOString(), // Data de registro
            connected: false // Status inicial de conexão
        }
    };

    try {
        await docClient.put(params).promise(); // Executa a operação put
        console.log(`[DynamoDB] Filho registrado/atualizado via HTTP: ${childName} (ID: ${id}) para o pai ${parentId}`);
        res.status(200).send('Filho registrado com sucesso via HTTP.');
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao registrar filho via HTTP:', error);
        res.status(500).send('Erro ao registrar filho via HTTP.');
    }
});

// --- Rota para Listar Filhos Registrados por Parent ID ---
app.get('/get-registered-children', async (req, res) => {
    const { parentId } = req.query; // Pega o parentId da query string

    const params = {
        TableName: DylocalStorage.clear(),
    };

    // Se um parentId for fornecido, filtra os resultados por ele
    if (parentId) {
        params.FilterExpression = 'parentId = :parentId';
        params.ExpressionAttributeValues = { ':parentId': parentId };
    }

    try {
        const data = await docClient.scan(params).promise(); // Executa a operação scan
        console.log(`[DynamoDB] Lista de filhos registrados solicitada da tabela '${DYNAMODB_TABLE_CHILDREN}'. Encontrados ${data.Items.length} filhos.`);
        res.status(200).json(data.Items); // Retorna os itens encontrados como JSON
    } catch (error) {
        console.error('[DynamoDB_ERROR] Erro ao listar filhos registrados:', error);
        res.status(500).send('Erro ao listar filhos registrados.');
    }
});

// --- Rotas de Upload de Áudio (mantidas como estão, usando S3) ---
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        console.warn('[S3_ERROR] Tentativa de upload de áudio sem arquivo.');
        return res.status(400).send('Nenhum arquivo de áudio enviado.');
    }

    const { childId, parentId, conversationId } = req.body;
    if (!childId || !parentId || !conversationId) {
        console.warn('[S3_ERROR] Dados incompletos para upload de áudio.');
        return res.status(400).send('childId, parentId e conversationId são obrigatórios.');
    }

    const s3BucketName = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory';
    const audioFileName = `audio-${uuidv4()}.opus`; // Nome único para o arquivo de áudio
    const s3Key = `conversations/${conversationId}/${audioFileName}`; // Caminho no S3

    const params = {
        Bucket: s3BucketName,
        Key: s3Key,
        Body: req.file.buffer, // Conteúdo do arquivo de áudio
        ContentType: req.file.mimetype // Tipo MIME do arquivo
    };

    try {
        // Faz o upload do arquivo para o S3
        await s3.upload(params).promise();
        const audioUrl = `https://${s3BucketName}.s3.${AWS.config.region}.amazonaws.com/${s3Key}`;
        console.log(`[S3] Áudio enviado para S3: ${audioUrl}`);

        // Registra a mensagem de áudio na tabela de mensagens do DynamoDB
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
        console.log(`[DynamoDB] Mensagem de áudio registrada para conversa ${conversationId}.`);

        // Atualiza a conversa com a última mensagem e timestamp
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
        console.log(`[DynamoDB] Conversa ${conversationId} atualizada com o último áudio.`);

        res.status(200).json({ message: 'Áudio enviado e registrado com sucesso!', audioUrl: audioUrl });
    } catch (error) {
        console.error('[S3_ERROR] Erro ao fazer upload do áudio ou registrar mensagem:', error);
        res.status(500).send('Erro ao processar o upload do áudio.');
    }
});

// --- Criação do Servidor HTTP e WebSocket ---
const server = http.createServer(app);
const wssCommands = new WebSocket.Server({ noServer: true }); // WebSocket Server para comandos (GPS, chat)
const wssAudio = new WebSocket.Server({ noServer: true });   // WebSocket Server para streaming de áudio

// activeConnections: Um mapa para armazenar e gerenciar todas as conexões WebSocket ativas.
// A chave é o ID (childId ou parentId) e o valor é um objeto contendo:
// {
//   wsCommands?: WebSocket,    // Referência ao WebSocket de comandos
//   wsAudio?: WebSocket,       // Referência ao WebSocket de áudio
//   type: string,             // 'child' ou 'parent'
//   listeningToChildId?: string, // Para pais: qual filho está ouvindo áudio (se houver)
//   childName?: string,        // Para filhos: nome do filho
//   parentId?: string          // Para filhos: ID do pai
// }
const activeConnections = new Map();

/**
 * Atualiza ou adiciona uma entrada de conexão no mapa activeConnections.
 * @param {string} id - O ID do cliente (childId ou parentId).
 * @param {string} connectionType - O tipo de cliente ('child' ou 'parent').
 * @param {WebSocket} ws - A instância do WebSocket.
 * @param {object} additionalProps - Propriedades adicionais para a entrada (ex: childName, listeningToChildId).
 */
function updateConnection(id, connectionType, ws, additionalProps = {}) {
    let entry = activeConnections.get(id);

    if (!entry) {
        // Se a entrada para este ID não existe, cria uma nova
        entry = { type: connectionType };
        activeConnections.set(id, entry);
        console.log(`[WebSocket-Manager] Nova entrada criada para ${connectionType} ID: ${id}`);
    } else {
        // Se a entrada já existe, garante que o tipo esteja correto
        entry.type = connectionType;
        console.log(`[WebSocket-Manager] Entrada existente atualizada para ${connectionType} ID: ${id}`);
    }

    // Associa o WebSocket correto (comandos ou áudio) à entrada
    if (ws.url && ws.url.includes('/ws-commands')) {
        entry.wsCommands = ws;
        ws.id = id;   // Atribui o ID diretamente ao objeto WS para referência rápida
        ws.type = connectionType; // Atribui o tipo diretamente ao objeto WS
        console.log(`[WebSocket-Manager] WS de comandos associado ao ID: ${id}`);
    } else if (ws.url && ws.url.includes('/ws-audio')) {
        entry.wsAudio = ws;
        ws.id = id;   // Atribui o ID diretamente ao objeto WS para referência rápida
        ws.type = connectionType; // Atribui o tipo diretamente ao objeto WS
        console.log(`[WebSocket-Manager] WS de áudio associado ao ID: ${id}`);
    }

    // Adiciona quaisquer propriedades adicionais
    Object.assign(entry, additionalProps);

    console.log(`[WebSocket-Manager] Conexão ${connectionType} ${id} atualizada. Total de entradas: ${activeConnections.size}`);
    // console.log("Current activeConnections state:", Array.from(activeConnections.entries())); // Para debug aprofundado do mapa
}

/**
 * Remove a referência de um WebSocket fechado e atualiza o status de conexão no DynamoDB se for um filho.
 * @param {WebSocket} wsToClose - A instância do WebSocket que está fechando.
 */
async function removeActiveConnection(wsToClose) {
    let foundId = wsToClose.id; // Tenta pegar o ID já atribuído ao WS
    let entryToUpdate = null;

    // Se o ID não foi atribuído por algum motivo (ex: erro precoce de conexão), tenta encontrá-lo no mapa
    if (!foundId) {
        for (let [id, entry] of activeConnections.entries()) {
            if (entry.wsCommands === wsToClose || entry.wsAudio === wsToClose) {
                foundId = id;
                entryToUpdate = entry;
                break;
            }
        }
    } else {
        entryToUpdate = activeConnections.get(foundId);
    }

    if (foundId && entryToUpdate) {
        // Remove a referência ao WebSocket específico que está fechando
        if (entryToUpdate.wsCommands === wsToClose) {
            delete entryToUpdate.wsCommands;
            console.log(`[WebSocket-Commands] Fechou conexão de comandos para ${foundId}.`);
        } else if (entryToUpdate.wsAudio === wsToClose) {
            delete entryToUpdate.wsAudio;
            console.log(`[WebSocket-Audio] Fechou conexão de áudio para ${foundId}.`);
        }

        // Se ambos os WebSockets (commands e audio) estiverem fechados para esta entrada, remove a entrada completa
        if (!entryToUpdate.wsCommands && !entryToUpdate.wsAudio) {
            activeConnections.delete(foundId);
            console.log(`[WebSocket-Manager] Entrada de conexão removida para: ${foundId} (ambas as WSs fechadas).`);

            // Se a conexão era de um filho e foi completamente removida, atualiza o status no DynamoDB
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
    console.log('[WebSocket-Commands] Novo cliente conectado.');
    ws.url = '/ws-commands'; // Atribui a URL para uso na função updateConnection

    ws.on('message', async message => {
        let parsedMessage;
        try {
            const messageString = message.toString();
            parsedMessage = JSON.parse(messageString);
            console.log(`[WebSocket-Commands] Mensagem JSON recebida: ${messageString}`);
        } catch (e) {
            console.error('[WebSocket-Commands] Erro ao analisar mensagem JSON, descartando:', e.message);
            return; // Sai da função se a mensagem não for um JSON válido
        }

        const { type, parentId, childName, data } = parsedMessage;
        // Pega childId do nível superior ou de 'data'
        const childId = parsedMessage.childId || (data && data.childId);

        console.log(`[WebSocket-Commands] Extracted - type: ${type}, parentId: ${parentId}, childId: ${childId}`);

        // Lógica de identificação de conexão (parentConnect, childConnect)
        if (type === 'childConnect' && childId && parentId && childName) {
            updateConnection(childId, 'child', ws, { childName: childName, parentId: parentId });
            console.log(`[WebSocket-Commands] Filho conectado e identificado: ID: ${childId}, Parent ID: ${parentId}, Nome: ${childName}`);

            // Atualiza o status de conexão do filho no DynamoDB
            const params = {
                TableName: DYNAMODB_TABLE_CHILDREN,
                Key: { childId: childId }, // Usa childId como chave
                UpdateExpression: 'SET childName = :cn, parentId = :pi, lastConnected = :lc, connected = :conn',
                ExpressionAttributeValues: {
                    ':cn': childName,
                    ':pi': parentId,
                    ':lc': new Date().toISOString(),
                    ':conn': true
                },
                ReturnValues: 'UPDATED_NEW' // Retorna os atributos atualizados
            };
            try {
                // Tenta atualizar. Se o item não existir, o DynamoDB o criará.
                await docClient.update(params).promise();
                console.log(`[DynamoDB] Filho ${childName} (${childId}) status de conexão atualizado para 'true'.`);
            } catch (err) {
                console.error(`[DynamoDB_ERROR] Erro ao atualizar status de conexão do filho ${childId}: ${err.message}`, err);
                // Se a atualização falhou (ex: item não existe e put não foi usado), tenta criar (put)
                // Isso garante que o filho será registrado mesmo que não exista previamente.
                const putParams = {
                    TableName: DYNAMODB_TABLE_CHILDREN,
                    Item: {
                        childId: childId,
                        childName: childName,
                        parentId: parentId,
                        registrationDate: new Date().toISOString(), // Data de registro inicial
                        lastConnected: new Date().toISOString(),
                        connected: true
                    }
                };
                try {
                    await docClient.put(putParams).promise();
                    console.log(`[DynamoDB] Filho ${childName} (${childId}) registrado/atualizado via WS na tabela '${DYNAMODB_TABLE_CHILDREN}'.`);
                } catch (putErr) {
                    console.error(`[DynamoDB_ERROR] Erro final ao registrar filho via WS: ${putErr.message}`, putErr);
                }
            }
        } else if (type === 'parentConnect' && parentId) {
            // Se for uma conexão de pai, verifica se está pedindo para ouvir um filho específico
            const listeningToChildId = (data && data.listeningToChildId) ? data.listeningToChildId : null;
            updateConnection(parentId, 'parent', ws, { listeningToChildId: listeningToChildId });
            console.log(`[WebSocket-Commands] Pai conectado e identificado: ID: ${parentId}, ouvindo filho: ${listeningToChildId || 'nenhum'}`);
        } else {
            // Se o WS ainda não tem ID (conexão nova sem identificação)
            if (!ws.id) {
                console.warn(`[WebSocket-Commands] Mensagem recebida antes da identificação da conexão: ${JSON.stringify(parsedMessage)}`);
                // Considerar fechar a conexão ou pedir identificação novamente se isso for um requisito
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
                        // Itera sobre todas as conexões ativas para encontrar pais que estão ouvindo este filho
                        for (let [id, entry] of activeConnections.entries()) {
                            // Verifica se é um pai, se tem um WS de comandos aberto e se está ouvindo o filho correto
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
                // A identificação já foi tratada acima na lógica de 'parentConnect'
                console.log(`[WebSocket-Commands] Pai ${ws.id} reafirmou conexão, ouvindo filho: ${activeConnections.get(ws.id)?.listeningToChildId || 'nenhum'}`);
                break;

            case 'childConnect':
                // A identificação já foi tratada acima na lógica de 'childConnect'
                console.log(`[WebSocket-Commands] Filho ${ws.id} reafirmou conexão (após registro inicial).`);
                break;

            case 'requestLocation':
                const requestedChildId = childId; // O ID do filho que o pai quer localizar
                const requestingParentId = ws.id; // O ID do pai que está solicitando

                if (requestedChildId && requestingParentId) {
                    console.log(`[WebSocket-Commands] Pai ${requestingParentId} solicitou localização do filho ${requestedChildId}.`);

                    // Busca a entrada do filho no mapa de conexões ativas
                    const childEntry = activeConnections.get(requestedChildId);

                    // Se o filho está online e tem uma conexão de comandos aberta
                    if (childEntry && childEntry.type === 'child' && childEntry.wsCommands && childEntry.wsCommands.readyState === WebSocket.OPEN) {
                        // Envia o comando 'getLocation' para o WebSocket de comandos do filho
                        childEntry.wsCommands.send(JSON.stringify({
                            type: 'getLocation',
                            childId: requestedChildId,
                            requestedBy: requestingParentId
                        }));
                        console.log(`[WebSocket-Commands] Mensagem 'getLocation' enviada para o filho ${requestedChildId}.`);
                        // Notifica o pai que a solicitação foi enviada com sucesso
                        ws.send(JSON.stringify({
                            type: 'locationRequestStatus',
                            childId: requestedChildId,
                            status: 'success',
                            message: 'Solicitação de localização enviada ao filho.'
                        }));
                    } else {
                        // Notifica o pai que o filho não está online ou não foi encontrado
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

            case 'requestAudioStream':
                if (ws.type === 'parent' && ws.id) { // Garante que é um pai enviando e já identificado
                    const requestedChildIdForAudio = parsedMessage.data && parsedMessage.data.childId;
                    if (requestedChildIdForAudio) {
                        // Atualiza a entrada do pai para indicar qual filho ele está ouvindo (apenas o comando WS)
                        updateConnection(ws.id, 'parent', ws, { listeningToChildId: requestedChildIdForAudio });
                        console.log(`[WebSocket-Commands] Pai ${ws.id} solicitou streaming de áudio do filho ${requestedChildIdForAudio}.`);

                        // Enviar comando ao filho para iniciar streaming (via ws-commands do filho)
                        const childEntry = activeConnections.get(requestedChildIdForAudio);
                        if (childEntry && childEntry.wsCommands && childEntry.wsCommands.readyState === WebSocket.OPEN) {
                            childEntry.wsCommands.send(JSON.stringify({ type: 'startAudioStream' }));
                            console.log(`[WebSocket-Commands] Comando 'startAudioStream' enviado para o filho ${requestedChildIdForAudio}.`);
                        } else {
                            console.warn(`[WebSocket-Commands] Filho ${requestedChildIdForAudio} não encontrado/online via comandos para iniciar streaming de áudio.`);
                            ws.send(JSON.stringify({ type: 'audioStreamStatus', status: 'error', message: 'Filho não está online para iniciar o streaming.', childId: requestedChildIdForAudio }));
                        }

                        ws.send(JSON.stringify({ type: 'audioStreamStatus', status: 'requested', childId: requestedChildIdForAudio }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Comando requestAudioStream inválido: childId ausente.' }));
                    }
                } else {
                    console.warn('[WebSocket-Commands] Comando requestAudioStream recebido de cliente não identificado ou não-pai.');
                }
                break;

            case 'stopAudioStream':
                if (ws.type === 'parent' && ws.id) { // Garante que é um pai enviando e já identificado
                    const stoppedChildIdForAudio = parsedMessage.data && parsedMessage.data.childId;
                    const parentEntry = activeConnections.get(ws.id);

                    // Verifica se o pai estava realmente ouvindo este filho
                    if (parentEntry && parentEntry.listeningToChildId === stoppedChildIdForAudio) {
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
                        console.warn(`[WebSocket-Commands] Pai ${ws.id} tentou parar stream de áudio de ${stoppedChildIdForAudio}, mas não estava ouvindo ou ID inválido.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Comando stopAudioStream inválido ou pai não estava ouvindo este filho.' }));
                    }
                } else {
                    console.warn('[WebSocket-Commands] Comando stopAudioStream recebido de cliente não identificado ou não-pai.');
                }
                break;

            default:
                console.warn(`[WebSocket-Commands] Tipo de mensagem desconhecido ou não tratável no WS de comandos: ${type}`);
                break;
        }
    });

    ws.on('close', async () => {
        console.log(`[WebSocket-Commands] Cliente desconectado (ID: ${ws.id || 'desconhecido'}).`);
        // Remove a conexão e atualiza o status no DynamoDB se necessário
        await removeActiveConnection(ws);
    });

    ws.on('error', error => {
        console.error('[WebSocket-Commands] Erro no WebSocket de comandos (ID: ${ws.id || 'desconhecido'}):', error);
        // Em caso de erro, tenta remover a conexão
        removeActiveConnection(ws);
    });
});


// --- WebSocket de Áudio ---
wssAudio.on('connection', ws => {
    console.log('[WebSocket-Audio] Novo cliente conectado.');
    ws.url = '/ws-audio'; // Atribui a URL para uso na função updateConnection

    ws.on('message', message => {
        let parsed = null;
        try {
            // Tenta analisar como JSON para identificação inicial (childAudioConnect, parentAudioConnect)
            parsed = JSON.parse(message.toString());
            // console.log(`[WebSocket-Audio] Mensagem JSON recebida: ${JSON.stringify(parsed)}`); // Debug: apenas para JSONs de controle
        } catch (e) {
            // console.log('[WebSocket-Audio] Mensagem não é JSON, assumindo dados de áudio binários.'); // Debug: esperado para chunks de áudio
        }

        if (parsed) {
            // Se é uma mensagem de identificação JSON
            if (parsed.type === 'childAudioConnect' && parsed.childId) {
                // Atualiza a entrada de conexão para associar este wsAudio ao filho
                updateConnection(parsed.childId, 'child', ws);
                console.log(`[WebSocket-Audio] Filho ${parsed.childId} conectado ao WS de Áudio.`);
                return; // Já processou esta mensagem de identificação
            }
            if (parsed.type === 'parentAudioConnect' && parsed.parentId) {
                // Atualiza a entrada de conexão para associar este wsAudio ao pai
                updateConnection(parsed.parentId, 'parent', ws);
                console.log(`[WebSocket-Audio] Pai ${parsed.parentId} conectado ao WS de Áudio.`);
                return; // Já processou esta mensagem de identificação
            }
            // Se for outro tipo de JSON, mas não de identificação, loga e ignora para o fluxo de áudio
            console.warn(`[WebSocket-Audio] Mensagem JSON inesperada no WS de áudio: ${JSON.stringify(parsed)}`);
            return;
        }

        // Se não foi uma mensagem JSON de identificação, assume que é o fluxo de áudio binário.
        // Precisa que o 'ws' de áudio já tenha sido identificado (ws.id e ws.type devem estar definidos)
        if (ws.type === 'child' && ws.id) { // Verifica se este WebSocket de áudio é de um filho identificado
            // console.log(`[WebSocket-Audio] Áudio recebido do filho: ${ws.id}. Retransmitindo...`); // Log de debug de streaming
            let parentFoundAndListening = false;
            // Percorre todas as entradas em activeConnections para encontrar pais ouvindo este filho
            for (let [parentId, parentEntry] of activeConnections.entries()) {
                // Verifica se é um pai, se tem um WS de áudio aberto e se está ouvindo o filho correto
                if (parentEntry.type === 'parent' && parentEntry.wsAudio && parentEntry.wsAudio.readyState === WebSocket.OPEN && parentEntry.listeningToChildId === ws.id) {
                    // Retransmite o buffer de áudio diretamente para o WebSocket de áudio do pai
                    parentEntry.wsAudio.send(message);
                    // console.log(`[WebSocket-Audio] Retransmitindo áudio do filho ${ws.id} para o pai ${parentId}.`); // Debug de streaming
                    parentFoundAndListening = true;
                }
            }
            if (!parentFoundAndListening) {
                // console.log(`[WebSocket-Audio] NENHUM pai online ou ouvindo o filho ${ws.id} para receber áudio.`); // Debug: Isso é normal se ninguém está ouvindo
            }
        } else {
            console.warn('[WebSocket-Audio] Mensagem de áudio recebida de cliente não identificado ou não-filho no WS de áudio.');
            // Opcional: Fechar conexão mal-comportada
            // ws.close(1008, 'Cliente não identificado ou tipo incorreto no WS de áudio.');
        }
    });

    ws.on('close', () => {
        console.log(`[WebSocket-Audio] Cliente desconectado (ID: ${ws.id || 'desconhecido'}).`);
        // Remove a conexão
        removeActiveConnection(ws);
    });

    ws.on('error', error => {
        console.error('[WebSocket-Audio] Erro no WebSocket de áudio (ID: ${ws.id || 'desconhecido'}):', error);
        // Em caso de erro, tenta remover a conexão
        removeActiveConnection(ws);
    });
});

// --- Roteamento de Upgrade de WebSocket ---
// Intercepta requisições de upgrade para WebSockets e as direciona para os WSs corretos
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
        console.warn(`[HTTP-Upgrade] Caminho de WebSocket inválido: ${pathname}. Destruindo socket.`);
        socket.destroy(); // Destroi o socket se o caminho não for reconhecido
    }
});

// --- Middleware para 404 (rota não encontrada) ---
app.use((req, res) => {
    console.warn(`[HTTP] Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).send('Rota não encontrada');
});

// Middleware para tratamento de erros gerais
app.use((err, req, res, next) => {
    console.error('[HTTP_ERROR] Erro interno do servidor:', err);
    res.status(500).send('Erro interno do servidor.');
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
    console.log(`Constante DYNAMODB_TABLE_CONVERSATIONS: ${DYNAMODB_TABLE_CONVERSATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_LOCATIONS: ${DYNAMODB_TABLE_LOCATIONS}`);
    console.log(`Constante DYNAMODB_TABLE_CHILDREN: ${DYNAMODB_TABLE_CHILDREN}`);
});