const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

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
    const { childId, title, text, timestamp, type } = req.body;
    console.log(`Notificação recebida - childId: ${childId}, title: ${title}, text: ${text}, timestamp: ${timestamp}, type: ${type}`);
    if (!childId || !text || !timestamp) {
        console.log('Erro: childId, text ou timestamp ausentes');
        return res.status(400).json({ message: 'childId, text e timestamp são obrigatórios' });
    }

    // Salvar a notificação como um arquivo de texto
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir);
    }
    const fileName = `text-${childId}-${timestamp}.txt`;
    const filePath = path.join(uploadDir, fileName);
    const content = JSON.stringify({ title, text, type: type || 'text' });
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
    const { childId, type, timestamp } = req.body;
    const filePath = req.file ? req.file.path : null;
    console.log(`Mídia recebida - childId: ${childId}, type: ${type}, timestamp: ${timestamp}, filePath: ${filePath}`);
    if (!filePath) {
        console.log('Erro: Arquivo não foi enviado');
        return res.status(400).json({ message: 'Arquivo é obrigatório' });
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
                if (type === 'text') {
                    const content = fs.readFileSync(path.join(uploadDir, file), 'utf-8');
                    let parsedContent;
                    try {
                        parsedContent = JSON.parse(content);
                    } catch (parseError) {
                        console.error(`Erro ao parsear JSON do arquivo ${file}: ${parseError.message}`);
                        continue;
                    }
                    conversations.push({
                        type: parsedContent.type || 'text',
                        timestamp: timestamp,
                        title: parsedContent.title || 'Sem título',
                        text: parsedContent.text || ''
                    });
                } else if (['image', 'video', 'audio'].includes(type)) {
                    conversations.push({
                        type: type,
                        filePath: `/${uploadDir}${file}`,
                        timestamp: timestamp
                    });
                } else {
                    console.log(`Tipo de arquivo desconhecido: ${type}, arquivo: ${file}, ignorando`);
                }
            } catch (error) {
                console.error(`Erro ao processar arquivo ${file}: ${error.message}`);
            }
        }
        console.log(`Conversas retornadas para ${childId}:`, conversations);
        res.status(200).json(conversations);
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

app.use('/uploads', express.static('uploads'));

// Middleware para capturar erros 404
app.use((req, res) => {
    console.log(`Rota não encontrada: ${req.method} ${req.url}`);
    res.status(404).send('Rota não encontrada');
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});