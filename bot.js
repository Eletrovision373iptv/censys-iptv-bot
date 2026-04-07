const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = 'Eletrovision373iptv';
const GITHUB_REPO  = 'censys-iptv-bot';
const GITHUB_BRANCH = 'main';

const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 800; 
const MAX_CONCURRENT   = 30; // Ajustado para equilíbrio no Termux

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = ['GLOBO','RECORD','SBT','BAND','SPORTV','ESPN','HBO','TNT'];

const waitingForName = new Map(); 

if (!BOT_TOKEN) {
    console.log("❌ Erro: Configure o BOT_TOKEN no seu terminal (export BOT_TOKEN=...)");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ── Funções de Rede ───────────────────────────────────────────────────────────

function isValidIP(ip) { return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip); }

function isValidCIDR(input) { return /^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/.test(input); }

function expandCIDR(cidr) {
    const [base, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr);
    const parts = base.split('.').map(Number);
    const baseInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
    const count = Math.pow(2, 32 - prefix);
    const ips = [];
    for (let i = 0; i < Math.min(count, 256); i++) {
        const n = (baseInt + i) >>> 0;
        ips.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
    return ips;
}

function checkPort(ip, port) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        sock.setTimeout(CONNECT_TIMEOUT);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(port, ip);
    });
}

async function scanIP(ip) {
    const found = [];
    // Varredura de portas em blocos
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p += MAX_CONCURRENT) {
        const pEnd = Math.min(p + MAX_CONCURRENT - 1, PORT_RANGE_END);
        const batch = [];
        for (let port = p; port <= pEnd; port++) batch.push(port);

        const results = await Promise.all(batch.map(async port => {
            const ok = await checkPort(ip, port);
            if (ok) {
                // Se a porta está aberta, checa se tem stream
                for (const path of STREAM_ENDPOINTS) {
                    const hasStream = await new Promise(res => {
                        const req = http.get({ host: ip, port, path, timeout: 1500 }, r => {
                            r.destroy();
                            res(r.statusCode < 500);
                        }).on('error', () => res(false));
                    });
                    if (hasStream) return { url: `http://${ip}:${port}${path}` };
                }
            }
            return null;
        }));
        found.push(...results.filter(Boolean));
    }
    return found;
}

// ── Handlers do Telegram ──────────────────────────────────────────────────────

bot.start(ctx => ctx.reply('🚀 Bot pronto! Envie uma lista de IPs ou um Range (ex: 192.168.1.0/24) para iniciar o scan.'));

bot.on('text', async ctx => {
    const input = ctx.message.text.trim();
    const chatId = ctx.chat.id;

    // Se estivermos esperando o nome do servidor após um scan
    if (waitingForName.has(chatId)) {
        const channels = waitingForName.get(chatId);
        waitingForName.delete(chatId);
        
        let m3u = `#EXTM3U\n# Servidor: ${input}\n\n`;
        channels.forEach((ch, i) => {
            const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
            m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
        });

        await ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename: `${input}.m3u` });
        return;
    }

    // Processar entrada de IPs
    const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
    const targetIPs = [];

    lines.forEach(line => {
        if (isValidIP(line)) targetIPs.push(line);
        else if (isValidCIDR(line)) targetIPs.push(...expandCIDR(line));
    });

    if (targetIPs.length === 0) return ctx.reply('❌ Nenhum IP válido encontrado na sua mensagem.');

    const status = await ctx.reply(`🔍 Iniciando varredura em ${targetIPs.length} IPs...\nIsso pode levar alguns minutos.`);
    
    let allFound = [];
    for (let i = 0; i < targetIPs.length; i++) {
        const ip = targetIPs[i];
        await ctx.telegram.editMessageText(chatId, status.message_id, undefined, `⏳ Processando IP ${i + 1}/${targetIPs.length}: \`${ip}\``, { parse_mode: 'Markdown' });
        
        const results = await scanIP(ip);
        allFound.push(...results);
    }

    if (allFound.length > 0) {
        await ctx.reply(`✅ Scan concluído! Encontrei ${allFound.length} canais ativos.\n\n📝 *Responda agora com o NOME que você quer dar para a lista:*`, { parse_mode: 'Markdown' });
        waitingForName.set(chatId, allFound);
    } else {
        await ctx.reply('❌ Scan concluído, mas nenhum canal foi encontrado nessas portas.');
    }
});

bot.launch();
console.log('🤖 Bot de Scan Manual rodando no Termux...');
