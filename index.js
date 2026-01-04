const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// Estado del QR y cliente
let qrCodeData = null;
let isReady = false;

// Configuracion de WhatsApp Web
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// Variables de entorno
const GRUPO_BUGS = process.env.GRUPO_BUGS;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8nbalde.app.n8n.cloud/webhook/ai-agent-mysql';

console.log('Iniciando WhatsApp Bridge...');
console.log(`Webhook n8n: ${N8N_WEBHOOK_URL}`);
console.log(`Grupo configurado: ${GRUPO_BUGS || 'No configurado - escuchando todos los mensajes'}`);

// Eventos de WhatsApp
client.on('qr', qr => {
    qrCodeData = qr;
    isReady = false;
    console.log('QR generado - visita /qr para escanearlo');
});

client.on('ready', () => {
    qrCodeData = null;
    isReady = true;
    console.log('WhatsApp conectado y listo');
});

client.on('authenticated', () => {
    console.log('Autenticacion exitosa');
});

client.on('auth_failure', msg => {
    console.error('Error de autenticacion:', msg);
});

client.on('disconnected', reason => {
    isReady = false;
    console.log('WhatsApp desconectado:', reason);
});

// Handler de mensajes
client.on('message', async msg => {
    // Si hay grupo configurado, solo escuchar ese grupo
    if (GRUPO_BUGS && msg.from !== GRUPO_BUGS) return;

    // Ignorar mensajes propios
    if (msg.fromMe) return;

    console.log(`Mensaje recibido de ${msg.from}: ${msg.body.substring(0, 50)}...`);

    try {
        const contact = await msg.getContact();

        // Enviar a n8n
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mensaje: msg.body,
                de: contact.pushname || contact.name || msg.author || 'Desconocido',
                telefono: msg.author || msg.from,
                timestamp: msg.timestamp,
                chatId: msg.from,
                isGroup: msg.from.includes('@g.us'),
                messageId: msg.id._serialized
            })
        });

        if (!response.ok) {
            console.error(`Error de n8n: ${response.status}`);
            return;
        }

        const data = await response.json();
        console.log('Respuesta de n8n:', JSON.stringify(data).substring(0, 100));

        // Si n8n devuelve respuesta, enviarla
        if (data.respuesta) {
            await msg.reply(data.respuesta);
            console.log('Respuesta enviada al chat');
        }
    } catch (err) {
        console.error('Error procesando mensaje:', err.message);
    }
});

// === ENDPOINTS HTTP ===

// Ver QR para escanear
app.get('/qr', async (req, res) => {
    if (isReady) {
        return res.send(`
            <html>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1>WhatsApp ya esta conectado</h1>
                    <p>No necesitas escanear el QR</p>
                    <a href="/status">Ver estado</a>
                </body>
            </html>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <html>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1>Esperando QR...</h1>
                    <p>Recarga la pagina en unos segundos</p>
                    <script>setTimeout(() => location.reload(), 3000)</script>
                </body>
            </html>
        `);
    }

    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`
        <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Escanea el QR con WhatsApp</h1>
                <img src="${qrImage}" style="max-width: 300px;" />
                <p>Abre WhatsApp > Dispositivos vinculados > Vincular dispositivo</p>
                <script>setTimeout(() => location.reload(), 5000)</script>
            </body>
            </html>
    `);
});

// Estado del servicio
app.get('/status', (req, res) => {
    res.json({
        status: isReady ? 'connected' : 'disconnected',
        qrPending: !!qrCodeData,
        grupo: GRUPO_BUGS || 'todos',
        webhook: N8N_WEBHOOK_URL
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Enviar mensaje desde n8n
app.post('/send', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp no esta conectado' });
    }

    const { mensaje, chatId } = req.body;

    if (!mensaje) {
        return res.status(400).json({ error: 'Falta el campo "mensaje"' });
    }

    const destino = chatId || GRUPO_BUGS;

    if (!destino) {
        return res.status(400).json({ error: 'Falta chatId y no hay grupo por defecto' });
    }

    try {
        await client.sendMessage(destino, mensaje);
        console.log(`Mensaje enviado a ${destino}`);
        res.json({ ok: true, destino });
    } catch (err) {
        console.error('Error enviando mensaje:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Listar chats (util para obtener IDs de grupos)
app.get('/chats', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp no esta conectado' });
    }

    try {
        const chats = await client.getChats();
        const grupos = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                nombre: chat.name,
                participantes: chat.participants?.length || 0
            }));

        res.json({ grupos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Iniciar cliente y servidor
client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor HTTP corriendo en puerto ${PORT}`);
    console.log(`Visita /qr para escanear el codigo QR`);
    console.log(`Visita /status para ver el estado`);
    console.log(`Visita /chats para listar grupos (despues de conectar)`);
});
