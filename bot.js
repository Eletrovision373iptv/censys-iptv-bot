const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ZOOMEYE_KEY  = process.env.ZOOMEYE_KEY;
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
      hostname: 'api.zoomeye.ai',
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

function buildM3U(channels) {
  let m3u = '#EXTM3U\n\n';
  channels.forEach((ch, i) => {
    m3u += `#EXTINF:-1,[FHD] ${ch.name} ${i + 1}\n${ch.url}\n`;
  });
  return m3u;
}

function buildListText(channels) {
  let text = '';
  channels.forEach((ch, i) => {
    text += `#EXTINF:-1,[FHD] ${ch.name} ${i + 1}\n${ch.url}\n`;
  });
  return text;
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

    const m3u      = buildM3U(allChannels);
    const listText = buildListText(allChannels);
    const filename = `censys_${query.replace(/[^a-z0-9]/gi, '_')}.m3u`;

    const header =
      `🛰 *Resultado ZoomEye:* \`${query}\`\n\n` +
      `🌐 ${ips.length} IPs verificados\n` +
      `🖥 ${ipsWithStreams} IP(s) com streams\n` +
      `📺 ${allChannels.length} stream(s) encontrado(s)\n\n`;

    const fullMsg = header + '```\n#EXTM3U\n\n' + listText + '```';

    if (fullMsg.length <= 4000) {
      await bot.telegram.editMessageText(chatId, msgId, undefined, fullMsg, { parse_mode: 'Markdown' });
    } else {
      await bot.telegram.editMessageText(chatId, msgId, undefined,
        header + '📎 Lista completa no arquivo abaixo:',
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename });

  } catch (err) {
    console.error(err);
    await bot.telegram.editMessageText(chatId, msgId, undefined,
      `❌ Erro: ${err.message}`
    );
  }
});

// IP único ou CIDR direto
bot.on('text', async ctx => {
  const input = ctx.message.text.trim();
  const isCIDR = isValidCIDR(input);
  const isIP   = isValidIP(input);

  if (!isIP && !isCIDR) {
    return ctx.reply(
      '❌ Entrada inválida.\n\n' +
      'Use `/buscar video/mp2t` para buscar no Censys\n' +
      'Ou envie um IP: `200.100.50.10`\n' +
      'Ou um range: `200.100.50.0/24`',
      { parse_mode: 'Markdown' }
    );
  }

  const statusMsg = await ctx.reply(`🔍 Iniciando varredura em \`${input}\`...`, { parse_mode: 'Markdown' });
  const chatId = ctx.chat.id;
  const msgId  = statusMsg.message_id;

  try {
    const ips = isCIDR ? expandCIDR(input) : [input];
    const allPorts = [];
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) allPorts.push(p);

    if (isIP) {
      await bot.telegram.editMessageText(chatId, msgId, undefined,
        `🔍 Varrendo \`${input}\`...\n📡 ${allPorts.length} portas`,
        { parse_mode: 'Markdown' }
      );

      const openPorts = await scanPorts(input, allPorts, async (done, total) => {
        try {
          await bot.telegram.editMessageText(chatId, msgId, undefined,
            `🔍 Varrendo \`${input}\`...\n⏳ ${done}/${total} portas verificadas`,
            { parse_mode: 'Markdown' }
          );
        } catch (_) {}
      });

      if (openPorts.length === 0) {
        return bot.telegram.editMessageText(chatId, msgId, undefined,
          `✅ Concluído em \`${input}\`\n\n❌ Nenhuma porta aberta.`,
          { parse_mode: 'Markdown' }
        );
      }

      await bot.telegram.editMessageText(chatId, msgId, undefined,
        `✅ ${openPorts.length} porta(s) abertas\n🎯 Testando streams em paralelo...`,
        { parse_mode: 'Markdown' }
      );

      const streamResults = await Promise.all(openPorts.map(async port => {
        const endpoint = await checkStream(input, port);
        if (!endpoint) return null;
        return { name: 'Canal', url: `http://${input}:${port}${endpoint}` };
      }));

      const channels = streamResults.filter(Boolean);

      if (channels.length === 0) {
        return bot.telegram.editMessageText(chatId, msgId, undefined,
          `✅ Concluído\n\n🔓 ${openPorts.length} porta(s) abertas\n❌ Nenhum stream válido.`,
          { parse_mode: 'Markdown' }
        );
      }

      const m3u      = buildM3U(channels);
      const listText = buildListText(channels);
      const filename = `iptv_${input.replace(/\./g, '_')}.m3u`;
      const header   =
        `🛰 *Resultado da varredura no IP* \`${input}\`:\n\n` +
        `🔓 ${openPorts.length} porta(s) TCP abertas\n` +
        `📺 ${channels.length} stream(s) encontrado(s)\n\n`;

      const fullMsg = header + '```\n#EXTM3U\n\n' + listText + '```';
      if (fullMsg.length <= 4000) {
        await bot.telegram.editMessageText(chatId, msgId, undefined, fullMsg, { parse_mode: 'Markdown' });
      } else {
        await bot.telegram.editMessageText(chatId, msgId, undefined,
          header + '📎 Lista completa no arquivo abaixo:', { parse_mode: 'Markdown' }
        );
      }
      await ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename });

    } else {
      // CIDR
      await bot.telegram.editMessageText(chatId, msgId, undefined,
        `🌐 Varrendo range \`${input}\`...\n📡 ${ips.length} IPs`,
        { parse_mode: 'Markdown' }
      );

      const allChannels = [];
      let ipsScanned = 0, ipsWithStreams = 0;

      for (const ip of ips) {
        const channels = await scanIPFull(ip);
        ipsScanned++;
        if (channels.length > 0) { ipsWithStreams++; allChannels.push(...channels); }
        if (ipsScanned % 10 === 0) {
          try {
            await bot.telegram.editMessageText(chatId, msgId, undefined,
              `🌐 Varrendo \`${input}\`...\n⏳ ${ipsScanned}/${ips.length} IPs | 📺 ${allChannels.length} streams`,
              { parse_mode: 'Markdown' }
            );
          } catch (_) {}
        }
      }

      if (allChannels.length === 0) {
        return bot.telegram.editMessageText(chatId, msgId, undefined,
          `✅ Concluído\n\n🔍 ${ips.length} IPs verificados\n❌ Nenhum stream encontrado`,
          { parse_mode: 'Markdown' }
        );
      }

      const m3u      = buildM3U(allChannels);
      const listText = buildListText(allChannels);
      const filename = `iptv_range_${input.split('/')[1]}.m3u`;
      const header   =
        `🛰 *Resultado do range* \`${input}\`:\n\n` +
        `🔍 ${ips.length} IPs verificados\n` +
        `🖥 ${ipsWithStreams} IP(s) com streams\n` +
        `📺 ${allChannels.length} stream(s) total\n\n`;

      const fullMsg = header + '```\n#EXTM3U\n\n' + listText + '```';
      if (fullMsg.length <= 4000) {
        await bot.telegram.editMessageText(chatId, msgId, undefined, fullMsg, { parse_mode: 'Markdown' });
      } else {
        await bot.telegram.editMessageText(chatId, msgId, undefined,
          header + '📎 Lista completa no arquivo abaixo:', { parse_mode: 'Markdown' }
        );
      }
      await ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename });
    }

  } catch (err) {
    console.error(err);
    await bot.telegram.editMessageText(chatId, msgId, undefined, `❌ Erro: ${err.message}`);
  }
});

bot.launch();
console.log('🤖 Bot IPTV Scanner + ZoomEye rodando...');
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
