import os
import requests
from censys.search import CensysHosts

# --- CONFIGURAÇÕES DE AMBIENTE ---
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
        requests.post(f"{base_url}/sendDocument", 
                      data={"chat_id": TELEGRAM_CHAT_ID, "caption": msg}, 
                      files={"document": (arquivo_nome, conteudo)})
    else:
        requests.post(f"{base_url}/sendMessage", 
                      json={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"})

def teste_extracao_bruta():
    if not CENSYS_ID:
        print("Erro: Verifique seus Secrets no GitHub.")
        return
    
    enviar_telegram("🧪 *Iniciando Teste de Extração...*\nBuscando exatamente como na foto (Status 200)")
    
    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    
    # Query baseada na sua imagem: Porta no range e resposta 200 OK
    query = 'services.port: [14000 TO 17000] and services.http.response.status_code: 200'
    
    links = []
    
    try:
        # Puxa 5 páginas para o teste ser rápido (250 resultados)
        for page in h.search(query, pages=5):
            for host in page:
                ip = host['ip']
                for service in host.get('services', []):
                    porta = service.get('port')
                    
                    # Filtro de segurança para manter no seu range
                    if 14000 <= porta <= 17000:
                        link = f"http://{ip}:{porta}/live.ts"
                        links.append(link)
                        print(f"📍 Extraído: {link}")
    except Exception as e:
        enviar_telegram(f"❌ Erro na API: {e}")
        return

    if links:
        # Remove duplicados e gera o TXT
        lista_final = sorted(list(set(links)))
        txt_data = "\n".join(lista_final)
        
        enviar_telegram(f"✅ *Teste Concluído!*\nEncontrados: `{len(lista_final)}` links.", 
                        "teste_lista.txt", txt_data)
    else:
        enviar_telegram("⚠️ O Censys não retornou nada com 'status_code: 200' nesse range agora.")

if __name__ == "__main__":
    teste_extracao_bruta()
