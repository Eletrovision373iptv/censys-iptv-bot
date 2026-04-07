const { Telegraf } = require('telegraf');
const net = require('net');
const http = require('http');
const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Certifique-se de configurar essas variáveis no painel do Railway/Render!
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ZOOMEYE_KEY  = process.env.ZOOMEYE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER  = 'Eletrovision373iptv';
const GITHUB_REPO  = 'censys-iptv-bot';
const GITHUB_BRANCH = 'main';

// Validação de segurança para não travar o deploy sem aviso
if (!BOT_TOKEN)   { console.error('❌ ERRO: BOT_TOKEN não definido nas variáveis de ambiente!'); }
if (!ZOOMEYE_KEY) { console.error('❌ ERRO: ZOOMEYE_KEY não definida!'); }

const PORT = process.env.PORT || 3000;

// Configurações de Scan (Ajustadas para evitar banimento)
const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 1000; // Aumentado para 1s para ser mais estável
const HTTP_TIMEOUT     = 2500;
const MAX_CONCURRENT   = 20;   // REDUZIDO: 80 era muito agressivo para o Render/Railway

const STREAM_ENDPOINTS = [
  '/live.ts', '/stream', '/stream.ts', '/live', '/video.ts', '/index.m3u8',
];

const LOGO_URL = 'https://i.imgur.com/dPaFa7x.png';

const CHANNEL_NAMES = [
  'ESPN','GLOBO','RECORD','SBT','SPORTV','PREMIERE','BAND','DISCOVERY',
  'CNN BRASIL','GNT','MULTISHOW','TNT','HBO','TELECINE','MEGAPIX',
  'COMBATE','PARAMOUNT','UNIVERSAL','SyFy','AXN','FOX','FX','SPACE',
  'HISTORY','NATIONAL GEOGRAPHIC','ANIMAL PLANET','DISCOVERY SCIENCE',
  'CARTOON NETWORK','DISNEY CHANNEL','NICKELODEON','COMEDY CENTRAL',
  'VH1','MTV','BIS','VIVA','TV CULTURA','TV BRASIL','REDE TV',
  'GAZETA','JOVEM PAN NEWS','RECORD NEWS','GLOBONEWS','BAND NEWS'
];

const waitingForName = new Map();

// Inicialização do Bot (Só inicia se tiver o Token)
if (BOT_TOKEN) {
    const bot = new Telegraf(BOT_TOKEN);

    // ── Keep-alive HTTP server ───────────────────────────────────────
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('Bot IPTV Scanner está vivo.');
    });
    server.listen(PORT, () => console.log(`🌐 Servidor de Keep-alive na porta ${PORT}`));

    // ── Funções de Apoio (ZoomEye, IP, CIDR) ──────────────────────────

    function zoomeyeSearch(query, page = 1) {
      return new Promise((resolve, reject) => {
        const params = new URLSearchParams({ query: query, page: page, pagesize: 100 });
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
              if (json.error) return reject(new Error(`ZoomEye: ${json.error}`));
              const list = json.matches || json.data?.list || [];
              const ips = list.map(h => h.ip).filter(Boolean);
              resolve({ ips, total: json.total || json.data?.total || ips.length });
            } catch (e) { reject(new Error(`ZoomEye resposta inválida`)); }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    function isValidIP(ip) { return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip); }

    function isValidCIDR(input) {
      const match = input.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
      if (!match) return false;
      const prefix = parseInt(input.split('/')[1]);
      return prefix >= 24 && prefix <= 32; // Limitado a /24 para não travar o bot
    }

    function expandCIDR(cidr) {
      const [base, prefixStr] = cidr.split('/');
      const prefix = parseInt(prefixStr);
      const parts = base.split('.').map(Number);
      const baseInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
      const count = Math.pow(2, 32 - prefix);
      const ips = [];
      for (let i = 1; i < Math.min(count, 256); i++) { // Máximo 254 IPs por segurança
        const n = (baseInt + i) >>> 0;
        ips.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
      }
      return ips;
    }

    function checkPort(ip, port) {
      return new Promise(resolve => {
        const sock = new net.Socket();
        let done = false;
        sock.setTimeout(CONNECT_TIMEOUT);
        sock.on('connect', () => { done = true; sock.destroy(); resolve(true); });
        sock.on('error',   () => { done = true; sock.destroy(); resolve(false); });
        sock.on('timeout', () => { done = true; sock.destroy(); resolve(false); });
        sock.connect(port, ip);
      });
    }

    function checkStream(ip, port) {
      return new Promise(resolve => {
        const globalTimer = setTimeout(() => resolve(null), 3500);
        let idx = 0;
        function tryNext() {
          if (idx >= STREAM_ENDPOINTS.length) { clearTimeout(globalTimer); return resolve(null); }
          const p = STREAM_ENDPOINTS[idx++];
          const req = http.get({ host: ip, port, path: p, timeout: HTTP_TIMEOUT }, res => {
            res.destroy();
            if (res.statusCode < 500) { clearTimeout(globalTimer); resolve(p); }
            else tryNext();
          }).on('error', tryNext);
        }
        tryNext();
      });
    }

    async function scanPorts(ip, ports, onProgress) {
      const open = [];
      let done = 0;
      for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
        const chunk = ports.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(chunk.map(async port => {
          const ok = await checkPort(ip, port);
          done++;
          return ok ? port : null;
        }));
        open.push(...results.filter(Boolean));
        if (onProgress) onProgress(done, ports.length);
        // Pequena pausa para não ser banido pelo firewall da hospedagem
        await new Promise(r => setTimeout(r, 200)); 
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
        return endpoint ? { url: `http://${ip}:${port}${endpoint}` } : null;
      }));
      return results.filter(Boolean);
    }

    function getChannelName(index) { return CHANNEL_NAMES[index % CHANNEL_NAMES.length]; }

    // ── Geração de Playlists e GitHub ──────────────────────────────────────────

    function buildM3U(channels, serverName, scanDate) {
      let m3u = `#EXTM3U\n# Servidor: ${serverName}\n# Data: ${scanDate}\n\n`;
      channels.forEach((ch, i) => {
        const name = getChannelName(i);
        m3u += `#EXTINF:-1 tvg-logo="${LOGO_URL}" group-title="${serverName}",[FHD] ${name} ${i+1}\n${ch.url}\n`;
      });
      return m3u;
    }

    async function saveToGitHub(filename, content) {
      if (!GITHUB_TOKEN) return null;
      const path = `playlists/${filename}`;
      const base64 = Buffer.from(content, 'utf-8').toString('base64');
      const body = JSON.stringify({ message: `Update ${filename}`, content: base64, branch: GITHUB_BRANCH });
      
      return new Promise(resolve => {
        const options = {
          hostname: 'api.github.com',
          path: `/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`,
          method: 'PUT',
          headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'bot', 'Content-Type': 'application/json' }
        };
        const req = https.request(options, res => {
          if (res.statusCode <= 201) resolve(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`);
          else resolve(null);
        });
        req.write(body);
        req.end();
      });
    }

    async function sendResults(ctx, channels, validEntries, totalWithStreams, serverName) {
      const scanDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const m3u = buildM3U(channels, serverName, scanDate);
      const safeName = serverName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
      const filenameM3U = `${safeName}.m3u`;

      await ctx.reply(`📺 *${serverName}* finalizado!\nEncontrados: ${channels.length} canais.`);
      const githubUrl = await saveToGitHub(filenameM3U, m3u);
      
      await ctx.replyWithDocument({ source: Buffer.from(m3u, 'utf-8'), filename: filenameM3U });
      if (githubUrl) ctx.reply(`🔗 Link GitHub:\n\`${githubUrl}\``, { parse_mode: 'Markdown' });
    }

    // ── Comandos do Bot ────────────────────────────────────────────────────────

    bot.start(ctx => ctx.reply('🚀 Bot Scanner Ativo! Use /buscar <query> ou mande um IP.'));

    bot.command('buscar', async ctx => {
      const query = ctx.message.text.replace('/buscar', '').trim() || 'video/mp2t';
      const statusMsg = await ctx.reply(`🔍 Buscando IPs para: \`${query}\`...`, { parse_mode: 'Markdown' });

      try {
        const { ips } = await zoomeyeSearch(query);
        if (ips.length === 0) return ctx.reply('❌ Nenhum IP encontrado.');

        let allChannels = [];
        let count = 0;
        for (const ip of ips.slice(0, 5)) { // Limitado a 5 IPs por busca para não ser banido
          const found = await scanIPFull(ip);
          if (found.length > 0) allChannels.push(...found);
          count++;
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `⏳ Scaneando IPs: ${count}/${ips.length}...`);
        }
        await sendResults(ctx, allChannels, ips, count, `Busca: ${query}`);
      } catch (e) { ctx.reply('❌ Erro na busca.'); }
    });

    bot.on('text', async ctx => {
      const input = ctx.message.text.trim();
      const chatId = ctx.chat.id;

      if (waitingForName.has(chatId)) {
          const data = waitingForName.get(chatId);
          waitingForName.delete(chatId);
          return sendResults(ctx, data.channels, data.entries, 1, input);
      }

      if (isValidIP(input) || isValidCIDR(input)) {
        const status = await ctx.reply('🔍 Iniciando Scan manual...');
        const ips = isValidCIDR(input) ? expandCIDR(input) : [input];
        let found = [];
        for(const ip of ips) {
            const res = await scanIPFull(ip);
            found.push(...res);
        }
        if (found.length > 0) {
            ctx.reply('✅ Canais encontrados! Qual o nome do servidor?');
            waitingForName.set(chatId, { channels: found, entries: ips });
        } else { ctx.reply('❌ Nenhum canal aberto nessas portas.'); }
      }
    });

    bot.launch();
    console.log('🤖 Bot rodando com sucesso!');
} else {
    console.log('⚠️ O Bot não pôde ser iniciado por falta de BOT_TOKEN.');
}
