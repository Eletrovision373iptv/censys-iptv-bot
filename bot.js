const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 400; // Mais rápido para não segurar o loop
const MAX_CONCURRENT   = 40;  // Segurança total para o Termux não travar

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';
const CHANNEL_NAMES = ['ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','HBO','TELECINE','MULTISHOW','GNT','TNT'];

const waitingForName = new Map(); 
const bot = new Telegraf(BOT_TOKEN);

// Server simplificado para evitar erro de porta no Termux
http.createServer((req, res) => { res.end('OK'); }).listen(PORT);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Funções de Rede ──────────────────────────────────────────────────────────

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
    const found = await new Promise((resolve) => {
      const req = http.get({ host: ip, port, path: p, timeout: 800 }, res => {
        res.destroy();
        resolve(res.statusCode < 400 ? p : null);
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (found) return found;
  }
  return null;
}

// ── Handler Principal ───────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // RESPOSTA DO NOME DO SERVIDOR
  if (waitingForName.has(chatId)) {
    const data = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    
    const serverName = input.substring(0, 30) || 'Servidor';
    const filename = `${serverName.replace(/\s+/g, '_')}.m3u`;

    let m3u = `#EXTM3U\n# Servidor: ${serverName}\n`;
    let preview = `🛰 *${serverName}*\n\n*--- PRÉVIA ---*\n\`\`\`\n`;

    data.channels.forEach((ch, i) => {
      const name = CHANNEL_NAMES[i % CHANNEL_NAMES.length];
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
      if (i < 20) preview += `[FHD] ${name} ${i+1}\n${ch.url}\n`;
    });

    if (data.channels.length > 20) preview += `\n... (+ ${data.channels.length - 20} canais)`;
    preview += `\n\`\`\``;

    await ctx.reply(preview, { parse_mode: 'Markdown' });
    await ctx.replyWithDocument({ source: Buffer.from(m3u), filename });
    return;
  }

  // RECEBIMENTO DE IPS
  const ips = input.split('\n').map(i => i.trim()).filter(i => /^\d/.test(i));
  if (ips.length === 0) return;

  const msg = await ctx.reply(`🔎 Iniciando scan em ${ips.length} IPs...`);
  const allChannels = [];

  for (const ip of ips) {
    const ports = Array.from({length: (PORT_RANGE_END - PORT_RANGE_START + 1)}, (_, i) => PORT_RANGE_START + i);

    for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
      const chunk = ports.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(chunk.map(p => checkPort(ip, p)));
      
      for (let j = 0; j < chunk.length; j++) {
        if (results[j]) {
          const endpoint = await checkStream(ip, chunk[j]);
          if (endpoint) allChannels.push({ url: `http://${ip}:${chunk[j]}${endpoint}` });
        }
      }

      // Atualiza o Telegram e dá uma pausa para o sistema respirar
      if (i % 240 === 0) {
        try {
          await bot.telegram.editMessageText(chatId, msg.message_id, null, 
            `⏳ IP: ${ip}\n🔍 Portas: ${i}/${ports.length}\n📺 Canais: ${allChannels.length}`);
          await sleep(50); // PAUSA CRUCIAL
        } catch(e) {}
      }
    }
  }

  if (allChannels.length === 0) {
    return ctx.reply('❌ Nenhum canal ativo encontrado nos IPs enviados.');
  }

  await ctx.reply(`✅ Scan Finalizado!\n📺 Total: ${allChannels.length}\n\n📝 *Qual o nome do servidor?*`, { parse_mode: 'Markdown' });
  waitingForName.set(chatId, { channels: allChannels });
});

bot.launch().then(() => console.log('🤖 Bot Estável no Termux!'));
