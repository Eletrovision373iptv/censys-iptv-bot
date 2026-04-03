const { Telegraf } = require('telegraf');
const axios = require('axios');
const net = require('net');

// --- CONFIGURAÇÕES (Pegas do GitHub Secrets) ---
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const [,, C_ID, C_SECRET] = (process.env.CENSYS_TOKEN || "").split('_');

const PORT_RANGE_START = 14000;
const PORT_RANGE_END   = 17000;
const CONNECT_TIMEOUT  = 800; 
const MAX_CONCURRENT   = 100; 

const bot = new Telegraf(BOT_TOKEN);

// Função de scanner de porta (Sua lógica de rede)
function checkPort(ip, port) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        let done = false;
        sock.setTimeout(CONNECT_TIMEOUT);
        const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
        sock.on('connect', () => finish(true));
        sock.on('error', () => finish(false));
        sock.on('timeout', () => finish(false));
        sock.connect(port, ip);
    });
}

// Escaneia o range de um IP específico
async function scanIP(ip) {
    const found = [];
    const ports = [];
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) ports.push(p);

    for (let i = 0; i < ports.length; i += MAX_CONCURRENT) {
        const chunk = ports.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(chunk.map(async p => (await checkPort(ip, p)) ? p : null));
        found.push(...results.filter(Boolean));
    }
    return found;
}

// Comando principal: Quando você digitar "video/mp2t"
bot.hears(/video\/mp2t/i, async (ctx) => {
    await ctx.reply("🔎 Buscando alvos no Censys e iniciando scanner nas portas 14000-17000... Aguarde.");

    const auth = Buffer.from(`${C_ID}:${C_SECRET}`).toString('base64');
    const query = 'services.port: [14000 TO 17000] and services.http.response.status_code: 200';

    try {
        const res = await axios.get(`https://search.censys.io/api/v2/hosts/search?q=${encodeURIComponent(query)}&per_page=15`, {
            headers: { 'Authorization': `Basic ${auth}` }
        });

        const hosts = res.data.result.hits;
        let links = [];

        for (const host of hosts) {
            const abertas = await scanIP(host.ip);
            abertas.forEach(p => links.push(`http://${host.ip}:${p}/live.ts`));
        }

        if (links.length > 0) {
            const uniqueLinks = [...new Set(links)];
            const conteudo = uniqueLinks.join('\n');
            
            // Monta o M3U
            let m3u = "#EXTM3U\n";
            uniqueLinks.forEach((l, i) => m3u += `#EXTINF:-1, Canal ${i+1}\n${l}\n`);

            // Envia os dois arquivos
            await ctx.replyWithDocument({ source: Buffer.from(conteudo), filename: 'canais.txt' });
            await ctx.replyWithDocument({ source: Buffer.from(m3u), filename: 'lista.m3u' });
            await ctx.reply(`✅ Scanner finalizado! Encontrados ${uniqueLinks.length} links.`);
        } else {
            await ctx.reply("⚠️ Nenhum IP com porta aberta respondeu no momento.");
        }
    } catch (err) {
        await ctx.reply("❌ Erro ao processar: " + err.message);
    }
});

bot.launch();
console.log("🤖 Bot rodando e aguardando comando 'video/mp2t'...");
