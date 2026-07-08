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
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
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
['temp', 'sessions', 'fonts', 'assets', 'tmp', 'quoteanime', 'assets/quoteanime/fonts'].forEach(d => {
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
const SYSTEM_PROMPT = `Kamu adalah JHON BOT WA GRUP AI - asisten WhatsApp paling keren, pinter, dan gaul! 🚀🔥\n\nSkill: Tahu segalanya.\nAturan: Jawab SINGKAT, PADAT, JELAS, PAKE BAHASA GAUL. LANGSUNG JAWAB!\n\nGASKEUN! 🔥🚀`;

// ============================================
// MENU TEXT - UDAH DI TAMBAHIN SEMUA FITUR
// ============================================
const MENU_TEKS = (senderName) => `
🤖 *JHON338 BOT*
⚡ Smart • Fast • Secure • 24/7

Hai @${senderName} 👋

━━━ 📂 MENU ━━━━━
 🏠 .menu
 🤖 .ask
 🎨 .stiker
 🎨 .anime
 📥 .ig
 🧹 .removewm
 🖼️ .removebg
 💬 .iqc
 🎬 .brat
 🎬 .bratvid
 📝 .quote

👑 wa.me/6285775137463
🚀 JHON338 GROUP BOT
`;

// ============================================
// AI PROVIDERS
// ============================================
const PROVIDERS = [
    { name: 'Google Gemini', call: async (p) => { const m = googleAI.getGenerativeModel({ model: 'gemini-2.5-flash' }); const r = await m.generateContent(`${SYSTEM_PROMPT}\n\n${p}`); return r.response.text(); } },
    { name: 'Groq AI', call: async (p) => { const r = await groqClient.chat.completions.create({ model: 'llama-3.3-70b-specdec', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: p }], max_tokens: 500 }); return r.choices[0].message.content; } },
    { name: 'DeepSeek AI', call: async (p) => { const r = await deepseekClient.chat.completions.create({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: p }], max_tokens: 500 }); return r.choices[0].message.content; } },
    { name: 'Mistral AI', call: async (p) => { const r = await mistralClient.chat.completions.create({ model: 'mistral-large-latest', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: p }], max_tokens: 500 }); return r.choices[0].message.content; } },
];

async function callAI(prompt) {
    for (const provider of PROVIDERS) {
        try { console.log(`🤖 ${provider.name}...`); const r = await provider.call(prompt); console.log(`✅ ${provider.name} OK!`); return { success: true, response: r, provider: provider.name }; }
        catch (e) { console.error(`❌ ${provider.name}:`, e.message); }
    }
    return { success: false, response: '❌ AI sibuk, coba lagi!' };
}

// ============================================
// STICKER GENERATOR
// ============================================
async function createSticker(text) {
    try {
        const sharp = (await import('sharp')).default;
        const tempDir = join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const words = text.split(' ');
        let lines = [];
        let cur = '';
        for (const w of words) {
            const t = cur ? cur + ' ' + w : w;
            if (t.length > 16 && cur) { lines.push(cur); cur = w; }
            else { cur = t; }
        }
        if (cur) lines.push(cur);
        if (!lines.length) lines = [text];

        const fs2 = lines.length > 4 ? 55 : lines.length > 3 ? 70 : lines.length > 2 ? 90 : lines.length > 1 ? 120 : 150;
        const lh = fs2 * 1.2;
        const th = lines.length * lh;
        const sy = (512 - th) / 2 + fs2 * 0.8;

        const texts = lines.map((l, i) => {
            const el = l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            return `<text x="256" y="${sy + i * lh}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fs2}" font-weight="bold" fill="black">${el}</text>`;
        }).join('');

        const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="white"/>${texts}</svg>`;

        const webp = join(tempDir, `st_${Date.now()}.webp`);
        await sharp(Buffer.from(svg)).resize(512,512).webp({quality:90,lossless:true}).toFile(webp);

        setTimeout(() => { try { fs.unlinkSync(webp); } catch {} }, 5000);

        return { buffer: fs.readFileSync(webp), filepath: webp };
    } catch (e) {
        console.error('Sticker error:', e.message);
        throw e;
    }
}

// ============================================
// IQC DARK FEATURE
// ============================================
const APPLE_EMOJI_JSON_URL = 'https://media.githubusercontent.com/media/Ditzzx-vibecoder/entahlah/main/emoji-apple.json';
const APPLE_EMOJI_JSON_LOCAL = join(__dirname, 'fonts', 'emoji-apple-image.json');

let appleEmojiMap = null;
const emojiImageCache = new Map();

async function downloadFile(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5 });
    return Buffer.from(res.data);
}

function emojiToUnicode(emoji) {
    return [...emoji].map(c => c.codePointAt(0).toString(16).padStart(4, '0')).join('-');
}

async function loadAppleEmojiMap() {
    if (appleEmojiMap) return appleEmojiMap;
    await mkdir(join(__dirname, 'fonts'), { recursive: true });
    if (!existsSync(APPLE_EMOJI_JSON_LOCAL)) {
        const buf = await downloadFile(APPLE_EMOJI_JSON_URL);
        await writeFile(APPLE_EMOJI_JSON_LOCAL, buf);
    }
    const raw = await readFile(APPLE_EMOJI_JSON_LOCAL, 'utf-8');
    appleEmojiMap = JSON.parse(raw);
    return appleEmojiMap;
}

async function getEmojiImage(emoji) {
    if (emojiImageCache.has(emoji)) return emojiImageCache.get(emoji);
    const map = await loadAppleEmojiMap();
    const base = emojiToUnicode(emoji);
    const variants = [
        base,
        base.replace(/-fe0f/gi, ''),
        `${base.replace(/-fe0f/gi, '')}-fe0f`,
        base.toUpperCase(),
        base.replace(/-fe0f/gi, '').toUpperCase(),
        base.replace(/-fe0f/gi, '').toUpperCase() + '-FE0F',
    ];
    let b64 = null;
    for (const v of variants) {
        if (map[v]) { b64 = map[v]; break; }
    }
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    const img = await loadImage(buf);
    emojiImageCache.set(emoji, img);
    return img;
}

async function drawAppleEmoji(ctx, emoji, x, y, size) {
    const img = await getEmojiImage(emoji);
    if (!img) {
        ctx.fillText(emoji, x, y);
        return;
    }
    ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
}

const EMOJI_REGEX = /(\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Emoji_Presentation}\uFE0F?|\p{Emoji}\uFE0F|[\u{1F1E0}-\u{1F1FF}]{2}|\p{Extended_Pictographic}\uFE0F?)/gu;

function measureTextCustom(ctx, text, fontSize) {
    const parts = text.split(EMOJI_REGEX);
    let totalWidth = 0;
    for (const part of parts) {
        if (!part) continue;
        EMOJI_REGEX.lastIndex = 0;
        if (EMOJI_REGEX.test(part)) {
            totalWidth += fontSize * 1.05;
        } else {
            totalWidth += ctx.measureText(part).width;
        }
        EMOJI_REGEX.lastIndex = 0;
    }
    return totalWidth;
}

async function drawTextWithEmojis(ctx, text, x, y, fontSize) {
    const parts = text.split(EMOJI_REGEX);
    let currentX = x;
    for (const part of parts) {
        if (!part) continue;
        EMOJI_REGEX.lastIndex = 0;
        if (EMOJI_REGEX.test(part)) {
            const emojiSize = fontSize * 1.05;
            const emojiCX = currentX + emojiSize / 2;
            const emojiCY = y;
            await drawAppleEmoji(ctx, part, emojiCX, emojiCY, emojiSize);
            currentX += emojiSize;
        } else {
            ctx.fillText(part, currentX, y);
            currentX += ctx.measureText(part).width;
        }
        EMOJI_REGEX.lastIndex = 0;
    }
}

function wrapText(ctx, text, maxWidth, fontSize) {
    ctx.font = `${fontSize}px InterRegular`;
    const words = text.split(" ");
    const lines = [];
    let cur = "";
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word.includes('\n')) {
            const parts = word.split('\n');
            for (let j = 0; j < parts.length; j++) {
                const test = cur + (cur ? " " : "") + parts[j];
                if (measureTextCustom(ctx, test, fontSize) > maxWidth && cur) {
                    lines.push(cur); cur = parts[j];
                } else { cur = test; }
                if (j < parts.length - 1) { lines.push(cur); cur = ""; }
            }
            continue;
        }
        const test = cur + (cur ? " " : "") + word;
        if (measureTextCustom(ctx, test, fontSize) > maxWidth && i > 0) {
            lines.push(cur); cur = word;
        } else { cur = test; }
    }
    if (cur) lines.push(cur);
    return lines;
}

async function generateIQC(text, timeStr = "16.34", imgUrl = null, emojis = ["👍", "❤️", "😂", "😮", "😢", "🙏"]) {
    try {
        const RIN_BG_URL = 'https://raw.githubusercontent.com/ryyntwx/allimagerin/refs/heads/main/iqc-hytam.png';
        const RIN_DIR = join(process.cwd(), 'assets', 'rinchat');
        const RIN_BG_LOCAL = join(RIN_DIR, 'iqc-hytam.png');
        const RIN_FONTS_DIR = join(RIN_DIR, 'fonts');
        const RIN_TMP = join(process.cwd(), 'tmp');

        const RIN_FONTS = [
            { url: 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2', file: 'Inter-Regular.ttf' }
        ];

        const BG_W = 941;
        const BG_H = 1671;

        await mkdir(RIN_FONTS_DIR, { recursive: true });
        await mkdir(RIN_TMP, { recursive: true });

        async function rinDownload(url, isJson = false) {
            const res = await axios.get(url, { responseType: isJson ? 'json' : 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5 });
            return isJson ? res.data : Buffer.from(res.data);
        }

        for (const f of RIN_FONTS) {
            const dest = join(RIN_FONTS_DIR, f.file);
            if (!existsSync(dest)) await writeFile(dest, await rinDownload(f.url));
            GlobalFonts.registerFromPath(dest, 'InterRegular');
        }

        if (!existsSync(RIN_BG_LOCAL)) {
            await writeFile(RIN_BG_LOCAL, await rinDownload(RIN_BG_URL));
        }

        await loadAppleEmojiMap();

        const canvas = createCanvas(BG_W, BG_H);
        const ctx = canvas.getContext('2d');
        const bgImg = await loadImage(RIN_BG_LOCAL);
        ctx.drawImage(bgImg, 0, 0, BG_W, BG_H);

        const PERMANENT_TIME_X = 463;
        const PERMANENT_TIME_Y = 8;
        const PERMANENT_TIME_SIZE = 27;

        ctx.fillStyle = "#ffffff";
        ctx.font = `${PERMANENT_TIME_SIZE}px InterRegular`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(timeStr, PERMANENT_TIME_X, PERMANENT_TIME_Y);

        const chatFontSize = 30;
        const maxWidthLimit = 530;
        const minBubbleWidth = 280;
        const lineHeight = chatFontSize + 14;
        const paddingX = 30;
        const paddingY = 20;
        const rad = 28;
        const fixedX = 35;
        const fixedBaseY = 946;

        ctx.font = `22px InterRegular`;
        const timeWidth = ctx.measureText(timeStr).width;

        let finalY, finalBubbleHeight, bubbleW;

        if (!imgUrl) {
            ctx.font = `${chatFontSize}px InterRegular`;
            const chatLines = wrapText(ctx, text, maxWidthLimit, chatFontSize);

            let longestW = 0;
            chatLines.forEach(l => {
                const w = measureTextCustom(ctx, l.trim(), chatFontSize);
                if (w > longestW) longestW = w;
            });

            bubbleW = longestW + (paddingX * 2);
            bubbleW = Math.max(bubbleW, timeWidth + 75);
            bubbleW = Math.max(bubbleW, 180);

            const spaceTimeY = 12;
            finalBubbleHeight = (chatLines.length * lineHeight) + paddingY + spaceTimeY + 22;
            finalY = fixedBaseY - finalBubbleHeight;

            ctx.fillStyle = "#1c1c1e";
            ctx.beginPath();
            ctx.moveTo(fixedX + rad, finalY);
            ctx.lineTo(fixedX + bubbleW - rad, finalY);
            ctx.quadraticCurveTo(fixedX + bubbleW, finalY, fixedX + bubbleW, finalY + rad);
            ctx.lineTo(fixedX + bubbleW, finalY + finalBubbleHeight - rad);
            ctx.quadraticCurveTo(fixedX + bubbleW, finalY + finalBubbleHeight, fixedX + bubbleW - rad, finalY + finalBubbleHeight);
            ctx.lineTo(fixedX + rad, finalY + finalBubbleHeight);
            ctx.quadraticCurveTo(fixedX + 8, finalY + finalBubbleHeight, fixedX + 8, finalY + finalBubbleHeight - 8);
            ctx.lineTo(fixedX + 8, finalY + rad);
            ctx.quadraticCurveTo(fixedX + 8, finalY, fixedX + rad, finalY);
            ctx.closePath();
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(fixedX + 12, finalY + finalBubbleHeight - 20);
            ctx.quadraticCurveTo(fixedX - 2, finalY + finalBubbleHeight - 4, fixedX - 8, finalY + finalBubbleHeight);
            ctx.quadraticCurveTo(fixedX + 6, finalY + finalBubbleHeight, fixedX + 22, finalY + finalBubbleHeight - 2);
            ctx.closePath();
            ctx.fill();

            ctx.save();
            ctx.fillStyle = "#ffffff";
            ctx.font = `${chatFontSize}px InterRegular`;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            for (let i = 0; i < chatLines.length; i++) {
                const lineY = finalY + paddingY + (i * lineHeight) + (chatFontSize / 2);
                await drawTextWithEmojis(ctx, chatLines[i].trim(), fixedX + paddingX, lineY, chatFontSize);
            }
            ctx.restore();

            ctx.fillStyle = "#727278";
            ctx.font = `22px InterRegular`;
            ctx.textAlign = "right";
            ctx.textBaseline = "top";
            ctx.fillText(timeStr, fixedX + bubbleW - 22, finalY + finalBubbleHeight - 38);

        } else {
            const imgBuf = imgUrl.startsWith('http')
                ? await rinDownload(imgUrl)
                : await readFile(imgUrl);
            const imgObj = await loadImage(imgBuf);

            const imgAspect = imgObj.width / imgObj.height;
            bubbleW = Math.min(Math.max(imgObj.width, minBubbleWidth), maxWidthLimit);
            let imgDrawH = Math.round(bubbleW / imgAspect);
            bubbleW = Math.max(bubbleW, timeWidth + 75);

            let captionLines = [];
            if (text) {
                ctx.font = `${chatFontSize}px InterRegular`;
                captionLines = wrapText(ctx, text, bubbleW - paddingX * 2, chatFontSize);
            }

            const captionH = captionLines.length > 0
                ? paddingY + (captionLines.length * lineHeight)
                : 0;
            const timeRowH = 28;
            finalBubbleHeight = imgDrawH + captionH + timeRowH + (captionLines.length > 0 ? 4 : 0);
            finalY = fixedBaseY - finalBubbleHeight;

            ctx.fillStyle = "#1c1c1e";
            ctx.beginPath();
            ctx.moveTo(fixedX + rad, finalY);
            ctx.lineTo(fixedX + bubbleW - rad, finalY);
            ctx.quadraticCurveTo(fixedX + bubbleW, finalY, fixedX + bubbleW, finalY + rad);
            ctx.lineTo(fixedX + bubbleW, finalY + finalBubbleHeight - rad);
            ctx.quadraticCurveTo(fixedX + bubbleW, finalY + finalBubbleHeight, fixedX + bubbleW - rad, finalY + finalBubbleHeight);
            ctx.lineTo(fixedX + rad, finalY + finalBubbleHeight);
            ctx.quadraticCurveTo(fixedX + 8, finalY + finalBubbleHeight, fixedX + 8, finalY + finalBubbleHeight - 8);
            ctx.lineTo(fixedX + 8, finalY + rad);
            ctx.quadraticCurveTo(fixedX + 8, finalY, fixedX + rad, finalY);
            ctx.closePath();
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(fixedX + 12, finalY + finalBubbleHeight - 20);
            ctx.quadraticCurveTo(fixedX - 2, finalY + finalBubbleHeight - 4, fixedX - 8, finalY + finalBubbleHeight);
            ctx.quadraticCurveTo(fixedX + 6, finalY + finalBubbleHeight, fixedX + 22, finalY + finalBubbleHeight - 2);
            ctx.closePath();
            ctx.fill();

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(fixedX + rad, finalY);
            ctx.lineTo(fixedX + bubbleW - rad, finalY);
            ctx.quadraticCurveTo(fixedX + bubbleW, finalY, fixedX + bubbleW, finalY + rad);
            ctx.lineTo(fixedX + bubbleW, finalY + imgDrawH);
            ctx.lineTo(fixedX + 8, finalY + imgDrawH);
            ctx.lineTo(fixedX + 8, finalY + rad);
            ctx.quadraticCurveTo(fixedX + 8, finalY, fixedX + rad, finalY);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(imgObj, fixedX, finalY, bubbleW, imgDrawH);
            ctx.beginPath();
            ctx.moveTo(fixedX + 8, finalY + imgDrawH);
            ctx.lineTo(fixedX + 8, finalY + rad);
            ctx.quadraticCurveTo(fixedX + 8, finalY, fixedX + rad, finalY);
            ctx.lineTo(fixedX + bubbleW - rad, finalY);
            ctx.quadraticCurveTo(fixedX + bubbleW, finalY, fixedX + bubbleW, finalY + rad);
            ctx.lineTo(fixedX + bubbleW, finalY + imgDrawH);
            ctx.strokeStyle = "#1c1c1e";
            ctx.lineWidth = 18;
            ctx.stroke();
            ctx.restore();

            if (captionLines.length > 0) {
                ctx.save();
                ctx.fillStyle = "#ffffff";
                ctx.font = `${chatFontSize}px InterRegular`;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                for (let i = 0; i < captionLines.length; i++) {
                    const lineY = finalY + imgDrawH + paddingY + (i * lineHeight) + (chatFontSize / 2);
                    await drawTextWithEmojis(ctx, captionLines[i].trim(), fixedX + paddingX, lineY, chatFontSize);
                }
                ctx.restore();
            }

            ctx.fillStyle = "#727278";
            ctx.font = `22px InterRegular`;
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(timeStr, fixedX + bubbleW - 22, finalY + finalBubbleHeight - timeRowH);
        }

        const emojiSize = Math.round(54 * 1.03);
        const emCardH = emojiSize + Math.round(44 * 1.03);
        const emCardW = Math.round(530 * 1.03);
        const emCardX = fixedX + 8;
        const emCardY = finalY - emCardH - 18;

        ctx.fillStyle = "#1c1c1e";
        ctx.beginPath();
        ctx.roundRect(emCardX, emCardY, emCardW, emCardH, [emCardH / 2]);
        ctx.fill();

        const startX = emCardX + 55;
        const spacingX = 76;
        const emojiCY = emCardY + (emCardH / 2) + 2;

        for (let i = 0; i < Math.min(emojis.length, 6); i++) {
            await drawAppleEmoji(ctx, emojis[i], startX + (i * spacingX), emojiCY, emojiSize);
        }

        ctx.fillStyle = "#8e8e93";
        ctx.font = `${Math.round(36 * 1.03)}px InterRegular`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("+", startX + (6 * spacingX) - 8, emCardY + (emCardH / 2) - 2);

        const rinOut = join(process.cwd(), `temp`, `iqc-${Date.now()}.png`);
        await writeFile(rinOut, await canvas.encode('png'));

        return rinOut;
    } catch (e) {
        console.error('IQC Error:', e.message || e);
        throw e;
    }
}

// ============================================
// BRAT CANVAS FEATURE
// ============================================
const BRAT_FONT_URL = 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/Font/ARIALN.ttf';
const BRAT_FONT_PATH = join(__dirname, 'fonts', 'ARIALN.ttf');

const BRAT_THEMES = {
    black: { bg: '#000000', text: '#ffffff' },
    white: { bg: '#ffffff', text: '#000000' },
    green: { bg: '#8ace00', text: '#000000' }
};

async function ensureBratFont() {
    if (!existsSync(BRAT_FONT_PATH)) {
        const buf = await downloadFile(BRAT_FONT_URL);
        await writeFile(BRAT_FONT_PATH, buf);
    }
    GlobalFonts.registerFromPath(BRAT_FONT_PATH, 'ArialNarrow');
}

async function generateBratCanvas(text, theme = 'white', blur = 0) {
    const selectedTheme = BRAT_THEMES[theme] || BRAT_THEMES.white;
    const blurAmount = [0, 1, 2, 3].includes(blur) ? blur : 0;

    const size = 1000;
    const padding = 80;
    const lineGap = 20;
    const maxWidth = size - padding * 2;
    const maxHeight = size - padding * 2;

    await ensureBratFont();
    await loadAppleEmojiMap();

    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Hitung font size
    const emojiRegex = EMOJI_REGEX;
    function measureText(ctx, text, fontSize) {
        const parts = text.split(emojiRegex);
        let w = 0;
        for (const part of parts) {
            if (!part) continue;
            emojiRegex.lastIndex = 0;
            if (emojiRegex.test(part)) w += fontSize;
            else w += ctx.measureText(part).width;
            emojiRegex.lastIndex = 0;
        }
        return w;
    }

    function wrapText2(ctx, text, maxWidth, fontSize) {
        ctx.font = `${fontSize}px ArialNarrow`;
        const words = text.split(' ');
        const lines = [];
        let cur = '';
        for (const word of words) {
            const test = cur ? cur + ' ' + word : word;
            if (measureText(ctx, test, fontSize) > maxWidth && cur) {
                lines.push(cur);
                cur = word;
            } else {
                cur = test;
            }
        }
        if (cur) lines.push(cur);
        return lines;
    }

    function fitsAt(ctx, text, fontSize, maxWidth, maxHeight, lineGap) {
        const lines = wrapText2(ctx, text, maxWidth, fontSize);
        const longestWord = Math.max(...text.split(' ').map(w => measureText(ctx, w, fontSize)));
        const totalHeight = lines.length * (fontSize + lineGap) - lineGap;
        return longestWord <= maxWidth && totalHeight <= maxHeight;
    }

    function findBestFontSize(ctx, text, maxWidth, maxHeight, lineGap) {
        let lo = 10;
        let hi = 700;
        let best = lo;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (fitsAt(ctx, text, mid, maxWidth, maxHeight, lineGap)) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best;
    }

    const fontSize = findBestFontSize(ctx, text, maxWidth, maxHeight, lineGap);
    const lines = wrapText2(ctx, text, maxWidth, fontSize);

    ctx.fillStyle = selectedTheme.bg;
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = selectedTheme.text;
    ctx.font = `${fontSize}px ArialNarrow`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.save();
    if (blurAmount > 0) ctx.filter = `blur(${blurAmount}px)`;

    const totalTextHeight = lines.length * (fontSize + lineGap) - lineGap;
    let y = (size - totalTextHeight) / 2;
    for (const line of lines) {
        await drawTextWithEmojis(ctx, line, padding, y, fontSize);
        y += fontSize + lineGap;
    }

    ctx.restore();

    const outPath = join(process.cwd(), `temp`, `brat-${Date.now()}.png`);
    await writeFile(outPath, await canvas.encode('png'));
    return outPath;
}

// ============================================
// BRAT VIDEO FEATURE
// ============================================
function tokenize(text) {
    return text.split(' ').filter(Boolean);
}

async function generateBratVideo({
    text = 'Halo Guys',
    theme = 'white',
    blur = 0,
    format = 'mp4',
    frameDuration = 0.4,
    holdDuration = 1.2,
    maxWordPerLayer = 1,
    maxWordBeforeReset = 0,
    fastProgress = true
} = {}) {
    const blurAmount = [0, 1, 2, 3].includes(blur) ? blur : 0;
    const step = Math.max(1, maxWordPerLayer);
    const resetSchedule = Array.isArray(maxWordBeforeReset)
        ? maxWordBeforeReset.map(n => Math.max(0, n))
        : [Math.max(0, maxWordBeforeReset)];
    const getResetAt = (batchIndex) => resetSchedule[batchIndex % resetSchedule.length];

    await ensureBratFont();
    await loadAppleEmojiMap();

    const tokens = tokenize(text);
    if (!tokens.length) throw new Error('Teks kosong');

    const tmpDir = join(process.cwd(), 'temp', `brat-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const partialTexts = [];
    let batchStart = 0;
    let batchIndex = 0;
    while (batchStart < tokens.length) {
        const resetAt = getResetAt(batchIndex);
        const batchEnd = resetAt > 0 ? Math.min(batchStart + resetAt, tokens.length) : tokens.length;
        for (let i = batchStart + step; i < batchEnd; i += step) {
            partialTexts.push(tokens.slice(batchStart, i).join(' '));
        }
        partialTexts.push(tokens.slice(batchStart, batchEnd).join(' '));
        batchStart = batchEnd;
        batchIndex++;
    }

    const renderFrame = async (partialText, index) => {
        const canvas = await createBratCanvas(partialText, theme, blurAmount);
        const buffer = await canvas.encode('png');
        const framePath = join(tmpDir, `frame-${String(index + 1).padStart(4, '0')}.png`);
        await writeFile(framePath, buffer);
        return framePath;
    };

    async function createBratCanvas(text, theme, blurAmount) {
        const selectedTheme = BRAT_THEMES[theme] || BRAT_THEMES.white;
        const size = 1000;
        const padding = 80;
        const lineGap = 20;
        const maxWidth = size - padding * 2;
        const maxHeight = size - padding * 2;

        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');

        const emojiRegex = EMOJI_REGEX;
        function measureText(ctx, text, fontSize) {
            const parts = text.split(emojiRegex);
            let w = 0;
            for (const part of parts) {
                if (!part) continue;
                emojiRegex.lastIndex = 0;
                if (emojiRegex.test(part)) w += fontSize;
                else w += ctx.measureText(part).width;
                emojiRegex.lastIndex = 0;
            }
            return w;
        }

        function wrapText2(ctx, text, maxWidth, fontSize) {
            ctx.font = `${fontSize}px ArialNarrow`;
            const words = text.split(' ');
            const lines = [];
            let cur = '';
            for (const word of words) {
                const test = cur ? cur + ' ' + word : word;
                if (measureText(ctx, test, fontSize) > maxWidth && cur) {
                    lines.push(cur);
                    cur = word;
                } else {
                    cur = test;
                }
            }
            if (cur) lines.push(cur);
            return lines;
        }

        function fitsAt(ctx, text, fontSize, maxWidth, maxHeight, lineGap) {
            const lines = wrapText2(ctx, text, maxWidth, fontSize);
            const longestWord = Math.max(...text.split(' ').map(w => measureText(ctx, w, fontSize)));
            const totalHeight = lines.length * (fontSize + lineGap) - lineGap;
            return longestWord <= maxWidth && totalHeight <= maxHeight;
        }

        function findBestFontSize(ctx, text, maxWidth, maxHeight, lineGap) {
            let lo = 10;
            let hi = 700;
            let best = lo;
            while (lo <= hi) {
                const mid = Math.floor((lo + hi) / 2);
                if (fitsAt(ctx, text, mid, maxWidth, maxHeight, lineGap)) {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return best;
        }

        const fontSize = findBestFontSize(ctx, text, maxWidth, maxHeight, lineGap);
        const lines = wrapText2(ctx, text, maxWidth, fontSize);

        ctx.fillStyle = selectedTheme.bg;
        ctx.fillRect(0, 0, size, size);

        ctx.fillStyle = selectedTheme.text;
        ctx.font = `${fontSize}px ArialNarrow`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        ctx.save();
        if (blurAmount > 0) ctx.filter = `blur(${blurAmount}px)`;

        const totalTextHeight = lines.length * (fontSize + lineGap) - lineGap;
        let y = (size - totalTextHeight) / 2;
        for (const line of lines) {
            await drawTextWithEmojis(ctx, line, padding, y, fontSize);
            y += fontSize + lineGap;
        }

        ctx.restore();
        return canvas;
    }

    let framePaths;
    if (fastProgress) {
        framePaths = await Promise.all(partialTexts.map((t, i) => renderFrame(t, i)));
    } else {
        framePaths = [];
        for (let i = 0; i < partialTexts.length; i++) {
            framePaths.push(await renderFrame(partialTexts[i], i));
        }
    }

    const durations = framePaths.map((_, i) =>
        i === framePaths.length - 1 ? holdDuration : frameDuration
    );

    const manifestLines = [];
    for (let i = 0; i < framePaths.length; i++) {
        manifestLines.push(`file '${framePaths[i].replace(/'/g, "'\\''")}'`);
        manifestLines.push(`duration ${durations[i]}`);
    }
    manifestLines.push(`file '${framePaths[framePaths.length - 1].replace(/'/g, "'\\''")}'`);
    const concatPath = join(tmpDir, 'concat.txt');
    await writeFile(concatPath, manifestLines.join('\n'));

    const ext = format === 'gif' ? 'gif' : 'mp4';
    const outPath = join(process.cwd(), `temp`, `bratvid-${Date.now()}.${ext}`);

    if (format === 'gif') {
        await execFileAsync('ffmpeg', [
            '-y',
            '-f', 'concat', '-safe', '0', '-i', concatPath,
            '-vf', 'fps=10,scale=1000:1000:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer',
            '-loop', '0',
            outPath
        ]);
    } else {
        await execFileAsync('ffmpeg', [
            '-y',
            '-f', 'concat', '-safe', '0', '-i', concatPath,
            '-vf', 'scale=1000:1000',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            outPath
        ]);
    }

    setTimeout(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }, 5000);

    return outPath;
}

// ============================================
// QUOTE ANIME FEATURE
// ============================================
const QUOTE_BACKGROUNDS = {
    1: {
        name: 'l',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/L.png',
        textZone: { x: 775, y: 56, w: 456, h: 1102 },
        usernameZone: { x: 890, y: 1167, w: 228, h: 50 },
        usernameFontSize: 28
    },
    2: {
        name: 'gojo',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/gok.png',
        textZone: { x: 755, y: 68, w: 466, h: 1027 },
        usernameZone: { x: 863, y: 1108, w: 249, h: 50 },
        usernameFontSize: 28
    },
    3: {
        name: 'yuji',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/cc.png',
        textZone: { x: 35, y: 68, w: 466, h: 1027 },
        usernameZone: { x: 133, y: 1108, w: 249, h: 50 },
        usernameFontSize: 28
    },
    4: {
        name: 'denji',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/denji.png',
        textZone: { x: 655, y: 68, w: 512, h: 1083 },
        usernameZone: { x: 795, y: 1152, w: 249, h: 50 },
        usernameFontSize: 28
    },
    5: {
        name: 'thorfin',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/thorfin.png',
        textZone: { x: 65, y: 54, w: 489, h: 992 },
        usernameZone: { x: 162, y: 1042, w: 249, h: 50 },
        usernameFontSize: 28
    },
    6: {
        name: 'naruto',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/Naruto.png',
        textZone: { x: 40, y: 56, w: 481, h: 1065 },
        usernameZone: { x: 170, y: 1126, w: 228, h: 50 },
        usernameFontSize: 28
    },
    7: {
        name: 'light',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/LIghtyagami.png',
        textZone: { x: 38, y: 56, w: 493, h: 941 },
        usernameZone: { x: 170, y: 1025, w: 228, h: 50 },
        usernameFontSize: 28
    },
    8: {
        name: 'higuruma',
        url: 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/qca/higuruma.png',
        textZone: { x: 755, y: 68, w: 424, h: 920 },
        usernameZone: { x: 840, y: 993, w: 249, h: 50 },
        usernameFontSize: 28
    }
};

const QUOTE_FONT_URL = 'https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/Font/ARIALN.ttf';
const QUOTE_FONT_PATH = join(__dirname, 'fonts', 'quote-arialn.ttf');
const INTER_FONT_URL = 'https://github.com/rsms/inter/raw/refs/heads/master/docs/font-files/Inter-Medium.woff2';
const INTER_FONT_PATH = join(__dirname, 'fonts', 'Inter-Medium.woff2');

async function generateQuote(text, username, backgroundId = 8) {
    const bg = QUOTE_BACKGROUNDS[backgroundId] || QUOTE_BACKGROUNDS[8];
    const ASSETS_DIR = join(__dirname, 'assets', 'quoteanime');
    const FONTS_DIR = join(ASSETS_DIR, 'fonts');
    const bgLocal = join(ASSETS_DIR, `${bg.name}.png`);

    await mkdir(FONTS_DIR, { recursive: true });

    async function downloadQuoteFile(url, dest) {
        if (!existsSync(dest)) {
            const res = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
            await writeFile(dest, Buffer.from(res.data));
        }
    }

    await downloadQuoteFile(QUOTE_FONT_URL, QUOTE_FONT_PATH);
    await downloadQuoteFile(INTER_FONT_URL, INTER_FONT_PATH);
    await downloadQuoteFile(bg.url, bgLocal);

    GlobalFonts.registerFromPath(QUOTE_FONT_PATH, 'ArialNarrow');
    GlobalFonts.registerFromPath(INTER_FONT_PATH, 'Inter');

    const CANVAS_SIZE = { width: 1254, height: 1254 };
    const canvas = createCanvas(CANVAS_SIZE.width, CANVAS_SIZE.height);
    const ctx = canvas.getContext('2d');

    const bgImg = await loadImage(bgLocal);
    ctx.drawImage(bgImg, 0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);

    // Draw quote text
    ctx.save();
    ctx.fillStyle = '#111111';
    ctx.textBaseline = 'middle';
    
    const textZone = bg.textZone;
    const fontSize = 75;
    ctx.font = `400 ${fontSize}px ArialNarrow`;
    
    function wrapQuoteText(ctx, text, maxWidth) {
        const out = [];
        text.split('\n').forEach(p => {
            let cur = '';
            p.split(' ').forEach(w => {
                const t = cur ? cur + ' ' + w : w;
                if (ctx.measureText(t).width > maxWidth && cur) { out.push(cur); cur = w; }
                else cur = t;
            });
            out.push(cur);
        });
        return out;
    }

    const lines = wrapQuoteText(ctx, text, textZone.w);
    const lh = fontSize * 1.2;
    const totalHeight = lines.length * lh;
    const startY = textZone.y + (textZone.h - totalHeight) / 2 + lh / 2;

    lines.forEach((l, i) => {
        const y = startY + i * lh;
        const words = l.split(' ');
        if (words.length === 1) {
            ctx.textAlign = 'center';
            ctx.fillText(l, textZone.x + textZone.w / 2, y);
        } else {
            const wordWidths = words.map(w => ctx.measureText(w).width);
            const totalWordsWidth = wordWidths.reduce((a, b) => a + b, 0);
            const spaceWidth = (textZone.w - totalWordsWidth) / (words.length - 1);
            ctx.textAlign = 'left';
            let cx = textZone.x;
            words.forEach((w, i) => {
                ctx.fillText(w, cx, y);
                cx += wordWidths[i] + spaceWidth;
            });
        }
    });
    ctx.restore();

    // Draw username
    ctx.save();
    ctx.fillStyle = '#121212';
    ctx.textBaseline = 'middle';
    const usernameX = textZone.x + textZone.w / 2;
    const usernameY = startY + (lines.length - 1) * lh + lh / 2 + 40;
    ctx.font = `500 ${bg.usernameFontSize}px Inter`;
    ctx.textAlign = 'center';
    ctx.fillText(username, usernameX, usernameY);
    ctx.restore();

    const outPath = join(process.cwd(), `temp`, `quote-${Date.now()}.png`);
    await writeFile(outPath, await canvas.encode('png'));
    return outPath;
}

// ============================================
// DOWNLOAD FUNCTIONS
// ============================================
async function downloadIG(url) {
    try {
        const ins = axios.create({ headers: { "user-agent": "Mozilla/5.0" } });
        const { data: msc } = await ins.get("https://fastdl.app/msec");
        const ts = Date.now() - (Math.abs(Date.now() - Math.floor(msc.msec * 1000)) >= 60000 ? Math.abs(Date.now() - Math.floor(msc.msec * 1000)) : 0);
        const crypto = await import('crypto');
        const sg = crypto.createHmac("sha256", Buffer.from("82314e32a384d00f055de496b4737acde3cbb2f851b90e1a70625f6d3bb56401", "hex")).update(url + ts).digest("hex");
        const { data: result } = await ins.post("https://cors.siputzx.my.id/https://api-wh.fastdl.app/api/convert", new URLSearchParams({ sf_url: url, ts: ts.toString(), _ts: "1778140969163", _tsc: "0", _sv: "2", _s: sg }).toString(), { headers: { "content-type": "application/x-www-form-urlencoded" } });
        let medias = [], info = { username: 'IG User', caption: '' };
        (Array.isArray(result) ? result : [result]).forEach(item => {
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
    const res = await axios.post('https://api-inference.huggingface.co/models/anton-l/stable-diffusion-xl-img2img', { inputs: { image: b64, prompt: "anime style", parameters: { num_inference_steps: 20, strength: 0.75 } } }, { headers: { 'Authorization': `Bearer ${API_KEYS.hf}` }, responseType: 'arraybuffer', timeout: 120000 });
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
        const groups = await sock.groupFetchAllParticipating();
        allGroups = Object.entries(groups).map(([id, info]) => ({ id, name: info.subject, participants: info.participants?.length || 0, allowed: allowedGroups.includes(id) }));
        io.emit('status', { connected: true, botName: sock.user?.name || 'JHON338 BOT', botNumber: sock.user?.id?.split(':')[0] || '', groups: allGroups, totalGroups: allGroups.length });
    } catch (e) { console.error('Error groups:', e.message); }
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
    if (sock) { try { sock.end(); } catch {} sock = null; }

    sock = makeWASocket({ version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) }, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ['JHON338 BOT', 'Chrome', '1.0.0'] });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) { const qrImg = await qrcode.toDataURL(qr); io.emit('qr', { qr: qrImg }); }
        if (connection === 'open') { isReady = true; io.emit('status', { connected: true, botName: sock.user?.name || 'JHON338 BOT', botNumber: sock.user?.id?.split(':')[0] || '' }); io.emit('message', { type: 'success', text: '✅ Connected!' }); await fetchGroups(); }
        if (connection === 'close') { isReady = false; io.emit('status', { connected: false }); io.emit('message', { type: 'info', text: '🛑 Disconnected.' }); }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || !isReady) return;
        const from = msg.key.remoteJid;
        if (!from.endsWith('@g.us')) return;
        const senderName = msg.pushName || 'User';
        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        if (!text) return;
        if (allowedGroups.length > 0 && !allowedGroups.includes(from)) return;
        if (!text.startsWith(botSettings.prefix)) return;

        const args = text.slice(botSettings.prefix.length).trim().split(/ +/);
        const cmd = args[0]?.toLowerCase();
        const input = args.slice(1).join(' ');

        try {
            await sock.sendPresenceUpdate('composing', from);
            let reply = '';
            switch (cmd) {
                case 'menu': 
                    reply = MENU_TEKS(senderName); 
                    break;
                    
                case 'ask': 
                    if (!input) { 
                        reply = '❌ .ask [pertanyaan]'; 
                        break; 
                    } 
                    await sock.sendMessage(from, { text: '🤔 *Mikir...*' }); 
                    const ai = await callAI(input); 
                    reply = ai.success ? `🤖 *${ai.provider}*\n\n${ai.response}` : ai.response; 
                    break;
                    
                case 'stiker':
                case 'sticker':
                    if (!input) { 
                        reply = '❌ *Cara pakai:* .stiker [teks]\n\nContoh: .stiker kakak\n.stiker jangan lupa bahagia'; 
                        break; 
                    }
                    await sock.sendMessage(from, { text: '⏳ *Bikin stiker nih...*' });
                    try {
                        const sticker = await createSticker(input);
                        await sock.sendMessage(from, { 
                            sticker: { url: sticker.filepath },
                            caption: `✅ *Stiker berhasil dibuat!*\n📝 "${input}"`
                        });
                        return;
                    } catch (e) { 
                        reply = `❌ *Gagal bikin stiker:* ${e.message}`; 
                    }
                    break;
                    
                case 'iqc':
                    if (!input) {
                        reply = '❌ *Cara pakai:* .iqc [teks]\n\nContoh: .iqc Earth without art is just "eh" 🌍🎨✨';
                        break;
                    }
                    await sock.sendMessage(from, { text: '⏳ *Bikin chat bubble keren...*' });
                    try {
                        const now = new Date();
                        const timeStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
                        const imageUrl = msg.message?.imageMessage ? await downloadMedia(msg) : null;
                        const emojis = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
                        
                        let resultPath;
                        if (imageUrl) {
                            const FormData = (await import('form-data')).default;
                            const form = new FormData();
                            form.append('files[]', imageUrl, 'img.png');
                            const up = await axios.post('https://clooud.my.id/uploder/', form, { headers: form.getHeaders(), timeout: 60000 });
                            const uploadedUrl = up.data?.files?.[0]?.url || up.data?.url;
                            resultPath = await generateIQC(input, timeStr, uploadedUrl, emojis);
                        } else {
                            resultPath = await generateIQC(input, timeStr, null, emojis);
                        }
                        
                        await sock.sendMessage(from, { 
                            image: { url: resultPath },
                            caption: '✅ *IQC Chat Bubble!*'
                        });
                        setTimeout(() => { try { fs.unlinkSync(resultPath); } catch {} }, 5000);
                        return;
                    } catch (e) { 
                        reply = `❌ *Gagal bikin IQC:* ${e.message}`; 
                    }
                    break;

                case 'brat':
                    if (!input) {
                        reply = '❌ *Cara pakai:* .brat [teks]\n\nContoh: .brat Halo Guys Nama Saya 🎨';
                        break;
                    }
                    await sock.sendMessage(from, { text: '⏳ *Bikin gambar BRAT...*' });
                    try {
                        const resultPath = await generateBratCanvas(input, 'white', 0);
                        await sock.sendMessage(from, { 
                            image: { url: resultPath },
                            caption: '✅ *BRAT Canvas!*'
                        });
                        setTimeout(() => { try { fs.unlinkSync(resultPath); } catch {} }, 5000);
                        return;
                    } catch (e) { 
                        reply = `❌ *Gagal bikin BRAT:* ${e.message}`; 
                    }
                    break;

                case 'bratvid':
                    if (!input) {
                        reply = '❌ *Cara pakai:* .bratvid [teks]\n\nContoh: .bratvid Halo Guys 🎬';
                        break;
                    }
                    await sock.sendMessage(from, { text: '⏳ *Bikin video BRAT...* (bisa lama)' });
                    try {
                        const resultPath = await generateBratVideo({
                            text: input,
                            theme: 'white',
                            blur: 0,
                            format: 'mp4',
                            frameDuration: 0.4,
                            holdDuration: 1.2,
                            maxWordPerLayer: 1,
                            maxWordBeforeReset: 0,
                            fastProgress: true
                        });
                        await sock.sendMessage(from, { 
                            video: { url: resultPath },
                            caption: '✅ *BRAT Video!*'
                        });
                        setTimeout(() => { try { fs.unlinkSync(resultPath); } catch {} }, 5000);
                        return;
                    } catch (e) { 
                        reply = `❌ *Gagal bikin BRAT Video:* ${e.message}`; 
                    }
                    break;

                case 'quote':
                    if (!input) {
                        reply = '❌ *Cara pakai:* .quote [teks] | [username]\n\nContoh: .quote "Hukum tidak selalu adil" | - Higuruma';
                        break;
                    }
                    await sock.sendMessage(from, { text: '⏳ *Bikin quote card anime...*' });
                    try {
                        const parts = input.split('|').map(s => s.trim());
                        const quoteText = parts[0] || 'Kosong';
                        const username = parts[1] || 'User';
                        const resultPath = await generateQuote(quoteText, username, 8);
                        await sock.sendMessage(from, { 
                            image: { url: resultPath },
                            caption: '✅ *Quote Card!*'
                        });
                        setTimeout(() => { try { fs.unlinkSync(resultPath); } catch {} }, 5000);
                        return;
                    } catch (e) { 
                        reply = `❌ *Gagal bikin Quote:* ${e.message}`; 
                    }
                    break;
                    
                case 'ig': 
                    if (!input?.includes('instagram.com')) { 
                        reply = '❌ Link IG invalid'; 
                        break; 
                    } 
                    await sock.sendMessage(from, { text: '⏳ *Downloading...*' }); 
                    try { 
                        const ig = await downloadIG(input); 
                        if (ig.medias.length > 0) { 
                            const m = ig.medias[0]; 
                            const cap = `📥 *IG* | ${ig.info.username}`; 
                            if (m.type === 'image') 
                                await sock.sendMessage(from, { image: { url: m.url }, caption: cap }); 
                            else 
                                await sock.sendMessage(from, { video: { url: m.url }, caption: cap }); 
                            return; 
                        } 
                        reply = '❌ Gagal!'; 
                    } catch (e) { 
                        reply = `❌ ${e.message}`; 
                    } 
                    break;
                    
                case 'removebg': 
                    if (!msg.message.imageMessage) { 
                        reply = '❌ Kirim gambar dgn .removebg'; 
                        break; 
                    } 
                    await sock.sendMessage(from, { text: '⏳ *Processing...*' }); 
                    try { 
                        const buf = await downloadMedia(msg); 
                        const url = await removeBG(buf); 
                        if (url) { 
                            await sock.sendMessage(from, { image: { url }, caption: '✅ *BG Removed!*' }); 
                            return; 
                        } 
                        reply = '❌ Gagal!'; 
                    } catch (e) { 
                        reply = `❌ ${e.message}`; 
                    } 
                    break;
                    
                case 'removewm': 
                    if (!msg.message.imageMessage) { 
                        reply = '❌ Kirim gambar dgn .removewm'; 
                        break; 
                    } 
                    await sock.sendMessage(from, { text: '⏳ *Processing...*' }); 
                    try { 
                        const buf = await downloadMedia(msg); 
                        const url = await removeWM(buf); 
                        if (url) { 
                            await sock.sendMessage(from, { image: { url }, caption: '✅ *WM Removed!*' }); 
                            return; 
                        } 
                        reply = '❌ Gagal!'; 
                    } catch (e) { 
                        reply = `❌ ${e.message}`; 
                    } 
                    break;
                    
                case 'anime': 
                    if (!msg.message.imageMessage) { 
                        reply = '❌ Kirim gambar dgn .anime'; 
                        break; 
                    } 
                    await sock.sendMessage(from, { text: '⏳ *Processing...*' }); 
                    try { 
                        const buf = await downloadMedia(msg); 
                        const path = await toAnime(buf); 
                        await sock.sendMessage(from, { image: { url: path }, caption: '✅ *Anime Style!*' }); 
                        setTimeout(() => { 
                            try { fs.unlinkSync(path); } catch {} 
                        }, 5000); 
                        return; 
                    } catch (e) { 
                        reply = `❌ ${e.message}`; 
                    } 
                    break;
                    
                case 'ping': 
                    reply = '🏓 Pong!'; 
                    break;
                    
                default: 
                    reply = `❌ *${cmd}* tidak dikenal!\nKetik *.menu*`;
            }
            if (reply) { 
                await sock.sendMessage(from, { text: reply }); 
            }
        } catch (error) { 
            console.error('❌ Error:', error.message); 
            try { 
                await sock.sendMessage(from, { text: `❌ Error: ${error.message}` }); 
            } catch {} 
        }
    });
}

// ============================================
// SOCKET.IO HANDLERS
// ============================================
io.on('connection', (socket) => {
    socket.emit('status', { connected: isReady, botName: sock?.user?.name || 'JHON338 BOT', botNumber: sock?.user?.id?.split(':')[0] || '', groups: allGroups, totalGroups: allGroups.length });
    socket.emit('update', { allowedGroups });
    socket.on('startBot', () => { if (!isReady) { startBot(); socket.emit('message', { type: 'info', text: '🚀 Starting...' }); } else { socket.emit('message', { type: 'warning', text: '⚠️ Already running!' }); } });
    socket.on('stopBot', () => { isReady = false; if (sock) { sock.end(); sock = null; } socket.emit('status', { connected: false }); });
    socket.on('updateGroups', (groups) => { allowedGroups = groups.slice(0, maxGroups); try { fs.writeFileSync(configPath, JSON.stringify({ allowedGroups, maxGroups, botSettings }, null, 2)); } catch {} socket.emit('update', { allowedGroups }); });
    socket.on('getGroups', async () => { if (sock && isReady) await fetchGroups(); socket.emit('groups', allGroups); });
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server ready on port ${PORT}`));