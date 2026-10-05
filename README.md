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

### Vaga livre no sistema, mas pode ter carro sem cadastro
Em uma vaga **livre**, a linha mostra só a ação principal (**Estacionar**) e um menu **⋮**
de opções. Pelo menu dá para **avisar que pode estar ocupada** (alguém estacionou sem
marcar no sistema). Aparece um chip 🔴 "pode estar ocupada" ao lado de "Livre", sem mudar
o status da vaga. Os avisos ficam em `state.occupiedAlerts` e cada pessoa só registra/retira
o próprio. No servidor o aviso é validado: cada um só mexe no seu (pelo header `X-Actor`) e
o aviso **só vale enquanto a vaga estiver livre** — assim que alguém de fato registra a
vaga, os avisos dela são descartados automaticamente. É o caso espelhado de "Sem carro?"
(vaga ocupada sem carro).

### Ranking de uso
Ícone de troféu no topo → página **Ranking** com quem mais usa as vagas, a
**vaga favorita** de cada um e filtro **Este mês / Geral**. Como o `state` zera todo dia,
o servidor grava o histórico na tabela `parking_sessions` — uma linha por sessão
(estacionou → liberou), aberta/fechada na mesma transação em que a ocupação muda
(inclusive takeover). Sessão que fica aberta quando o dia vira conta até a meia-noite.

- **Um dia só conta com pelo menos 2h na vaga** (`RANK_MIN_MINUTES`, somando as sessões do
  dia) — quem marca sem querer e libera logo não entra. É só uma verificação no
  servidor: o tempo não aparece no app nem é exposto pela API. Sair e voltar no mesmo dia conta 1.
- Favorita = vaga presente em mais dias contados (empate → mais tempo total).
- Empates de dias dividem a posição. O endpoint não expõe telefones; `me` vem do `X-Actor`.
- O histórico começa a contar a partir do deploy desta versão.
- O ranking nunca bloqueia o estacionamento: se a tabela não puder ser criada, o app sobe
  sem ranking (`/api/ranking` → 503); se gravar o histórico falhar, só o histórico é
  desfeito (savepoint) e a vaga é gravada normalmente.

### Sugestões
A chave `suggestions` (persistente, sem reset diário) guarda as ideias enviadas, com
votos 👍/👎 (cada um só mexe no próprio voto) e um flag **`implemented`** que qualquer
pessoa logada pode marcar/desmarcar — a sugestão ganha um selo "Implementada".

- `server.js` (raiz) — **backend canônico** (é ele que vai para produção). Express: serve o
  frontend estático + KV store:
  - `GET /api/events` → stream SSE com os deltas (ids alterados)
  - `GET /api/ranking?period=month|all` → `{period, since, items:[{pos,name,sala,days,fav,favDays,me}]}`
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
| DB role     | `estacionaedge_app` (tabelas `kv` e `parking_sessions`)                             |
| nginx       | `/etc/nginx/sites-available/estacionaedge.baluarte.dev.br`     |
| Monitoramento | Grafana — dashboard "App — EstacionaEDGE" (`grafana.baluarte.dev.br/d/app-estacionaedge`) |

O banco é **isolado** dos outros apps (psiclinic etc.) — mesmo Postgres, database próprio.

## Monitoramento (Grafana)

Métricas no Grafana/Prometheus da VPS: status/CPU/RAM/uptime/restarts via PM2 e
saúde do banco (`pg_stat_database` do database `estacionaedge`). Artefatos versionados
em `monitoring/` (dashboard + entry do process-exporter). Detalhes e deploy:
`monitoring/README.md`.

## Editar e publicar

1. Edite `frontend.html` (frontend) e/ou `server.js` da raiz (backend).
2. Commit + push para `main`.
3. Dispare o deploy pelo **deploy-bot** (mensagem secreta no WhatsApp — ver
   `deploy-bot/README.md`). Ele roda `deploy-bot/deploy.sh` no VPS: `git reset --hard
   origin/main`, gera `app/public/index.html`, copia o `server.js` da raiz + `app/` para
   `/opt/estacionaedge`, `npm install`, `pm2 reload` e health check.
   Só vai para produção o que já está no GitHub.

Alternativa manual (legado): `cd ../_ops && python deploy_estacionaedge.py`.
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
cp ../server.js .      # mesmo layout do deploy (app/server.js é ignorado pelo git)
npm start              # http://127.0.0.1:3100
```
