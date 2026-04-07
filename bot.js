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

const PORT = process.env.PORT || 3000;
const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 500;
const MAX_CONCURRENT   = 60; // Equilíbrio para o Termux

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = ['ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','HBO','TELECINE'];

const waitingForName = new Map(); 
const bot = new Telegraf(BOT_TOKEN);

http.createServer((req, res) => { res.writeHead(200); res.end('Bot Online'); }).listen(PORT);

// ── Funções Auxiliares ───────────────────────────────────────────────────────

function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    sock.setTimeout(CONNECT_TIMEOUT);
    sock.on('connect', () => { if(!done){ done=true; sock.destroy(); resolve(true); }});
    const fail = () => { if(!done){ done=true; sock.destroy(); resolve(false); }};
    sock.on('error', fail); sock.on('timeout', fail);
    sock.connect(port, ip);
  });
}

async function checkStream(ip, port) {
  for (const p of STREAM_ENDPOINTS) {
    try {
      const found = await new Promise((resolve) => {
        const req = http.get({ host: ip, port, path: p, timeout: 1000 }, res => {
          res.destroy();
          resolve(res.statusCode < 400 ? p : null);
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (found) return found;
    } catch(e) {}
  }
  return null;
}

// ── Lógica de Varredura ─────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  if (waitingForName.has(chatId)) {
    const data = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    const serverName = input || 'Servidor';
    const filename = `${serverName.replace(/\s+/g, '_')}.m3u`;

    let m3u = `#EXTM3U\n`;
    data.channels.forEach((ch, i) => {
      const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
    });

    // Prévia de 20 canais
    let preview = `🛰 *${serverName}*\n\n*--- PRÉVIA ---*\n\`\`\`\n`;
    data.channels.slice(0, 20).forEach((ch, i) => {
      preview += `[FHD] ${CHANNEL_NAMES[i % CHANNEL_NAMES.length]} ${i+1}\n${ch.url}\n`;
    });
    preview += `\`\`\``;

    await ctx.reply(preview, { parse_mode: 'Markdown' });
    await ctx.replyWithDocument({ source: Buffer.from(m3u), filename });
    return;
  }

  const ips = input.split('\n').map(i => i.trim()).filter(i => /^\d/.test(i));
  if (ips.length === 0) return;

  const msg = await ctx.reply(`🔎 Iniciando scan em ${ips.length} IPs...`);
  const allChannels = [];

  for (const ip of ips) {
    const ports = [];
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) ports.push(p);

    // Varredura com contador de portas (IGUAL ANTES)
    for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
      const chunk = ports.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(chunk.map(p => checkPort(ip, p)));
      
      for (let j = 0; j < chunk.length; j++) {
        if (results[j]) {
          const endpoint = await checkStream(ip, chunk[j]);
          if (endpoint) allChannels.push({ url: `http://${ip}:${chunk[j]}${endpoint}` });
        }
      }

      // ATUALIZA O TELEGRAM A CADA 200 PORTAS
      if (i % 200 === 0) {
        try {
          await bot.telegram.editMessageText(chatId, msg.message_id, null, 
            `⏳ IP: ${ip}\n🔍 Portas: ${i}/${ports.length}\n📺 Canais: ${allChannels.length}`);
        } catch(e) {}
      }
    }
  }

  if (allChannels.length === 0) return ctx.reply('❌ Nenhum canal ativo.');

  await ctx.reply(`✅ Scan Finalizado!\n📺 Total: ${allChannels.length}\n\n📝 *Qual o nome do servidor?*`, { parse_mode: 'Markdown' });
  waitingForName.set(chatId, { channels: allChannels });
});

bot.launch();
