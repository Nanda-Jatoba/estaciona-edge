'use strict';
/*
 * EstacionaEDGE — servidor.
 * - Serve o frontend estático (public/index.html).
 * - Expõe um KV store simples para o escopo COMPARTILHADO do app
 *   (ocupação das vagas, chamadas, cadastro de usuários).
 *   O escopo PESSOAL (tema, telefone logado) fica no localStorage do browser.
 *
 * O frontend (window.storage, injetado em index.html) fala com:
 *   GET    /api/kv/:key   -> 200 {value} | 404
 *   PUT    /api/kv/:key   -> body {value:string} -> 200 {value}
 *   DELETE /api/kv/:key   -> 200 {deleted:true}
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.HOST || '127.0.0.1';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida — abortando.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[pg pool error]', err.message));

async function ensureSchema() {
  await pool.query(`
    create table if not exists kv (
      key        text primary key,
      value      text not null,
      updated_at timestamptz not null default now()
    )
  `);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= 200;
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/kv/:key', async (req, res) => {
  const k = req.params.key;
  if (!validKey(k)) return res.status(400).json({ error: 'bad key' });
  try {
    const r = await pool.query('select value from kv where key = $1', [k]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ value: r.rows[0].value });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/api/kv/:key', async (req, res) => {
  const k = req.params.key;
  if (!validKey(k)) return res.status(400).json({ error: 'bad key' });
  const v = req.body && req.body.value;
  if (typeof v !== 'string') return res.status(400).json({ error: 'value must be a string' });
  if (v.length > 2000000) return res.status(413).json({ error: 'value too large' });
  try {
    await pool.query(
      `insert into kv (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [k, v]
    );
    res.json({ value: v });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/kv/:key', async (req, res) => {
  const k = req.params.key;
  if (!validKey(k)) return res.status(400).json({ error: 'bad key' });
  try {
    await pool.query('delete from kv where key = $1', [k]);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Frontend estático
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC, { extensions: ['html'], maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

ensureSchema()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`EstacionaEDGE rodando em http://${HOST}:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Falha ao garantir schema:', e.message);
    process.exit(1);
  });
