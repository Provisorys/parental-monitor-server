const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs'); // Manter fs por enquanto para a rota /get-conversations e /get-child-ids até migrarmos para DynamoDB
const { v4: uuidv4 } = require('uuid'); // Para gerar IDs únicos para mensagens

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

---

## Rotas de API com Integração AWS

### Rota para receber notificações (mensagens de texto)

Esta rota agora salva mensagens na tabela **`Messages`** do DynamoDB.

```javascript
app.post('/notifications', async (req, res) => {
    console.log('Requisição POST /notifications recebida.');
    const { childId, message, messageType, timestamp, contactOrGroup, direction, phoneNumber } = req.body;
    const timestampValue = timestamp || Date.now(); // Usar number para timestamp
    const messageTypeString = messageType || 'TEXT_MESSAGE'; // Padrão se não for fornecido

    // Validação básica
    if (!childId || !message) {
        console.error('Erro: childId ou message ausentes na requisição /notifications.');
        return res.status(400).json({ message: 'childId e message são obrigatórios' });
    }

    const messageDirection = direction || (messageTypeString === "SENT" ? "sent" : messageTypeString === "RECEIVED" ? "received" : "unknown");
    const contactOrGroupValue = contactOrGroup || 'unknown';
    const phoneNumberValue = phoneNumber || 'unknown_number';

    const messageItem = {
        id: uuidv4(), // ID único para a mensagem
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
        // Isso é importante para o /get-conversations/ que busca a última mensagem e contato
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
        // Retornar um erro 500 para o cliente, indicando falha no servidor
        res.status(500).json({ message: 'Erro interno do servidor ao processar notificação.', error: error.message });
    }
});