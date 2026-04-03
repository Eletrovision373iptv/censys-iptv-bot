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
        if files:
            requests.post(url, data=payload, files=files, timeout=20)
        else:
            requests.post(url, json=payload, timeout=20)
    except:
        pass

def verificar_stream(ip, porta):
    """Verifica manualmente o IP e porta no formato TS"""
    url = f"http://{ip}:{porta}/live.ts"
    try:
        # Aumentei o timeout para 5 segundos para não perder IPs lentos
        # stream=True permite checar apenas o início do arquivo (header)
        with requests.get(url, timeout=5.0, stream=True) as r:
            if r.status_code == 200:
                # Verifica se o servidor está entregando vídeo mesmo
                if "video" in r.headers.get("Content-Type", "") or r.headers.get("Server") == "MPEG-TS":
                    return True
    except:
        pass
    return False

def buscar_e_escanear():
    if not CENSYS_ID: return {}, 0
    
    enviar_telegram("sendMessage", {"chat_id": TELEGRAM_CHAT_ID, "text": "🔎 *Busca Restrita:* Portas 14000 a 17000\nFiltro: video/mp2t", "parse_mode": "Markdown"})
    
    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    
    # QUERY EXATA: Apenas o seu range e apenas conteúdo de vídeo
    query = 'services.port: [14000 TO 17000] and services.http.response.headers.content_type: "video/mp2t"'
    
    resultados = defaultdict(list)
    total = 0

    try:
        # Varre 10 páginas (500 hosts) para garantir volume
        for page in h.search(query, pages=10):
            for host in page:
                ip = host['ip']
                org = host.get('autonomous_system', {}).get('name', 'Servidor')
                
                for service in host.get('services', []):
                    porta = service.get('port')
                    # Trava de segurança no código para garantir o range
                    if 14000 <= porta <= 17000:
                        if verificar_stream(ip, porta):
                            url = f"http://{ip}:{porta}/live.ts"
                            resultados[org].append(url)
                            total += 1
                            print(f"✅ CONECTADO: {url}")
    except Exception as e:
        print(f"Erro na busca: {e}")

    return resultados, total

def enviar_resultados(dados, total):
    if total == 0:
        enviar_telegram("sendMessage", {"chat_id": TELEGRAM_CHAT_ID, "text": "⚠️ Varredura terminada. Encontrei IPs no Censys, mas nenhum respondeu ao teste '200 OK' no momento."})
        return

    m3u = "#EXTM3U\n"
    txt = ""
    for org, urls in dados.items():
        for i, url in enumerate(urls):
            m3u += f"#EXTINF:-1, {org} - Canal {i+1}\n{url}\n"
            txt += f"{url}\n"

    enviar_telegram("sendMessage", {"chat_id": TELEGRAM_CHAT_ID, "text": f"🎯 **Alvos Encontrados!**\nTotal no seu range: `{total}`", "parse_mode": "Markdown"})
    
    # Envio dos arquivos
    url_doc = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendDocument"
    requests.post(url_doc, data={"chat_id": TELEGRAM_CHAT_ID}, files={"document": ("lista_ips.txt", txt)})
    requests.post(url_doc, data={"chat_id": TELEGRAM_CHAT_ID}, files={"document": ("canais.m3u", m3u)})

if __name__ == "__main__":
    canais, qtd = buscar_e_escanear()
    enviar_resultados(canais, qtd)
