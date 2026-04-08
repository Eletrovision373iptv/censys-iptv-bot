const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = 'Eletrovision373iptv';
const GITHUB_REPO  = 'censys-iptv-bot';

const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 400;
const MAX_CONCURRENT   = 40; 

const STREAM_ENDPOINTS = ['/live.ts', '/stream', '/live', '/index.m3u8'];
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';
const CHANNEL_NAMES = ['ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','HBO','TELECINE','MULTISHOW','GNT','TNT'];

const waitingForName = new Map(); 
const bot = new Telegraf(BOT_TOKEN);

http.createServer((req, res) => { res.end('OK'); }).listen(process.env.PORT || 3000);
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

async function saveToGitHub(path, content) {
  if (!GITHUB_TOKEN) return null;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  let sha = null;
  try {
    const getOptions = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Accept': 'application/vnd.github.v3+json' }
    };
    await new Promise(res => {
      https.get(getOptions, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { sha = JSON.parse(d).sha; } catch(e){} res(); });
      }).on('error', res);
    });
  } catch(e){}

  return new Promise(resolve => {
    const body = JSON.stringify({ message: `Update ${path}`, content: base64, sha });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'iptv-bot', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      if (res.statusCode <= 201) resolve(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/${path}`);
      else resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Handler Principal ───────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // SALVAR COM NOME DO SERVIDOR
  if (waitingForName.has(chatId)) {
    const data = waitingForName.get(chatId);
    waitingForName.delete(chatId);
    
    const serverName = input || 'Servidor';
    const baseName = serverName.replace(/\s+/g, '_');

    let m3u = `#EXTM3U\n# Servidor: ${serverName}\n`;
    let txt = `LISTA DE CANAIS - ${serverName}\n\n`;
    let preview = `🛰 *${serverName}*\n\n*--- PRÉVIA ---*\n\`\`\`\n`;

    data.channels.forEach((ch, i) => {
      const name = `${CHANNEL_NAMES[i % CHANNEL_NAMES.length]} ${i+1}`;
      m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name}\n${ch.url}\n`;
      txt += `[FHD] ${name} -> ${ch.url}\n`;
      if (i < 20) preview += `[FHD] ${name}\n${ch.url}\n`;
    });

    if (data.channels.length > 20) preview += `\n... (+ ${data.channels.length - 20} canais)`;
    preview += `\n\`\`\``;

    await ctx.reply(preview, { parse_mode: 'Markdown' });
    await ctx.reply('📦 Enviando arquivos (M3U e TXT) e salvando no GitHub...');
    
    // Salva no GitHub (Playlist)
    const gitUrl = await saveToGitHub(`playlists/${baseName}.m3u`, m3u);
    
    // Envia arquivos para o Telegram
    await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${baseName}.m3u` });
    await ctx.replyWithDocument({ source: Buffer.from(txt), filename: `${baseName}.txt` });
    
    if (gitUrl) await ctx.reply(`✅ *GitHub:* \`${gitUrl}\``, { parse_mode: 'Markdown' });
    return;
  }

  const ips = input.split('\n').map(i => i.trim()).filter(i => /^\d/.test(i));
  if (ips.length === 0) return;

  const msg = await ctx.reply(`🔎 Iniciando scan em ${ips.length} IPs...`);
  const allChannels = [];
  let summary = "📊 *Resumo do Scan:*\n";

  for (const ip of ips) {
    let ipChannelsCount = 0;
    const ports = Array.from({length: (PORT_RANGE_END - PORT_RANGE_START + 1)}, (_, i) => PORT_RANGE_START + i);

    for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
      const chunk = ports.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(chunk.map(p => checkPort(ip, p)));
      
      for (let j = 0; j < chunk.length; j++) {
        if (results[j]) {
          const endpoint = await checkStream(ip, chunk[j]);
          if (endpoint) {
            allChannels.push({ url: `http://${ip}:${chunk[j]}${endpoint}` });
            ipChannelsCount++;
          }
        }
      }

      if (i % 240 === 0) {
        try {
          await bot.telegram.editMessageText(chatId, msg.message_id, null, 
            `⏳ Analisando IP: \`${ip}\`\n🔍 Portas: ${i}/${ports.length}\n📺 Canais neste IP: ${ipChannelsCount}\n✨ Total Acumulado: ${allChannels.length}`, { parse_mode: 'Markdown' });
          await sleep(60); 
        } catch(e) {}
      }
    }
    summary += `🔹 ${ip}: ${ipChannelsCount} canais\n`;
  }

  if (allChannels.length === 0) return ctx.reply('❌ Nenhum canal encontrado nos IPs enviados.');

  await ctx.reply(summary + `\nTotal Geral: ${allChannels.length}\n\n📝 *Qual o nome do servidor?*`, { parse_mode: 'Markdown' });
  waitingForName.set(chatId, { channels: allChannels });
});

bot.launch();
