const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT; // Remove o || 3000 para forçar o uso da porta do Render

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

// Configuração de upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const childId = req.body.childId || 'unknown';
        const type = req.body.type || 'unknown';
        const ext = path.extname(file.originalname).toLowerCase();
        const mediaType = ext === '.jpg' || ext === '.png' ? 'image' : ext === '.mp4' ? 'video' : 'audio';
        cb(null, `${mediaType}-${childId}-${timestamp}${ext}`);
    }
});
const upload = multer({ storage: storage });

app.post('/notifications', (req, res) => {
    const { childId, message, messageType, timestamp, contactOrGroup, direction } = req.body;
    const timestampValue = timestamp || Date.now().toString();
    console.log(`Notificação recebida - childId: ${childId}, message: ${message}, timestamp: ${timestampValue}, type: ${messageType}, contactOrGroup: ${contactOrGroup}, direction: ${direction}`);

    // Validação básica
    if (!childId || !message) {
        console.log('Erro: childId ou message ausentes');
        return res.status(400).json({ message: 'childId e message são obrigatórios' });
    }

    // Determinar o direction se não for fornecido
    const messageDirection = direction || (messageType === "SENT" ? "sent" : messageType === "RECEIVED" ? "received" : "unknown");

    // Garantir que contactOrGroup tenha um valor padrão
    const contactOrGroupValue = contactOrGroup || 'unknown';

    // Salvar a notificação como um arquivo de texto
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir);
    }
    const fileName = `${messageType || 'text'}-${childId}-${timestampValue}.txt`;
    const filePath = path.join(uploadDir, fileName);
    const content = JSON.stringify({
        message,
        type: messageType || 'text',
        direction: messageDirection,
        contactOrGroup: contactOrGroupValue
    });
    try {
        fs.writeFileSync(filePath, content);
        console.log(`Notificação salva em: ${filePath}`);
        res.status(200).json({ message: 'Notificação recebida e salva com sucesso' });
    } catch (error) {
        console.error(`Erro ao salvar notificação: ${error.message}`);
        res.status(500).json({ message: 'Erro ao salvar notificação', error: error.message });
    }
});

app.post('/media', upload.single('file'), (req, res) => {
    const { childId, type, timestamp, direction, contactOrGroup } = req.body;
    const filePath = req.file ? req.file.path : null;
    console.log(`Mídia recebida - childId: ${childId}, type: ${type}, timestamp: ${timestamp}, direction: ${direction}, contactOrGroup: ${contactOrGroup}, filePath: ${filePath}`);

    if (!filePath) {
        console.log('Erro: Arquivo não foi enviado');
        return res.status(400).json({ message: 'Arquivo é obrigatório' });
    }
    if (!direction || !['sent', 'received'].includes(direction)) {
        console.log('Erro: direction inválido ou ausente');
        return res.status(400).json({ message: 'direction é obrigatório e deve ser "sent" ou "received"' });
    }

    // Garantir que contactOrGroup tenha um valor padrão
    const contactOrGroupValue = contactOrGroup || 'unknown';

    // Opcional: Salvar direction e contactOrGroup em um arquivo de metadados associado à mídia
    const metaFileName = `meta-${childId}-${timestamp}.json`;
    const metaFilePath = path.join('uploads/', metaFileName);
    const metaContent = JSON.stringify({ direction, contactOrGroup: contactOrGroupValue });
    try {
        fs.writeFileSync(metaFilePath, metaContent);
        console.log(`Metadados salvos em: ${metaFilePath}`);
    } catch (error) {
        console.error(`Erro ao salvar metadados: ${error.message}`);
    }

    res.status(200).json({ message: 'Mídia recebida com sucesso', filePath });
});

app.get('/get-conversations/:childId', (req, res) => {
    const { childId } = req.params;
    const uploadDir = 'uploads/';
    const conversations = [];
    try {
        if (!fs.existsSync(uploadDir)) {
            console.log(`Pasta ${uploadDir} não existe, retornando lista vazia`);
            return res.status(200).json([]);
        }
        const files = fs.readdirSync(uploadDir).filter(file => file.includes(childId));
        console.log(`Arquivos encontrados para ${childId}:`, files);

        for (const file of files) {
            try {
                const parts = file.split('-');
                if (parts.length < 3) {
                    console.log(`Arquivo com formato inválido: ${file}, ignorando`);
                    continue;
                }
                const type = parts[0];
                const fileChildId = parts[1];
                const timestamp = parts[2].split('.')[0];
                if (fileChildId !== childId) {
                    console.log(`Arquivo ${file} não pertence a childId ${childId}, ignorando`);
                    continue;
                }
                if (['text', 'LOCATION', 'SENT', 'RECEIVED', 'IMAGE', 'AUDIO', 'WHATSAPP_MESSAGE'].includes(type.toUpperCase())) {
                    const content = fs.readFileSync(path.join(uploadDir, file), 'utf-8');
                    let parsedContent;
                    try {
                        parsedContent = JSON.parse(content);
                    } catch (parseError) {
                        console.error(`Erro ao parsear JSON do arquivo ${file}: ${parseError.message}`);
                        continue;
                    }
                    conversations.push({
                        childId: fileChildId,
                        type: parsedContent.type || 'text',
                        timestamp: timestamp,
                        message: parsedContent.message || parsedContent.text || '',
                        direction: parsedContent.direction || 'unknown',
                        contactOrGroup: parsedContent.contactOrGroup || 'unknown'
                    });
                } else if (['image', 'video', 'audio'].includes(type)) {
                    const metaFile = `meta-${childId}-${timestamp}.json`;
                    let direction = 'received';
                    let contactOrGroup = 'unknown';
                    if (fs.existsSync(path.join(uploadDir, metaFile))) {
                        const metaContent = fs.readFileSync(path.join(uploadDir, metaFile), 'utf-8');
                        const parsedMeta = JSON.parse(metaContent);
                        direction = parsedMeta.direction || 'received';
                        contactOrGroup = parsedMeta.contactOrGroup || 'unknown';
                    }
                    conversations.push({
                        childId: fileChildId,
                        type: type,
                        filePath: `/${uploadDir}${file}`,
                        timestamp: timestamp,
                        direction: direction,
                        contactOrGroup: contactOrGroup
                    });
                } else {
                    console.log(`Tipo de arquivo desconhecido: ${type}, arquivo: ${file}, ignorando`);
                }
            } catch (error) {
                console.error(`Erro ao processar arquivo ${file}: ${error.message}`);
            }
        }

        // Agrupar por contactOrGroup
        const groupedConversations = {};
        conversations.forEach(conversation => {
            const group = conversation.contactOrGroup || 'unknown';
            if (!groupedConversations[group]) {
                groupedConversations[group] = [];
            }
            groupedConversations[group].push(conversation);
        });

        console.log(`Conversas agrupadas retornadas para ${childId}:`, groupedConversations);
        res.status(200).json(groupedConversations);
    } catch (error) {
        console.error(`Erro ao processar get-conversations/${childId}: ${error.message}`);
        res.status(500).json({ message: 'Erro ao buscar conversas', error: error.message });
    }
});

app.get('/get-child-ids', (req, res) => {
    const uploadDir = 'uploads/';
    try {
        if (!fs.existsSync(uploadDir)) {
            console.log(`Pasta ${uploadDir} não existe, retornando lista vazia`);
            return res.status(200).json([]);
        }
        const files = fs.readdirSync(uploadDir);
        console.log(`Arquivos encontrados:`, files);
        const childIds = [...new Set(files.map(file => {
            const parts = file.split('-');
            return parts[1] || 'unknown';
        }))].filter(childId => childId !== 'unknown');
        console.log(`childIds retornados:`, childIds);
        res.status(200).json(childIds);
    } catch (error) {
        console.error(`Erro ao listar childIds: ${error.message}`);
        res.status(500).json({ message: 'Erro ao listar childIds', error: error.message });
    }
});

app.post('/rename-child-id/:oldChildId/:newChildId', (req, res) => {
    const { oldChildId, newChildId } = req.params;
    const uploadDir = 'uploads/';
    try {
        if (!fs.existsSync(uploadDir)) {
            console.log(`Pasta ${uploadDir} não existe`);
            return res.status(404).json({ message: 'Nenhum dado encontrado para renomear' });
        }

        const files = fs.readdirSync(uploadDir).filter(file => file.includes(oldChildId));
        console.log(`Arquivos encontrados para ${oldChildId}:`, files);

        for (const file of files) {
            const parts = file.split('-');
            if (parts.length < 3) {
                console.log(`Arquivo com formato inválido: ${file}, ignorando`);
                continue;
            }
            const type = parts[0];
            const fileChildId = parts[1];
            const timestamp = parts[2].split('.')[0];
            if (fileChildId !== oldChildId) {
                console.log(`Arquivo ${file} não pertence a childId ${oldChildId}, ignorando`);
                continue;
            }

            const oldFilePath = path.join(uploadDir, file);
            const newFileName = file.replace(`${type}-${oldChildId}`, `${type}-${newChildId}`);
            const newFilePath = path.join(uploadDir, newFileName);

            fs.renameSync(oldFilePath, newFilePath);
            console.log(`Arquivo renomeado de ${file} para ${newFileName}`);
        }

        res.status(200).json({ message: `childId renomeado de ${oldChildId} para ${newChildId}` });
    } catch (error) {
        console.error(`Erro ao renomear childId de ${oldChildId} para ${newChildId}: ${error.message}`);
        res.status(500).json({ message: 'Erro ao renomear childId', error: error.message });
    }
});

app.use('/uploads', express.static('uploads'));

// Middleware para capturar erros 404
app.use((req, res) => {
    console.log(`Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`PORTA AMBIENTE: ${process.env.PORT}`); // Log para depurar a porta
});