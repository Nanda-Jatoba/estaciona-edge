'use strict';
/*
 * EstacionaEDGE — servidor.
 * - Serve o frontend estático (public/index.html).
 * - KV para o escopo COMPARTILHADO (escopo pessoal fica no localStorage do browser).
 *
 * A chave `state` (ocupação + chamadas) é AUTORITATIVA no servidor: em vez de
 * confiar no blob enviado, o servidor lê o estado atual, descobre quem está
 * agindo (header X-Actor = telefone logado) e aplica só o que é permitido:
 *   - você só ocupa uma vaga LIVRE, e só colocando você mesmo;
 *   - você só LIBERA a sua própria vaga;
 *   - ninguém sobrescreve/edita a vaga de outra pessoa;
 *   - um mesmo telefone nunca fica em mais de uma vaga.
 * Tudo dentro de uma transação com advisory lock (sem perda por concorrência).
 *
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

/* ===== Layout das vagas (espelha o VAGAS de vagas_2.html) ===== */
const SLOT_TYPE = {};
for (const id of ['209', '211', '419', '813']) { SLOT_TYPE[id + '-0'] = 'carro'; SLOT_TYPE[id + '-1'] = 'carro'; }
for (const id of ['210', '812']) { SLOT_TYPE[id + '-0'] = 'carro'; for (let i = 1; i <= 5; i++) SLOT_TYPE[id + '-' + i] = 'moto'; }
const MAX_SLOTS = Object.keys(SLOT_TYPE).length;

/* ===== Helpers de validação ===== */
function normDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

function validBrPhone(raw) {
  const d = normDigits(raw);
  if (d.length !== 10 && d.length !== 11) return false;
  const ddd = parseInt(d.slice(0, 2), 10);
  if (!(ddd >= 11 && ddd <= 99)) return false;       // DDD plausível
  if (d.length === 11 && d[2] !== '9') return false; // celular: 9 após o DDD
  if (/^(\d)\1+$/.test(d)) return false;             // todos os dígitos iguais (00000000000…)
  return true;
}

// Data de hoje em America/Sao_Paulo (YYYY-MM-DD) — casa com o todayStr() do cliente.
function spDateStr() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }

function validOccEntry(k, o) {
  if (typeof o !== 'object' || o === null) return false;
  if (SLOT_TYPE[k] === undefined) return false;          // vaga precisa existir
  if (!validBrPhone(o.phone)) return false;
  if (typeof o.name !== 'string' || o.name.trim().length < 2 || o.name.length > 60) return false;
  const sala = String(o.sala == null ? '' : o.sala);
  if (sala.length < 1 || sala.length > 12) return false;
  if (o.type !== SLOT_TYPE[k]) return false;             // carro/moto conforme a vaga
  return true;
}

function validCallEntry(c) {
  if (typeof c !== 'object' || c === null) return false;
  for (const f of ['from', 'sala', 'box', 'local']) {
    if (c[f] != null && String(c[f]).length > 60) return false;
  }
  return true;
}

/*
 * Aplica a transição pedida pelo cliente de forma autoritativa.
 * actor = telefone (normalizado) de quem está agindo.
 */
function mergeOccupancy(storedOcc, newOcc, actor) {
  const result = {};
  // 1) parte do que já existe; só remove se o dono for o próprio actor.
  for (const k of Object.keys(storedOcc)) {
    const cur = storedOcc[k];
    const incoming = newOcc[k];
    if (incoming === undefined) {
      if (actor && normDigits(cur.phone) === actor) continue; // dono liberou a própria -> remove
      result[k] = cur;                                        // não é dono -> mantém
    } else if (normDigits(cur.phone) === normDigits(incoming.phone)) {
      // mesma pessoa: só permite atualizar se o próprio dono está agindo
      result[k] = (actor && normDigits(cur.phone) === actor && validOccEntry(k, incoming)) ? incoming : cur;
    } else {
      result[k] = cur; // tentativa de trocar o ocupante de uma vaga ocupada -> ignora
    }
  }
  // 2) novas ocupações: só em vaga livre e só colocando você mesmo.
  for (const k of Object.keys(newOcc)) {
    if (result[k] !== undefined || storedOcc[k] !== undefined) continue;
    const o = newOcc[k];
    if (!validOccEntry(k, o)) continue;
    if (!actor || normDigits(o.phone) !== actor) continue;
    result[k] = o;
  }
  // 3) um telefone só pode ocupar uma vaga (mantém a primeira).
  const seen = new Set();
  for (const k of Object.keys(result)) {
    const ph = normDigits(result[k].phone);
    if (seen.has(ph)) delete result[k]; else seen.add(ph);
  }
  return result;
}

function mergeCalls(storedCalls, newCalls, actor) {
  const result = {};
  for (const k of Object.keys(storedCalls)) {
    if (newCalls[k] === undefined && actor && k === actor) continue; // dismiss da própria notificação
    result[k] = storedCalls[k];
  }
  for (const k of Object.keys(newCalls)) {
    if (!validBrPhone(k) || !validCallEntry(newCalls[k]) || !actor) continue;
    result[k] = newCalls[k]; // só logado cria/atualiza chamada para o alvo k
  }
  // cap defensivo
  const keys = Object.keys(result);
  if (keys.length > MAX_SLOTS) for (const k of keys.slice(MAX_SLOTS)) delete result[k];
  return result;
}

/* ===== App ===== */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // atrás do nginx — req.ip vem do X-Forwarded-For
app.use(express.json({ limit: '2mb' }));

function allowedKey(k) { return k === 'state' || /^user:.+/.test(k); }

// Rate limit simples por IP nas ESCRITAS (janela de 60s).
const RL_WINDOW = 60000, RL_MAX = 40;
const rlHits = new Map();
function writeLimiter(req, res, next) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  let e = rlHits.get(ip);
  if (!e || now > e.reset) { e = { n: 0, reset: now + RL_WINDOW }; rlHits.set(ip, e); }
  if (++e.n > RL_MAX) return res.status(429).json({ error: 'muitas requisições, tente em instantes' });
  if (rlHits.size > 5000) for (const [kk, vv] of rlHits) if (now > vv.reset) rlHits.delete(kk);
  next();
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('select 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/api/kv/:key', async (req, res) => {
  const k = req.params.key;
  if (!allowedKey(k)) return res.status(400).json({ error: 'bad key' });
  try {
    const r = await pool.query('select value from kv where key = $1', [k]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    let value = r.rows[0].value;
    if (k === 'state') { // reset diário no próprio read
      const today = spDateStr();
      try { const st = JSON.parse(value); if (!st || st.date !== today) value = JSON.stringify({ date: today, occupancy: {}, calls: {} }); }
      catch { value = JSON.stringify({ date: today, occupancy: {}, calls: {} }); }
    }
    res.json({ value });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put('/api/kv/:key', writeLimiter, async (req, res) => {
  const k = req.params.key;
  if (!allowedKey(k)) return res.status(400).json({ error: 'bad key' });
  const v = req.body && req.body.value;
  if (typeof v !== 'string') return res.status(400).json({ error: 'value must be a string' });
  if (v.length > 2000000) return res.status(413).json({ error: 'value too large' });

  // ---- chave state: aplicação autoritativa da transição ----
  if (k === 'state') {
    let incoming;
    try { incoming = JSON.parse(v); } catch { return res.status(400).json({ error: 'state inválido' }); }
    if (typeof incoming !== 'object' || incoming === null) return res.status(400).json({ error: 'state inválido' });
    const newOcc = (incoming.occupancy && typeof incoming.occupancy === 'object' && !Array.isArray(incoming.occupancy)) ? incoming.occupancy : {};
    const newCalls = (incoming.calls && typeof incoming.calls === 'object' && !Array.isArray(incoming.calls)) ? incoming.calls : {};
    if (Object.keys(newOcc).length > MAX_SLOTS * 2) return res.status(400).json({ error: 'occupancy grande demais' });
    const actor = normDigits(req.get('X-Actor'));
    const today = spDateStr();

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(729145)'); // serializa escritas do state
      let storedOcc = {}, storedCalls = {};
      const r = await client.query('select value from kv where key = $1', ['state']);
      if (r.rows.length) {
        try { const st = JSON.parse(r.rows[0].value); if (st && st.date === today) { storedOcc = st.occupancy || {}; storedCalls = st.calls || {}; } }
        catch { /* estado corrompido: trata como vazio */ }
      }
      const merged = JSON.stringify({
        date: today,
        occupancy: mergeOccupancy(storedOcc, newOcc, actor),
        calls: mergeCalls(storedCalls, newCalls, actor),
      });
      await client.query(
        `insert into kv (key, value, updated_at) values ('state', $1, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [merged]
      );
      await client.query('commit');
      return res.json({ value: merged });
    } catch (e) {
      try { await client.query('rollback'); } catch { /* noop */ }
      return res.status(500).json({ error: String(e.message || e) });
    } finally {
      client.release();
    }
  }

  // ---- chave user:<telefone>: validação de cadastro ----
  if (k.startsWith('user:')) {
    const phone = k.slice(5);
    if (!validBrPhone(phone)) return res.status(400).json({ error: 'telefone inválido' });
    if (v.length > 600) return res.status(400).json({ error: 'user grande demais' });
    let u; try { u = JSON.parse(v); } catch { return res.status(400).json({ error: 'user inválido' }); }
    if (typeof u !== 'object' || u === null) return res.status(400).json({ error: 'user inválido' });
    if (typeof u.name !== 'string' || u.name.trim().length < 2 || u.name.length > 60) return res.status(400).json({ error: 'nome inválido' });
    if (normDigits(u.phone) !== normDigits(phone)) return res.status(400).json({ error: 'phone divergente' });
    try {
      await pool.query(
        `insert into kv (key, value, updated_at) values ($1, $2, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [k, v]
      );
      return res.json({ value: v });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  return res.status(400).json({ error: 'key não suportada' });
});

app.delete('/api/kv/:key', writeLimiter, async (req, res) => {
  const k = req.params.key;
  if (!allowedKey(k)) return res.status(400).json({ error: 'bad key' });
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
    app.listen(PORT, HOST, () => console.log(`EstacionaEDGE rodando em http://${HOST}:${PORT}`));
  })
  .catch((e) => {
    console.error('Falha ao garantir schema:', e.message);
    process.exit(1);
  });
