import os
import requests
from censys.search import CensysHosts

# --- VARIÁVEIS COM NOMES PADRONIZADOS ---
# Certifique-se que no GitHub os nomes estão EXATAMENTE assim:
TOKEN_BOT = os.getenv("TELEGRAM_TOKEN")
MEU_ID = os.getenv("TELEGRAM_CHAT_ID")
CENSYS_CHAVE = os.getenv("CENSYS_TOKEN")

# Organiza as chaves do Censys
try:
    parts = CENSYS_CHAVE.split('_')
    C_ID, C_SECRET = parts[1], parts[2]
except:
    C_ID = C_SECRET = None

def enviar_ao_telegram(mensagem, nome_arquivo=None, dados=None):
    url_base = f"https://api.telegram.org/bot{TOKEN_BOT}"
    
    if nome_arquivo and dados:
        # Envia o arquivo TXT com a lista
        requests.post(f"{url_base}/sendDocument", 
                      data={"chat_id": MEU_ID, "caption": mensagem}, 
                      files={"document": (nome_arquivo, dados)})
    else:
        # Envia apenas o aviso de texto
        requests.post(f"{url_base}/sendMessage", 
                      json={"chat_id": MEU_ID, "text": mensagem, "parse_mode": "Markdown"})

def iniciar_extracao():
    if not C_ID or not TOKEN_BOT:
        print("Erro: Verifique os nomes dos Secrets no GitHub!")
        return

    enviar_ao_telegram("🚀 *Iniciando busca definitiva...*\nRange: 14000-17000\nFiltro: Status 200 OK")

    h = CensysHosts(api_id=C_ID, api_secret=C_SECRET)
    # Query que achou os IPs na sua foto
    query = 'services.port: [14000 TO 17000] and services.http.response.status_code: 200'
    
    lista_links = []

    try:
        # Busca 10 páginas de resultados
        for page in h.search(query, pages=10):
            for host in page:
                ip = host['ip']
                for service in host.get('services', []):
                    porta = service.get('port')
                    if 14000 <= porta <= 17000:
                        # Monta o link bruto com /live.ts
                        lista_links.append(f"http://{ip}:{porta}/live.ts")
    except Exception as e:
        enviar_ao_telegram(f"❌ Erro na busca: {e}")
        return

    if lista_links:
        # Tira IPs repetidos e cria o texto
        final = "\n".join(sorted(list(set(lista_links))))
        enviar_ao_telegram(f"✅ *Pronto!* Encontrados `{len(lista_links)}` links.", 
                           "lista_iptv.txt", final)
    else:
        enviar_ao_telegram("⚠️ Nenhum IP com porta aberta encontrado agora.")

if __name__ == "__main__":
    iniciar_extracao()
