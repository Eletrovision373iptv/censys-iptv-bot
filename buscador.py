import os
import requests
from censys.search import CensysHosts
from collections import defaultdict

# --- CONFIGURAÇÕES ---
FULL_TOKEN = os.getenv("CENSYS_TOKEN")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

try:
    parts = FULL_TOKEN.split('_')
    CENSYS_ID = parts[1]
    CENSYS_SECRET = parts[2]
except:
    CENSYS_ID = CENSYS_SECRET = None

def enviar_telegram(endpoint, payload=None, files=None):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/{endpoint}"
    try:
        requests.post(url, data=payload, json=payload if not files else None, files=files, timeout=15)
    except:
        pass

def verificar_stream(ip, porta):
    """Verifica rápido se o canal está aberto"""
    url = f"http://{ip}:{porta}/live.ts"
    try:
        # Timeout de 1.5s para não travar o script
        with requests.get(url, timeout=1.5, stream=True) as r:
            if r.status_code == 200:
                return True
    except:
        pass
    return False

def buscar_e_escanear():
    if not CENSYS_ID: return {}, 0
    
    enviar_telegram("sendMessage", {"chat_id": TELEGRAM_CHAT_ID, "text": "🔎 *Iniciando Varredura Otimizada...*", "parse_mode": "Markdown"})
    
    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    
    # Query certeira: Portas de IPTV (80, 8000, 8080, 14000-17000) com vídeo
    query = '(services.port: [80, 8000, 8080] or services.port: [14000 TO 17000]) and services.http.response.headers.content_type: "video/mp2t"'
    
    resultados = defaultdict(list)
    total = 0

    try:
        # 4 páginas é o ideal para o GitHub não cancelar (200 IPs)
        for page in h.search(query, pages=4):
            for host in page:
                ip = host['ip']
                org = host.get('autonomous_system', {}).get('name', 'Servidor')
                for service in host.get('services', []):
                    porta = service.get('port')
                    if verificar_stream(ip, porta):
                        url = f"http://{ip}:{porta}/live.ts"
                        resultados[org].append(url)
                        total += 1
                        print(f"✅ Achado: {url}")
    except Exception as e:
        print(f"Erro: {e}")

    return resultados, total

def enviar_resultados(dados, total):
    if total == 0:
        enviar_telegram("sendMessage", {"chat_id": TELEGRAM_CHAT_ID, "text": "⚠️ Nada aberto encontrado nesta rodada."})
        return

    m3u = "#EXTM3U\n"
    txt = ""
    for org, urls in dados.items():
        for i, url in enumerate(urls):
            m3u += f"#EXTINF:-1, {org} - {i+1}\n{url}\n"
            txt += f"{url}\n"

    enviar_telegram("sendMessage", {"chat_id": TELEGRAM_CHAT_ID, "text": f"✅ **Varredura Finalizada!**\n📺 Canais: `{total}`", "parse_mode": "Markdown"})
    enviar_telegram("sendDocument", {"chat_id": TELEGRAM_CHAT_ID}, files={"document": ("lista.txt", txt)})
    enviar_telegram("sendDocument", {"chat_id": TELEGRAM_CHAT_ID}, files={"document": ("lista.m3u", m3u)})

if __name__ == "__main__":
    canais, qtd = buscar_e_escanear()
    enviar_resultados(canais, qtd)
