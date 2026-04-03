import os
import requests
from censys.search import CensysHosts
from collections import defaultdict

# --- CONFIGURAÇÕES (Lidas do GitHub Secrets) ---
# Você deve criar o Secret 'CENSYS_TOKEN' com aquele valor censys_xxxx_yyyy
FULL_TOKEN = os.getenv("CENSYS_TOKEN")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

# Divide o token para extrair ID e Secret
try:
    parts = FULL_TOKEN.split('_')
    CENSYS_ID = parts[1]
    CENSYS_SECRET = parts[2]
except (AttributeError, IndexError):
    print("❌ Erro: CENSYS_TOKEN não encontrado ou em formato inválido!")
    CENSYS_ID = None
    CENSYS_SECRET = None

def verificar_stream(ip, porta):
    """Verifica se o stream está online e aberto (200 OK)"""
    url = f"http://{ip}:{porta}/live.ts"
    try:
        # stream=True para ler apenas o cabeçalho e não baixar o vídeo
        with requests.get(url, timeout=3, stream=True) as r:
            if r.status_code == 200:
                return True
    except:
        pass
    return False

def buscar_e_escanear():
    if not CENSYS_ID or not CENSYS_SECRET:
        return {}, 0

    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    
    # Query focada no seu range e tipo de conteúdo (MPEG-TS)
    query = 'services.port: [14000 TO 17000] and services.http.response.headers.content_type: "video/mp2t"'
    
    print(f"🔎 Acessando Censys e filtrando portas 14000-17000...")
    resultados_por_org = defaultdict(list)
    total_canais = 0

    try:
        # Busca a primeira página (50 hosts)
        for page in h.search(query, pages=1):
            for host in page:
                ip = host['ip']
                # Pega a "Organization" (ASN Name)
                org = host.get('autonomous_system', {}).get('name', 'Servidor Desconhecido')
                
                # O Censys traz os serviços do host, filtramos a porta exata
                for service in host.get('services', []):
                    porta = service.get('port')
                    if 14000 <= porta <= 17000:
                        if verificar_stream(ip, porta):
                            url = f"http://{ip}:{porta}/live.ts"
                            resultados_por_org[org].append(url)
                            total_canais += 1
                            print(f"✅ Aberto: {url} | Org: {org}")
    except Exception as e:
        print(f"Erro na busca do Censys: {e}")

    return resultados_por_org, total_canais

def gerar_arquivos_e_enviar(dados, total):
    if total == 0:
        print("⚠️ Nenhum canal aberto encontrado hoje.")
        # Envia aviso ao Telegram mesmo se não achar nada
        base_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
        requests.post(f"{base_url}/sendMessage", json={
            "chat_id": TELEGRAM_CHAT_ID, 
            "text": "⚠️ *Varredura concluída:* Nenhum IP novo encontrado nas portas 14000-17000.", 
            "parse_mode": "Markdown"
        })
        return

    # 1. Preparar conteúdos
    m3u_content = "#EXTM3U\n"
    txt_content = ""
    resumo_msg = f"🛰 **Varredura Censys Concluída!**\n\n📺 Canais abertos: `{total}`\n\n"

    for org, urls in dados.items():
        resumo_msg += f"🏢 *{org}*: {len(urls)} canais\n"
        for i, url in enumerate(urls):
            m3u_content += f"#EXTINF:-1, [FHD] {org} - Ch {i+1}\n{url}\n"
            txt_content += f"{url}\n"

    # 2. Enviar para o Telegram via API
    base_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
    
    # Mensagem de Texto
    requests.post(f"{base_url}/sendMessage", json={
        "chat_id": TELEGRAM_CHAT_ID, 
        "text": resumo_msg, 
        "parse_mode": "Markdown"
    })

    # Arquivo TXT (Só IPs)
    requests.post(f"{base_url}/sendDocument", 
        data={"chat_id": TELEGRAM_CHAT_ID},
        files={"document": ("lista_ips.txt", txt_content)})

    # Arquivo M3U (Lista pronta)
    requests.post(f"{base_url}/sendDocument", 
        data={"chat_id": TELEGRAM_CHAT_ID},
        files={"document": ("canais_abertos.m3u", m3u_content)})
    
    print(f"🚀 Sucesso! {total} canais enviados ao Telegram.")

if __name__ == "__main__":
    canais_dados, total_encontrado = buscar_e_escanear()
    gerar_arquivos_e_enviar(canais_dados, total_encontrado)
