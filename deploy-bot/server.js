'use strict';
/*
 * EstacionaEDGE deploy-bot.
 *
 * Recebe o webhook MESSAGES_UPSERT da Evolution API (instância psiclinic-alerts),
 * e quando chega uma mensagem cujo texto bate EXATAMENTE com a palavra-gatilho
 * secreta (TRIGGER_PHRASE), roda o deploy.sh (git pull + build + pm2 reload no VPS)
 * e responde no WhatsApp com o status.
 *
 * Zero dependências externas: usa http nativo + fetch global (Node >= 18) +
 * child_process. Roda só em 127.0.0.1 — a Evolution chama localmente, nada exposto.
 *
 * Segurança: a única barreira pedida é a palavra-gatilho secreta. Opcionalmente,
 * ALLOWED_NUMBERS restringe quais remetentes podem disparar.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/* ===== .env minimalista (KEY=VALUE por linha) ===== */
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BOT_PORT = parseInt(process.env.BOT_PORT || '3200', 10);
// Interface de bind. A Evolution roda em container Docker, então o webhook dela
// não enxerga o 127.0.0.1 do host — use o IP do gateway da bridge (ex.: 172.20.0.1)
// para que o container alcance o bot sem expor a porta na internet.
const BOT_HOST = process.env.BOT_HOST || '127.0.0.1';
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const EVOLUTION_URL = (process.env.EVOLUTION_URL || 'http://127.0.0.1:8089').replace(/\/$/, '');
const APIKEY = process.env.EVOLUTION_APIKEY || '';
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'alertas-baluarte';
const TRIGGER = (process.env.TRIGGER_PHRASE || '').trim();
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || path.join(__dirname, 'deploy.sh');
const ALLOWED = (process.env.ALLOWED_NUMBERS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
// O WhatsApp pode identificar o remetente por um LID (@lid), que NÃO é endereçável
// pela API. Quando isso acontece (e não dá pra extrair o telefone real do payload),
// a confirmação vai para este número fixo. Sem ele, o deploy roda mas não há resposta.
const NOTIFY_NUMBER = (process.env.NOTIFY_NUMBER || '').replace(/\D/g, '');

if (!TRIGGER) { console.error('TRIGGER_PHRASE não definida — abortando.'); process.exit(1); }
if (!APIKEY) { console.error('EVOLUTION_APIKEY não definida — abortando.'); process.exit(1); }

let deploying = false;

const digits = (s) => String(s || '').replace(/\D/g, '');

async function sendText(toJid, text) {
  const number = digits(toJid);
  if (!number) return;
  try {
    const r = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: APIKEY },
      body: JSON.stringify({ number, text }),
    });
    if (!r.ok) console.error('sendText HTTP', r.status, await r.text().catch(() => ''));
  } catch (e) { console.error('sendText falhou:', e.message); }
}

function runDeploy() {
  return new Promise((resolve) => {
    execFile('/bin/bash', [DEPLOY_SCRIPT], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function extractText(data) {
  const m = data && data.message;
  if (!m) return '';
  return m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '';
}

// Para onde mandar a resposta. Prioridade:
//  1) remoteJid já é um telefone (@s.whatsapp.net) -> usa ele;
//  2) telefone real exposto no payload (senderPn/participantPn);
//  3) NOTIFY_NUMBER (quando o remetente é só um @lid, não endereçável).
function replyTarget(data) {
  const key = data.key || {};
  const jid = key.remoteJid || '';
  if (jid.endsWith('@s.whatsapp.net')) return digits(jid);
  const pn = key.senderPn || key.participantPn || data.senderPn || '';
  if (pn) return digits(pn);
  return NOTIFY_NUMBER;
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, deploying }));
  }

  if (req.method !== 'POST' || urlPath !== WEBHOOK_PATH) {
    res.writeHead(404); return res.end('not found');
  }

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
  req.on('end', async () => {
    // responde rápido pra Evolution não re-tentar; processa em seguida.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    let payload;
    try { payload = JSON.parse(body); } catch { return; }
    if (!/messages[._]upsert/i.test(payload.event || '')) return;

    const data = payload.data || {};
    if (data.key && data.key.fromMe) return;                 // ignora o que o próprio número enviou
    const sender = (data.key && data.key.remoteJid) || '';
    if (!sender || sender.endsWith('@g.us')) return;          // ignora grupos
    const text = extractText(data).trim();
    if (!text) return;

    // Barreira: a mensagem precisa ser EXATAMENTE a palavra-gatilho (case-insensitive).
    if (text.toLowerCase() !== TRIGGER.toLowerCase()) return;

    const target = replyTarget(data);                          // para onde vai a confirmação
    if (ALLOWED.length && !ALLOWED.includes(digits(sender))) {
      console.log('Disparo negado (remetente não autorizado):', digits(sender));
      await sendText(target, '⛔ Você não está autorizado a disparar deploy.');
      return;
    }

    if (deploying) { await sendText(target, '⏳ Já há um deploy em andamento. Aguarde terminar.'); return; }

    deploying = true;
    console.log('Deploy disparado por', sender, '-> resposta para', target || '(sem destino)');
    if (!target) console.error('Sem destino de resposta: remetente é LID e NOTIFY_NUMBER não está definido.');
    await sendText(target, '🚀 Deploy do EstacionaEDGE iniciado...');
    const r = await runDeploy();
    deploying = false;

    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-10).join('\n');
    if (r.ok) await sendText(target, `✅ Deploy OK — https://estacionaedge.baluarte.dev.br\n\n${tail}`);
    else await sendText(target, `❌ Deploy FALHOU (code ${r.code})\n\n${tail}`);
    console.log('Deploy', r.ok ? 'OK' : 'FALHOU', 'code', r.code);
  });
});

server.listen(BOT_PORT, BOT_HOST, () => {
  console.log(`deploy-bot ouvindo em http://${BOT_HOST}:${BOT_PORT}${WEBHOOK_PATH} (instância ${INSTANCE})`);
});
