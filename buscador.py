import os
import requests
import urllib3
from censys.search import CensysHosts
from collections import defaultdict

# Desativa avisos de segurança para aceitar qualquer IP/Certificado
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CENSYS_TOKEN = os.getenv("CENSYS_TOKEN")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

try:
    parts = CENSYS_TOKEN.split('_')
    CENSYS_ID, CENSYS_SECRET = parts[1], parts[2]
except:
    CENSYS_ID = CENSYS_SECRET = None

def verificar_stream(ip, porta):
    url = f"http://{ip}:{porta}/live.ts"
    # Cabeçalho que simula um Player de IPTV (VLC/Perfect Player)
    headers = {'User-Agent': 'VLC/3.0.12 LibVLC/3.0.12'}
    try:
        # verify=False e timeout longo para ignorar erros de SSL/Rede
        r = requests.get(url, headers=headers, timeout=6, stream=True, verify=False)
        if r.status_code == 200:
            return True
    except:
        pass
    return False

def buscar_e_escanear():
    if not CENSYS_ID: return {}, 0
    
    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    # Sua query exata
    query = 'services.port: [14000 TO 17000] and services.http.response.headers.content_type: "video/mp2t"'
    
    resultados = defaultdict(list)
    total = 0

    print("🛰 Buscando no seu range 14k-17k...")
    try:
        # Varre 20 páginas (1000 resultados) para não deixar passar nada
        for page in h.search(query, pages=20):
            for host in page:
                ip = host['ip']
                org = host.get('autonomous_system', {}).get('name', 'Servidor')
                
                for service in host.get('services', []):
                    porta = service.get('port')
                    if 14000 <= porta <= 17000:
                        if verificar_stream(ip, porta):
                            url = f"http://{ip}:{porta}/live.ts"
                            resultados[org].append(url)
                            total += 1
                            print(f"✅ ABERTO: {url}")
    except Exception as e:
        print(f"Erro: {e}")

    return resultados, total

def enviar_resultados(dados, total):
    base_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
    
    if total == 0:
        requests.post(f"{base_url}/sendMessage", json={"chat_id": TELEGRAM_CHAT_ID, "text": "❌ O Censys retornou IPs, mas o teste de conexão falhou em todos. Verifique se o formato /live.ts está correto para esses IPs."})
        return

    m3u = "#EXTM3U\n"
    txt = ""
    for org, urls in dados.items():
        for i, url in enumerate(urls):
            m3u += f"#EXTINF:-1, {org} - {i+1}\n{url}\n"
            txt += f"{url}\n"

    requests.post(f"{base_url}/sendMessage", json={"chat_id": TELEGRAM_CHAT_ID, "text": f"🎯 **Varredura Completa!**\nEncontrados: `{total}` links no seu range.", "parse_mode": "Markdown"})
    requests.post(f"{base_url}/sendDocument", data={"chat_id": TELEGRAM_CHAT_ID}, files={"document": ("lista.m3u", m3u)})

if __name__ == "__main__":
    canais, qtd = buscar_e_escanear()
    enviar_resultados(canais, qtd)
