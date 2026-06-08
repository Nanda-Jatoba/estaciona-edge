# EstacionaEDGE — deploy-bot

Dispara o deploy do EstacionaEDGE por **mensagem de WhatsApp**. Roda no próprio VPS,
recebe o webhook da Evolution API e, quando chega a **palavra-gatilho secreta**,
executa o `deploy.sh` (git pull + build + `pm2 reload`) e responde com o status.

```
WhatsApp ──► Evolution API ──webhook(MESSAGES_UPSERT)──► deploy-bot (127.0.0.1:3200)
                                                              │ valida palavra-gatilho
                                                              ▼
                                                    deploy.sh (git pull + build + pm2 reload)
                                                              │
                          resposta no WhatsApp ◄── sendText ──┘  (✅ ok / ❌ erro + health)
```

## Como funciona

- Só reage a mensagens cujo texto bate **exatamente** com `TRIGGER_PHRASE` (case-insensitive).
  Qualquer outra mensagem ao número é ignorada pelo bot.
- Ignora mensagens de grupos e mensagens enviadas pelo próprio número (`fromMe`).
- Trava `deploying` impede dois deploys simultâneos.
- `ALLOWED_NUMBERS` (opcional) restringe quem pode disparar.
- Zero dependências: `http` nativo + `fetch` global + `child_process`. Nada exposto
  publicamente — ouve só em `127.0.0.1`, a Evolution chama localmente.

## Instalação no VPS (uma vez)

```bash
# 1. clone-fonte que o deploy.sh usa pra dar git pull
git clone https://github.com/Nanda-Jatoba/estaciona-edge.git /opt/estacionaedge-src

# 2. configura o bot
cd /opt/estacionaedge-src/deploy-bot
cp .env.example .env
nano .env            # apikey, instância, TRIGGER_PHRASE secreta
chmod +x deploy.sh

# 3. sobe via pm2
pm2 start ecosystem.config.js && pm2 save

# 4. registra o webhook na instância da Evolution
#    IMPORTANTE: a Evolution roda em container Docker — o webhook precisa apontar para
#    o gateway da bridge (BOT_HOST), NÃO para 127.0.0.1 (que seria o localhost do container).
curl -X POST http://127.0.0.1:8089/webhook/set/psiclinic-alerts \
  -H "apikey: $EVOLUTION_APIKEY" -H 'Content-Type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"http://172.20.0.1:3200/webhook","events":["MESSAGES_UPSERT"]}}'
```

## Atualizar o bot

O `deploy.sh` faz `git reset --hard origin/main` no clone, então o próprio código do
bot é atualizado no pull (o `.env` é preservado por ser gitignored). Para aplicar
mudanças no bot em si: `pm2 reload estacionaedge-deploybot`.

## Disparar

Mande a palavra-gatilho secreta por WhatsApp para **558299048816**. O bot responde
com o andamento e o resultado (incluindo o commit publicado e o health check).
