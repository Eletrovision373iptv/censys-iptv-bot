def buscar_e_escanear():
    if not CENSYS_ID or not CENSYS_SECRET:
        return {}, 0

    enviar_aviso_telegram("🛰 *Iniciando busca global...* (Isso pode demorar 1-2 minutos)")

    h = CensysHosts(api_id=CENSYS_ID, api_secret=CENSYS_SECRET)
    
    # Query ampliada: busca qualquer servidor com cabeçalho de vídeo MPEG-TS
    query = 'services.http.response.headers.content_type: "video/mp2t"'
    
    print(f"🔎 Buscando em toda a base do Censys...")
    resultados_por_org = defaultdict(list)
    total_canais = 0

    try:
        # Olhar as primeiras 10 páginas (500 resultados)
        for page in h.search(query, pages=10):
            for host in page:
                ip = host['ip']
                org = host.get('autonomous_system', {}).get('name', 'Servidor Desconhecido')
                
                for service in host.get('services', []):
                    porta = service.get('port')
                    # Tenta verificar se o stream está aberto
                    if verificar_stream(ip, porta):
                        url = f"http://{ip}:{porta}/live.ts"
                        resultados_por_org[org].append(url)
                        total_canais += 1
                        print(f"✅ ABERTO: {url}")
    except Exception as e:
        print(f"Erro: {e}")

    return resultados_por_org, total_canais
