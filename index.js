const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rota padrão para verificar se o servidor está ativo
app.get('/', (req, res) => {
    res.status(200).send('Servidor Parental Monitor rodando!');
});

// Configurar armazenamento com multer
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
        const childId = req.body.childId || 'unknown'; // Usar childId do corpo da requisição
        cb(null, `${timestamp}-${childId}-${file.originalname}`);
    }
});
const upload = multer({ storage: storage });

// Rota para receber mensagens (notificações)
app.post('/notifications', (req, res) => {
    const { childId, message, timestamp } = req.body;
    console.log(`Notificação recebida - childId: ${childId}, message: ${message}, timestamp: ${timestamp}`);
    // Aqui você pode salvar a mensagem em um banco de dados ou arquivo
    res.status(200).json({ message: 'Notificação recebida com sucesso' });
});

// Rota para receber mídias (fotos, vídeos, áudios)
app.post('/media', upload.single('file'), (req, res) => {
    const { childId, type, timestamp } = req.body;
    const filePath = req.file ? req.file.path : null;
    console.log(`Mídia recebida - childId: ${childId}, type: ${type}, timestamp: ${timestamp}, filePath: ${filePath}`);
    // Aqui você pode salvar os dados em um banco de dados ou manter os arquivos
    res.status(200).json({ message: 'Mídia recebida com sucesso', filePath: filePath });
});

// Rota para listar mídias por childId
app.get('/get-conversations/:childId', (req, res) => {
    const { childId } = req.params;
    const uploadDir = 'uploads/';
    const files = fs.readdirSync(uploadDir).filter(file => file.includes(childId));
    const mediaList = files.map(file => ({
        filePath: `/${uploadDir}${file}`,
        timestamp: file.split('-')[0],
        type: file.split('.').pop() === 'jpg' ? 'image' : file.split('.').pop() === 'mp4' ? 'video' : 'audio'
    }));
    res.status(200).json(mediaList);
});

// Rota para listar todos os childIds disponíveis
app.get('/get-child-ids', (req, res) => {
    const uploadDir = 'uploads/';
    try {
        const files = fs.readdirSync(uploadDir);
        // Extrair childIds únicos dos nomes dos arquivos
        const childIds = [...new Set(files.map(file => {
            const parts = file.split('-');
            return parts[1]; // Pega o childId (segundo elemento após o timestamp)
        }))].filter(childId => childId !== 'unknown'); // Remove 'unknown' se não houver childId
        res.status(200).json(childIds);
    } catch (error) {
        console.error('Erro ao listar childIds:', error);
        res.status(500).json({ message: 'Erro ao listar childIds' });
    }
});

app.use('/uploads', express.static('uploads'));

// Iniciar o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});