const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
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
const GITHUB_USER    = process.env.GITHUB_USER;
const GITHUB_REPO    = process.env.GITHUB_REPO;

const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const MAX_CONCURRENT   = 40; 
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const bot = new Telegraf(BOT_TOKEN);

// ── Vision & FFmpeg ──────────────────────────────────────────────────────────
function captureFrame(url) {
  const tmpFile = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
  try {
    spawnSync('ffmpeg', [
      '-y', '-timeout', '5000000', '-i', url,
      '-vframes', '1', '-ss', '00:00:02', '-vf', 'scale=320:180',
      '-f', 'image2', tmpFile
    ], { timeout: 8000 });
    return fs.existsSync(tmpFile) ? tmpFile : null;
  } catch (_) { return null; }
}

async function analyzeFrame(imagePath) {
  return new Promise(resolve => {
    try {
      const base64 = fs.readFileSync(imagePath).toString('base64');
      const body = JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: 'LOGO_DETECTION', maxResults: 1 }, { type: 'TEXT_DETECTION', maxResults: 1 }]
        }]
      });
      const options = {
        hostname: 'vision.googleapis.com',
        path: `/v1/images:annotate?key=${VISION_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      };
      const req = https.request(options, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            const logo = json.responses[0]?.logoAnnotations?.[0]?.description;
            const text = json.responses[0]?.textAnnotations?.[0]?.description?.split('\n')[0];
            resolve(logo || text || null);
          } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(body); req.end();
    } catch (_) { resolve(null); }
  });
}

// ── Funções de Rede ──────────────────────────────────────────────────────────
function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(450);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

async function checkStream(ip, port) {
  const endpoints = ['/live.ts', '/stream', '/live'];
  for (const p of endpoints) {
    const ok = await new Promise(r => {
      const req = http.get({ host: ip, port, path: p, timeout: 1200 }, res => {
        res.destroy(); r(res.statusCode < 400);
      });
      req.on('error', () => r(false));
    });
    if (ok) return p;
  }
  return null;
}

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;
  const pathFile = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  const body = JSON.stringify({ message: `Update ${filename}`, content: base64 });
  const opt = {
    hostname: 'api.github.com', path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${pathFile}`,
    method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Content-Type': 'application/json' }
  };
  return new Promise(resolve => {
    const req = https.request(opt, res => resolve(res.statusCode <= 201 ? `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/${pathFile}` : null));
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

// ── Handler Principal ────────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const lines = ctx.message.text.trim().split('\n').map(l => l.trim());
  let serverName = !/^\d/.test(lines[0]) ? lines[0] : "SERVIDOR_IPTV";
  let ips = lines.filter(l => /^(\d{1,3}\.){3}\d{1,3}/.test(l));

  if (ips.length === 0) return;

  const status = await ctx.reply(`🛰 <b>${serverName}</b>\n🔎 Preparando scan...`, { parse_mode: 'HTML' });
  const results = [];

  try {
    for (let ipIdx = 0; ipIdx < ips.length; ipIdx++) {
      const ip = ips[ipIdx];
      const ports = Array.from({length: 3001}, (_, i) => 14000 + i);

      for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
        const chunk = ports.slice(i, i + MAX_CONCURRENT);
        const open = await Promise.all(chunk.map(p => checkPort(ip, p)));
        
        for (let j = 0; j < chunk.length; j++) {
          if (open[j]) {
            const pathUrl = await checkStream(ip, chunk[j]);
            if (pathUrl) {
              const url = `http://${ip}:${chunk[j]}${pathUrl}`;
              const frame = captureFrame(url);
              const name = frame ? (await analyzeFrame(frame)) : null;
              if (frame && fs.existsSync(frame)) fs.unlinkSync(frame);
              results.push({ url, name: (name || `CANAL ${results.length + 1}`).toUpperCase() });
            }
          }
        }

        // Atualização visual do progresso
        if (i % 200 === 0) {
          await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, 
            `🛰 <b>${serverName}</b>\n🌐 IP: <code>${ip}</code> (${ipIdx + 1}/${ips.length})\n🔍 Portas: ${i}/3000\n📺 Canais: <b>${results.length}</b>`, 
            { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }

    if (results.length === 0) {
      return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, "❌ Nenhum canal encontrado.");
    }

    const safe = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
    let m3u = `#EXTM3U\n`;
    let txt = `SERVER: ${serverName}\nTOTAL: ${results.length}\n\n`;
    let preview = `<b>✅ FINALIZADO: ${serverName}</b>\n<pre>`;

    results.forEach((res, i) => {
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",${res.name}\n${res.url}\n`;
      txt += `${res.url}\n`;
      if (i < 20) preview += `${res.name}\n`;
    });

    if (results.length > 20) preview += `\n... + ${results.length - 20} canais`;
    preview += `</pre>`;

    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, preview, { parse_mode: 'HTML' });
    
    await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${safe}.m3u` });
    await ctx.replyWithDocument({ source: Buffer.from(txt), filename: `${safe}.txt` });
    
    const githubLink = await saveToGitHub(`${safe}.m3u`, m3u);
    if (githubLink) ctx.reply(`🔗 <b>GitHub:</b> <code>${githubLink}</code>`, { parse_mode: 'HTML' });

  } catch (err) {
    console.error(err);
    ctx.reply("❌ Ocorreu um erro crítico no scan.");
  }
});

bot.launch();
console.log('🤖 Bot Online com Contador Visual ativado.');
