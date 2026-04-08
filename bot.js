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
const MAX_CONCURRENT   = 60; // Ajustado para estabilidade no Termux

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/video.ts', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = [
  'ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY',
  'HBO','TELECINE','MULTISHOW','GNT','TNT','HBO 2','HBO FAMILY'
];

const waitingForName = new Map(); 
const bot = new Telegraf(BOT_TOKEN);

// Keep-alive
http.createServer((req, res) => { res.end('Bot Online'); }).listen(PORT);

// ── Funções de Rede ──────────────────────────────────────────────────────────

function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    sock.setTimeout(CONNECT_TIMEOUT);
    sock.on('connect', () => { if(!done){ done=true; sock.destroy(); resolve(true); }});
    const fail = () => { if(!done){ done=true; sock.destroy(); resolve(false); }};
    sock.on('error', fail); sock.on('timeout', fail);
    sock.connect(port, ip);
  });
}

async function checkStream(ip, port) {
  for (const p of STREAM_ENDPOINTS) {
    const found = await new Promise((resolve) => {
      const req = http.get({ host: ip, port, path: p, timeout: 1200 }, res => {
        res.destroy();
        resolve(res.statusCode < 400 ? p : null);
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (found) return found;
  }
  return null;
}

// ── Funções de Playlist ──────────────────────────────────────────────────────

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const path = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  let sha = null;
  try {
    await new Promise((resolve) => {
      const opt = { hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`, headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Accept': 'application/vnd.github.v3+json' }};
      https.get(opt, r => { let d=''; r.on('data', c=>d+=c); r.on('end', ()=>{ try{sha=JSON.parse(d).sha}catch(e){} resolve(); })}).on('error', resolve);
    });
  } catch(e){}

  return new Promise(resolve => {
    const body = JSON.stringify({ message: `Update ${filename}`, content: base64, sha });
    const opt = { hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`, method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }};
    const req = https.request(opt, res => { resolve(res.statusCode <= 201 ? `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/${path}` : null); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

// ── Handler Principal ───────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (waitingForName.has(chatId)) {
    const data = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    
    const serverName = input || 'Servidor';
    const filename = `${serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase()}.m3u`;

    let m3u = `#EXTM3U\n# Servidor: ${serverName}\n`;
    let preview = `<b>🛰 ${serverName}</b>\n\n<b>--- PRÉVIA ---</b>\n<pre>\n`;

    data.channels.forEach((ch, i) => {
      const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
      if (i < 20) preview += `[FHD] ${name} ${i+1}\n${ch.url}\n`;
    });

    if (data.channels.length > 20) preview += `\n... (+ ${data.channels.length - 20} canais)`;
    preview += `\n</pre>`;

    await ctx.reply(preview, { parse_mode: 'HTML' });
    
    const [githubUrl] = await Promise.all([
      saveToGitHub(filename, m3u),
      ctx.replyWithDocument({ source: Buffer.from(m3u), filename })
    ]);

    if(githubUrl) ctx.reply(`✅ <b>Playlist no GitHub:</b>\n<code>${githubUrl}</code>`, { parse_mode: 'HTML' });
    return;
  }

  const ips = input.split('\n').map(i => i.trim()).filter(i => /^\d/.test(i));
  if (ips.length === 0) return;

  const msg = await ctx.reply(`🔎 Iniciando scan em ${ips.length} IP(s)...`);
  const allChannels = [];

  for (const ip of ips) {
    const ports = Array.from({length: 3001}, (_, i) => 14000 + i);

    for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
      const chunk = ports.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(chunk.map(p => checkPort(ip, p)));
      
      for (let j = 0; j < chunk.length; j++) {
        if (results[j]) {
          const endpoint = await checkStream(ip, chunk[j]);
          if (endpoint) allChannels.push({ url: `http://${ip}:${chunk[j]}${endpoint}` });
        }
      }

      if (i % 300 === 0) {
        try {
          await bot.telegram.editMessageText(chatId, msg.message_id, null, 
            `⏳ <b>IP:</b> ${ip}\n🔍 <b>Portas:</b> ${i}/3000\n📺 <b>Canais:</b> ${allChannels.length}`, { parse_mode: 'HTML' });
        } catch(e) {}
      }
    }
  }

  if (allChannels.length === 0) return ctx.reply('❌ Nenhum canal ativo.');

  await ctx.reply(`✅ <b>Scan Finalizado!</b>\n📺 Total: ${allChannels.length}\n\n📝 <b>Qual o nome do servidor?</b>`, { parse_mode: 'HTML' });
  waitingForName.set(chatId, { channels: allChannels });
});

bot.launch();
console.log('🤖 Bot IPTV Manual (Sem ZoomEye) Online!');
