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

const STREAM_ENDPOINTS = [
  '/live.ts', '/stream', '/stream.ts', '/live', '/video.ts', '/index.m3u8',
];

const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = [
  'ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY',
  'CNN BRASIL','GNT','MULTISHOW','TNT','HBO','TELECINE','MEGAPIX',
  'COMBATE','PARAMOUNT','UNIVERSAL','SyFy','AXN','FOX','FX','SPACE',
  'HISTORY','NATIONAL GEOGRAPHIC','ANIMAL PLANET','DISCOVERY SCIENCE',
  'CARTOON NETWORK','DISNEY CHANNEL','NICKELODEON','COMEDY CENTRAL',
  'VH1','MTV','BIS','VIVA','TV CULTURA','TV BRASIL','REDE TV',
  'GAZETA','JOVEM PAN NEWS','RECORD NEWS','GLOBONEWS','BAND NEWS'
];

const waitingForName = new Map();

const bot = new Telegraf(BOT_TOKEN);

// ── Keep-alive ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot IPTV Scanner online.');
});
server.listen(PORT, () => console.log(`🌐 Servidor ativo na porta ${PORT}`));

// ── Funções Scanner (Originais) ───────────────────────────────────────────────

function isValidIP(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split('.').every(n => parseInt(n) <= 255);
}

function isValidCIDR(input) {
  const match = input.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
  if (!match) return false;
  const prefix = parseInt(input.split('/')[1]);
  return prefix >= 16 && prefix <= 32;
}

function expandCIDR(cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr);
  const parts = base.split('.').map(Number);
  const baseInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
  const networkInt = (baseInt & mask) >>> 0;
  const count = Math.pow(2, 32 - prefix);
  const ips = [];
  for (let i = 1; i < count - 1; i++) {
    const n = (networkInt + i) >>> 0;
    ips.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return ips;
}

function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(CONNECT_TIMEOUT);
    sock.on('connect', () => finish(true));
    sock.on('error',   () => finish(false));
    sock.on('timeout', () => finish(false));
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
      });
      req.on('error', tryNext);
      req.on('timeout', () => { req.destroy(); tryNext(); });
    }
    tryNext();
  });
}

async function scanPorts(ip, ports, onProgress) {
  const open = [];
  let done = 0;
  const chunks = [];
  for (let i = 0; i < ports.length; i += MAX_CONCURRENT) chunks.push(ports.slice(i, i + MAX_CONCURRENT));
  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(async port => {
      const ok = await checkPort(ip, port);
      done++;
      if (done % 100 === 0 && onProgress) onProgress(done, ports.length);
      return ok ? port : null;
    }));
    open.push(...results.filter(Boolean));
  }
  return open;
}

async function scanIPFull(ip) {
  const allPorts = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);
  const openPorts = await scanPorts(ip, allPorts, null);
  if (openPorts.length === 0) return [];
  const results = await Promise.all(openPorts.map(async port => {
    const endpoint = await checkStream(ip, port);
    if (!endpoint) return null;
    return { name: `Canal`, url: `http://${ip}:${port}${endpoint}` };
  }));
  return results.filter(Boolean);
}

function getChannelName(index) {
  return CHANNEL_NAMES[index % CHANNEL_NAMES.length];
}

// ── Funções de Playlist e GitHub (Originais) ──────────────────────────────────

function buildM3U(channels, serverName, scanDate) {
  let m3u = `#EXTM3U url-tvg="" tvg-shift=0 cache=500\n`;
  m3u += `# Servidor: ${serverName}\n# Scan: ${scanDate}\n\n`;
  channels.forEach((ch, i) => {
    const name = getChannelName(i);
    m3u += `#EXTINF:-1 tvg-id="${name}" tvg-name="${name}" tvg-logo="${LOGO_URL}" group-title="${serverName}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
  });
  return m3u;
}

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const path = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  let sha = null;
  try {
    await new Promise(resolve => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
        method: 'GET',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'bot', 'Accept': 'application/vnd.github.v3+json' },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { sha = JSON.parse(data).sha || null; } catch(_) {} resolve(); });
      });
      req.on('error', () => resolve());
      req.end();
    });
  } catch(_) {}

  return new Promise(resolve => {
    const body = JSON.stringify({ message: `Update ${filename}`, content: base64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'bot', 'Content-Type': 'application/json' },
    };
    const req = https.request(options, res => {
      if (res.statusCode === 200 || res.statusCode === 201) resolve(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`);
      else resolve(null);
    });
    req.write(body);
    req.end();
  });
}

async function sendResults(ctx, channels, validEntries, totalWithStreams, serverName) {
  const scanDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const m3u = buildM3U(channels, serverName, scanDate);
  const safeName = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  const filenameM3U = `${safeName}.m3u`;

  await ctx.reply(`🛰 *${serverName}*\n🔍 ${validEntries.length} IP(s) verificado(s)\n📺 ${channels.length} canal(is) encontrado(s)`, { parse_mode: 'Markdown' });

  const githubUrl = await saveToGitHub(filenameM3U, m3u);
  await ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename: filenameM3U });

  if (githubUrl) {
    await ctx.reply(`✅ *Playlist salva no GitHub!*\n\`${githubUrl}\``, { parse_mode: 'Markdown' });
  }
}

// ── Handlers (Apenas Manual) ──────────────────────────────────────────────────

bot.start(ctx => ctx.reply('🚀 Bot pronto! Envie os IPs ou Ranges (ex: 89.187.190.0/24).'));

bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (waitingForName.has(chatId)) {
    const data = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    await ctx.reply(`✅ Gerando arquivos para: ${input}...`);
    await sendResults(ctx, data.channels, data.entries, data.totalWithStreams, input);
    return;
  }

  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  const validEntries = lines.filter(l => isValidIP(l) || isValidCIDR(l));

  if (validEntries.length === 0) return ctx.reply('❌ Envie IPs válidos.');

  const statusMsg = await ctx.reply(`🔍 Iniciando varredura em ${validEntries.length} entrada(s)...`);

  try {
    const allChannels = [];
    let totalWithStreams = 0;

    for (const entry of validEntries) {
      const ips = isValidCIDR(entry) ? expandCIDR(entry) : [entry];
      
      for (const ip of ips) {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, `⏳ Verificando: \`${ip}\`...`, { parse_mode: 'Markdown' });
        const channels = await scanIPFull(ip);
        if (channels.length > 0) {
          totalWithStreams++;
          allChannels.push(...channels);
        }
      }
    }

    if (allChannels.length === 0) return ctx.reply('❌ Nenhum stream encontrado.');

    await ctx.reply(`✅ Concluído! ${allChannels.length} canais encontrados.\n\n📝 *Qual o nome do servidor?*`, { parse_mode: 'Markdown' });
    waitingForName.set(chatId, { entries: validEntries, channels: allChannels, totalWithStreams });

  } catch (err) {
    ctx.reply(`❌ Erro: ${err.message}`);
  }
});

bot.launch();
console.log('🤖 Bot IPTV Scanner Manual Online...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
