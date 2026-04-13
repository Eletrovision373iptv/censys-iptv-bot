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

const PORT_START = 14000;
const PORT_END   = 17000;
const MAX_CONCURRENT = 50; 
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = ['ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY'];

const bot = new Telegraf(BOT_TOKEN);

function captureFrame(url) {
  const tmpFile = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
  try {
    spawnSync('ffmpeg', ['-y', '-i', url, '-vframes', '1', '-ss', '00:00:03', '-vf', 'scale=320:180', '-f', 'image2', tmpFile], { timeout: 10000 });
    return fs.existsSync(tmpFile) ? tmpFile : null;
  } catch (_) { return null; }
}

async function analyzeFrame(imagePath) {
  return new Promise(resolve => {
    try {
      const base64 = fs.readFileSync(imagePath).toString('base64');
      const body = JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: 'LOGO_DETECTION', maxResults: 1 }, { type: 'TEXT_DETECTION', maxResults: 1 }] }]
      });
      const options = { hostname: 'vision.googleapis.com', path: `/v1/images:annotate?key=${VISION_API_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } };
      const req = https.request(options, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            const logo = json.responses?.[0]?.logoAnnotations?.[0]?.description;
            const text = json.responses?.[0]?.textAnnotations?.[0]?.description?.split('\n')[0];
            resolve(logo || text || null);
          } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null)); req.write(body); req.end();
    } catch (_) { resolve(null); }
  });
}

function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

async function checkStream(ip, port) {
  const p = '/live.ts';
  return new Promise(r => {
    const req = http.get({ host: ip, port, path: p, timeout: 1500 }, res => { res.destroy(); r(res.statusCode < 500 ? p : null); });
    req.on('error', () => r(null));
  });
}

bot.on('text', async ctx => {
  const lines = ctx.message.text.trim().split('\n').map(l => l.trim());
  let serverName = lines[0];
  let ips = lines.filter(l => /^(\d{1,3}\.){3}\d{1,3}$/.test(l));
  if (ips.length === 0) return;

  const status = await ctx.reply(`🛰 <b>${serverName}</b>\n🔎 Iniciando...`, { parse_mode: 'HTML' });
  const allChannels = [];

  for (const ip of ips) {
    for (let p = 0; p <= 3000; p++) {
      const actualPort = PORT_START + p;
      
      // Atualiza a mesma mensagem com progresso e canais achados
      if (p % 50 === 0 || p === 3000) {
        let text = `🛰 <b>${serverName}</b>\n🌐 IP: <code>${ip}</code>\n🔍 Scan: ${p}/3000\n📺 Canais: ${allChannels.length}\n\n`;
        // Mostra os últimos 5 canais achados no status pra você ver subindo
        allChannels.slice(-5).forEach(c => text += `✅ ${c.name} (${c.port})\n`);
        
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, text, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (await checkPort(ip, actualPort)) {
        const endpoint = await checkStream(ip, actualPort);
        if (endpoint) {
          const url = `http://${ip}:${actualPort}${endpoint}`;
          const frame = captureFrame(url);
          const name = frame ? await analyzeFrame(frame) : null;
          if (frame) fs.unlinkSync(frame);
          allChannels.push({ name: (name || `CANAL ${allChannels.length + 1}`).toUpperCase(), url, port: actualPort });
        }
      }
    }
  }

  // PRÉVIA FINAL DE 15 LINHAS
  let m3u = `#EXTM3U\n`;
  let finalPreview = `✅ <b>${serverName} - FINALIZADO</b>\n\n`;
  
  allChannels.forEach((ch, i) => {
    m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",${ch.name}\n${ch.url}\n`;
    if (i < 15) finalPreview += `📺 ${ch.name}\n`;
  });

  if (allChannels.length > 15) finalPreview += `\n... e mais ${allChannels.length - 15} canais.`;

  await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, finalPreview, { parse_mode: 'HTML' });
  await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${serverName}.m3u` });
});

bot.launch();
console.log('🤖 Scanner dinâmico (0-3000) online.');
