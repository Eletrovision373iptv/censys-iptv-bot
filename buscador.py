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
        # Envia o arquivo TXT
        requests.post(f"{base_url}/sendDocument", 
                      data={"chat_id": TELEGRAM_CHAT_ID, "caption": msg}, 
                      files={"document": (arquivo_nome, conteudo)})
    else:
        # Envia apenas mensagem de texto
        requests.post(f"{base_url}/sendMessage", 
                      json={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"})

def rodar_extrator():
    if not CENSYS_ID:
        print("Erro: CENSYS_TOKEN não configurado corretamente.")
        return
    
    enviar_telegram("🔎 *Iniciando Extração Bruta...*\nRange: 14000-17000\nFormato: `http://ip:porta/live.ts`")
    
    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    # Query focada no seu range e em serviços de vídeo
    query = 'services.port: [14000 TO 17000] and services.http.response.headers.content_type: "video/mp2t"'
    
    links_gerados = []
    
    try:
        # Varre 20 páginas para pegar o máximo de IPs possível (até 1000)
        for page in h.search(query, pages=20):
            for host in page:
                ip = host['ip']
                for service in host.get('services', []):
                    porta = service.get('port')
                    
                    # Filtra apenas o range que você quer
                    if 14000 <= porta <= 17000:
                        # Monta o link exatamente como você pediu
                        link_formatado = f"http://{ip}:{porta}/live.ts"
                        links_gerados.append(link_formatado)
                        print(f"📍 Adicionado: {link_formatado}")
                        
    except Exception as e:
        enviar_telegram(f"❌ Erro na API do Censys: {e}")
        return

    if links_gerados:
        # Remove duplicados (caso o mesmo IP apareça mais de uma vez)
        lista_final = sorted(list(set(links_gerados)))
        conteudo_txt = "\n".join(lista_final)
        
        status_msg = f"✅ *Extração Concluída!*\nTotal de links gerados: `{len(lista_final)}`"
        enviar_telegram(status_msg, "lista_iptv_censys.txt", conteudo_txt)
    else:
        enviar_telegram("⚠️ O Censys não encontrou nenhum IP nesse range com filtro de vídeo agora.")

if __name__ == "__main__":
    rodar_extrator()
