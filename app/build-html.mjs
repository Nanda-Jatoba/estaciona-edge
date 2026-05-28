/*
 * Gera public/index.html a partir de ../vagas_2.html injetando o shim
 * window.storage (escopo compartilhado -> /api/kv ; escopo pessoal -> localStorage).
 * Idempotente: roda quantas vezes quiser.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'vagas_2.html');
const OUT_DIR = join(__dirname, 'public');
const OUT = join(OUT_DIR, 'index.html');

const SHIM = `<script>
/* ===== EstacionaEDGE storage shim =====
   Escopo compartilhado (shared=true)  -> API REST /api/kv (Postgres, global p/ todos)
   Escopo pessoal       (shared=false) -> localStorage (por dispositivo)            */
(function () {
  var API = '/api/kv/';
  function url(k) { return API + encodeURIComponent(k); }
  async function apiGet(k) {
    var r = await fetch(url(k), { cache: 'no-store' });
    if (r.status === 404) { var e = new Error('nf'); e.code = 404; throw e; }
    if (!r.ok) throw new Error('kv get ' + r.status);
    return await r.json(); // { value }
  }
  window.storage = {
    async get(k, shared) {
      if (shared) return await apiGet(k);
      var v = localStorage.getItem('ee:' + k);
      if (v === null) throw new Error('nf');
      return { value: v };
    },
    async set(k, v, shared) {
      if (shared) {
        var headers = { 'Content-Type': 'application/json' };
        var actor = localStorage.getItem('ee:currentUser'); // telefone logado (escopo pessoal)
        if (actor) headers['X-Actor'] = actor;
        var r = await fetch(url(k), { method: 'PUT', headers: headers, body: JSON.stringify({ value: v }) });
        if (!r.ok) throw new Error('kv set ' + r.status);
        var jr = await r.json().catch(function () { return { value: v }; });
        return { value: jr && jr.value != null ? jr.value : v };
      }
      localStorage.setItem('ee:' + k, v);
      return { value: v };
    },
    async delete(k, shared) {
      if (shared) { await fetch(url(k), { method: 'DELETE' }); return { deleted: true }; }
      localStorage.removeItem('ee:' + k);
      return { deleted: true };
    },
    async list() { return { keys: [] }; },
  };
})();
</script>
`;

let html = readFileSync(SRC, 'utf8');

// Remove injeções anteriores (idempotência) e injeta antes do 1º <script> da app.
html = html.replace(/<script>\n\/\* ===== EstacionaEDGE storage shim[\s\S]*?<\/script>\n/, '');

const marker = '<script>';
const idx = html.indexOf(marker);
if (idx === -1) throw new Error('Não encontrei <script> no HTML de origem.');
html = html.slice(0, idx) + SHIM + html.slice(idx);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log('Gerado', OUT, '(' + html.length + ' bytes)');
