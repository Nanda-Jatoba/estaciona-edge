// PM2 — EstacionaEDGE. Env real vem de /opt/estacionaedge/.env (dotenv).
module.exports = {
  apps: [
    {
      name: 'estacionaedge',
      cwd: '/opt/estacionaedge',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
