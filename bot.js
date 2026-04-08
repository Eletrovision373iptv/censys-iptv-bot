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
if (!BOT_TOKEN)   throw new Error('BOT_TOKEN não definido!');
if (!ZOOMEYE_KEY) throw new Error('ZOOMEYE_KEY não definida!');

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
  'GAZETA','JOVEM PAN NEWS','RECORD NEWS','GLOBONEWS','BAND NEWS',
  'PREMIERE 1','PREMIERE 2','PREMIERE 3','PREMIERE 4','PREMIERE 5',
  'SPORTV 2','SPORTV 3','ESPN 2','ESPN 3','ESPN 4',
  'HBO 2','HBO FAMILY','HBO HITS','HBO PLUS','HBO SIGNATURE',
  'TELECINE FUN','TELECINE TOUCH','TELECINE PIPOCA','TELECINE CULT',
  'CINEMAX','CINEMAX 2','MAX PRIME','TELECINE ACTION',
  'DISCOVERY HOME','DISCOVERY TURBO','DISCOVERY THEATER',
  'NAT GEO WILD','DISNEY JUNIOR','DISNEY XD','BOOMERANG',
  'TOONCAST','STUDIO UNIVERSAL','FILM & ARTS','ARTE 1',
  'OFF','LIFETIME','WE TV','E! ENTERTAINMENT','PEOPLE+ARTS',
];

const waitingForName = new Map(); 

const bot = new Telegraf(BOT_TOKEN);

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot IPTV Scanner online.');
});
server.listen(PORT, () => console.log(`🌐 Keep-alive na porta ${PORT}`));

// ── ZoomEye API ───────────────────────────────────────────────────────────────

function zoomeyeSearch(query, page = 1) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      query: query,
      page: page,
      pagesize: 100,
    });

    const options = {
      hostname: 'api.zoomeye.org',
      path: `/host/search?${params.toString()}`,
      method: 'GET',
      headers: {
        'Authorization': `JWT ${ZOOMEYE_KEY}`,
        'User-Agent': 'iptv-scanner-bot/1.0',
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(`ZoomEye: ${json.error}`));
          if (res.statusCode !== 200) return reject(new Error(`ZoomEye: HTTP ${res.statusCode}`));
          const list = json.matches || json.data?.list || [];
          const ips = list.map(h => h.ip).filter(Boolean);
          resolve({ ips, total: json.total || json.data?.total || ips.length });
        } catch (e) {
          reject(new Error(`ZoomEye resposta inválida`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout ZoomEye')); });
    req.end();
  });
}

// ── Scanner ───────────────────────────────────────────────────────────────────

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

const logBuffer = new Map();

async function logToTelegram(chatId, line) {
  if (!chatId) return;
  if (!logBuffer.has(chatId)) logBuffer.set(chatId, { lines: [], timer: null });
  const buf = logBuffer.get(chatId);
  buf.lines.push(line);
  if (buf.lines.length >= 10) {
    clearTimeout(buf.timer);
    await flushLog(chatId);
  } else {
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushLog(chatId), 3000);
  }
}

async function flushLog(chatId) {
  const buf = logBuffer.get(chatId);
  if (!buf || buf.lines.length === 0) return;
  const msg = buf.lines.join('\n');
  buf.lines = [];
  try {
    await bot.telegram.sendMessage(chatId, '<pre>' + msg + '</pre>', { parse_mode: 'HTML' });
  } catch (_) {}
}

async function scanIPFull(ip, chatId = null) {
  const allPorts = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);
  const openPorts = await scanPorts(ip, allPorts, null);
  if (openPorts.length === 0) return [];
  const results = await Promise.all(openPorts.map(async (port, idx) => {
    const endpoint = await checkStream(ip, port);
    if (!endpoint) return null;
    const quality = endpoint.includes('.ts') ? 'FHD' : 'HD';
    const name = getChannelName(idx);
    await logToTelegram(chatId, `[${quality}] -> ${name} (Porta: ${port})`);
    return { url: `http://${ip}:${port}${endpoint}` };
  }));
  return results.filter(Boolean);
}

function getChannelName(index) {
  return CHANNEL_NAMES[index % CHANNEL_NAMES.length];
}

function buildM3U(channels, serverName, scanDate) {
  let m3u = `#EXTM3U url-tvg="" tvg-shift=0 cache=500\n`;
  m3u += `# Servidor: ${serverName}\n`;
  m3u += `# Scan: ${scanDate}\n\n`;
  channels.forEach((ch, i) => {
    const name = getChannelName(i);
    const num  = i + 1;
    m3u += `#EXTINF:-1 tvg-id="${name}" tvg-name="${name}" tvg-logo="${LOGO_URL}" group-title="${serverName}",[FHD] ${name} ${num}\n`;
    m3u += `${ch.url}\n`;
  });
  return m3u;
}

function buildTXT(channels, serverName, scanDate) {
  let txt = `Servidor: ${serverName}\n`;
  txt += `Scan: ${scanDate}\n`;
  txt += `Total: ${channels.length} canais\n\n`;
  channels.forEach((ch, i) => {
    const name = getChannelName(i);
    txt += `${ch.url}\n`;
    txt += `#EXTINF:-1,[FHD] ${name} ${i + 1}\n`;
  });
  return txt;
}

function buildListText(channels) {
  let text = '';
  channels.forEach((ch, i) => {
    const name = getChannelName(i);
    text += `#EXTINF:-1,[FHD] ${name} ${i + 1}\n${ch.url}\n`;
  });
  return text;
}

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const path = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  let sha = null;
  try {
    await new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
        method: 'GET',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-scanner-bot', 'Accept': 'application/vnd.github.v3+json' },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { sha = JSON.parse(data).sha || null; } catch (_) {} resolve(); });
      });
      req.on('error', resolve);
      req.end();
    });
  } catch (_) {}

  return new Promise((resolve) => {
    const body = JSON.stringify({ message: sha ? `Atualizar ${filename}` : `Adicionar ${filename}`, content: base64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-scanner-bot', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      if (res.statusCode === 200 || res.statusCode === 201) resolve(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`);
      else resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function sendResults(ctx, channels, validEntries, totalWithStreams, serverName) {
  const scanDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const m3u      = buildM3U(channels, serverName, scanDate);
  const txt      = buildTXT(channels, serverName, scanDate);
  const listText = buildListText(channels);

  const filenameM3U = `${serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase()}.m3u`;
  const filenameTXT = `${serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase()}.txt`;

  const header =
    `<b>🛰 ${serverName}</b>\n` +
    `📅 ${scanDate}\n\n` +
    `🔍 ${validEntries.length} IP(s) verificado(s)\n` +
    `🖥 ${totalWithStreams} IP(s) com streams\n` +
    `📺 ${channels.length} canal(is) encontrado(s)\n\n`;

  const preview = listText.split('\n').slice(0, 30).join('\n');
  await ctx.reply(
    header + '<b>--- PRÉVIA ---</b>\n<pre>' + preview + (channels.length > 15 ? '\n...' : '') + '</pre>',
    { parse_mode: 'HTML' }
  );

  const [githubUrl] = await Promise.all([
    saveToGitHub(filenameM3U, m3u),
    ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename: filenameM3U }),
    ctx.replyWithDocument({ source: Buffer.from(txt, 'utf-8'), filename: filenameTXT }),
  ]);

  if (githubUrl) {
    await ctx.reply(
      `✅ <b>Playlist salva no GitHub!</b>\n\n` +
      `🔗 Link direto para usar no player:\n<code>${githubUrl}</code>\n\n` +
      `<i>Próximo scan com o mesmo nome atualiza automaticamente.</i>`,
      { parse_mode: 'HTML' }
    );
  }
}

// ── Bot handlers ──────────────────────────────────────────────────────────────

bot.start(ctx => ctx.reply(
  '<b>🛰 Bot IPTV Scanner</b>\n\n' +
  'Comandos disponíveis:\n\n' +
  '<code>/buscar</code> — busca no ZoomEye e varre\n' +
  'Ou envie diretamente IP ou Range CIDR.',
  { parse_mode: 'HTML' }
));

bot.help(ctx => ctx.reply(
  '📖 <b>Comandos:</b>\n\n' +
  '<code>/buscar &lt;query&gt;</code> — ZoomEye + scanner',
  { parse_mode: 'HTML' }
));

bot.command('buscar', async ctx => {
  const query = ctx.message.text.replace('/buscar', '').trim() || 'video/mp2t';
  const statusMsg = await ctx.reply(`🔍 Buscando no ZoomEye: <code>${query}</code>...`, { parse_mode: 'HTML' });
  const chatId = ctx.chat.id;
  const msgId  = statusMsg.message_id;

  try {
    await bot.telegram.editMessageText(chatId, msgId, undefined, `🌐 Consultando ZoomEye para: <code>${query}</code>...`, { parse_mode: 'HTML' });
    const { ips, total } = await zoomeyeSearch(query);
    if (ips.length === 0) return bot.telegram.editMessageText(chatId, msgId, undefined, `✅ Busca concluída\n\n❌ Nenhum IP encontrado.`, { parse_mode: 'HTML' });

    await bot.telegram.editMessageText(chatId, msgId, undefined, `✅ ZoomEye: ${ips.length} IPs\n🔍 Varrendo portas...`, { parse_mode: 'HTML' });

    const allChannels = [];
    let ipsScanned = 0;
    let ipsWithStreams = 0;

    for (const ip of ips) {
      const channels = await scanIPFull(ip, chatId);
      ipsScanned++;
      if (channels.length > 0) { ipsWithStreams++; allChannels.push(...channels); }
      if (ipsScanned % 3 === 0 || ipsScanned === ips.length) {
        try { await bot.telegram.editMessageText(chatId, msgId, undefined, `🔍 Varrendo IPs...\n⏳ ${ipsScanned}/${ips.length} IPs | 📺 ${allChannels.length} streams`, { parse_mode: 'HTML' }); } catch (_) {}
      }
    }

    if (allChannels.length === 0) return bot.telegram.editMessageText(chatId, msgId, undefined, `✅ Varredura concluída\n❌ Nada encontrado.`, { parse_mode: 'HTML' });
    await bot.telegram.editMessageText(chatId, msgId, undefined, `✅ ${allChannels.length} canal(is)!\n📦 Gerando...`, { parse_mode: 'HTML' });
    await sendResults(ctx, allChannels, ips, ipsWithStreams, `ZoomEye: ${query}`);
  } catch (err) {
    await bot.telegram.editMessageText(chatId, msgId, undefined, `❌ Erro: ${err.message}`);
  }
});

bot.on('text', async ctx => {
  const input  = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (waitingForName.has(chatId)) {
    const { entries, channels, totalWithStreams } = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    const serverName = input || 'Servidor IPTV';
    await ctx.reply(`✅ Nome: <b>${serverName}</b>\n📦 Gerando arquivos...`, { parse_mode: 'HTML' });
    await sendResults(ctx, channels, entries, totalWithStreams, serverName);
    return;
  }

  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  const validEntries = lines.filter(l => isValidIP(l) || isValidCIDR(l));

  if (validEntries.length === 0) return ctx.reply('❌ Entrada inválida.', { parse_mode: 'HTML' });

  const statusMsg = await ctx.reply(`🔍 Iniciando varredura de ${validEntries.length} IP(s)...`, { parse_mode: 'HTML' });
  const msgId = statusMsg.message_id;

  try {
    const allChannels = [];
    let totalScanned = 0;
    let totalWithStreams = 0;

    for (const entry of validEntries) {
      const isCIDR = isValidCIDR(entry);
      const isIP = isValidIP(entry);
      const ips = isCIDR ? expandCIDR(entry) : [entry];

      try { await bot.telegram.editMessageText(chatId, msgId, undefined, `🔍 Varrendo <code>${entry}</code>...\n⏳ ${totalScanned}/${validEntries.length} entradas`, { parse_mode: 'HTML' }); } catch (_) {}

      if (isIP) {
        const allPorts = [];
        for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);
        const openPorts = await scanPorts(entry, allPorts, async (done, total) => {
          try { await bot.telegram.editMessageText(chatId, msgId, undefined, `🔍 Varrendo <code>${entry}</code>...\n⏳ ${done}/${total} portas`, { parse_mode: 'HTML' }); } catch (_) {}
        });
        if (openPorts.length > 0) {
          const streamResults = await Promise.all(openPorts.map(async (port, idx) => {
            const endpoint = await checkStream(entry, port);
            if (!endpoint) return null;
            await logToTelegram(chatId, `[STREAM] -> Porta: ${port}`);
            return { url: `http://${entry}:${port}${endpoint}` };
          }));
          const channels = streamResults.filter(Boolean);
          if (channels.length > 0) { totalWithStreams++; allChannels.push(...channels); }
        }
      } else {
        for (const ip of ips) {
          const channels = await scanIPFull(ip, chatId);
          if (channels.length > 0) { totalWithStreams++; allChannels.push(...channels); }
        }
      }
      totalScanned++;
    }

    if (allChannels.length === 0) return bot.telegram.editMessageText(chatId, msgId, undefined, `✅ Concluído\n❌ Nada encontrado.`, { parse_mode: 'HTML' });

    await bot.telegram.editMessageText(chatId, msgId, undefined, `✅ Varredura concluída!\n\n🖥 ${totalWithStreams} IP(s) com streams\n📺 ${allChannels.length} canais\n\n📝 <b>Qual o nome deste servidor?</b>`, { parse_mode: 'HTML' });
    waitingForName.set(chatId, { entries: validEntries, channels: allChannels, totalWithStreams });
  } catch (err) {
    await bot.telegram.editMessageText(chatId, msgId, undefined, `❌ Erro: ${err.message}`);
  }
});

bot.launch();
console.log('🤖 Bot IPTV Scanner + ZoomEye rodando...');
