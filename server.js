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

/* ===== Layout das vagas (espelha o VAGAS de frontend.html) ===== */
const SLOT_TYPE = {};
for (const id of ['209', '210', '211', '419', '710', '813']) { SLOT_TYPE[id + '-0'] = 'carro'; SLOT_TYPE[id + '-1'] = 'carro'; }
for (let i = 0; i < 10; i++) SLOT_TYPE['812-' + i] = 'moto';
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
 * takeoverSlots = vagas que o actor pode ASSUMIR no lugar de outra pessoa
 *   (vaga marcada por ele como "sem carro"); fora dessa lista, ninguém troca o ocupante.
 */
function mergeOccupancy(storedOcc, newOcc, actor, takeoverSlots) {
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
    } else if (actor && normDigits(incoming.phone) === actor && validOccEntry(k, incoming) && takeoverSlots && takeoverSlots.has(k)) {
      result[k] = incoming; // takeover: você assume uma vaga que marcou como vazia
    } else {
      result[k] = cur; // qualquer outra troca de ocupante -> ignora
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

function validWaitEntry(w) {
  if (typeof w !== 'object' || w === null) return false;
  if (!validBrPhone(w.phone)) return false;
  if (typeof w.name !== 'string' || w.name.trim().length < 2 || w.name.length > 60) return false;
  const sala = String(w.sala == null ? '' : w.sala);
  if (sala.length < 1 || sala.length > 12) return false;
  return true;
}

// Lista de espera: keyed por telefone. Cada um só adiciona/remove a si próprio.
function mergeWaitlist(storedWait, newWait, actor) {
  const result = {};
  for (const k of Object.keys(storedWait)) {
    if (newWait[k] === undefined && actor && normDigits(k) === actor) continue; // o próprio saiu
    result[k] = storedWait[k];
  }
  for (const k of Object.keys(newWait)) {
    if (!validBrPhone(k) || !actor || normDigits(k) !== actor) continue; // só a si mesmo
    const w = newWait[k];
    if (!validWaitEntry(w) || normDigits(w.phone) !== normDigits(k)) continue;
    result[k] = w;
  }
  return result;
}

function validSuggestion(s) {
  if (typeof s !== 'object' || s === null) return false;
  if (typeof s.name !== 'string' || s.name.trim().length < 2 || s.name.length > 60) return false;
  if (!validBrPhone(s.phone)) return false;
  const sala = String(s.sala == null ? '' : s.sala);
  if (sala.length < 1 || sala.length > 12) return false;
  if (typeof s.text !== 'string' || s.text.trim().length < 1 || s.text.length > 1000) return false;
  if (typeof s.ts !== 'number' || !isFinite(s.ts)) return false;
  return true;
}

// Votos (👍/👎) por sugestão: objeto { telefone: 1 | -1 }.
function sanitizeVotes(v) {
  const out = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= 2000) break;
    if (!validBrPhone(k)) continue;
    if (v[k] === 1 || v[k] === -1) { out[normDigits(k)] = v[k]; n++; }
  }
  return out;
}

/* ===== Avisos de "vaga marcada como cheia, mas sem carro" =====
 * disputes[slotId] = { telefone: { name, phone, ts } }
 * Cada pessoa só registra/retira o PRÓPRIO aviso, e só em vaga ocupada por OUTRA pessoa.
 */
function validDisputeEntry(d) {
  if (typeof d !== 'object' || d === null) return false;
  if (!validBrPhone(d.phone)) return false;
  if (typeof d.name !== 'string' || d.name.trim().length < 2 || d.name.length > 60) return false;
  return true;
}
function mergeDisputes(storedDisputes, newDisputes, actor, occ) {
  const result = {};
  // mantém os avisos já existentes (de qualquer pessoa); remove só o do próprio actor se ele tirou.
  for (const slot of Object.keys(storedDisputes)) {
    const cur = storedDisputes[slot] || {};
    const incoming = (newDisputes[slot] && typeof newDisputes[slot] === 'object') ? newDisputes[slot] : undefined;
    const kept = {};
    for (const ph of Object.keys(cur)) {
      if (incoming && incoming[ph] === undefined && actor && normDigits(ph) === actor) continue; // tirou o próprio aviso
      kept[ph] = cur[ph];
    }
    if (Object.keys(kept).length) result[slot] = kept;
  }
  // adiciona o aviso do próprio actor (nunca o de outra pessoa).
  for (const slot of Object.keys(newDisputes)) {
    const incoming = newDisputes[slot];
    if (typeof incoming !== 'object' || incoming === null) continue;
    for (const ph of Object.keys(incoming)) {
      if (!actor || normDigits(ph) !== actor) continue;
      const d = incoming[ph];
      if (!validDisputeEntry(d) || normDigits(d.phone) !== actor) continue;
      (result[slot] = result[slot] || {})[actor] = { name: d.name, phone: d.phone, ts: (typeof d.ts === 'number' && isFinite(d.ts)) ? d.ts : Date.now() };
    }
  }
  // limpeza: aviso só vale para vaga ocupada por OUTRA pessoa.
  for (const slot of Object.keys(result)) {
    const o = occ[slot];
    if (!o) { delete result[slot]; continue; }                         // vaga livre -> sem aviso
    for (const ph of Object.keys(result[slot])) {
      if (normDigits(o.phone) === normDigits(ph)) delete result[slot][ph]; // ocupante não se avisa
    }
    if (!Object.keys(result[slot]).length) delete result[slot];
  }
  return result;
}

/* ===== Avisos de "vaga livre no sistema, mas pode ter carro sem cadastro" =====
 * occupiedAlerts[slotId] = { telefone: { name, phone, ts } }
 * Cada pessoa só registra/retira o PRÓPRIO aviso, e só vale enquanto a vaga estiver LIVRE.
 */
function validOccAlertEntry(d) {
  if (typeof d !== 'object' || d === null) return false;
  if (!validBrPhone(d.phone)) return false;
  if (typeof d.name !== 'string' || d.name.trim().length < 2 || d.name.length > 60) return false;
  return true;
}
function mergeOccAlerts(storedAlerts, newAlerts, actor, occ) {
  const result = {};
  // mantém os avisos já existentes (de qualquer pessoa); remove só o do próprio actor se ele tirou.
  for (const slot of Object.keys(storedAlerts)) {
    const cur = storedAlerts[slot] || {};
    const incoming = (newAlerts[slot] && typeof newAlerts[slot] === 'object') ? newAlerts[slot] : undefined;
    const kept = {};
    for (const ph of Object.keys(cur)) {
      if (incoming && incoming[ph] === undefined && actor && normDigits(ph) === actor) continue; // tirou o próprio aviso
      kept[ph] = cur[ph];
    }
    if (Object.keys(kept).length) result[slot] = kept;
  }
  // adiciona o aviso do próprio actor (nunca o de outra pessoa).
  for (const slot of Object.keys(newAlerts)) {
    const incoming = newAlerts[slot];
    if (typeof incoming !== 'object' || incoming === null) continue;
    for (const ph of Object.keys(incoming)) {
      if (!actor || normDigits(ph) !== actor) continue;
      const d = incoming[ph];
      if (!validOccAlertEntry(d) || normDigits(d.phone) !== actor) continue;
      (result[slot] = result[slot] || {})[actor] = { name: d.name, phone: d.phone, ts: (typeof d.ts === 'number' && isFinite(d.ts)) ? d.ts : Date.now() };
    }
  }
  // limpeza: aviso só vale para vaga LIVRE. Se já tem ocupante registrado, descarta.
  for (const slot of Object.keys(result)) {
    if (occ[slot]) delete result[slot];
  }
  return result;
}

/* ===== Delta: o que mudou entre dois mapas {id: obj} =====
 * Devolve só os ids alterados (novo valor) ou removidos (null) — nunca o estado inteiro. */
function mapDelta(before, after) {
  const delta = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) delta[k] = after[k];
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) delta[k] = null;
  }
  return delta;
}

/* ===== SSE: empurra mudanças para os clientes (substitui o polling) =====
 * Um cliente abre UMA conexão longa em /api/events; o servidor só escreve quando
 * alguém faz uma ação, e manda apenas os ids que mudaram. */
const sseClients = new Set();
let evSeq = 0;
function broadcast(payload) {
  evSeq++;
  const frame = 'id: ' + evSeq + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const res of sseClients) { try { res.write(frame); } catch { /* cliente caiu */ } }
}

/* ===== App ===== */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // atrás do nginx — req.ip vem do X-Forwarded-For
app.use(express.json({ limit: '2mb' }));

function allowedKey(k) { return k === 'state' || k === 'suggestions' || /^user:.+/.test(k); }

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

// Stream de eventos: o cliente assina e recebe só os ids que mudaram (sem polling).
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: não bufferiza o stream
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 5000\n\n'); // se a conexão cair, o browser reconecta em 5s
  res.write(': ok\n\n');
  sseClients.add(res);
  // keep-alive (servidor -> cliente): mantém a conexão viva através de proxies.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
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
      try { const st = JSON.parse(value); if (!st || st.date !== today) value = JSON.stringify({ date: today, occupancy: {}, calls: {}, waitlist: {}, disputes: {}, occupiedAlerts: {} }); }
      catch { value = JSON.stringify({ date: today, occupancy: {}, calls: {}, waitlist: {}, disputes: {}, occupiedAlerts: {} }); }
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
    const newWait = (incoming.waitlist && typeof incoming.waitlist === 'object' && !Array.isArray(incoming.waitlist)) ? incoming.waitlist : {};
    const newDisp = (incoming.disputes && typeof incoming.disputes === 'object' && !Array.isArray(incoming.disputes)) ? incoming.disputes : {};
    const newOAlert = (incoming.occupiedAlerts && typeof incoming.occupiedAlerts === 'object' && !Array.isArray(incoming.occupiedAlerts)) ? incoming.occupiedAlerts : {};
    if (Object.keys(newOcc).length > MAX_SLOTS * 2) return res.status(400).json({ error: 'occupancy grande demais' });
    const actor = normDigits(req.get('X-Actor'));
    const today = spDateStr();

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(729145)'); // serializa escritas do state
      let storedOcc = {}, storedCalls = {}, storedWait = {}, storedDisp = {}, storedOAlert = {};
      const r = await client.query('select value from kv where key = $1', ['state']);
      if (r.rows.length) {
        try { const st = JSON.parse(r.rows[0].value); if (st && st.date === today) { storedOcc = st.occupancy || {}; storedCalls = st.calls || {}; storedWait = st.waitlist || {}; storedDisp = st.disputes || {}; storedOAlert = st.occupiedAlerts || {}; } }
        catch { /* estado corrompido: trata como vazio */ }
      }
      // Vagas que o actor pode ASSUMIR: aquelas que ele mesmo marcou como "sem carro"
      // nesta requisição, e desde que ele não esteja estacionado em outro lugar.
      const actorParked = !!actor && Object.values(storedOcc).some((o) => normDigits(o.phone) === actor);
      const takeoverSlots = new Set();
      if (actor && !actorParked) {
        for (const slot of Object.keys(newDisp)) {
          const d = newDisp[slot];
          if (d && typeof d === 'object' && Object.keys(d).some((ph) => normDigits(ph) === actor)) takeoverSlots.add(slot);
        }
      }
      const mergedOcc = mergeOccupancy(storedOcc, newOcc, actor, takeoverSlots);
      const mergedCalls = mergeCalls(storedCalls, newCalls, actor);
      const mergedWait = mergeWaitlist(storedWait, newWait, actor);
      // quem está estacionado não fica na lista de espera
      const parkedPhones = new Set(Object.values(mergedOcc).map((o) => normDigits(o.phone)));
      for (const k of Object.keys(mergedWait)) if (parkedPhones.has(normDigits(k))) delete mergedWait[k];
      const mergedDisp = mergeDisputes(storedDisp, newDisp, actor, mergedOcc);
      // vaga assumida (takeover efetivado) -> tem carro de novo, limpa os avisos dela
      for (const k of takeoverSlots) if (mergedOcc[k] && normDigits(mergedOcc[k].phone) === actor) delete mergedDisp[k];
      const mergedOAlert = mergeOccAlerts(storedOAlert, newOAlert, actor, mergedOcc);
      const merged = JSON.stringify({
        date: today,
        occupancy: mergedOcc,
        calls: mergedCalls,
        waitlist: mergedWait,
        disputes: mergedDisp,
        occupiedAlerts: mergedOAlert,
      });
      await client.query(
        `insert into kv (key, value, updated_at) values ('state', $1, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [merged]
      );
      await client.query('commit');
      // Empurra para os outros clientes só o que mudou (ids), não o estado inteiro.
      const occD = mapDelta(storedOcc, mergedOcc);
      const callsD = mapDelta(storedCalls, mergedCalls);
      const waitD = mapDelta(storedWait, mergedWait);
      const dispD = mapDelta(storedDisp, mergedDisp);
      const oalertD = mapDelta(storedOAlert, mergedOAlert);
      if (Object.keys(occD).length || Object.keys(callsD).length || Object.keys(waitD).length || Object.keys(dispD).length || Object.keys(oalertD).length) {
        broadcast({ t: 'state', date: today, occ: occD, calls: callsD, wait: waitD, disp: dispD, oalert: oalertD });
      }
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

  // ---- chave suggestions: lista de sugestões/melhorias (persistente, sem reset diário) ----
  if (k === 'suggestions') {
    let arr;
    try { arr = JSON.parse(v); } catch { return res.status(400).json({ error: 'suggestions inválido' }); }
    if (!Array.isArray(arr)) return res.status(400).json({ error: 'suggestions inválido' });
    const incoming = arr.filter(validSuggestion);
    const actor = normDigits(req.get('X-Actor'));
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(729146)'); // serializa escritas das sugestões
      let stored = [];
      const r = await client.query('select value from kv where key = $1', ['suggestions']);
      if (r.rows.length) { try { const a = JSON.parse(r.rows[0].value); if (Array.isArray(a)) stored = a.filter(validSuggestion); } catch { /* vazio */ } }
      // snapshot do "antes" por id (string, para não compartilhar referência com byId)
      const beforeMap = {};
      for (const s of stored) beforeMap[normDigits(s.phone) + '|' + s.ts] = JSON.stringify(s);
      // mapa por id (telefone|ts); preserva a ordem (cronológica) do que já existe
      const byId = new Map();
      for (const s of stored) { s.votes = sanitizeVotes(s.votes); byId.set(normDigits(s.phone) + '|' + s.ts, s); }
      for (const s of incoming) {
        const id = normDigits(s.phone) + '|' + s.ts;
        const inVotes = sanitizeVotes(s.votes);
        if (byId.has(id)) {
          // já existe: texto/autor são imutáveis; cada um só mexe no PRÓPRIO voto
          const cur = byId.get(id);
          if (actor) { if (inVotes[actor] === 1 || inVotes[actor] === -1) cur.votes[actor] = inVotes[actor]; else delete cur.votes[actor]; }
          // marcar/desmarcar como implementada (qualquer pessoa logada pode sinalizar)
          if (actor && typeof s.implemented === 'boolean') {
            cur.implemented = s.implemented;
            if (s.implemented) {
              cur.implementedBy = (typeof s.implementedBy === 'string') ? s.implementedBy.slice(0, 60) : (cur.implementedBy || '');
              cur.implementedTs = (typeof s.implementedTs === 'number' && isFinite(s.implementedTs)) ? s.implementedTs : (cur.implementedTs || Date.now());
            } else { cur.implementedBy = ''; cur.implementedTs = 0; }
          }
        } else {
          // nova sugestão: aceita, mas só com o voto do próprio actor
          const fresh = { name: s.name, sala: String(s.sala), phone: s.phone, text: s.text, ts: s.ts, votes: {}, implemented: false, implementedBy: '', implementedTs: 0 };
          if (actor && (inVotes[actor] === 1 || inVotes[actor] === -1)) fresh.votes[actor] = inVotes[actor];
          byId.set(id, fresh);
        }
      }
      const finalArr = Array.from(byId.values()).slice(-500);
      const out = JSON.stringify(finalArr);
      await client.query(
        `insert into kv (key, value, updated_at) values ('suggestions', $1, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [out]
      );
      await client.query('commit');
      // broadcast: só as sugestões que mudaram (por id), não a lista inteira
      const afterMap = {};
      for (const s of finalArr) afterMap[normDigits(s.phone) + '|' + s.ts] = s;
      const items = {};
      for (const id of Object.keys(afterMap)) if (beforeMap[id] !== JSON.stringify(afterMap[id])) items[id] = afterMap[id];
      for (const id of Object.keys(beforeMap)) if (!(id in afterMap)) items[id] = null;
      if (Object.keys(items).length) broadcast({ t: 'sug', items });
      return res.json({ value: out });
    } catch (e) {
      try { await client.query('rollback'); } catch { /* noop */ }
      return res.status(500).json({ error: String(e.message || e) });
    } finally {
      client.release();
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
