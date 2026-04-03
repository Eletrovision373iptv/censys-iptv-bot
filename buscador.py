import os
import requests
from censys.search import CensysHosts
from collections import defaultdict

# --- CONFIGURAÇÕES (Defina no GitHub Secrets) ---
CENSYS_ID = os.getenv("CENSYS_ID")
CENSYS_SECRET = os.getenv("CENSYS_SECRET")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

def verificar_stream(ip, porta):
    """Verifica se o stream está online e aberto (200 OK)"""
    url = f"http://{ip}:{porta}/live.ts"
    try:
        # stream=True para não baixar o vídeo, apenas ler o cabeçalho
        with requests.get(url, timeout=2.5, stream=True) as r:
            if r.status_code == 200:
                return True
    except:
        pass
    return False

def buscar_e_escanear():
    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    
    # Query focada no seu range e tipo de conteúdo
    query = 'services.port: [14000 TO 17000] and services.http.response.headers.content_type: "video/mp2t"'
    
    print("🔎 Acessando base de dados do Censys...")
    resultados_por_org = defaultdict(list)
    total_canais = 0

    try:
        # Busca a primeira página de resultados
        for page in h.search(query, pages=1):
            for host in page:
                ip = host['ip']
                # Pega a "Organization" (Ex: CDN77, DigitalOcean, etc)
                org = host.get('autonomous_system', {}).get('name', 'Servidor Desconhecido')
                
                for service in host.get('services', []):
                    porta = service.get('port')
                    if 14000 <= porta <= 17000:
                        if verificar_stream(ip, porta):
                            url = f"http://{ip}:{porta}/live.ts"
                            resultados_por_org[org].append(url)
                            total_canais += 1
                            print(f"✅ Achado: {url} ({org})")
    except Exception as e:
        print(f"Erro na busca: {e}")

    return resultados_por_org, total_canais

def gerar_arquivos_e_enviar(dados, total):
    if total == 0:
        return

    # 1. Criar texto da M3U e Lista TXT
    m3u_content = "#EXTM3U\n"
    txt_content = ""
    resumo_msg = f"🛰 **Varredura Censys Concluída!**\n\n📺 Total de canais abertos: `{total}`\n\n"

    for org, urls in dados.items():
        resumo_msg += f"🏢 *{org}*: {len(urls)} canais\n"
        for i, url in enumerate(urls):
            m3u_content += f"#EXTINF:-1, [FHD] {org} - Ch {i+1}\n{url}\n"
            txt_content += f"{url}\n"

    # 2. Enviar Mensagem de Resumo
    base_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
    requests.post(f"{base_url}/sendMessage", json={
        "chat_id": TELEGRAM_CHAT_ID, 
        "text": resumo_msg, 
        "parse_mode": "Markdown"
    })

    # 3. Enviar Arquivo .TXT
    requests.post(f"{base_url}/sendDocument", 
        data={"chat_id": TELEGRAM_CHAT_ID},
        files={"document": ("lista_ips.txt", txt_content)})

    # 4. Enviar Arquivo .M3U
    requests.post(f"{base_url}/sendDocument", 
        data={"chat_id": TELEGRAM_CHAT_ID},
        files={"document": ("canais_abertos.m3u", m3u_content)})

if __name__ == "__main__":
    canais_dados, total_encontrado = buscar_e_escanear()
    gerar_arquivos_e_enviar(canais_dados, total_encontrado)
