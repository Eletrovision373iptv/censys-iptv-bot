const { Telegraf } = require('telegraf');
const { spawnSync } = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- CARREGAR CONFIGS ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VISION_API_KEY = process.env.VISION_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = process.env.GITHUB_USER || 'Eletrovision373iptv';
const GITHUB_REPO = process.env.GITHUB_REPO || 'censys-iptv-bot';

const bot = new Telegraf(BOT_TOKEN);

// --- FUNÇÃO IA (GOOGLE VISION) ---
async function identificarNomePelaImagem(url) {
  const tmpFile = path.join(os.tmpdir(), `snap_${Date.now()}.jpg`);
  try {
    // Tira print rápido (2 segundos de buffer para estabilizar imagem)
    spawnSync('ffmpeg', [
      '-y', '-i', url, '-ss', '00:00:02', '-vframes', '1',
      '-vf', 'scale=480:-1', '-q:v', '2', '-f', 'image2', tmpFile
    ], { timeout: 12000 });

    if (!fs.existsSync(tmpFile)) return null;

    const base64Image = fs.readFileSync(tmpFile).toString('base64');
    const body = JSON.stringify({
      requests: [{
        image: { content: base64Image },
        features: [{ type: 'LOGO_DETECTION' }, { type: 'TEXT_DETECTION' }]
      }]
    });

    const visionRes = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'vision.googleapis.com',
        path: `/v1/images:annotate?key=${VISION_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.write(body);
      req.end();
    });

    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

    const annotations = visionRes.responses?.[0];
    const logo = annotations?.logoAnnotations?.[0]?.description;
    const text = annotations?.textAnnotations?.[0]?.description?.split('\n')[0];

    // Se a IA retornar texto muito longo ou erro, filtramos
    const resultado = logo || text;
    return resultado && resultado.length < 50 ? resultado.toUpperCase() : null;

  } catch (e) {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    return null;
  }
}

// --- SALVAR GITHUB ---
async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return;
  const filePath = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  const body = JSON.stringify({ message: `IA Scan: ${filename}`, content: base64, branch: 'main' });
  
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

// --- SCANNER PRINCIPAL ---
async function realizarScanIA(ctx, serverName, ips) {
  const status = await ctx.reply(`🛰 <b>${serverName}</b>\n🧠 IA ativada. Iniciando reconhecimento...`, { parse_mode: 'HTML' });
  const allChannels = [];

  for (const ip of ips) {
    for (let p = 0; p <= 3000; p++) {
      const actualPort = 14000 + p;
      
      if (p % 25 === 0 || p === 3000) {
        let text = `🛰 <b>${serverName}</b>\n🌐 IP: <code>${ip}</code>\n🔍 Scan: ${p}/3000\n📺 Achados: ${allChannels.length}`;
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, text, { parse_mode: 'HTML' }).catch(() => {});
      }

      const isAlive = await new Promise(r => {
        const s = new net.Socket();
        s.setTimeout(700);
        s.on('connect', () => { s.destroy(); r(true); });
        s.on('error', () => r(false));
        s.on('timeout', () => r(false));
        s.connect(actualPort, ip);
      });

      if (isAlive) {
        const url = `http://${ip}:${actualPort}/live.ts`;
        // Chama a IA para ler a imagem
        const nomeIA = await identificarNomePelaImagem(url);
        const nomeFinal = nomeIA || `CANAL DESCONHECIDO ${allChannels.length + 1}`;
        
        allChannels.push({ name: nomeFinal, url, port: actualPort });
        console.log(`[IA] Porta ${actualPort}: ${nomeFinal}`);
      }
    }
  }

  if (allChannels.length === 0) return ctx.reply("❌ Nada encontrado.");

  // GERAÇÃO DE ARQUIVOS
  const safe = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  let m3u = `#EXTM3U\n`;
  let txt = `SERVER: ${serverName}\n\n`;
  let preview = `✅ <b>${serverName} - FINALIZADO</b>\n\n`;

  allChannels.forEach((ch, i) => {
    m3u += `#EXTINF:-1 tvg-logo="https://i.imgur.com/dPaFa7x.png",${ch.name}\n${ch.url}\n`;
    txt += `${ch.url}\n`;
    if (i < 15) preview += `📺 ${ch.name} (${ch.port})\n`;
  });

  if (allChannels.length > 15) preview += `\n... e mais ${allChannels.length - 15} canais.`;

  await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, preview, { parse_mode: 'HTML' });
  await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: `${safe}.m3u` });
  await ctx.replyWithDocument({ source: Buffer.from(txt), filename: `${safe}.txt` });
  saveToGitHub(`${safe}.m3u`, m3u);
}

bot.on('text', ctx => {
  const lines = ctx.message.text.trim().split('\n').map(l => l.trim());
  const ips = lines.filter(l => /^(\d{1,3}\.){3}\d{1,3}$/.test(l));
  if (ips.length > 0) realizarScanIA(ctx, lines[0], ips).catch(console.error);
});

bot.launch({ handlerTimeout: 0 });
console.log('🤖 Bot com Reconhecimento de Imagem Online!');
