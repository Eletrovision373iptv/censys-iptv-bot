import os
import requests
from censys.search import CensysHosts
from collections import defaultdict

# --- CONFIGURAÇÕES (Lidas do GitHub Secrets) ---
FULL_TOKEN = os.getenv("CENSYS_TOKEN")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

# Divide o token único para extrair ID e Secret automaticamente
try:
    if FULL_TOKEN:
        parts = FULL_TOKEN.split('_')
        CENSYS_ID = parts[1]
        CENSYS_SECRET = parts[2]
    else:
        CENSYS_ID = None
        CENSYS_SECRET = None
except (AttributeError, IndexError):
    print("❌ Erro: CENSYS_TOKEN em formato inválido!")
    CENSYS_ID = None
    CENSYS_SECRET = None

def enviar_aviso_telegram(texto):
    """Função auxiliar para enviar avisos rápidos ao Telegram"""
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        requests.post(url, json={
            "chat_id": TELEGRAM_CHAT_ID, 
            "text": texto, 
            "parse_mode": "Markdown"
        }, timeout=10)
    except:
        pass

def verificar_stream(ip, porta):
    """Verifica se o stream está online e aberto (200 OK)"""
    url = f"http://{ip}:{porta}/live.ts"
    try:
        # stream=True lê apenas o cabeçalho para ser ultra rápido
        with requests.get(url, timeout=2.5, stream=True) as r:
            if r.status_code == 200:
                return True
    except:
        pass
    return False

def buscar_e_escanear():
    if not CENSYS_ID or not CENSYS_SECRET:
        print("❌ Chaves do Censys não configuradas corretamente.")
        return {}, 0

    # Avisa no Telegram que a varredura começou
    enviar_aviso_telegram("🛰 *Iniciando busca diária no Censys...*\nRange: 14000-17000")

    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    
    # Query focada no seu range e tipo de conteúdo (MPEG-TS)
    query = 'services.port: [14000 TO 17000] and services.http.response.headers.content_type: "video/mp2t"'
    
    print(f"🔎 Buscando no Censys...")
    resultados_por_org = defaultdict(list)
    total_canais = 0

    try:
        # Aumentamos para 5 páginas (250 resultados) para garantir que ache algo aberto
        for page in h.search(query, pages=5):
            for host in page:
                ip = host['ip']
                org = host.get('autonomous_system', {}).get('name', 'Servidor Desconhecido')
                
                for service in host.get('services', []):
                    porta = service.get('port')
                    if 14000 <= porta <= 17000:
                        if verificar_stream(ip, porta):
                            url = f"http://{ip}:{porta}/live.ts"
                            resultados_por_org[org].append(url)
                            total_canais += 1
                            print(f"✅ ON: {url} ({org})")
    except Exception as e:
        print(f"Erro no Censys: {e}")
        enviar_aviso_telegram(f"❌ *Erro no Censys:* {e}")

    return resultados_por_org, total_canais

def gerar_arquivos_e_enviar(dados, total):
    base_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"

    if total == 0:
        print("⚠️ Nada encontrado.")
        requests.post(f"{base_url}/sendMessage", json={
            "chat_id": TELEGRAM_CHAT_ID, 
            "text": "⚠️ *Varredura concluída:* Nenhum canal aberto (200 OK) encontrado no momento.", 
            "parse_mode": "Markdown"
        })
        return

    # 1. Preparar arquivos
    m3u_content = "#EXTM3U\n"
    txt_content = ""
    resumo_msg = f"✅ **Sucesso! Varredura Concluída**\n\n📺 Canais encontrados: `{total}`\n\n"

    for org, urls in dados.items():
        resumo_msg += f"🏢 *{org}*: {len(urls)} canais\n"
        for i, url in enumerate(urls):
            m3u_content += f"#EXTINF:-1, [FHD] {org} - {i+1}\n{url}\n"
            txt_content += f"{url}\n"

    # 2. Enviar Mensagem, TXT e M3U
    try:
        # Texto
        requests.post(f"{base_url}/sendMessage", json={
            "chat_id": TELEGRAM_CHAT_ID, "text": resumo_msg, "parse_mode": "Markdown"
        })
        # TXT
        requests.post(f"{base_url}/sendDocument", data={"chat_id": TELEGRAM_CHAT_ID},
            files={"document": ("lista_ips.txt", txt_content)})
        # M3U
        requests.post(f"{base_url}/sendDocument", data={"chat_id": TELEGRAM_CHAT_ID},
            files={"document": ("lista_iptv.m3u", m3u_content)})
        
        print("🚀 Arquivos enviados ao Telegram!")
    except Exception as e:
        print(f"Erro ao enviar para Telegram: {e}")

if __name__ == "__main__":
    canais_dados, total_encontrado = buscar_e_escanear()
    gerar_arquivos_e_enviar(canais_dados, total_encontrado)
