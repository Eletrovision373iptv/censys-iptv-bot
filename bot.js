const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ZOOMEYE_KEY  = process.env.ZOOMEYE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = 'Eletrovision373iptv';
const GITHUB_REPO  = 'censys-iptv-bot';
const GITHUB_BRANCH = 'main';
if (!BOT_TOKEN)   throw new Error('BOT_TOKEN não definido!');
if (!ZOOMEYE_KEY) throw new Error('ZOOMEYE_KEY não definida!');

const PORT = process.env.PORT || 3000;

const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 800;
const HTTP_TIMEOUT     = 2000;
const MAX_CONCURRENT   = 80;

const STREAM_ENDPOINTS = [
  '/live.ts', '/stream', '/stream.ts', '/live', '/video.ts', '/index.m3u8',
];

// Logo padrão para todos os canais
const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

// Nomes aleatórios de canais brasileiros
const CHANNEL_NAMES = [
  'ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY',
  'CNN BRASIL','GNT','MULTISHOW','TNT','HBO','TELECINE','MEGAPIX',
  'COMBATE','PARAMOUNT','UNIVERSAL','SyFy','AXN','FOX','FX','SPACE',
  'HISTORY','NATIONAL GEOGRAPHIC','ANIMAL PLANET','DISCOVERY SCIENCE',
  'CARTOON NETWORK','DISNEY CHANNEL','NICKELODEON','COMEDY CENTRAL',
  'VH1','MTV','BIS','VIVA','TV CULTURA','TV BRASIL','REDE TV',
  'GAZETA','JOVEM PAN NEWS','RECORD NEWS','GLOBONEWS','BAND NEWS',
  'PREMIERE 1','PREMIERE 2','PREMIERE 3','PREMIERE 4','PREMIERE 5',
  'SPORTV 2','SPORTV 3','ESPN 2','ESPN 3','ESPN 4',
  'HBO 2','HBO FAMILY','HBO HITS','HBO PLUS','HBO SIGNATURE',
  'TELECINE FUN','TELECINE TOUCH','TELECINE PIPOCA','TELECINE CULT',
  'CINEMAX','CINEMAX 2','MAX PRIME','TELECINE ACTION',
  'DISCOVERY HOME','DISCOVERY TURBO','DISCOVERY THEATER',
  'NAT GEO WILD','DISNEY JUNIOR','DISNEY XD','BOOMERANG',
  'TOONCAST','STUDIO UNIVERSAL','FILM & ARTS','ARTE 1',
  'OFF','LIFETIME','WE TV','E! ENTERTAINMENT','PEOPLE+ARTS',
];

// Estado de conversa: aguardando nome do servidor
const waitingForName = new Map(); // chatId -> { entries, channels }
// ──────────────────────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

// ── Keep-alive HTTP server (Render.com) ───────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot IPTV Scanner online.');
});
server.listen(PORT, () => console.log(`🌐 Keep-alive na porta ${PORT}`));

// ── ZoomEye API ───────────────────────────────────────────────────────────────

function zoomeyeSearch(query, page = 1) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      query: query,
      page: page,
      pagesize: 100,
    });

    const options = {
      hostname: 'api.zoomeye.org',
      path: `/host/search?${params.toString()}`,
      method: 'GET',
      headers: {
        'Authorization': `JWT ${ZOOMEYE_KEY}`,
        'User-Agent': 'iptv-scanner-bot/1.0',
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('ZoomEye HTTP status:', res.statusCode);
          console.log('ZoomEye response:', JSON.stringify(json).slice(0, 500));

          if (json.error) {
            return reject(new Error(`ZoomEye: ${json.error}`));
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`ZoomEye: HTTP ${res.statusCode} - ${json.message || JSON.stringify(json).slice(0, 100)}`));
          }

          const list = json.matches || json.data?.list || [];
          const ips = list.map(h => h.ip).filter(Boolean);
          resolve({ ips, total: json.total || json.data?.total || ips.length });
        } catch (e) {
          console.log('ZoomEye raw (não é JSON):', data.slice(0, 500));
          reject(new Error(`ZoomEye resposta inválida: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout ZoomEye')); });
    req.end();
  });
}

// ── Scanner ───────────────────────────────────────────────────────────────────

function isValidIP(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split('.').every(n => parseInt(n) <= 255);
}

function isValidCIDR(input) {
  const match = input.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
  if (!match) return false;
  const prefix = parseInt(input.split('/')[1]);
  return prefix >= 16 && prefix <= 32;
}

function expandCIDR(cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr);
  const parts = base.split('.').map(Number);
  const baseInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
  const networkInt = (baseInt & mask) >>> 0;
  const count = Math.pow(2, 32 - prefix);
  const ips = [];
  for (let i = 1; i < count - 1; i++) {
    const n = (networkInt + i) >>> 0;
    ips.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return ips;
}

function checkPort(ip, port) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(CONNECT_TIMEOUT);
    sock.on('connect', () => finish(true));
    sock.on('error',   () => finish(false));
    sock.on('timeout', () => finish(false));
    sock.connect(port, ip);
  });
}

function checkStream(ip, port) {
  return new Promise(resolve => {
    const globalTimer = setTimeout(() => resolve(null), 3000);
    let idx = 0;
    function tryNext() {
      if (idx >= STREAM_ENDPOINTS.length) { clearTimeout(globalTimer); return resolve(null); }
      const p = STREAM_ENDPOINTS[idx++];
      const req = http.get({ host: ip, port, path: p, timeout: HTTP_TIMEOUT }, res => {
        res.destroy();
        if (res.statusCode < 500) { clearTimeout(globalTimer); resolve(p); }
        else tryNext();
      });
      req.on('error', tryNext);
      req.on('timeout', () => { req.destroy(); tryNext(); });
    }
    tryNext();
  });
}

async function scanPorts(ip, ports, onProgress) {
  const open = [];
  let done = 0;
  const chunks = [];
  for (let i = 0; i < ports.length; i += MAX_CONCURRENT) chunks.push(ports.slice(i, i + MAX_CONCURRENT));
  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(async port => {
      const ok = await checkPort(ip, port);
      done++;
      if (done % 100 === 0 && onProgress) onProgress(done, ports.length);
      return ok ? port : null;
    }));
    open.push(...results.filter(Boolean));
  }
  return open;
}

async function scanIPFull(ip) {
  const allPorts = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);
  const openPorts = await scanPorts(ip, allPorts, null);
  if (openPorts.length === 0) return [];
  const results = await Promise.all(openPorts.map(async port => {
    const endpoint = await checkStream(ip, port);
    if (!endpoint) return null;
    return { name: `Canal`, url: `http://${ip}:${port}${endpoint}` };
  }));
  return results.filter(Boolean);
}

function getChannelName(index) {
  return CHANNEL_NAMES[index % CHANNEL_NAMES.length];
}

function buildM3U(channels, serverName, scanDate) {
  let m3u = `#EXTM3U url-tvg="" tvg-shift=0 cache=500\n`;
  m3u += `# Servidor: ${serverName}\n`;
  m3u += `# Scan: ${scanDate}\n\n`;
  channels.forEach((ch, i) => {
    const name = getChannelName(i);
    const num  = i + 1;
    m3u += `#EXTINF:-1 tvg-id="${name}" tvg-name="${name}" tvg-logo="${LOGO_URL}" group-title="${serverName}",[FHD] ${name} ${num}\n`;
    m3u += `${ch.url}\n`;
  });
  return m3u;
}

function buildTXT(channels, serverName, scanDate) {
  let txt = `Servidor: ${serverName}\n`;
  txt += `Scan: ${scanDate}\n`;
  txt += `Total: ${channels.length} canais\n\n`;
  channels.forEach((ch, i) => {
    const name = getChannelName(i);
    txt += `${ch.url}\n`;
    txt += `#EXTINF:-1,[FHD] ${name} ${i + 1}\n`;
  });
  return txt;
}

function buildListText(channels) {
  let text = '';
  channels.forEach((ch, i) => {
    const name = getChannelName(i);
    text += `#EXTINF:-1,[FHD] ${name} ${i + 1}\n${ch.url}\n`;
  });
  return text;
}

// Salva ou atualiza arquivo no GitHub
async function saveToGitHub(filename, content) {
  if (!GITHUB_TOKEN) return null;

  const path = `playlists/${filename}`;
  const base64 = Buffer.from(content, 'utf-8').toString('base64');

  // Primeiro tenta pegar o SHA do arquivo existente
  let sha = null;
  try {
    await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
        method: 'GET',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'iptv-scanner-bot',
          'Accept': 'application/vnd.github.v3+json',
        },
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            sha = json.sha || null;
          } catch (_) {}
          resolve();
        });
      });
      req.on('error', resolve);
      req.end();
    });
  } catch (_) {}

  // Salva ou atualiza
  return new Promise((resolve) => {
    const body = JSON.stringify({
      message: sha ? `Atualizar ${filename}` : `Adicionar ${filename}`,
      content: base64,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    });

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'iptv-scanner-bot',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`);
        } else {
          console.log('GitHub error:', data.slice(0, 200));
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function sendResults(ctx, channels, validEntries, totalWithStreams, serverName) {
  const scanDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const m3u      = buildM3U(channels, serverName, scanDate);
  const txt      = buildTXT(channels, serverName, scanDate);
  const listText = buildListText(channels);

  const safeName    = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  const filenameM3U = `${safeName}.m3u`;
  const filenameTXT = `${safeName}.txt`;

  const header =
    `🛰 *${serverName}*\n` +
    `📅 ${scanDate}\n\n` +
    `🔍 ${validEntries.length} IP(s) verificado(s)\n` +
    `🖥 ${totalWithStreams} IP(s) com streams\n` +
    `📺 ${channels.length} canal(is) encontrado(s)\n\n`;

  // Prévia — primeiras 15 entradas como mensagem de texto
  const preview = listText.split('\n').slice(0, 30).join('\n');
  await ctx.reply(
    header + '```\n' + preview + (channels.length > 15 ? '\n...' : '') + '\n```',
    { parse_mode: 'Markdown' }
  );

  // Salva no GitHub em paralelo com envio dos arquivos
  const [githubUrl] = await Promise.all([
    saveToGitHub(filenameM3U, m3u),
    ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename: filenameM3U }),
    ctx.replyWithDocument({ source: Buffer.from(txt, 'utf-8'), filename: filenameTXT }),
  ]);

  // Mostra link do GitHub se salvou com sucesso
  if (githubUrl) {
    await ctx.reply(
      `✅ *Playlist salva no GitHub!*\n\n` +
      `🔗 Link direto para usar no player:\n\`${githubUrl}\`\n\n` +
      `_Próximo scan com o mesmo nome atualiza automaticamente._`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ── Bot handlers ──────────────────────────────────────────────────────────────

bot.start(ctx => ctx.reply(
  '🛰 *Bot IPTV Scanner*\n\n' +
  'Comandos disponíveis:\n\n' +
  '`/buscar` — busca IPs no ZoomEye e varre automaticamente\n' +
  '`/buscar video/mp2t` — busca por tipo de stream\n' +
  '`/buscar port:14001` — busca por porta\n\n' +
  'Ou envie diretamente:\n' +
  '• IP: `89.187.190.183`\n' +
  '• Range: `89.187.190.0/24`',
  { parse_mode: 'Markdown' }
));

bot.help(ctx => ctx.reply(
  '📖 *Comandos:*\n\n' +
  '`/buscar <query>` — busca no ZoomEye + varre IPs\n' +
  '`/buscar video/mp2t` — streams de vídeo\n' +
  '`/buscar port:16071` — porta específica\n' +
  '`/buscar country:BR port:14001` — por país\n\n' +
  'Ou envie IP/range direto:\n' +
  '• `89.187.190.183`\n' +
  '• `89.187.190.0/24`',
  { parse_mode: 'Markdown' }
));

// Comando /buscar — Censys + scanner automático
bot.command('buscar', async ctx => {
  const query = ctx.message.text.replace('/buscar', '').trim() || 'video/mp2t';

  const statusMsg = await ctx.reply(
    `🔍 Buscando no ZoomEye: \`${query}\`...`,
    { parse_mode: 'Markdown' }
  );
  const chatId = ctx.chat.id;
  const msgId  = statusMsg.message_id;

  try {
    // Etapa 1: buscar IPs no Censys
    await bot.telegram.editMessageText(chatId, msgId, undefined,
      `🌐 Consultando ZoomEye para: \`${query}\`...`,
      { parse_mode: 'Markdown' }
    );

    const { ips, total } = await zoomeyeSearch(query);

    if (ips.length === 0) {
      return bot.telegram.editMessageText(chatId, msgId, undefined,
        `✅ Busca concluída\n\n❌ Nenhum IP encontrado para: \`${query}\``,
        { parse_mode: 'Markdown' }
      );
    }

    await bot.telegram.editMessageText(chatId, msgId, undefined,
      `✅ ZoomEye retornou ${ips.length} IP(s) (total: ~${total})\n` +
      `🔍 Iniciando varredura de portas ${PORT_RANGE_START}–${PORT_RANGE_END}...`,
      { parse_mode: 'Markdown' }
    );

    // Etapa 2: varrer cada IP
    const allChannels = [];
    let ipsScanned = 0;
    let ipsWithStreams = 0;

    for (const ip of ips) {
      const channels = await scanIPFull(ip);
      ipsScanned++;
      if (channels.length > 0) {
        ipsWithStreams++;
        allChannels.push(...channels);
      }

      if (ipsScanned % 3 === 0 || ipsScanned === ips.length) {
        try {
          await bot.telegram.editMessageText(chatId, msgId, undefined,
            `🔍 Varrendo IPs do Censys...\n` +
            `⏳ ${ipsScanned}/${ips.length} IPs | 📺 ${allChannels.length} stream(s)`,
            { parse_mode: 'Markdown' }
          );
        } catch (_) {}
      }
    }

    if (allChannels.length === 0) {
      return bot.telegram.editMessageText(chatId, msgId, undefined,
        `✅ Varredura concluída\n\n` +
        `🌐 Query: \`${query}\`\n` +
        `🔍 ${ips.length} IPs verificados\n` +
        `❌ Nenhum stream válido encontrado`,
        { parse_mode: 'Markdown' }
      );
    }

    await bot.telegram.editMessageText(chatId, msgId, undefined,
      `✅ ${allChannels.length} canal(is) encontrado(s)!\n📦 Gerando arquivos...`,
      { parse_mode: 'Markdown' }
    );

    const serverName = `ZoomEye: ${query}`;
    await sendResults(ctx, allChannels, ips, ipsWithStreams, serverName);

  } catch (err) {
    console.error(err);
    await bot.telegram.editMessageText(chatId, msgId, undefined,
      `❌ Erro: ${err.message}`
    );
  }
});

// IP único, múltiplos IPs ou CIDR direto
bot.on('text', async ctx => {
  const input  = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  // ── Se estamos aguardando o nome do servidor ──────────────────────────────
  if (waitingForName.has(chatId)) {
    const { entries, channels, totalWithStreams } = waitingForName.get(chatId);
    waitingForName.delete(chatId);

    const serverName = input || 'Servidor IPTV';
    await ctx.reply(`✅ Nome: *${serverName}*\n📦 Gerando arquivos...`, { parse_mode: 'Markdown' });
    await sendResults(ctx, channels, entries, totalWithStreams, serverName);
    return;
  }

  // ── Extrai linhas válidas (IPs ou CIDRs) ─────────────────────────────────
  const lines        = input.split('\n').map(l => l.trim()).filter(Boolean);
  const validEntries = lines.filter(l => isValidIP(l) || isValidCIDR(l));

  if (validEntries.length === 0) {
    return ctx.reply(
      '❌ Entrada inválida.\n\n' +
      'Use `/buscar video/mp2t` para buscar no ZoomEye\n' +
      'Ou envie um ou mais IPs (um por linha):\n' +
      '`89.187.190.183`\n' +
      '`107.150.59.42`\n' +
      '`200.100.50.0/24`',
      { parse_mode: 'Markdown' }
    );
  }

  const statusMsg = await ctx.reply(
    `🔍 Iniciando varredura de ${validEntries.length} IP(s)...`,
    { parse_mode: 'Markdown' }
  );
  const msgId = statusMsg.message_id;

  try {
    const allChannels = [];
    let totalScanned    = 0;
    let totalWithStreams = 0;

    for (const entry of validEntries) {
      const isCIDR = isValidCIDR(entry);
      const isIP   = isValidIP(entry);
      const ips    = isCIDR ? expandCIDR(entry) : [entry];

      try {
        await bot.telegram.editMessageText(chatId, msgId, undefined,
          `🔍 Varrendo \`${entry}\`...\n⏳ ${totalScanned}/${validEntries.length} entradas | 📺 ${allChannels.length} streams`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) {}

      if (isIP) {
        const allPorts = [];
        for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);

        const openPorts = await scanPorts(entry, allPorts, async (done, total) => {
          try {
            await bot.telegram.editMessageText(chatId, msgId, undefined,
              `🔍 Varrendo \`${entry}\`...\n⏳ ${done}/${total} portas | 📺 ${allChannels.length} streams`,
              { parse_mode: 'Markdown' }
            );
          } catch (_) {}
        });

        if (openPorts.length > 0) {
          const streamResults = await Promise.all(openPorts.map(async port => {
            const endpoint = await checkStream(entry, port);
            if (!endpoint) return null;
            return { url: `http://${entry}:${port}${endpoint}` };
          }));
          const channels = streamResults.filter(Boolean);
          if (channels.length > 0) { totalWithStreams++; allChannels.push(...channels); }
        }
      } else {
        for (const ip of ips) {
          const channels = await scanIPFull(ip);
          if (channels.length > 0) { totalWithStreams++; allChannels.push(...channels); }
        }
      }

      totalScanned++;
    }

    if (allChannels.length === 0) {
      return bot.telegram.editMessageText(chatId, msgId, undefined,
        `✅ Concluído\n\n🔍 ${validEntries.length} IP(s) verificados\n❌ Nenhum stream encontrado`,
        { parse_mode: 'Markdown' }
      );
    }

    // Varredura concluída — pergunta o nome do servidor
    await bot.telegram.editMessageText(chatId, msgId, undefined,
      `✅ Varredura concluída!\n\n` +
      `🖥 ${totalWithStreams} IP(s) com streams\n` +
      `📺 ${allChannels.length} canal(is) encontrado(s)\n\n` +
      `📝 *Qual o nome deste servidor?*\n_(ex: Globo Server, Brasil IPTV, ...)_`,
      { parse_mode: 'Markdown' }
    );

    // Salva estado aguardando resposta
    waitingForName.set(chatId, { entries: validEntries, channels: allChannels, totalWithStreams });

  } catch (err) {
    console.error(err);
    await bot.telegram.editMessageText(chatId, msgId, undefined, `❌ Erro: ${err.message}`);
  }
});

bot.launch();
console.log('🤖 Bot IPTV Scanner + ZoomEye rodando...');
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
