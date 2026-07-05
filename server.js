import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import qrcode from 'qrcode';
import pino from 'pino';
import makeWASocket, { 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    makeCacheableSignalKeyStore 
} from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// KONFIGURASI API KEYS
// ============================================
const API_KEYS = {
    google: process.env.GOOGLE_API_KEY || '',
    groq: process.env.GROQ_API_KEY || '',
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    mistral: process.env.MISTRAL_API_KEY || '',
    hf: process.env.HUGGINGFACE_API_KEY || '',
};

// ============================================
// EXPRESS & SOCKET.IO SETUP
// ============================================
const app = express();
const server = createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    } 
});

app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', 'Thu, 01 Jan 1970 00:00:00 GMT');
    next();
});

app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// ============================================
// STATE MANAGEMENT
// ============================================
let sock = null;
let isReady = false;
let qrCodeData = null;
let allowedGroups = [];
let maxGroups = 5;
let allGroups = [];
let currentDevice = null;
let botSettings = {
    ownerName: 'JHON338',
    ownerNumber: '6285775137463',
    botName: 'JHON338',
    prefix: '.',
};

// ============================================
// LOAD CONFIG DARI FILE
// ============================================
const configPath = join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.allowedGroups) allowedGroups = config.allowedGroups;
        if (config.maxGroups) maxGroups = config.maxGroups || 5;
        if (config.botSettings) botSettings = { ...botSettings, ...config.botSettings };
        console.log(`📂 Config loaded: ${allowedGroups.length} groups allowed`);
    } catch (e) {
        console.log('⚠️ Failed to load config:', e.message);
    }
}

// ============================================
// FOLDER SETUP
// ============================================
['temp', 'sessions'].forEach(d => {
    const p = join(__dirname, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ============================================
// AI PROVIDERS SETUP
// ============================================
const googleAI = new GoogleGenerativeAI(API_KEYS.google);
const groqClient = new Groq({ apiKey: API_KEYS.groq });
const deepseekClient = new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: API_KEYS.deepseek });
const mistralClient = new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: API_KEYS.mistral });

// ============================================
// SYSTEM PROMPT
// ============================================
const SYSTEM_PROMPT = `
Kamu adalah JHON BOT WA GRUP AI - asisten WhatsApp paling keren, pinter, dan gaul! 🚀🔥

# IDENTITAS 🦸
- Nama: JHON BOT WA GRUP AI
- Gaya: Gaul, asyik
- Skill: Tahu segalanya, jika ada pertanyaan jawab langsung dan bisa mengingat kelanjutan pertanyaan yang di berikan

# ATURAN MAIN 🎯
1. Jawab SINGKAT, PADAT, JELAS, PAKE BAHASA GAUL
2. Harus tahu segalanya
3. LANGSUNG JAWAB - jangan pake kata pengantar!

GASKEUN! 🔥🚀
`;

// ============================================
// MENU TEXT
// ============================================
const MENU_TEKS = (senderName) => `
           🤖 JHON338 GROUP BOT 🤖
      ⚡ Smart • Fast • Secure • 24/7 ⚡

Hai @${senderName} 👋
Selamat datang di layanan resmi JHON338.

━━━ 🤖 BOT INFO ━━━━━━━━━━━━━

👑 Owner      : ${botSettings.ownerName}
🤖 Nama Bot   : JHON338
📦 Mode       : Group Assistant
🌐 Platform   : WhatsApp
🟢 Status     : Online
🚀 Version    : v1.0.5
🔥 Runtime    : 24/7

━━━ 📂 MAIN MENU ━━━━━━━━━━━━

 🏠 .menu
 🤖 .ask
 🎨 .stiker
 🎨 .anime
 🎨 .brat
 💬 .rinchat
 📥 .ig
 🧹 .removewm
 🖼️ .removebg
 🎬 .bratvid

━━━ ✨ KEUNGGULAN ━━━━━━━━━━━

⚡ Respon super cepat
🤖 AI Assistant
🛡️ Anti Spam
📥 Downloader lengkap
🎨 Sticker Maker
👥 Group Management
🔒 Aman & Stabil

━━━ 🌐 OFFICIAL LINK ━━━━━━━━

🌳 Linktree
https://jhon338-jc.github.io/Linktree/

📢 WhatsApp Channel
https://whatsapp.com/channel/0029VbC0TW8545uvqe36Kv0b

👑 Owner
https://wa.me/6285775137463

━━━ 💬 CATATAN ━━━━━━━━━━━━━━

• Gunakan *.menu* untuk melihat semua fitur.
• Jangan spam bot.
• Gunakan bot dengan bijak.

━━━━━━━━━━━━━━━━━━━━━━

🚀 JHON338 GROUP BOT
❤️ Thank You For Using Our Service
`;

// ============================================
// AI PROVIDERS
// ============================================
const PROVIDERS = [
    {
        name: 'Google Gemini',
        call: async (prompt) => {
            const model = googleAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent(`${SYSTEM_PROMPT}\n\nPERTANYAAN: ${prompt}`);
            return result.response.text();
        }
    },
    {
        name: 'Groq AI',
        call: async (prompt) => {
            const result = await groqClient.chat.completions.create({
                model: 'llama-3.3-70b-specdec',
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
                max_tokens: 500,
            });
            return result.choices[0].message.content;
        }
    },
    {
        name: 'DeepSeek AI',
        call: async (prompt) => {
            const result = await deepseekClient.chat.completions.create({
                model: 'deepseek-chat',
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
                max_tokens: 500,
            });
            return result.choices[0].message.content;
        }
    },
    {
        name: 'Mistral AI',
        call: async (prompt) => {
            const result = await mistralClient.chat.completions.create({
                model: 'mistral-large-latest',
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
                max_tokens: 500,
            });
            return result.choices[0].message.content;
        }
    },
];

async function callAI(prompt) {
    for (const provider of PROVIDERS) {
        try {
            console.log(`🤖 Trying ${provider.name}...`);
            const response = await provider.call(prompt);
            console.log(`✅ ${provider.name} OK!`);
            return { success: true, response, provider: provider.name };
        } catch (e) {
            console.error(`❌ ${provider.name} FAILED:`, e.message);
        }
    }
    return { success: false, response: '❌ Semua AI lagi sibuk, coba lagi nanti!' };
}

// ============================================
// STICKER GENERATOR (SHARP SVG + ARIAL FONT)
// ============================================
async function createSticker(text) {
    try {
        const sharp = (await import('sharp')).default;
        
        // Baca font Arial Narrow
        const fontPath = join(__dirname, 'fonts', 'ARIALN.ttf');
        let fontBase64 = '';
        
        if (fs.existsSync(fontPath)) {
            fontBase64 = fs.readFileSync(fontPath).toString('base64');
        }
        
        // Bungkus teks
        const words = text.split(' ');
        let lines = [];
        let currentLine = '';
        
        for (const word of words) {
            const testLine = currentLine ? currentLine + ' ' + word : word;
            if (testLine.length > 18 && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) lines.push(currentLine);
        if (lines.length === 0) lines = [text];
        
        // Font size menyesuaikan jumlah baris
        const fontSize = lines.length > 4 ? 60 : lines.length > 3 ? 80 : lines.length > 2 ? 100 : lines.length > 1 ? 130 : 160;
        const lineHeight = fontSize * 1.25;
        const totalHeight = lines.length * lineHeight;
        const startY = (512 - totalHeight) / 2 + fontSize * 0.85;
        
        // Bikin text elements dengan font Arial Narrow
        const textElements = lines.map((line, i) => {
            const escapedLine = line
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            const y = startY + i * lineHeight;
            return `<text x="256" y="${y}" text-anchor="middle" font-family="'Arial Narrow', Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="black">${escapedLine}</text>`;
        }).join('\n');
        
        // Font face CSS kalau font ada
        const fontFace = fontBase64 ? 
            `<style>
                @font-face {
                    font-family: 'Arial Narrow';
                    src: url(data:font/ttf;base64,${fontBase64}) format('truetype');
                }
            </style>` : '';
        
        // SVG
        const svg = `
        <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
            ${fontFace}
            <rect width="512" height="512" fill="white"/>
            ${textElements}
        </svg>`;
        
        const tempDir = join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        
        const tempWebp = join(tempDir, `sticker_${Date.now()}.webp`);
        
        await sharp(Buffer.from(svg))
            .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
            .webp({ quality: 95, lossless: true })
            .toFile(tempWebp);
        
        const webpBuffer = fs.readFileSync(tempWebp);
        
        setTimeout(() => {
            try { fs.unlinkSync(tempWebp); } catch {}
        }, 5000);
        
        return { buffer: webpBuffer, filepath: tempWebp };
        
    } catch (error) {
        console.error('❌ Sticker error:', error.message);
        throw error;
    }
}


async function downloadIG(url) {
    try {
        const ins = axios.create({ headers: { "user-agent": "Mozilla/5.0" } });
        const { data: msc } = await ins.get("https://fastdl.app/msec");
        const ts = Date.now() - (Math.abs(Date.now() - Math.floor(msc.msec * 1000)) >= 60000 ? Math.abs(Date.now() - Math.floor(msc.msec * 1000)) : 0);
        const crypto = await import('crypto');
        const sg = crypto.createHmac("sha256", Buffer.from("82314e32a384d00f055de496b4737acde3cbb2f851b90e1a70625f6d3bb56401", "hex")).update(url + ts).digest("hex");
        const { data: result } = await ins.post("https://cors.siputzx.my.id/https://api-wh.fastdl.app/api/convert", new URLSearchParams({ sf_url: url, ts: ts.toString(), _ts: "1778140969163", _tsc: "0", _sv: "2", _s: sg }).toString(), { headers: { "content-type": "application/x-www-form-urlencoded" } });
        let medias = [], info = { username: 'IG User', caption: '' };
        const items = Array.isArray(result) ? result : [result];
        items.forEach(item => {
            if (item.meta) info = { username: item.meta.username || 'IG User', caption: item.meta.title || '' };
            if (item.url) item.url.forEach(u => medias.push({ type: u.type === 'jpg' ? 'image' : 'video', url: u.url }));
        });
        return { info, medias: medias.slice(0, 1) };
    } catch (e) { throw e; }
}

async function removeBG(buffer) {
    const b64 = buffer.toString('base64');
    const res = await axios.post('https://background-remover.com/removeImageBackground', { encodedImage: `data:image/jpeg;base64,${b64}`, title: 'img.jpg', mimeType: 'image/jpeg' }, { headers: { 'Content-Type': 'application/json' }, timeout: 60000, responseType: 'arraybuffer' });
    const tmp = join(__dirname, 'temp', `bg_${Date.now()}.png`);
    fs.writeFileSync(tmp, res.data);
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('files[]', fs.createReadStream(tmp), 'img.png');
    const up = await axios.post('https://clooud.my.id/uploder/', form, { headers: form.getHeaders(), timeout: 60000 });
    try { fs.unlinkSync(tmp); } catch {}
    return up.data?.files?.[0]?.url || up.data?.url;
}

async function removeWM(buffer) {
    const boundary = `----${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="img.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), buffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const create = await axios.post('https://api.ezremove.ai/api/ez-remove/watermark-remove/create-job', body, { headers: { 'User-Agent': 'Mozilla/5.0', 'product-serial': `sr-${Date.now()}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, timeout: 30000 });
    const jobId = create.data?.result?.job_id;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const check = await axios.get(`https://api.ezremove.ai/api/ez-remove/watermark-remove/get-job/${jobId}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'product-serial': `sr-${Date.now()}` }, timeout: 15000 });
        if (check.data?.code === 100000 && check.data?.result?.output?.[0]) return check.data.result.output[0];
    }
    throw new Error('Timeout');
}

async function toAnime(buffer) {
    const b64 = buffer.toString('base64');
    const res = await axios.post('https://api-inference.huggingface.co/models/anton-l/stable-diffusion-xl-img2img', { inputs: { image: b64, prompt: "anime style, studio ghibli", parameters: { num_inference_steps: 20, strength: 0.75 } } }, { headers: { 'Authorization': `Bearer ${API_KEYS.hf}` }, responseType: 'arraybuffer', timeout: 120000 });
    const tmp = join(__dirname, 'temp', `anime_${Date.now()}.png`);
    fs.writeFileSync(tmp, res.data);
    return tmp;
}

async function downloadMedia(msg) {
    const messageType = Object.keys(msg.message)[0];
    const stream = await (await import('@whiskeysockets/baileys')).downloadContentFromMessage(msg.message[messageType], messageType.replace('Message', ''));
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
}

async function fetchGroups() {
    try {
        console.log('📊 Fetching groups...');
        const groups = await sock.groupFetchAllParticipating();
        allGroups = Object.entries(groups).map(([id, info]) => ({
            id,
            name: info.subject,
            participants: info.participants?.length || 0,
            allowed: allowedGroups.includes(id),
        }));
        console.log(`✅ ${allGroups.length} groups found`);
        io.emit('status', {
            connected: true,
            botName: sock.user?.name || botSettings.botName,
            botNumber: sock.user?.id?.split(':')[0] || '',
            groups: allGroups,
            totalGroups: allGroups.length,
        });
    } catch (e) {
        console.error('Error fetching groups:', e.message);
    }
}

// ============================================
// START BOT
// ============================================
async function startBot() {
    const sessionFolder = currentDevice ? `sessions_${currentDevice}` : 'sessions';
    const sessionPath = join(__dirname, sessionFolder);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    if (sock) {
        try { sock.end(); } catch {}
        sock = null;
    }

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['JHON338 BOT', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 QR Ready!');
            const qrImg = await qrcode.toDataURL(qr);
            io.emit('qr', { qr: qrImg });
        }

        if (connection === 'open') {
            isReady = true;
            console.log(`✅ BOT CONNECTED! (${sock.user?.name || 'Unknown'})`);
            io.emit('status', {
                connected: true,
                botName: sock.user?.name || 'JHON338 BOT',
                botNumber: sock.user?.id?.split(':')[0] || '',
            });
            io.emit('message', { type: 'success', text: '✅ Bot connected!' });
            await fetchGroups();
        }

        if (connection === 'close') {
            isReady = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('❌ Disconnected:', code);
            io.emit('status', { connected: false, reconnecting: false });
            io.emit('message', { type: 'info', text: '🛑 Bot disconnected. Click Start to reconnect.' });
        }
    });

    // Message Handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || !isReady) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        if (!isGroup) return;

        const senderName = msg.pushName || 'User';

        let text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption || '';

        if (!text) return;

        console.log(`📨 [Group] ${senderName}: ${text}`);

        // Hanya grup yang dipilih di web
        if (allowedGroups.length > 0 && !allowedGroups.includes(from)) return;

        const prefix = botSettings.prefix;
        if (!text.startsWith(prefix)) return;

        const args = text.slice(prefix.length).trim().split(/ +/);
        const cmd = args[0]?.toLowerCase();
        const input = args.slice(1).join(' ');

        console.log(`⚡ Command: ${cmd} | Input: ${input}`);

        try {
            await sock.sendPresenceUpdate('composing', from);
            let reply = '';

            switch (cmd) {
                case 'menu':
                    reply = MENU_TEKS(senderName);
                    break;
                case 'ask':
                    if (!input) { reply = '❌ Contoh: .ask siapa presiden indonesia?'; break; }
                    await sock.sendMessage(from, { text: '🤔 *Mikir dulu...*' });
                    const ai = await callAI(input);
                    reply = ai.success ? `🤖 *${ai.provider}*\n\n${ai.response}` : ai.response;
                    break;
                
case 'stiker':
    if (!input) { reply = '❌ Contoh: .stiker aku suka susu'; break; }
    await sock.sendMessage(from, { text: '⏳ *Bikin stiker...*' });
    try {
        const sticker = await createSticker(input);
        await sock.sendMessage(from, { 
            sticker: { url: sticker.filepath }
        });
        return;
    } catch (e) { reply = `❌ Gagal: ${e.message}`; }
    break;

                case 'ig':
                    if (!input || !input.includes('instagram.com')) { reply = '❌ Link IG tidak valid!'; break; }
                    await sock.sendMessage(from, { text: '⏳ *Downloading...*' });
                    try {
                        const ig = await downloadIG(input);
                        if (ig.medias.length > 0) {
                            const m = ig.medias[0];
                            const cap = `📥 *Instagram*\n👤 ${ig.info.username}\n📝 ${ig.info.caption || ''}`;
                            if (m.type === 'image') await sock.sendMessage(from, { image: { url: m.url }, caption: cap });
                            else await sock.sendMessage(from, { video: { url: m.url }, caption: cap });
                            return;
                        }
                        reply = '❌ Gagal download!';
                    } catch (e) { reply = `❌ Error: ${e.message}`; }
                    break;
                case 'removebg':
                    if (!msg.message.imageMessage) { reply = '❌ Kirim gambar dengan caption .removebg'; break; }
                    await sock.sendMessage(from, { text: '⏳ *Processing...*' });
                    try {
                        const buf = await downloadMedia(msg);
                        const url = await removeBG(buf);
                        if (url) { await sock.sendMessage(from, { image: { url }, caption: '✅ *Background Removed!*' }); return; }
                        reply = '❌ Gagal!';
                    } catch (e) { reply = `❌ Error: ${e.message}`; }
                    break;
                case 'removewm':
                    if (!msg.message.imageMessage) { reply = '❌ Kirim gambar dengan caption .removewm'; break; }
                    await sock.sendMessage(from, { text: '⏳ *Processing...*' });
                    try {
                        const buf = await downloadMedia(msg);
                        const url = await removeWM(buf);
                        if (url) { await sock.sendMessage(from, { image: { url }, caption: '✅ *Watermark Removed!*' }); return; }
                        reply = '❌ Gagal!';
                    } catch (e) { reply = `❌ Error: ${e.message}`; }
                    break;
                case 'anime':
                    if (!msg.message.imageMessage) { reply = '❌ Kirim gambar dengan caption .anime'; break; }
                    await sock.sendMessage(from, { text: '⏳ *Processing...*' });
                    try {
                        const buf = await downloadMedia(msg);
                        const path = await toAnime(buf);
                        await sock.sendMessage(from, { image: { url: path }, caption: '✅ *Anime Style!*' });
                        setTimeout(() => { try { fs.unlinkSync(path); } catch {} }, 5000);
                        return;
                    } catch (e) { reply = `❌ Error: ${e.message}`; }
                    break;
                case 'brat':
                case 'rinchat':
                case 'bratvid':
                    reply = `🚧 Fitur *${cmd}* sedang dalam pengembangan! Sabar ya... 🔧`;
                    break;
                case 'ping':
                    reply = '🏓 Pong! Bot online!';
                    break;
                default:
                    reply = `❌ Command *${cmd}* tidak dikenal!\nKetik *.menu* untuk lihat semua command.`;
            }

            if (reply) {
                await sock.sendMessage(from, { text: reply });
                console.log('✅ Reply sent!');
            }
        } catch (error) {
            console.error('❌ Error:', error.message);
            try { await sock.sendMessage(from, { text: `❌ Error: ${error.message}` }); } catch {}
        }
    });
}

// ============================================
// SOCKET.IO HANDLERS
// ============================================
io.on('connection', (socket) => {
    console.log('🔌 Web connected:', socket.id);

    socket.emit('status', {
        connected: isReady,
        botName: sock?.user?.name || 'JHON338 BOT',
        botNumber: sock?.user?.id?.split(':')[0] || '',
        groups: allGroups,
        totalGroups: allGroups.length,
    });

    socket.emit('settings', { ...botSettings, allowedGroups, maxGroups });
    socket.emit('update', { allowedGroups });

    socket.on('startBot', () => {
        if (!isReady) {
            startBot();
            socket.emit('message', { type: 'info', text: '🚀 Starting bot...' });
        } else {
            socket.emit('message', { type: 'warning', text: '⚠️ Bot already running!' });
        }
    });

    socket.on('stopBot', () => {
        isReady = false;
        if (sock) { 
            sock.end(); 
            sock = null; 
        }
        socket.emit('status', { connected: false });
        socket.emit('message', { type: 'info', text: '🛑 Bot stopped!' });
        console.log('🛑 Bot stopped by user');
    });

    socket.on('setDevice', (number) => {
        currentDevice = number;
        console.log(`📱 Device set to: ${number}`);
        isReady = false;
        if (sock) { sock.end(); sock = null; }
        socket.emit('status', { connected: false });
        socket.emit('message', { type: 'info', text: `📱 Switching to ${number}...` });
    });

    socket.on('updateSettings', (s) => {
        botSettings = { ...botSettings, ...s };
        maxGroups = s.maxGroups || 5;
        try { fs.writeFileSync(configPath, JSON.stringify({ allowedGroups, maxGroups, botSettings }, null, 2)); } catch {}
        socket.emit('message', { type: 'success', text: '✅ Settings saved!' });
    });

    socket.on('updateGroups', (groups) => {
        allowedGroups = groups.slice(0, maxGroups);
        try { fs.writeFileSync(configPath, JSON.stringify({ allowedGroups, maxGroups, botSettings }, null, 2)); } catch {}
        socket.emit('update', { allowedGroups });
        socket.emit('message', { type: 'success', text: `✅ ${allowedGroups.length} groups saved!` });
        console.log(`💾 Groups saved: ${allowedGroups.length} groups`);
    });

    socket.on('getGroups', async () => {
        if (sock && isReady) await fetchGroups();
        socket.emit('groups', allGroups);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Web disconnected:', socket.id);
    });
});

// ============================================
// ROUTES
// ============================================
// Health check for Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/api/status', (req, res) => res.json({
    connected: isReady,
    botNumber: sock?.user?.id?.split(':')[0] || '',
    botName: sock?.user?.name || '',
    settings: botSettings,
    allowedGroups,
    allGroups
}));

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('🚀 JHON338 BOT SERVER (BAILEYS)');
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`📱 Multi-Device Support: ON`);
    console.log(`👥 Max Groups: ${maxGroups}`);
    console.log(`💾 Groups saved to: config.json`);
    console.log('🟢 Server ready. Click "Start Bot" to begin.');
    console.log('='.repeat(50));
});