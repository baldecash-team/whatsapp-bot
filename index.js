const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

let qrCodeData = null;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const GRUPO_BUGS = process.env.GRUPO_BUGS;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

client.on('qr', qr => {
    qrCodeData = qr;
    console.log('QR generado, visita /qr para escanearlo');
});

client.on('ready', () => {
    qrCodeData = null;
    console.log('WhatsApp conectado');
});

client.on('message', async msg => {
    if (msg.from !== GRUPO_BUGS || msg.fromMe) return;

    const contact = await msg.getContact();

    try {
        const response = await fetch(N8N_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mensaje: msg.body,
                de: contact.pushname || msg.author,
                telefono: msg.author,
                timestamp: msg.timestamp,
                chatId: msg.from
            })
        });

        const data = await response.json();
        if (data.respuesta) {
            await msg.reply(data.respuesta);
        }
    } catch (err) {
        console.error('Error enviando a n8n:', err);
    }
});

// Ver QR desde el browser
app.get('/qr', async (req, res) => {
    if (!qrCodeData) {
        return res.send('Ya conectado o esperando QR...');
    }
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`<img src="${qrImage}" />`);
});

// Endpoint para envios desde n8n
app.post('/send', async (req, res) => {
    const { chatId, mensaje } = req.body;
    await client.sendMessage(chatId || GRUPO_BUGS, mensaje);
    res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

client.initialize();
app.listen(process.env.PORT || 3000);
