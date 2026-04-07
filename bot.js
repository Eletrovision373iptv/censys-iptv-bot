const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIGURAÇÕES ───────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = 'Eletrovision373iptv';
const GITHUB_REPO  = 'censys-iptv-bot';

const PORT = process.env.PORT || 3000;
const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const MAX_CONCURRENT   = 40; // Ajustado para estabilidade no Termux

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/video.ts', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = [
  'ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY',
  'CNN BRASIL','GNT','MULTISHOW','TNT','HBO','TELECINE','MEGAPIX',
  'COMBATE','PARAMOUNT','UNIVERSAL','SyFy','AXN','FOX','FX','SPACE',
  'HISTORY','NATIONAL GEOGRAPHIC','ANIMAL PLANET','DISCOVERY SCIENCE'
];

const waitingForName = new Map(); 
const bot = new Telegraf(BOT_TOKEN);

// Server para manter o bot vivo em plataformas como Render/Koyeb
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Online'); }).listen(PORT);

// ─── SCANNER LÓGICA ──────────────────────────────────────────────────────────
function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(500); // Timeout curto para rapidez
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

function checkStream(ip, port) {
  return new Promise(resolve => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= STREAM_ENDPOINTS.length) return resolve(null);
      const req = http.get({ host: ip, port, path: STREAM_ENDPOINTS[idx++], timeout: 1000 }, res => {
        res.destroy();
        if (res.statusCode < 400) resolve(res.req.path);
        else tryNext();
      }).on('error', tryNext).on('timeout', () => { req.destroy(); tryNext(); });
    };
    tryNext();
  });
}

async function scanIPFull(ip, ctx, msgId) {
  const allPorts = Array.from({length: PORT_RANGE_END - PORT_RANGE_START + 1}, (_, i) => PORT_RANGE_START + i);
  const openPorts = [];
  
  for (let i = 0; i < allPorts.length; i += MAX_CONCURRENT) {
    const chunk = allPorts.slice(i, i + MAX_CONCURRENT);
    const res = await Promise.all(chunk.map(p => checkPort(ip, p)));
    chunk.forEach((p, idx) => { if(res[idx]) openPorts.push(p); });
    
    // Feedback visual no Telegram
    if (i % 400 === 0) { 
        try { await bot.telegram.editMessageText(ctx.chat.id, msgId, null, `⏳ IP: ${ip}\n🔍 Verificando portas...\n📺 Canais encontrados: ${openPorts.length}`); } catch(e){}
    }
  }
  
  const results = [];
  for (const port of openPorts) {
    const endpoint = await checkStream(ip, port);
    if (endpoint) results.push({ url: `http://${ip}:${port}${endpoint}` });
  }
  return results;
}

// ─── GITHUB (Background) ─────────────────────────────────────────────────────
async function saveToGitHub(filename, content) {
    if (!GITHUB_TOKEN) return;
    const path = `playlists/${filename}`;
    const base64 = Buffer.from(content).toString('base64');
    const body = JSON.stringify({ message: `Update ${filename}`, content: base64 });
    const opt = { 
        hostname: 'api.github.com', 
        path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`, 
        method: 'PUT', 
        headers: { 
            'Authorization': `token ${GITHUB_TOKEN}`, 
            'User-Agent': 'iptv-bot', 
            'Content-Type': 'application/json' 
        } 
    };
    const req = https.request(opt);
    req.write(body);
    req.end();
}

// ─── TELEGRAM HANDLERS ───────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // RESPOSTA AO NOME DO SERVIDOR
  if (waitingForName.has(chatId)) {
    const data = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    const serverName = input.replace(/\s+/g, '_') || 'Server';

    let m3u = `#EXTM3U\n# Servidor: ${serverName}\n`;
    let txt = `LISTA IPTV - ${serverName}\nTotal: ${data.channels.length} canais\n\n`;
    let preview = `🛰 *${serverName}*\n📅 ${new Date().toLocaleDateString('pt-BR')}\n📺 Total: ${data.channels.length}\n\n*--- PRÉVIA ---*\n\`\`\`\n`;
    
    data.channels.forEach((ch, i) => {
      const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
      const line = `[FHD] ${name} ${i+1}`;
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",${line}\n${ch.url}\n`;
      txt += `${line}\n${ch.url}\n\n`;
      if (i < 20) preview += `${line}\n${ch.url}\n`;
    });
    
    if (data.channels.length > 20) preview += `\n... (+ ${data.channels.length - 20} canais)`;
    preview += `\n\`\`\``;

    // Envio sequencial para evitar travamento
    await ctx.reply(preview, { parse_mode: 'Markdown' });
    await ctx.reply('📦 Enviando arquivos gerados...');
    await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${serverName}.m3u` });
    await ctx.replyWithDocument({ source: Buffer.from(txt), filename: `${serverName}.txt` });
    
    // Salva no GitHub em background
    saveToGitHub(`${serverName}.m3u`, m3u);
    return;
  }

  // PROCESSAMENTO DE IPS ENVIADOS
  const ips = input.split('\n').map(i => i.trim()).filter(i => /^\d/.test(i));
  if (ips.length === 0) return;

  const msg = await ctx.reply(`🚀 Iniciando Scan de ${ips.length} IP(s)...`);
  const allChannels = [];

  for (const ip of ips) {
    const res = await scanIPFull(ip, ctx, msg.message_id);
    allChannels.push(...res);
  }

  if (allChannels.length === 0) return ctx.reply('❌ Nenhum canal ativo encontrado nos IPs informados.');

  await ctx.reply(`✅ Scan Finalizado!\n📺 Total de canais: ${allChannels.length}\n\n📝 *Qual o nome do servidor?*`, { parse_mode: 'Markdown' });
  waitingForName.set(chatId, { channels: allChannels });
});

bot.launch();
console.log('🤖 Bot IPTV Scanner Online!');
