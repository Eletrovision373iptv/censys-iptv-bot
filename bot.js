const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── CONFIG (lê do arquivo .env) ─────────────────────────────────────────────
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  env.split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
} catch (_) {}

const BOT_TOKEN      = process.env.BOT_TOKEN;
const VISION_API_KEY = process.env.VISION_API_KEY;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_USER    = process.env.GITHUB_USER  || 'Eletrovision373iptv';
const GITHUB_REPO    = process.env.GITHUB_REPO  || 'censys-iptv-bot';
const GITHUB_BRANCH  = 'main';

if (!BOT_TOKEN)      throw new Error('BOT_TOKEN não definido! Verifique o .env');
if (!VISION_API_KEY) throw new Error('VISION_API_KEY não definida! Verifique o .env');

const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 800;
const HTTP_TIMEOUT     = 2000;
const MAX_CONCURRENT   = 80;

const STREAM_ENDPOINTS = [
  '/live.ts', '/stream', '/stream.ts', '/live', '/video.ts', '/index.m3u8',
];

const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

// Nomes fallback se Vision não reconhecer
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
  'CINEMAX','MAX PRIME','TELECINE ACTION','DISCOVERY HOME',
  'DISCOVERY TURBO','NAT GEO WILD','DISNEY JUNIOR','DISNEY XD',
  'BOOMERANG','TOONCAST','STUDIO UNIVERSAL','FILM & ARTS','ARTE 1',
  'OFF','LIFETIME','E! ENTERTAINMENT','PEOPLE+ARTS',
];

const bot = new Telegraf(BOT_TOKEN);

// ── Google Vision API ─────────────────────────────────────────────────────────

function captureFrame(url) {
  const tmpFile = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
  try {
    spawnSync('ffmpeg', [
      '-y', '-i', url,
      '-vframes', '1',
      '-ss', '00:00:03',
      '-vf', 'scale=320:180',
      '-f', 'image2',
      tmpFile,
    ], { timeout: 15000 });
    if (fs.existsSync(tmpFile)) return tmpFile;
    return null;
  } catch (_) { return null; }
}

function analyzeFrame(imagePath) {
  return new Promise(resolve => {
    try {
      const base64 = fs.readFileSync(imagePath).toString('base64');
      const body = JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [
            { type: 'LOGO_DETECTION', maxResults: 3 },
            { type: 'TEXT_DETECTION', maxResults: 5 },
          ],
        }],
      });
      const options = {
        hostname: 'vision.googleapis.com',
        path: `/v1/images:annotate?key=${VISION_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const resp = json.responses?.[0];
            const logos = resp?.logoAnnotations || [];
            if (logos.length > 0) return resolve(logos[0].description.toUpperCase());
            const texts = resp?.textAnnotations || [];
            if (texts.length > 0) {
              const first = texts[0].description.split('\n')[0].trim().toUpperCase();
              if (first.length > 1 && first.length < 40) return resolve(first);
            }
            resolve(null);
          } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    } catch (_) { resolve(null); }
  });
}

async function detectChannelName(url) {
  const framePath = captureFrame(url);
  if (!framePath) return null;
  try {
    return await analyzeFrame(framePath);
  } finally {
    try { fs.unlinkSync(framePath); } catch (_) {}
  }
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const filePath = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  let sha = null;
  try {
    await new Promise(resolve => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${filePath}`,
        method: 'GET',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Accept': 'application/vnd.github.v3+json' },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { sha = JSON.parse(d).sha || null; } catch (_) {} resolve(); });
      });
      req.on('error', resolve);
      req.end();
    });
  } catch (_) {}

  return new Promise(resolve => {
    const body = JSON.stringify({ message: sha ? `Atualizar ${filename}` : `Adicionar ${filename}`, content: base64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${filePath}`,
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${filePath}`);
        } else { console.log('GitHub error:', d.slice(0, 200)); resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Scanner ───────────────────────────────────────────────────────────────────

function isValidIP(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(n => parseInt(n) <= 255);
}

function isValidCIDR(input) {
  const match = input.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
  if (!match) return false;
  return parseInt(input.split('/')[1]) >= 16;
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
    const finish = ok => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(CONNECT_TIMEOUT);
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
    sock.on('timeout', () => finish(false));
    sock.connect(port, ip);
  });
}

function checkStream(ip, port) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 3000);
    let idx = 0;
    function tryNext() {
      if (idx >= STREAM_ENDPOINTS.length) { clearTimeout(timer); return resolve(null); }
      const p = STREAM_ENDPOINTS[idx++];
      const req = http.get({ host: ip, port, path: p, timeout: HTTP_TIMEOUT }, res => {
        res.destroy();
        if (res.statusCode < 500) { clearTimeout(timer); resolve(p); }
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

// ── Log em tempo real no Telegram ─────────────────────────────────────────────
const logBuffer = new Map();

async function logToTelegram(chatId, line) {
  console.log(line);
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
    await bot.telegram.sendMessage(chatId, '```\n' + msg + '\n```', { parse_mode: 'Markdown' });
  } catch (_) {}
}

// ── Scan completo de um IP com Vision ─────────────────────────────────────────
async function scanIPFull(ip, chatId = null, useVision = false) {
  const allPorts = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);
  const openPorts = await scanPorts(ip, allPorts, null);
  if (openPorts.length === 0) return [];

  const results = await Promise.all(openPorts.map(async (port, idx) => {
    const endpoint = await checkStream(ip, port);
    if (!endpoint) return null;
    const url = `http://${ip}:${port}${endpoint}`;
    const quality = endpoint.includes('.ts') ? 'FHD' : 'HD';

    let name = null;
    if (useVision) {
      name = await detectChannelName(url);
    }
    if (!name) name = CHANNEL_NAMES[idx % CHANNEL_NAMES.length];

    await logToTelegram(chatId, `[${quality}] -> ${name} (Porta: ${port})`);
    return { name, url };
  }));
  return results.filter(Boolean);
}

// ── Build M3U / TXT ───────────────────────────────────────────────────────────

function buildM3U(channels, serverName, scanDate) {
  let m3u = `#EXTM3U url-tvg="" tvg-shift=0 cache=500\n`;
  m3u += `# Servidor: ${serverName}\n# Scan: ${scanDate}\n\n`;
  channels.forEach((ch, i) => {
    m3u += `#EXTINF:-1 tvg-id="${ch.name}" tvg-name="${ch.name}" tvg-logo="${LOGO_URL}" group-title="${serverName}",[FHD] ${ch.name} ${i + 1}\n`;
    m3u += `${ch.url}\n`;
  });
  return m3u;
}

function buildTXT(channels, serverName, scanDate) {
  let txt = `Servidor: ${serverName}\nScan: ${scanDate}\nTotal: ${channels.length} canais\n\n`;
  channels.forEach((ch, i) => {
    txt += `${ch.url}\n#EXTINF:-1,[FHD] ${ch.name} ${i + 1}\n`;
  });
  return txt;
}

function buildListText(channels) {
  return channels.map((ch, i) => `#EXTINF:-1,[FHD] ${ch.name} ${i + 1}\n${ch.url}`).join('\n');
}

// ── Enviar resultados ─────────────────────────────────────────────────────────
async function sendResults(ctx, channels, validEntries, totalWithStreams, serverName) {
  const scanDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const m3u = buildM3U(channels, serverName, scanDate);
  const txt = buildTXT(channels, serverName, scanDate);
  const listText = buildListText(channels);

  const safeName = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  const filenameM3U = `${safeName}.m3u`;
  const filenameTXT = `${safeName}.txt`;

  const header =
    `🛰 *${serverName}*\n📅 ${scanDate}\n\n` +
    `🔍 ${validEntries.length} IP(s) verificado(s)\n` +
    `🖥 ${totalWithStreams} IP(s) com streams\n` +
    `📺 ${channels.length} canal(is) encontrado(s)\n\n`;

  const preview = listText.split('\n').slice(0, 30).join('\n');
  await ctx.reply(
    header + '```\n' + preview + (channels.length > 15 ? '\n...' : '') + '\n```',
    { parse_mode: 'Markdown' }
  );

  const [githubUrl] = await Promise.all([
    saveToGitHub(filenameM3U, m3u),
    ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename: filenameM3U }),
    ctx.replyWithDocument({ source: Buffer.from(txt, 'utf-8'), filename: filenameTXT }),
  ]);

  if (githubUrl) {
    await ctx.reply(
      `✅ *Playlist salva no GitHub!*\n\n🔗 Link para o player:\n\`${githubUrl}\`\n\n_Próximo scan atualiza automaticamente._`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ── Bot handlers ──────────────────────────────────────────────────────────────

bot.start(ctx => ctx.reply(
  '🛰 *Bot IPTV Scanner + Vision*\n\n' +
  'Envie o nome do servidor na primeira linha e os IPs abaixo:\n\n' +
  '```\nSTAR BR\n89.187.190.183\n107.150.59.42\n```\n\n' +
  'Ou range CIDR:\n```\nBRASIL IPTV\n89.187.190.0/24\n```',
  { parse_mode: 'Markdown' }
));

bot.on('text', async ctx => {
  const input  = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // ── Extrai linhas ─────────────────────────────────────────────────────────
  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);

  // Primeira linha é o nome se não for IP/CIDR
  let serverName = 'Servidor IPTV';
  let entryLines = lines;

  if (lines.length > 0 && !isValidIP(lines[0]) && !isValidCIDR(lines[0])) {
    serverName = lines[0];
    entryLines = lines.slice(1);
  }

  const validEntries = entryLines.filter(l => isValidIP(l) || isValidCIDR(l));

  if (validEntries.length === 0) {
    return ctx.reply(
      '❌ Nenhum IP encontrado.\n\nFormato correto:\n```\nNOME DO SERVIDOR\n89.187.190.183\n107.150.59.42\n```',
      { parse_mode: 'Markdown' }
    );
  }

  const statusMsg = await ctx.reply(
    `🛰 *${serverName}*\n🔍 Iniciando varredura de ${validEntries.length} IP(s)...`,
    { parse_mode: 'Markdown' }
  );
  const msgId = statusMsg.message_id;

  try {
    const allChannels = [];
    let totalScanned = 0;
    let totalWithStreams = 0;

    for (const entry of validEntries) {
      const isCIDR = isValidCIDR(entry);
      const isIP   = isValidIP(entry);

      try {
        await bot.telegram.editMessageText(chatId, msgId, undefined,
          `🛰 *${serverName}*\n🔍 Varrendo \`${entry}\`...\n⏳ ${totalScanned}/${validEntries.length} | 📺 ${allChannels.length} streams`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) {}

      if (isIP) {
        const allPorts = [];
        for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);

        const openPorts = await scanPorts(entry, allPorts, async (done, total) => {
          try {
            await bot.telegram.editMessageText(chatId, msgId, undefined,
              `🛰 *${serverName}*\n🔍 Varrendo \`${entry}\`...\n⏳ ${done}/${total} portas | 📺 ${allChannels.length} streams`,
              { parse_mode: 'Markdown' }
            );
          } catch (_) {}
        });

        if (openPorts.length > 0) {
          const streamResults = await Promise.all(openPorts.map(async (port, idx) => {
            const endpoint = await checkStream(entry, port);
            if (!endpoint) return null;
            const url = `http://${entry}:${port}${endpoint}`;
            const quality = endpoint.includes('.ts') ? 'FHD' : 'HD';
            const name = CHANNEL_NAMES[idx % CHANNEL_NAMES.length];
            await logToTelegram(chatId, `[${quality}] -> ${name} (Porta: ${port})`);
            return { name, url };
          }));
          const channels = streamResults.filter(Boolean);
          if (channels.length > 0) { totalWithStreams++; allChannels.push(...channels); }
        }
      } else {
        const ips = expandCIDR(entry);
        for (const ip of ips) {
          const channels = await scanIPFull(ip, chatId, false);
          if (channels.length > 0) { totalWithStreams++; allChannels.push(...channels); }
        }
      }
      totalScanned++;
    }

    if (allChannels.length === 0) {
      return bot.telegram.editMessageText(chatId, msgId, undefined,
        `✅ Concluído — *${serverName}*\n\n🔍 ${validEntries.length} IP(s) verificados\n❌ Nenhum stream encontrado`,
        { parse_mode: 'Markdown' }
      );
    }

    await bot.telegram.editMessageText(chatId, msgId, undefined,
      `✅ *${serverName}*\n\n📺 ${allChannels.length} canal(is) encontrado(s)\n🔎 Identificando nomes via Vision...`,
      { parse_mode: 'Markdown' }
    );

    // Identifica nomes via Google Vision
    for (let i = 0; i < allChannels.length; i++) {
      try {
        await bot.telegram.editMessageText(chatId, msgId, undefined,
          `🔎 *${serverName}*\nIdentificando canal ${i + 1}/${allChannels.length}...`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) {}
      const detected = await detectChannelName(allChannels[i].url);
      if (detected) allChannels[i].name = detected;
    }

    await sendResults(ctx, allChannels, validEntries, totalWithStreams, serverName);

  } catch (err) {
    console.error(err);
    await bot.telegram.editMessageText(chatId, msgId, undefined, `❌ Erro: ${err.message}`);
  }
});

bot.launch();
console.log('🤖 Bot IPTV Scanner + Vision rodando no Termux...');
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
