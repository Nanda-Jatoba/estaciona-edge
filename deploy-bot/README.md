# EstacionaEDGE | deploy-bot

Dispara o deploy do EstacionaEDGE por **mensagem de WhatsApp**. Roda no próprio VPS,
recebe o webhook do gateway de WhatsApp (OpenWA) e, quando chega a **palavra-gatilho
secreta**, executa o `deploy.sh` (git pull + build + `pm2 reload`) e responde com o status.

```
WhatsApp ──► OpenWA ──webhook(message.received)──► deploy-bot (172.21.0.1:3200)
                                                        │ valida palavra-gatilho
                                                        ▼
                                              deploy.sh (git pull + build + pm2 reload)
                                                        │
                    resposta no WhatsApp ◄── send-text ─┘  (ok / erro + health)
```

## Como funciona

- Só reage a mensagens cujo texto bate **exatamente** com `TRIGGER_PHRASE` (case-insensitive).
  Qualquer outra mensagem ao número é ignorada pelo bot.
- Ignora mensagens de grupos e canais, e mensagens enviadas pelo próprio número (`fromMe`).
- Trava `deploying` impede dois deploys simultâneos.
- A confirmação vai para quem enviou se o WhatsApp expõe o telefone (`@c.us`);
  se o remetente vier como `@lid` (privacidade), cai no `NOTIFY_NUMBER`.
- `ALLOWED_NUMBERS` (opcional) restringe quem pode disparar.
- Zero dependências: `http` nativo + `fetch` global + `child_process`.

## Variáveis de ambiente

A configuração usa o prefixo neutro `WHATSAPP_*` em vez do nome do fornecedor.
Assim uma futura troca de gateway não obriga a renomear tudo de novo, como
aconteceu na migração do Evolution API para o OpenWA.

| Variável | Para que serve |
|---|---|
| `WHATSAPP_API_URL` | Base do gateway, ex. `http://127.0.0.1:2786` |
| `WHATSAPP_API_KEY` | Header `x-api-key` do OpenWA |
| `WHATSAPP_SESSION_ID` | UUID da sessão que envia e recebe |

## Rede (gateway em Docker)

O gateway roda em container e o webhook dele **não** enxerga o `127.0.0.1` do host.
Por isso o bot escuta no gateway da bridge Docker (`BOT_HOST=172.21.0.1`), que é
privado e não exposto na internet.

Atenção: o OpenWA tem um guard de SSRF que recusa webhook para endereço privado.
Esse mesmo IP precisa constar em `SSRF_ALLOWED_HOSTS` no `.env` do OpenWA, senão a
entrega é barrada antes de sair.

## Instalação no VPS (uma vez)

```bash
# 1. clone-fonte que o deploy.sh usa pra dar git pull
git clone https://github.com/Nanda-Jatoba/estaciona-edge.git /opt/estacionaedge-src

# 2. configura o bot
cd /opt/estacionaedge-src/deploy-bot
cp .env.example .env
nano .env            # api key, session id, TRIGGER_PHRASE secreta, NOTIFY_NUMBER
chmod +x deploy.sh

# 3. sobe via pm2
pm2 start ecosystem.config.js && pm2 save

# 4. registra o webhook na sessão do OpenWA (aponta pro gateway, não 127.0.0.1)
curl -X POST http://127.0.0.1:2786/api/webhooks \
  -H "x-api-key: $WHATSAPP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"sessionId":"'"$WHATSAPP_SESSION_ID"'","url":"http://172.21.0.1:3200/webhook","events":["message.received"]}'
```

Não existe `PATCH` de webhook no OpenWA: para mudar a lista de eventos ou a URL,
apague o webhook (`DELETE /api/webhooks/{id}`) e recrie.

## Atualizar o bot

O `deploy.sh` faz `git reset --hard origin/main` no clone, então o próprio código do
bot é atualizado no pull (o `.env` é preservado por ser gitignored). Por isso, editar
`server.js` direto no VPS não adianta: o primeiro deploy seguinte desfaz a mudança.
Mude aqui no repositório, faça push e depois `pm2 reload estacionaedge-deploybot`.

## Disparar

Mande a palavra-gatilho secreta por WhatsApp para **558299048816**. O bot responde
com o andamento e o resultado (incluindo o commit publicado e o health check).
