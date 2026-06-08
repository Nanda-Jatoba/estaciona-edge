module.exports = {
  apps: [
    {
      name: 'estacionaedge-deploybot',
      script: 'server.js',
      cwd: '/opt/estacionaedge-src/deploy-bot',
      instances: 1,
      autorestart: true,
      max_memory_restart: '120M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
