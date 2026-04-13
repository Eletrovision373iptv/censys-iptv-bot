const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- CONFIGURAÇÕES ---
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  env.split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
} catch (_) {}

const BOT_TOKEN      = process.env.BOT_TOKEN;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_USER    = process.env.GITHUB_USER  || 'Eletrovision373iptv';
const GITHUB_REPO    = process.env.GITHUB_REPO  || 'censys-iptv-bot';
const LOGO_URL       = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = ['ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY','HBO','TNT','GNT','MULTISHOW'];

const bot = new Telegraf(BOT_TOKEN);

// --- FUNÇÕES AUXILIARES ---

function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(1000); // Tempo para não perder porta lenta
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

async function checkStream(ip, port) {
  return new Promise(r => {
    const req = http.get({ host: ip, port, path: '/live.ts', timeout: 2500 }, res => { 
      res.destroy(); 
      r(res.statusCode < 500 ? '/live.ts' : null); 
    });
    req.on('error', () => r(null));
  });
}

async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return;
  const filePath = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  const body = JSON.stringify({ message: `Update ${filename}`, content: base64, branch: 'main' });
  
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${filePath}`,
    method: 'PUT',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Content-Type': 'application/json' }
  };

  const req = https.request(options);
  req.write(body);
  req.end();
}

// --- SCANNER ---

async function realizarScanCompleto(ctx, serverName, ips) {
  const status = await ctx.reply(`🛰 <b>${serverName}</b>\n🔎 Iniciando busca profunda...`, { parse_mode: 'HTML' });
  const allChannels = [];

  for (const ip of ips) {
    for (let p = 0; p <= 3000; p++) {
      const actualPort = 14000 + p;
      
      if (p % 20 === 0 || p === 3000) {
        let text = `🛰 <b>${serverName}</b>\n🌐 IP: <code>${ip}</code>\n🔍 Scan: ${p}/3000\n📺 Achados: ${allChannels.length}`;
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, text, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (await checkPort(ip, actualPort)) {
        const endpoint = await checkStream(ip, actualPort);
        if (endpoint) {
          const baseName = CHANNEL_NAMES[allChannels.length % CHANNEL_NAMES.length];
          const count = allChannels.length + 1;
          const channelNameWithNum = `${baseName} ${count}`; // Nome + Número
          
          allChannels.push({ 
            name: channelNameWithNum, 
            url: `http://${ip}:${actualPort}${endpoint}`, 
            port: actualPort 
          });
          console.log(`[OK] ${channelNameWithNum}`);
        }
      }
    }
  }

  if (allChannels.length === 0) {
    return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, "❌ Nenhum canal encontrado no IP.");
  }

  // GERAÇÃO DOS ARQUIVOS E PRÉVIA
  const safeName = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  let m3u = `#EXTM3U\n`;
  let txt = `SERVER: ${serverName}\n\n`;
  let finalPreview = `✅ <b>${serverName} - FINALIZADO</b>\n\n`;
  
  allChannels.forEach((ch, i) => {
    m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",${ch.name}\n${ch.url}\n`;
    txt += `${ch.url}\n`;
    if (i < 15) finalPreview += `📺 ${ch.name} (${ch.port})\n`;
  });

  if (allChannels.length > 15) finalPreview += `\n... e mais ${allChannels.length - 15} canais no arquivo.`;

  // FINALIZAÇÃO
  await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, finalPreview, { parse_mode: 'HTML' });
  await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${safeName}.m3u` });
  await ctx.replyWithDocument({ source: Buffer.from(txt), filename: `${safeName}.txt` });
  
  // Salva no GitHub
  saveToGitHub(`${safeName}.m3u`, m3u);
}

bot.on('text', (ctx) => {
  const lines = ctx.message.text.trim().split('\n').map(l => l.trim());
  let serverName = lines[0];
  let ips = lines.filter(l => /^(\d{1,3}\.){3}\d{1,3}$/.test(l));

  if (ips.length > 0) {
    realizarScanCompleto(ctx, serverName, ips).catch(console.error);
  }
});

bot.launch({ handlerTimeout: 0 });
console.log('🤖 Bot Completo Online (M3U + TXT + GitHub + Nomes Numerados)');
