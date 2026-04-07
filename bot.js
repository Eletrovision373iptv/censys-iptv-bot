const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = 'Eletrovision373iptv';
const GITHUB_REPO  = 'censys-iptv-bot';
const GITHUB_BRANCH = 'main';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN não definido!');

const PORT = process.env.PORT || 3000;
const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 800;
const HTTP_TIMEOUT     = 2000;
const MAX_CONCURRENT   = 80;

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/stream.ts', '/live', '/video.ts', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = [
  'ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY',
  'CNN BRASIL','GNT','MULTISHOW','TNT','HBO','TELECINE','MEGAPIX',
  'COMBATE','PARAMOUNT','UNIVERSAL','SyFy','AXN','FOX','FX','SPACE'
];

const waitingForName = new Map();
const bot = new Telegraf(BOT_TOKEN);

// ── Keep-alive ────────────────────────────────────────────────────────────────
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Online'); }).listen(PORT);

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
  for (let i = 1; i < Math.min(count, 256); i++) {
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

function checkStream(ip, port) {
  return new Promise(resolve => {
    const globalTimer = setTimeout(() => resolve(null), 3000);
    let idx = 0;
    function tryNext() {
      if (idx >= STREAM_ENDPOINTS.length) { clearTimeout(globalTimer); return resolve(null); }
      const p = STREAM_ENDPOINTS[idx++];
      const req = http.get({ host: ip, port, path: p, timeout: HTTP_TIMEOUT }, res => {
        res.destroy();
        if (res.statusCode < 500) { clearTimeout(globalTimer); resolve(p); }
        else tryNext();
      }).on('error', tryNext);
    }
    tryNext();
  });
}

async function scanIPFull(ip) {
    const found = [];
    const ports = [];
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) ports.push(p);

    for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
        const chunk = ports.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(chunk.map(async port => {
            if (await checkPort(ip, port)) {
                const path = await checkStream(ip, port);
                return path ? { url: `http://${ip}:${port}${path}` } : null;
            }
            return null;
        }));
        found.push(...results.filter(Boolean));
    }
    return found;
}

// ── Playlists e GitHub ────────────────────────────────────────────────────────

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const path = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  let sha = null;
  try {
    const options = { hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`, method: 'GET', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'bot' } };
    await new Promise(res => { https.get(options, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { sha = JSON.parse(d).sha; } catch(e){} res(); }); }); });
  } catch(e){}

  const body = JSON.stringify({ message: `Update ${filename}`, content: base64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) });
  const options = { hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`, method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'bot', 'Content-Type': 'application/json' } };
  return new Promise(resolve => { const req = https.request(options, res => { resolve(res.statusCode < 300 ? `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}` : null); }); req.write(body); req.end(); });
}

async function sendResults(ctx, channels, serverName) {
  const scanDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  
  // Criar M3U
  let m3u = `#EXTM3U\n# Servidor: ${serverName}\n# Data: ${scanDate}\n\n`;
  // Criar TXT (Lista Simples)
  let txt = `LISTA IPTV - ${serverName}\nData: ${scanDate}\n\n`;
  // Criar Prévia para o Telegram (20 primeiros)
  let preview = `🛰 *${serverName}*\n📅 ${scanDate}\n📺 Encontrados: ${channels.length} canais\n\n*--- PRÉVIA ---*\n\`\`\``;

  channels.forEach((ch, i) => {
    const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
    const line = `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
    m3u += line;
    txt += `${name} ${i+1}: ${ch.url}\n`;
    if (i < 20) preview += `#EXTINF:-1,[FHD] ${name} ${i+1}\n${ch.url}\n`;
  });
  preview += `\`\`\``;

  const safeName = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  
  // Enviar a Prévia
  await ctx.reply(preview, { parse_mode: 'Markdown' });

  // Salvar no Git e Enviar Arquivos
  const githubUrl = await saveToGitHub(`${safeName}.m3u`, m3u);
  await ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename: `${safeName}.m3u` });
  await ctx.replyWithDocument({ source: Buffer.from(txt, 'utf-8'), filename: `${safeName}.txt` });

  if (githubUrl) ctx.reply(`✅ *Playlist no GitHub:*\n\`${githubUrl}\``, { parse_mode: 'Markdown' });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  if (waitingForName.has(ctx.chat.id)) {
    const data = waitingForName.get(ctx.chat.id);
    waitingForName.delete(ctx.chat.id);
    return sendResults(ctx, data.channels, input);
  }

  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  const targetIPs = [];
  lines.forEach(l => { if (isValidIP(l)) targetIPs.push(l); else if (isValidCIDR(l)) targetIPs.push(...expandCIDR(l)); });

  if (targetIPs.length === 0) return;

  const status = await ctx.reply(`🔍 Escaneando ${targetIPs.length} IP(s)...`);
  let allFound = [];
  for (const ip of targetIPs) {
    const res = await scanIPFull(ip);
    allFound.push(...res);
  }

  if (allFound.length > 0) {
    await ctx.reply(`✅ Encontrados ${allFound.length} canais ativos.\n\n📝 *Qual o nome do servidor?*`, { parse_mode: 'Markdown' });
    waitingForName.set(ctx.chat.id, { channels: allFound });
  } else { ctx.reply('❌ Nada encontrado.'); }
});

bot.launch();
console.log('🤖 Bot Atualizado com Prévia e TXT!');
