const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
  'COMBATE','PARAMOUNT','UNIVERSAL','SyFy','AXN','FOX','FX','SPACE',
  'HISTORY','NATIONAL GEOGRAPHIC','ANIMAL PLANET','DISCOVERY SCIENCE',
  'CARTOON NETWORK','DISNEY CHANNEL','NICKELODEON','COMEDY CENTRAL',
  'VH1','MTV','BIS','VIVA','TV CULTURA','TV BRASIL','REDE TV',
  'GAZETA','JOVEM PAN NEWS','RECORD NEWS','GLOBONEWS','BAND NEWS'
];

const bot = new Telegraf(BOT_TOKEN);

function captureFrame(url) {
  const tmpFile = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
  try {
    spawnSync('ffmpeg', ['-y', '-i', url, '-vframes', '1', '-ss', '00:00:03', '-vf', 'scale=320:180', '-f', 'image2', tmpFile], { timeout: 15000 });
    return fs.existsSync(tmpFile) ? tmpFile : null;
  } catch (_) { return null; }
}

function analyzeFrame(imagePath) {
  return new Promise(resolve => {
    try {
      const base64 = fs.readFileSync(imagePath).toString('base64');
      const body = JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: 'LOGO_DETECTION', maxResults: 3 }, { type: 'TEXT_DETECTION', maxResults: 5 }] }]
      });
      const options = { hostname: 'vision.googleapis.com', path: `/v1/images:annotate?key=${VISION_API_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } };
      const req = https.request(options, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            const logos = json.responses?.[0]?.logoAnnotations || [];
            if (logos.length > 0) return resolve(logos[0].description.toUpperCase());
            const texts = json.responses?.[0]?.textAnnotations || [];
            if (texts.length > 0) resolve(texts[0].description.split('\n')[0].trim().toUpperCase());
            else resolve(null);
          } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null)); req.write(body); req.end();
    } catch (_) { resolve(null); }
  });
}

async function detectChannelName(url) {
  const framePath = captureFrame(url);
  if (!framePath) return null;
  try { return await analyzeFrame(framePath); } finally { try { fs.unlinkSync(framePath); } catch (_) {} }
}

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const filePath = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  const body = JSON.stringify({ message: `Atualizar ${filename}`, content: base64, branch: GITHUB_BRANCH });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${filePath}`,
      method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Content-Type': 'application/json' }
    }, res => resolve(res.statusCode <= 201 ? `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${filePath}` : null));
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

function isValidIP(ip) { return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip); }
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

async function checkStream(ip, port) {
  for (const p of STREAM_ENDPOINTS) {
    const ok = await new Promise(r => {
      const req = http.get({ host: ip, port, path: p, timeout: HTTP_TIMEOUT }, res => { res.destroy(); r(res.statusCode < 500); });
      req.on('error', () => r(false));
    });
    if (ok) return p;
  }
  return null;
}

bot.on('text', async ctx => {
  const lines = ctx.message.text.trim().split('\n').map(l => l.trim());
  let serverName = !isValidIP(lines[0]) ? lines[0] : "SERVIDOR";
  let ips = lines.filter(l => isValidIP(l));
  if (ips.length === 0) return;

  const status = await ctx.reply(`🛰 *${serverName}*\n🔍 Iniciando scan...`, { parse_mode: 'Markdown' });
  const allChannels = [];

  try {
    for (const ip of ips) {
      for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
        // Atualiza apenas a mensagem de status (sem mandar novas mensagens)
        if (p % 100 === 0) {
          await bot.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `🛰 *${serverName}*\n🌐 IP: ${ip}\n🔍 Porta: ${p}/17000\n📺 Achados: ${allChannels.length}`).catch(()=>{});
        }
        if (await checkPort(ip, p)) {
          const endpoint = await checkStream(ip, p);
          if (endpoint) {
            const url = `http://${ip}:${p}${endpoint}`;
            const name = (await detectChannelName(url)) || CHANNEL_NAMES[allChannels.length % CHANNEL_NAMES.length];
            allChannels.push({ name, url });
            // Log apenas no console do Termux para não poluir o Telegram
            console.log(`[ACHADO] -> ${name} (${p})`);
          }
        }
      }
    }

    if (allChannels.length === 0) return ctx.reply("❌ Nada encontrado.");

    const safe = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
    let m3u = `#EXTM3U\n`;
    let txt = `SERVER: ${serverName}\n\n`;
    let preview = `✅ *${serverName} - FINALIZADO*\n\n`;

    allChannels.forEach((ch, i) => {
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",${ch.name}\n${ch.url}\n`;
      txt += `${ch.url}\n`;
      if (i < 15) preview += `📺 ${ch.name}\n`;
    });

    if (allChannels.length > 15) preview += `\n... e mais ${allChannels.length - 15} canais.`;

    await ctx.reply(preview, { parse_mode: 'Markdown' });
    await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${safe}.m3u` });
    await ctx.replyWithDocument({ source: Buffer.from(txt), filename: `${safe}.txt` });
    saveToGitHub(`${safe}.m3u`, m3u);

  } catch (err) { console.error(err); }
});

bot.launch();
console.log('🤖 Bot IPTV Online...');
