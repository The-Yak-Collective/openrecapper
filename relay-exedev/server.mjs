// OpenRecapper relay service.
// Bridges the bot's /summarize (and later /email) calls to the exe.dev LLM Gateway.
// Runs on 127.0.0.1 only; auth via X-Relay-Token shared secret.
import http from 'node:http';

const PORT = parseInt(process.env.RELAY_PORT || '8787', 10);
const HOST = '127.0.0.1';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
// exe.dev gateway endpoints (link-local, no API keys needed). Look up the
// addresses in the exe.dev docs (https://exe.dev/docs.md) and set them in the
// service environment:
//  - RELAY_LLM_GATEWAY:   LLM gateway, Anthropic-compatible Messages API
//  - RELAY_EMAIL_GATEWAY: email gateway. Recipient must be you, a teammate, or
//    someone who has logged into the shared VM (anti-spam), and is rate-limited.
const GATEWAY = process.env.RELAY_LLM_GATEWAY || '';
const EMAIL_GATEWAY = process.env.RELAY_EMAIL_GATEWAY || '';
const DEFAULT_MODEL = process.env.RELAY_MODEL || 'claude-sonnet-4-6';

if (!RELAY_TOKEN) {
  console.error('[relay] FATAL: RELAY_TOKEN not set');
  process.exit(1);
}
if (!GATEWAY || !EMAIL_GATEWAY) {
  console.error('[relay] FATAL: RELAY_LLM_GATEWAY and RELAY_EMAIL_GATEWAY must be set (see https://exe.dev/docs.md)');
  process.exit(1);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function summarize({ system, prompt, model, maxTokens }) {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: maxTokens || 2500,
      system: system || undefined,
      messages: [{ role: 'user', content: prompt || '' }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`gateway ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    : '';
  // truncated: the model stopped because it hit max_tokens (output is cut off).
  return { text: text.trim(), truncated: data.stop_reason === 'max_tokens' };
}

async function sendEmail({ to, subject, body }) {
  if (!to || !subject) throw new Error('email requires "to" and "subject"');
  const res = await fetch(EMAIL_GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, subject, body: body || '' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false || data?.error) {
    throw new Error(`email gateway ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    if (req.headers['x-relay-token'] !== RELAY_TOKEN) {
      return send(res, 401, { error: 'unauthorized' });
    }

    if (req.url === '/summarize') {
      const body = await readJson(req);
      const { text, truncated } = await summarize(body);
      console.log(`[relay] /summarize ok (${text.length} chars${truncated ? ', truncated at max_tokens' : ''})`);
      return send(res, 200, { text, truncated });
    }

    if (req.url === '/email') {
      const body = await readJson(req);
      await sendEmail(body);
      console.log(`[relay] /email ok -> ${body?.to}`);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[relay] error:', err);
    return send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT} (model: ${DEFAULT_MODEL})`);
});
