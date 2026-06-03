# EstacionaEDGE

App de vagas do Centenário Office — quem está em cada vaga, liberar/ocupar vaga e
chamar pelo WhatsApp quem está bloqueando a saída.

**Produção:** https://estacionaedge.baluarte.dev.br

## Como funciona

- `frontend.html` — **fonte** do frontend (HTML/CSS/JS único, sem build de framework).
- `app/build-html.mjs` — gera `app/public/index.html` injetando o shim `window.storage`:
  - **escopo compartilhado** (ocupação das vagas, chamadas, lista de espera, avisos de
    "vaga vazia", sugestões, cadastro de usuários) → API REST `/api/kv` → Postgres →
    visível para **todos**.
  - **escopo pessoal** (tema, telefone logado) → `localStorage` (por dispositivo).

### Tempo real, sem polling
O frontend **não** fica buscando o estado de tempos em tempos. Ele abre **uma** conexão
SSE em `GET /api/events`; o servidor só escreve quando **alguém faz uma ação** e manda
**apenas os ids que mudaram** (ocupação/chamadas/espera/avisos ou a sugestão alterada),
nunca o estado inteiro. O cliente aplica o delta na hora. Uma reconciliação completa só
acontece em reconexão ou ao reativar a aba (orientado a evento, não a tempo). O keep-alive
do SSE é servidor→cliente (não é o cliente fazendo requisições). Em ambiente sem backend
(abrir o HTML solto) o SSE fica desligado e o app continua funcionando.
### Estado autoritativo (anti-abuso)
A chave `state` (ocupação + chamadas + lista de espera + avisos de "vaga vazia") **não**
é gravada como blob cru: o servidor lê o estado atual, identifica quem age pelo header
`X-Actor` (telefone logado, enviado pelo shim a partir do `localStorage`) e aplica só o
permitido — você ocupa apenas vaga livre como você mesmo, só libera a sua, um telefone
nunca fica em duas vagas, e na lista de espera/avisos cada um só mexe em si próprio.
Tudo numa transação com advisory lock (sem perda por concorrência) + reset diário no
servidor (timezone America/Sao_Paulo) + rate limit por IP nas escritas + validação de
telefone BR e schema. Edições ilegítimas são silenciosamente neutralizadas (HTTP 200 sem
efeito). `SLOT_TYPE` no server espelha o `VAGAS` do `frontend.html` — mudou a planta das
vagas, atualize os dois.

### Vaga marcada como cheia, mas sem carro
Em uma vaga ocupada por outra pessoa há o botão **"Sem carro?"**, que abre uma folha com
duas ações: **avisar que pode estar vazia** (mostra um chip ⚠️ "pode estar vazia" ao lado
do nome, sem mudar o ocupante) ou **estacionar aqui** (assume a vaga no lugar de quem
estava). Os avisos ficam em `state.disputes` e cada pessoa só registra/retira o próprio.
O *takeover* é controlado no servidor: só **você se colocando**, **apenas** numa vaga que
você mesmo marcou como vazia na mesma requisição (autorização), e **desde que não esteja
estacionado** em outro lugar; ao assumir, os avisos daquela vaga são limpos. Qualquer
outra troca de ocupante continua sendo ignorada.

### Sugestões
A chave `suggestions` (persistente, sem reset diário) guarda as ideias enviadas, com
votos 👍/👎 (cada um só mexe no próprio voto) e um flag **`implemented`** que qualquer
pessoa logada pode marcar/desmarcar — a sugestão ganha um selo "Implementada".

- `app/server.js` — Express: serve o frontend estático + KV store:
  - `GET /api/events` → stream SSE com os deltas (ids alterados)
  - `GET /api/kv/:key` → `{value}` | 404 (`state`, `suggestions`, `user:<telefone>`)
  - `PUT /api/kv/:key` (body `{value:string}`) → `{value}` (aplicação autoritativa)
  - `DELETE /api/kv/:key` → `{deleted:true}`
  - `GET /api/health`

## Infra (VPS 212.85.20.210)

| Item        | Valor                                                         |
|-------------|---------------------------------------------------------------|
| Domínio     | estacionaedge.baluarte.dev.br (DNS → VPS, SSL Let's Encrypt)   |
| App         | PM2 `estacionaedge`, Node/Express, `127.0.0.1:3100`           |
| Diretório   | `/opt/estacionaedge` (`.env` com `DATABASE_URL`/`PORT`)        |
| Banco       | `estacionaedge` no container `baluarte-postgres` (5433)        |
| DB role     | `estacionaedge_app` (tabela `kv`)                             |
| nginx       | `/etc/nginx/sites-available/estacionaedge.baluarte.dev.br`     |
| Monitoramento | Grafana — dashboard "App — EstacionaEDGE" (`grafana.baluarte.dev.br/d/app-estacionaedge`) |

O banco é **isolado** dos outros apps (psiclinic etc.) — mesmo Postgres, database próprio.

## Monitoramento (Grafana)

Métricas no Grafana/Prometheus da VPS: status/CPU/RAM/uptime/restarts via PM2 e
saúde do banco (`pg_stat_database` do database `estacionaedge`). Artefatos versionados
em `monitoring/` (dashboard + entry do process-exporter). Detalhes e deploy:
`monitoring/README.md`.

## Editar e publicar

1. Edite `frontend.html`.
2. `cd ../_ops && python deploy_estacionaedge.py` (rebuild + upload + `pm2 reload` + health check).

Auth no VPS via chave `~/.ssh/psiclinic_ops_ed25519`.

> **nginx + SSE:** o endpoint `/api/events` é um stream de longa duração. A resposta já
> manda `X-Accel-Buffering: no` (o nginx respeita e desliga o buffer), mas confirme um
> `proxy_read_timeout` alto (ex.: 1h) no bloco do site para a conexão não cair cedo, e que
> não há buffering/cache nessa rota.

## Dev local

```bash
cd app
cp .env.example .env   # ajuste DATABASE_URL (ex.: túnel SSH p/ o Postgres prod)
npm install
node build-html.mjs
npm start              # http://127.0.0.1:3100
```
