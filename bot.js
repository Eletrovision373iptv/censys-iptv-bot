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

const PORT = process.env.PORT || 3000;
const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 600; 
const MAX_CONCURRENT   = 50; 

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';
const CHANNEL_NAMES = ['ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','HBO','TELECINE','TNT','MULTISHOW','GNT'];

const bot = new Telegraf(BOT_TOKEN);
http.createServer((req, res) => { res.end('OK'); }).listen(PORT);

// ── Funções de Apoio ─────────────────────────────────────────────────────────

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
      const req = http.get({ host: ip, port, path: p, timeout: 1000 }, res => {
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

// ── Lógica Principal ────────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const lines = ctx.message.text.trim().split('\n').map(l => l.trim());
  const chatId = ctx.chat.id;

  let serverName = "SERVIDOR_IPTV";
  let ips = [];

  if (!/^\d/.test(lines[0])) {
    serverName = lines[0];
    ips = lines.slice(1).filter(l => /^\d/.test(l));
  } else {
    ips = lines.filter(l => /^\d/.test(l));
  }

  if (ips.length === 0) return;

  const msg = await ctx.reply(`🛰 <b>Servidor:</b> ${serverName}\nIniciando scan em ${ips.length} IP(s)...`, { parse_mode: 'HTML' });
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

      if (i % 400 === 0) {
        try {
          await bot.telegram.editMessageText(chatId, msg.message_id, null, 
            `🛰 <b>Servidor:</b> ${serverName}\n⏳ <b>IP:</b> ${ip}\n🔍 <b>Portas:</b> ${i}/3000\n📺 <b>Canais:</b> ${allChannels.length}`, { parse_mode: 'HTML' });
        } catch(e) {}
      }
    }
  }

  if (allChannels.length === 0) return ctx.reply('❌ Nenhum canal ativo.');

  const safeName = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  const filenameM3U = `${safeName}.m3u`;
  const filenameTXT = `${safeName}.txt`;

  let m3u = `#EXTM3U\n# Servidor: ${serverName}\n`;
  let txt = `SERVIDOR: ${serverName}\nTOTAL: ${allChannels.length}\n\n`;
  let preview = `<b>✅ SCAN FINALIZADO</b>\n<b>🛰 ${serverName}</b>\n\n<b>--- PRÉVIA ---</b>\n<pre>\n`;

  allChannels.forEach((ch, i) => {
    const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
    m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
    txt += `${ch.url}\n`;
    if (i < 15) preview += `[FHD] ${name} ${i+1}\n${ch.url}\n`;
  });

  if (allChannels.length > 15) preview += `\n... (+ ${allChannels.length - 15} canais)`;
  preview += `\n</pre>`;

  await ctx.reply(preview, { parse_mode: 'HTML' });
  
  const [githubUrl] = await Promise.all([
    saveToGitHub(filenameM3U, m3u),
    ctx.replyWithDocument({ source: Buffer.from(m3u), filename: filenameM3U }),
    ctx.replyWithDocument({ source: Buffer.from(txt), filename: filenameTXT })
  ]);

  if(githubUrl) ctx.reply(`🔗 <b>GitHub:</b> <code>${githubUrl}</code>`, { parse_mode: 'HTML' });
});

bot.launch();
