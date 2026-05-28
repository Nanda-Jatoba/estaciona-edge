# EstacionaEDGE

App de vagas do Centenário Office — quem está em cada box, liberar/ocupar vaga e
chamar pelo WhatsApp quem está bloqueando a saída.

**Produção:** https://estacionaedge.baluarte.dev.br

## Como funciona

- `vagas_2.html` — **fonte** do frontend (HTML/CSS/JS único, sem build de framework).
- `app/build-html.mjs` — gera `app/public/index.html` injetando o shim `window.storage`:
  - **escopo compartilhado** (ocupação das vagas, chamadas, cadastro de usuários) →
    API REST `/api/kv` → Postgres → visível para **todos**.
  - **escopo pessoal** (tema, telefone logado) → `localStorage` (por dispositivo).
- `app/server.js` — Express: serve o frontend estático + KV store:
  - `GET /api/kv/:key` → `{value}` | 404
  - `PUT /api/kv/:key` (body `{value:string}`) → `{value}`
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

1. Edite `vagas_2.html`.
2. `cd ../_ops && python deploy_estacionaedge.py` (rebuild + upload + `pm2 reload` + health check).

Auth no VPS via chave `~/.ssh/psiclinic_ops_ed25519`.

## Dev local

```bash
cd app
cp .env.example .env   # ajuste DATABASE_URL (ex.: túnel SSH p/ o Postgres prod)
npm install
node build-html.mjs
npm start              # http://127.0.0.1:3100
```
