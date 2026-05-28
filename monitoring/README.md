# Monitoramento — EstacionaEDGE

A stack de observabilidade (Prometheus + Grafana + exporters) vive na VPS em
`/opt/monitoring`. Estes arquivos são os artefatos do EstacionaEDGE, versionados
aqui para reprodutibilidade. O deploy copia-os para a VPS.

## `app-estacionaedge.json`
Dashboard Grafana do app. Vai em
`/opt/monitoring/configs/grafana/dashboards/app-estacionaedge.json`
(montado read-only no container `grafana`; o provider recarrega a cada 60s).

Painéis: status/uptime/RAM/CPU/restarts via métricas `pm2_*` (coletor PM2 já
captura todos os processos automaticamente) + bloco de banco via
`pg_stat_database_*{datname="estacionaedge"}` (conexões, cache hit, linhas/s, deadlocks).

URL: https://grafana.baluarte.dev.br → dashboard "App — EstacionaEDGE".

## process-exporter
Adicionar a entry abaixo em `/opt/monitoring/configs/process-exporter/process-exporter.yml`
(dentro de `process_names:`) e reiniciar: `docker restart process-exporter`.

```yaml
  - name: estacionaedge
    cmdline: ['/opt/estacionaedge']
```

## Deploy do monitoramento
`cd ../../_ops && python deploy_estacionaedge_monitoring.py`
(copia o dashboard, garante a entry do process-exporter e reinicia o exporter).
