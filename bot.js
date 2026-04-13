const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  env.split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
} catch (_) {}

const BOT_TOKEN = process.env.BOT_TOKEN;
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';
const CHANNEL_NAMES = ['ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY','HBO','TNT','GNT','MULTISHOW','AXN','SPACE','VIVA'];

const bot = new Telegraf(BOT_TOKEN);

function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(800); 
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

async function checkStream(ip, port) {
  return new Promise(r => {
    const req = http.get({ host: ip, port, path: '/live.ts', timeout: 2000 }, res => { 
      res.destroy(); 
      r(res.statusCode < 500 ? '/live.ts' : null); 
    });
    req.on('error', () => r(null));
  });
}

// FUNÇÃO DE SCAN SEPARADA PARA NÃO TRAVAR O BOT
async function realizarScan(ctx, serverName, ips) {
  const status = await ctx.reply(`🛰 <b>${serverName}</b>\n🔎 Preparando...`, { parse_mode: 'HTML' });
  const allChannels = [];

  for (const ip of ips) {
    for (let p = 0; p <= 3000; p++) {
      const actualPort = 14000 + p;
      
      // Atualiza a contagem a cada 25 portas para ser preciso
      if (p % 25 === 0 || p === 3000) {
        let text = `🛰 <b>${serverName}</b>\n🌐 IP: <code>${ip}</code>\n🔍 Scan: ${p}/3000\n📺 Achados: ${allChannels.length}`;
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, text, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (await checkPort(ip, actualPort)) {
        const endpoint = await checkStream(ip, actualPort);
        if (endpoint) {
          const name = CHANNEL_NAMES[allChannels.length % CHANNEL_NAMES.length];
          allChannels.push({ name, url: `http://${ip}:${actualPort}${endpoint}`, port: actualPort });
          console.log(`[ACHADO] ${name} na porta ${actualPort}`);
        }
      }
    }
  }

  if (allChannels.length === 0) {
    return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, "❌ Nenhum canal encontrado.");
  }

  // PRÉVIA FINAL 15 LINHAS
  let m3u = `#EXTM3U\n`;
  let finalPreview = `✅ <b>${serverName} - FINALIZADO</b>\n\n`;
  
  allChannels.forEach((ch, i) => {
    m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",${ch.name}\n${ch.url}\n`;
    if (i < 15) finalPreview += `📺 ${ch.name} (${ch.port})\n`;
  });

  if (allChannels.length > 15) finalPreview += `\n... e mais ${allChannels.length - 15} canais.`;

  await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, finalPreview, { parse_mode: 'HTML' });
  await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${serverName}.m3u` });
}

bot.on('text', (ctx) => {
  const lines = ctx.message.text.trim().split('\n').map(l => l.trim());
  let serverName = lines[0];
  let ips = lines.filter(l => /^(\d{1,3}\.){3}\d{1,3}$/.test(l));

  if (ips.length > 0) {
    // AQUI É O SEGREDO: chama a função sem o "await" para o bot não travar
    realizarScan(ctx, serverName, ips).catch(err => console.error(err));
  }
});

bot.launch({ handlerTimeout: 0 });
console.log('🤖 Bot Online - Scan 0-3000 sem travas.');
