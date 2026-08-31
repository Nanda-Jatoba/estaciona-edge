'use strict';
/*
 * EstacionaEDGE deploy-bot.
 *
 * Recebe o webhook message.received do OpenWA e, quando chega uma mensagem
 * cujo texto bate EXATAMENTE com a palavra-gatilho
 * secreta (TRIGGER_PHRASE), roda o deploy.sh (git pull + build + pm2 reload no VPS)
 * e responde no WhatsApp com o status.
 *
 * Zero dependências externas: usa http nativo + fetch global (Node >= 18) +
 * child_process. Escuta só no gateway da bridge do Docker, que o container do
 * OpenWA alcança sem que a porta fique exposta na internet.
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
// Interface de bind. O gateway roda em container Docker e não enxerga o
// 127.0.0.1 do host, então o bot escuta no IP do gateway da bridge da rede do
// container. Com o OpenWA esse endereço ainda precisa constar em
// SSRF_ALLOWED_HOSTS no .env dele, senão a entrega é recusada pelo guard de
// SSRF antes mesmo de sair.
const BOT_HOST = process.env.BOT_HOST || '127.0.0.1';
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const WHATSAPP_URL = (process.env.WHATSAPP_API_URL || 'http://127.0.0.1:2786').replace(/\/$/, '');
const APIKEY = process.env.WHATSAPP_API_KEY || '';
const SESSION = process.env.WHATSAPP_SESSION_ID || '';
const TRIGGER = (process.env.TRIGGER_PHRASE || '').trim();
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || path.join(__dirname, 'deploy.sh');
const ALLOWED = (process.env.ALLOWED_NUMBERS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
// Números que SEMPRE recebem a confirmação do deploy (lista separada por vírgula).
// Como o WhatsApp entrega o remetente como LID anônimo (não dá pra saber/responder
// quem disparou), a confirmação vai para esta lista fixa de "admins do deploy".
const NOTIFY_NUMBERS = (process.env.NOTIFY_NUMBER || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);

if (!TRIGGER) { console.error('TRIGGER_PHRASE não definida, abortando.'); process.exit(1); }
if (!APIKEY) { console.error('WHATSAPP_API_KEY não definida, abortando.'); process.exit(1); }
if (!SESSION) { console.error('WHATSAPP_SESSION_ID não definida, abortando.'); process.exit(1); }

let deploying = false;

const digits = (s) => String(s || '').replace(/\D/g, '');

async function sendText(toJid, text) {
  const number = digits(toJid);
  if (!number) return;
  try {
    const r = await fetch(`${WHATSAPP_URL}/api/sessions/${SESSION}/messages/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APIKEY },
      body: JSON.stringify({ chatId: `${number}@c.us`, text }),
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

// O OpenWA entrega a mensagem já normalizada em `data.body`, com `type` dizendo
// a natureza. O gateway anterior entregava a estrutura crua do Baileys e obrigava
// a escavar conversation/extendedTextMessage.
function extractText(data) {
  if (!data) return '';
  // `type` costuma vir como 'text'/'chat' dependendo da engine; quando o campo
  // nao vem, o corpo ainda serve. So descartamos o que claramente nao e texto.
  const tipo = String(data.type || '').toLowerCase();
  if (tipo && !['text', 'chat', 'conversation', 'extendedtext'].includes(tipo)) return '';
  return String(data.body || '');
}

// Para quem mandar a confirmação: sempre a lista NOTIFY_NUMBERS e, se o remetente
// vier com telefone real (não-LID), também responde direto para ele. Deduplicado.
function replyTargets(data) {
  const set = new Set(NOTIFY_NUMBERS);
  const from = String((data && data.from) || '');
  if (from.endsWith('@c.us')) set.add(digits(from));
  else if (data && data.senderPhone) set.add(digits(data.senderPhone));
  return [...set].filter(Boolean);
}

async function notifyAll(targets, text) {
  for (const t of targets) await sendText(t, text);
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
    // responde rápido para o gateway não re-tentar; processa em seguida.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    let payload;
    try { payload = JSON.parse(body); } catch { return; }
    if ((payload.event || '') !== 'message.received') return;

    const data = payload.data || {};
    if (data.fromMe) return;                                  // ignora o que o próprio número enviou
    const sender = String(data.from || '');
    // Guard de conversa direta escrito como negacao: `kind` nem sempre vem no
    // payload do webhook (a API expoe, o evento nem sempre), e exigir
    // kind === 'individual' fazia o bot descartar toda mensagem legitima.
    if (!sender) return;
    if (data.isGroup || sender.endsWith('@g.us') || sender.endsWith('@newsletter')) return;
    if (data.kind && data.kind !== 'individual') return;
    const text = extractText(data).trim();
    if (!text) return;

    // Barreira: a mensagem precisa ser EXATAMENTE a palavra-gatilho (case-insensitive).
    if (text.toLowerCase() !== TRIGGER.toLowerCase()) return;

    const targets = replyTargets(data);                        // quem recebe a confirmação
    if (ALLOWED.length && !ALLOWED.includes(digits(sender))) {
      console.log('Disparo negado (remetente não autorizado):', digits(sender));
      await notifyAll(targets, '⛔ Você não está autorizado a disparar deploy.');
      return;
    }

    if (deploying) { await notifyAll(targets, '⏳ Já há um deploy em andamento. Aguarde terminar.'); return; }

    deploying = true;
    console.log('Deploy disparado por', sender, '-> resposta para', targets.join(',') || '(sem destino)');
    if (!targets.length) console.error('Sem destino de resposta: remetente é LID e NOTIFY_NUMBER não está definido.');
    await notifyAll(targets, '🚀 Deploy do EstacionaEDGE iniciado...');
    const r = await runDeploy();
    deploying = false;

    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-10).join('\n');
    if (r.ok) await notifyAll(targets, `✅ Deploy OK: https://estacionaedge.baluarte.dev.br\n\n${tail}`);
    else await notifyAll(targets, `❌ Deploy FALHOU (code ${r.code})\n\n${tail}`);
    console.log('Deploy', r.ok ? 'OK' : 'FALHOU', 'code', r.code);
  });
});

server.listen(BOT_PORT, BOT_HOST, () => {
  console.log(`deploy-bot ouvindo em http://${BOT_HOST}:${BOT_PORT}${WEBHOOK_PATH} (sessão ${SESSION})`);
});
