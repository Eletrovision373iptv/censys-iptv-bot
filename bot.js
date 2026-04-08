const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

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

const bot = new Telegraf(BOT_TOKEN);
http.createServer((req, res) => { res.end('OK'); }).listen(process.env.PORT || 3000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Funções de Rede e GitHub ─────────────────────────────────────────────────

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

// ── Lógica do Scanner ────────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const lines = ctx.message.text.split('\n').map(l => l.trim()).filter(l => l !== "");
  if (lines.length < 2) return ctx.reply("⚠️ Formato: \n1ª linha: Nome do Servidor\nResto: Lista de IPs");

  const serverName = lines[0];
  const ips = lines.slice(1).filter(i => /^\d/.test(i));
  const chatId = ctx.chat.id;

  if (ips.length === 0) return ctx.reply("❌ Nenhum IP válido encontrado abaixo do nome.");

  const statusMsg = await ctx.reply(`🛰 *Servidor:* ${serverName}\n🔎 Escaneando ${ips.length} IPs...`, { parse_mode: 'Markdown' });
  const allChannels = [];
  let summary = `📊 *Resumo: ${serverName}*\n`;

  for (const ip of ips) {
    let ipCount = 0;
    const ports = Array.from({length: (PORT_RANGE_END - PORT_RANGE_START + 1)}, (_, i) => PORT_RANGE_START + i);

    for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
      const chunk = ports.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(chunk.map(p => checkPort(ip, p)));
      
      for (let j = 0; j < chunk.length; j++) {
        if (results[j]) {
          const endpoint = await checkStream(ip, chunk[j]);
          if (endpoint) {
            allChannels.push({ url: `http://${ip}:${chunk[j]}${endpoint}` });
            ipCount++;
          }
        }
      }

      if (i % 300 === 0) {
        try {
          await bot.telegram.editMessageText(chatId, statusMsg.message_id, null, 
            `⏳ Analisando: \`${ip}\`\n🔍 Portas: ${i}/${ports.length}\n📺 Canais no IP: ${ipCount}\n✨ Total: ${allChannels.length}`, { parse_mode: 'Markdown' });
        } catch(e) {}
      }
    }
    summary += `🔹 ${ip}: ${ipCount} canais\n`;
    await sleep(100); // Pausa para o Termux respirar entre IPs
  }

  if (allChannels.length === 0) return ctx.reply('❌ Nenhum canal encontrado.');

  // GERAR ARQUIVOS E SALVAR
  const baseName = serverName.replace(/\s+/g, '_');
  let m3u = `#EXTM3U\n# Servidor: ${serverName}\n`;
  let txt = `LISTA: ${serverName}\n\n`;
  let preview = `✅ *Scan Concluído!*\n${summary}\n*--- PRÉVIA ---*\n\`\`\`\n`;

  allChannels.forEach((ch, i) => {
    const name = `${CHANNEL_NAMES[i % CHANNEL_NAMES.length]} ${i+1}`;
    m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}",[FHD] ${name}\n${ch.url}\n`;
    txt += `[FHD] ${name} -> ${ch.url}\n`;
    if (i < 20) preview += `[FHD] ${name}\n${ch.url}\n`;
  });

  if (allChannels.length > 20) preview += `\n... (+ ${allChannels.length - 20} canais)`;
  preview += `\n\`\`\``;

  await ctx.reply(preview, { parse_mode: 'Markdown' });
  
  const gitUrl = await saveToGitHub(`playlists/${baseName}.m3u`, m3u);
  await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${baseName}.m3u` });
  await ctx.replyWithDocument({ source: Buffer.from(txt), filename: `${baseName}.txt` });

  if (gitUrl) ctx.reply(`🔗 *GitHub:* \`${gitUrl}\``, { parse_mode: 'Markdown' });
});

bot.launch();
