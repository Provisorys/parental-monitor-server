const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
// const { v4: uuidv4 } = require('uuid'); // Removido: Não precisamos mais de uuidv4 para IDs numéricos

// SDK da AWS
const AWS = require('aws-sdk');

const app = express();
const PORT = process.env.PORT; // A porta do Render é fornecida via variável de ambiente

// Configuração da AWS
// Certifique-se de que AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY e AWS_REGION
// estão definidos nas variáveis de ambiente do Render.
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION // Deve ser 'us-east-1' para suas tabelas atuais
});

// Clientes AWS
const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

// Nomes das tabelas DynamoDB (use variáveis de ambiente para produção)
const DYNAMODB_TABLE_CHILDREN = process.env.DYNAMODB_TABLE_CHILDREN || 'Children';
const DYNAMODB_TABLE_MESSAGES = process.env.DYNAMODB_TABLE_MESSAGES || 'Messages';
const DYNAMODB_TABLE_CONVERSATIONS = process.env.DYNAMODB_TABLE_CONVERSATIONS || 'Conversations';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'parental-monitor-midias-provisory'; // Nome do seu bucket S3

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Middleware para capturar requisições
app.use((req, res, next) => {
    console.log(`Requisição recebida: ${req.method} ${req.url}`);
    next();
});

// Rota padrão
app.get('/', (req, res) => {
    console.log('Requisição GET / recebida');
    res.status(200).send('Servidor Parental Monitor rodando!');
});

// Configuração de upload para arquivos de mídia (ainda usa memória, mas o destino final é o S3)
const upload = multer({
    storage: multer.memoryStorage(), // Armazena o arquivo em memória para upload direto para o S3
    limits: { fileSize: 20 * 1024 * 1024 } // Limite de 20MB para uploads
});

// --- Rotas de API com Integração AWS ---

// Rota para receber notificações (mensagens de texto)
app.post('/notifications', async (req, res) => {
    console.log('Requisição POST /notifications recebida.');
    const { childId, message, messageType, timestamp, contactOrGroup, direction, phoneNumber } = req.body;
    const timestampValue = timestamp || Date.now(); // Usar number para timestamp
    const messageTypeString = messageType || 'TEXT_MESSAGE'; // Padrão se não for fornecido

    // Validação básica
    if (!childId || !message) {
        console.error('Erro: Campos obrigatórios childId ou message ausentes na requisição /notifications.');
        return res.status(400).json({ message: 'childId e message são obrigatórios' });
    }

    const messageDirection = direction || (messageTypeString === "SENT" ? "sent" : messageTypeString === "RECEIVED" ? "received" : "unknown");
    const contactOrGroupValue = contactOrGroup || 'unknown';
    const phoneNumberValue = phoneNumber || 'unknown_number';

    const messageItem = {
        // id: uuidv4(), // Antigo: Gerava string, mas a tabela espera Number
        id: timestampValue + Math.floor(Math.random() * 1000), // NOVO: Gerando ID numérico único
        childId,
        message,
        messageType: messageTypeString,
        timestamp: timestampValue,
        contactOrGroup: contactOrGroupValue,
        phoneNumber: phoneNumberValue,
        direction: messageDirection
    };

    const putMessageParams = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: messageItem
    };

    try {
        console.log('Tentando salvar mensagem no DynamoDB:', JSON.stringify(messageItem));
        await docClient.put(putMessageParams).promise();
        console.log('Mensagem salva com sucesso no DynamoDB.');

        // Lógica para atualizar a conversa (se existir uma tabela Conversations)
        const updateConversationParams = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: {
                childId: childId,
                contactOrGroup: contactOrGroupValue // contactOrGroup é a SK da Conversations
            },
            UpdateExpression: 'SET #ts = :timestamp, #lm = :lastMessage, #pn = :phoneNumber, #dir = :direction',
            ExpressionAttributeNames: {
                '#ts': 'lastTimestamp',
                '#lm': 'lastMessage',
                '#pn': 'phoneNumber',
                '#dir': 'lastDirection'
            },
            ExpressionAttributeValues: {
                ':timestamp': timestampValue,
                ':lastMessage': message,
                ':phoneNumber': phoneNumberValue,
                ':direction': messageDirection
            },
            ReturnValues: 'UPDATED_NEW' // Retorna os atributos atualizados
        };

        console.log('Tentando atualizar conversa no DynamoDB:', updateConversationParams.Key);
        await docClient.update(updateConversationParams).promise();
        console.log('Conversa atualizada com sucesso no DynamoDB.');

        res.status(200).json({ message: 'Notificação recebida e salva com sucesso' });

    } catch (error) {
        console.error('Erro ao salvar notificação ou atualizar conversa no DynamoDB:', error);
        res.status(500).json({ message: 'Erro interno do servidor ao processar notificação.', error: error.message });
    }
});

// Rota para receber arquivos de mídia
app.post('/media', upload.single('file'), async (req, res) => {
    console.log('Requisição POST /media recebida.');
    const { childId, type, timestamp, direction, contactOrGroup, phoneNumber } = req.body;
    const file = req.file; // Arquivo em memória do multer
    const timestampValue = timestamp || Date.now();

    if (!file) {
        console.error('Erro: Arquivo de mídia não foi enviado.');
        return res.status(400).json({ message: 'Arquivo é obrigatório' });
    }
    if (!direction || !['sent', 'received'].includes(direction)) {
        console.error('Erro: direction inválido ou ausente para mídia.');
        return res.status(400).json({ message: 'direction é obrigatório e deve ser "sent" ou "received"' });
    }

    const contactOrGroupValue = contactOrGroup || 'unknown';
    const phoneNumberValue = phoneNumber || 'unknown_number';
    const fileExtension = file.originalname ? `.${file.originalname.split('.').pop()}` : ''; // Extrai extensão de forma segura
    // const mediaId = uuidv4(); // Antigo: Gerava string, mas a tabela espera Number
    const mediaId = timestampValue + Math.floor(Math.random() * 1000); // NOVO: Gerando ID numérico único
    const s3Key = `media/${childId}/${mediaId}${fileExtension}`; // Caminho no S3

    const s3UploadParams = {
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Body: file.buffer, // Buffer do arquivo em memória
        ContentType: file.mimetype
    };

    const messageItem = {
        id: mediaId, // ID único para a mídia
        childId,
        message: `Mídia (${type || file.mimetype})`, // Mensagem descritiva para mídia
        messageType: type || file.mimetype, // Pode ser 'image', 'video', 'audio' ou mimetype
        timestamp: timestampValue,
        contactOrGroup: contactOrGroupValue,
        s3Url: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}` // URL pública do S3 (ajuste se usar CloudFront)
    };

    const putMessageParams = {
        TableName: DYNAMODB_TABLE_MESSAGES,
        Item: messageItem
    };

    try {
        console.log('Tentando fazer upload de mídia para S3:', s3Key);
        await s3.upload(s3UploadParams).promise();
        console.log('Upload de mídia para S3 concluído com sucesso.');

        console.log('Tentando salvar metadados da mídia no DynamoDB:', JSON.stringify(messageItem));
        await docClient.put(putMessageParams).promise();
        console.log('Metadados da mídia salvos com sucesso no DynamoDB.');

        // Lógica para atualizar a conversa na tabela Conversations (assim como nas notificações)
        const updateConversationParams = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            Key: {
                childId: childId,
                contactOrGroup: contactOrGroupValue
            },
            UpdateExpression: 'SET #ts = :timestamp, #lm = :lastMessage, #pn = :phoneNumber, #dir = :direction',
            ExpressionAttributeNames: {
                '#ts': 'lastTimestamp',
                '#lm': 'lastMessage',
                '#pn': 'phoneNumber',
                '#dir': 'lastDirection'
            },
            ExpressionAttributeValues: {
                ':timestamp': timestampValue,
                ':lastMessage': `Mídia (${type || file.mimetype})`,
                ':phoneNumber': phoneNumberValue,
                ':direction': direction
            },
            ReturnValues: 'UPDATED_NEW'
        };

        console.log('Tentando atualizar conversa (mídia) no DynamoDB:', updateConversationParams.Key);
        await docClient.update(updateConversationParams).promise();
        console.log('Conversa (mídia) atualizada com sucesso no DynamoDB.');

        res.status(200).json({ message: 'Mídia recebida e processada com sucesso', s3Url: messageItem.s3Url });

    } catch (error) {
        console.error('Erro ao processar mídia (S3 ou DynamoDB):', error);
        res.status(500).json({ message: 'Erro interno do servidor ao processar mídia.', error: error.message });
    }
});

// Rota para buscar as conversas de um determinado childId
app.get('/get-conversations/:childId', async (req, res) => {
    console.log('Requisição GET /get-conversations/:childId recebida.');
    const { childId } = req.params;

    if (!childId) {
        console.error('Erro: childId ausente na requisição /get-conversations.');
        return res.status(400).json({ message: 'childId é obrigatório' });
    }

    try {
        // 1. Buscar todas as conversas para este childId na tabela Conversations
        // A tabela Conversations tem childId como Partition Key (PK) e contactOrGroup como Sort Key (SK).
        const conversationsParams = {
            TableName: DYNAMODB_TABLE_CONVERSATIONS,
            KeyConditionExpression: 'childId = :cid',
            ExpressionAttributeValues: {
                ':cid': childId
            }
        };
        console.log('Tentando buscar conversas no DynamoDB para childId:', childId);
        const conversationsData = await docClient.query(conversationsParams).promise();
        const rawConversations = conversationsData.Items;
        console.log(`Conversas encontradas para ${childId}:`, rawConversations.length);

        if (!rawConversations || rawConversations.length === 0) {
            console.log(`Nenhuma conversa encontrada para ${childId}.`);
            return res.status(200).json([]);
        }

        // 2. Para cada conversa, buscar as mensagens correspondentes na tabela Messages
        // A tabela Messages tem childId como Partition Key (PK) e id como Sort Key (SK).
        // Precisamos de um GSI (Global Secondary Index) em Messages que use contactOrGroup e phoneNumber
        // para buscar mensagens de uma conversa específica ou scanear e filtrar.
        // Assumindo que você tem um GSI ou vai filtrar o scan, vamos usar Scan para demonstração.
        // Para melhor performance, crie um GSI em 'Messages' com Partition Key 'childId' e Sort Key 'contactOrGroup'.
        const groupedConversations = [];

        for (const conv of rawConversations) {
            const messagesParams = {
                TableName: DYNAMODB_TABLE_MESSAGES,
                // Idealmente, você usaria um GSI aqui para 'contactOrGroup' e 'phoneNumber'
                // ou apenas 'contactOrGroup' para o childId.
                // Como não temos um GSI definido, vamos usar um SCAN com FilterExpression.
                // ATENÇÃO: SCANs são caros e lentos para grandes volumes de dados.
                FilterExpression: 'childId = :cid AND contactOrGroup = :cog AND phoneNumber = :pn',
                ExpressionAttributeValues: {
                    ':cid': childId,
                    ':cog': conv.contactOrGroup,
                    ':pn': conv.phoneNumber
                }
            };

            console.log(`Tentando buscar mensagens (SCAN) para conversa: ${conv.contactOrGroup} (${conv.phoneNumber})`);
            const messagesData = await docClient.scan(messagesParams).promise(); // Usando scan
            const messages = messagesData.Items;
            console.log(`Mensagens encontradas para ${conv.contactOrGroup}:`, messages.length);

            // Ordenar mensagens por timestamp (mais recentes primeiro)
            messages.sort((a, b) => b.timestamp - a.timestamp);

            groupedConversations.push({
                contactOrGroup: conv.contactOrGroup,
                phoneNumber: conv.phoneNumber,
                lastTimestamp: conv.lastTimestamp,
                lastMessage: conv.lastMessage,
                lastDirection: conv.lastDirection,
                messages: messages
            });
        }

        // 3. Ordenar as conversas agrupadas pela última mensagem (mais recente primeiro)
        groupedConversations.sort((a, b) => b.lastTimestamp - a.lastTimestamp);

        console.log(`Conversas agrupadas retornadas para ${childId}:`, groupedConversations.length);
        res.status(200).json(groupedConversations);

    } catch (error) {
        console.error(`Erro ao buscar conversas para childId ${childId} no DynamoDB:`, error);
        res.status(500).json({ message: 'Erro ao buscar conversas', error: error.message });
    }
});

// Rota para buscar child IDs
app.get('/get-child-ids', async (req, res) => {
    console.log('Requisição GET /get-child-ids recebida.');
    const params = {
        TableName: DYNAMODB_TABLE_CHILDREN,
        ProjectionExpression: 'childId' // Apenas pega o childId
    };

    try {
        console.log('Tentando escanear child IDs na tabela Children do DynamoDB.');
        const data = await docClient.scan(params).promise(); // Usando scan, pois não há filtro de PK/SK aqui
        const childIds = [...new Set(data.Items.map(item => item.childId))]; // Garante IDs únicos
        console.log(`childIds encontrados no DynamoDB:`, childIds);
        res.status(200).json(childIds);
    } catch (error) {
        console.error('Erro ao listar child IDs no DynamoDB:', error);
        res.status(500).json({ message: 'Erro ao listar child IDs', error: error.message });
    }
});

// Rota para renomear child ID
app.post('/rename-child-id/:oldChildId/:newChildId', async (req, res) => {
    console.log('Requisição POST /rename-child-id recebida.');
    const { oldChildId, newChildId } = req.params;

    if (!oldChildId || !newChildId) {
        console.error('Erro: oldChildId ou newChildId ausentes.');
        return res.status(400).json({ message: 'oldChildId e newChildId são obrigatórios' });
    }

    try {
        // A funcionalidade de renomear childId em DynamoDB/S3 é complexa e requer lógica de migração de dados.
        // Isso normalmente envolve:
        // 1. Consultar todos os itens do oldChildId em TODAS as tabelas (Children, Messages, Conversations).
        // 2. Criar novos itens com o newChildId para cada item encontrado.
        // 3. Deletar os itens antigos com o oldChildId.
        // 4. Para S3: Copiar objetos do prefixo oldChildId para newChildId e depois deletar os antigos.
        // Isso pode ser demorado e deve ser tratado em um processo assíncrono (ex: AWS Lambda, Fargate task),
        // não em uma requisição HTTP direta, para evitar timeouts.
        console.warn(`Atenção: A função de renomear childId não está totalmente implementada para DynamoDB/S3. Esta operação é complexa e não é recomendada para execução em requisição HTTP direta.`);
        return res.status(501).json({ message: 'A funcionalidade de renomear childId não está totalmente implementada para DynamoDB/S3 e precisa de uma solução robusta para migração de dados.' });

    } catch (error) {
        console.error(`Erro ao renomear childId de ${oldChildId} para ${newChildId}:`, error);
        res.status(500).json({ message: 'Erro ao renomear childId', error: error.message });
    }
});

// Middleware para capturar erros 404
app.use((req, res) => {
    console.log(`Rota não encontrada (404): ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});

// Tratamento de erros geral
app.use((err, req, res, next) => {
    console.error('Erro de servidor não tratado:', err);
    res.status(500).send('Erro interno do servidor.');
});

app.listen(PORT || 10000, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT || 10000}`);
    console.log(`PORTA AMBIENTE: ${process.env.PORT}`);
    console.log(`Região AWS configurada: ${process.env.AWS_REGION}`);
    console.log(`Bucket S3 configurado: ${process.env.S3_BUCKET_NAME}`);
    console.log(`Tabelas DynamoDB: Children=${DYNAMODB_TABLE_CHILDREN}, Messages=${DYNAMODB_TABLE_MESSAGES}, Conversations=${DYNAMODB_TABLE_CONVERSATIONS}`);
});