const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ZOOMEYE_KEY  = process.env.ZOOMEYE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = 'Eletrovision373iptv';
const GITHUB_REPO  = 'censys-iptv-bot';
const GITHUB_BRANCH = 'main';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN não definido!');

const PORT = process.env.PORT || 3000;
const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 600;
const HTTP_TIMEOUT     = 1500;
const MAX_CONCURRENT   = 50; 

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/video.ts', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = [
  'ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY',
  'CNN BRASIL','GNT','MULTISHOW','TNT','HBO','TELECINE','MEGAPIX',
  'COMBATE','PARAMOUNT','UNIVERSAL','SyFy','AXN','FOX','FX','SPACE',
  'HISTORY','NATIONAL GEOGRAPHIC','ANIMAL PLANET','DISCOVERY SCIENCE',
  'CARTOON NETWORK','DISNEY CHANNEL','NICKELODEON','COMEDY CENTRAL',
  'VH1','MTV','BIS','VIVA','TV CULTURA'
];

const waitingForName = new Map(); 
const bot = new Telegraf(BOT_TOKEN);

// ── Server Keep-alive ────────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot IPTV Online');
}).listen(PORT, () => console.log(`🌐 Keep-alive na porta ${PORT}`));

// ── Funções Scanner ──────────────────────────────────────────────────────────
function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    sock.setTimeout(CONNECT_TIMEOUT);
    sock.on('connect', () => { if(!done){ done=true; sock.destroy(); resolve(true); }});
    sock.on('error',   () => { if(!done){ done=true; sock.destroy(); resolve(false); }});
    sock.on('timeout', () => { if(!done){ done=true; sock.destroy(); resolve(false); }});
    sock.connect(port, ip);
  });
}

function checkStream(ip, port) {
  return new Promise(resolve => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= STREAM_ENDPOINTS.length) return resolve(null);
      const p = STREAM_ENDPOINTS[idx++];
      const req = http.get({ host: ip, port, path: p, timeout: HTTP_TIMEOUT }, res => {
        res.destroy();
        if (res.statusCode < 400) resolve(p);
        else tryNext();
      });
      req.on('error', tryNext);
      req.on('timeout', () => { req.destroy(); tryNext(); });
    };
    tryNext();
  });
}

async function scanIPFull(ip) {
  const allPorts = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);
  
  const openPorts = [];
  for (let i = 0; i < allPorts.length; i += MAX_CONCURRENT) {
    const chunk = allPorts.slice(i, i + MAX_CONCURRENT);
    const res = await Promise.all(chunk.map(p => checkPort(ip, p)));
    chunk.forEach((p, idx) => { if(res[idx]) openPorts.push(p); });
    await new Promise(r => setTimeout(r, 15));
  }
  
  const results = [];
  for (const port of openPorts) {
    const endpoint = await checkStream(ip, port);
    if (endpoint) results.push({ url: `http://${ip}:${port}${endpoint}` });
  }
  return results;
}

// ── GitHub & Envio ──────────────────────────────────────────────────────────
async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const path = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  let sha = null;
  try {
    const getOpt = { hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`, headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Accept': 'application/vnd.github.v3+json' } };
    await new Promise(res => https.get(getOpt, r => { let d=''; r.on('data', c=>d+=c); r.on('end', ()=>{try{sha=JSON.parse(d).sha}catch(e){}res()}) }).on('error', res));
  } catch(e){}
  return new Promise(resolve => {
    const body = JSON.stringify({ message: `Update ${filename}`, content: base64, sha });
    const opt = { hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`, method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opt, res => { if (res.statusCode <= 201) resolve(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/${path}`); else resolve(null); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

// ── Lógica Principal ────────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (waitingForName.has(chatId)) {
    const data = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    const serverName = input || 'Servidor_IPTV';
    const filename = `${serverName.replace(/\s+/g, '_')}.m3u`;

    // 1. Gera M3U completo
    let m3u = `#EXTM3U\n# Servidor: ${serverName}\n`;
    data.channels.forEach((ch, i) => {
      const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
    });

    // 2. Gera Prévia (Apenas as primeiras 20 linhas/canais)
    let preview = `🛰 *${serverName}*\n📺 Total: ${data.channels.length} canais\n\n*--- PRÉVIA ---*\n\`\`\`\n`;
    data.channels.slice(0, 20).forEach((ch, i) => {
      const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
      preview += `[FHD] ${name} ${i+1}\n${ch.url}\n`;
    });
    if (data.channels.length > 20) preview += `\n... (e mais ${data.channels.length - 20} canais)`;
    preview += `\n\`\`\``;

    await ctx.reply(preview, { parse_mode: 'Markdown' });
    await ctx.reply('📦 Enviando arquivos...');
    
    const [url] = await Promise.all([
      saveToGitHub(filename, m3u),
      ctx.replyWithDocument({ source: Buffer.from(m3u), filename })
    ]);

    if(url) ctx.reply(`✅ Playlist no GitHub:\n\`${url}\``, { parse_mode: 'Markdown' });
    return;
  }

  const ips = input.split('\n').map(i => i.trim()).filter(i => /^\d/.test(i));
  if (ips.length === 0) return;

  const msg = await ctx.reply(`🔍 Escaneando ${ips.length} IP(s)...`);
  const allChannels = [];
  let foundIPs = 0;

  for (const ip of ips) {
    const res = await scanIPFull(ip);
    if (res.length > 0) { foundIPs++; allChannels.push(...res); }
    try { await bot.telegram.editMessageText(chatId, msg.message_id, null, `⏳ Processando: ${ip}\n📺 Canais encontrados: ${allChannels.length}`); } catch(e){}
  }

  if (allChannels.length === 0) return ctx.reply('❌ Nenhum canal encontrado.');

  await ctx.reply(`✅ Scan Concluído!\n🖥 IPs ativos: ${foundIPs}\n📺 Total: ${allChannels.length}\n\n📝 *Qual o nome do servidor?*`, { parse_mode: 'Markdown' });
  waitingForName.set(chatId, { channels: allChannels });
});

bot.launch();
console.log('🤖 Bot IPTV Scanner Atualizado!');
