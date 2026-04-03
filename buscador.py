import os
import requests
from censys.search import CensysHosts

# --- CONFIGURAÇÕES ---
CENSYS_TOKEN = os.getenv("CENSYS_TOKEN")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

try:
    parts = CENSYS_TOKEN.split('_')
    CENSYS_ID, CENSYS_SECRET = parts[1], parts[2]
except:
    CENSYS_ID = CENSYS_SECRET = None

def enviar_telegram(msg, arquivo_nome=None, conteudo=None):
    base_url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
    if arquivo_nome and conteudo:
        requests.post(f"{base_url}/sendDocument", data={"chat_id": TELEGRAM_CHAT_ID, "caption": msg}, files={"document": (arquivo_nome, conteudo)})
    else:
        requests.post(f"{base_url}/sendMessage", json={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"})

def scanner_direto():
    if not CENSYS_ID:
        return
    
    enviar_telegram("🔎 *Iniciando Extração de IPs...*\nRange: 14000-17000\nFiltro: video/mp2t")
    
    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    # Query focada no que você pediu
    query = 'services.port: [14000 TO 17000] and services.http.response.headers.content_type: "video/mp2t"'
    
    ips_encontrados = []
    
    try:
        # Puxa 20 páginas (1000 hosts em potencial)
        for page in h.search(query, pages=20):
            for host in page:
                ip = host['ip']
                for service in host.get('services', []):
                    porta = service.get('port')
                    # Filtro rígido de porta no código
                    if 14000 <= porta <= 17000:
                        ips_encontrados.append(f"{ip}:{porta}")
                        print(f"📍 Extraído: {ip}:{porta}")
    except Exception as e:
        enviar_telegram(f"❌ Erro no Censys: {e}")
        return

    if ips_encontrados:
        # Remove duplicados e gera o texto
        lista_unica = sorted(list(set(ips_encontrados)))
        texto_final = "\n".join(lista_unica)
        
        msg_sucesso = f"✅ *Extração Concluída!*\nEncontrados `{len(lista_unica)}` endereços no range escolhido."
        enviar_telegram(msg_sucesso, "ips_extraidos.txt", texto_final)
    else:
        enviar_telegram("⚠️ O Censys não retornou nenhum IP nesse range com esse filtro no momento.")

if __name__ == "__main__":
    scanner_direto()
