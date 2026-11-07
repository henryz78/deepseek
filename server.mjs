// OpenAI-compatible server in front of the browser driver. Serial queue (the free license allows one browser).
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { start, stop, ask, isAlive, ContinueError } from './deepseek.mjs';
import { BridgeError } from './detect.mjs';

const PORT = Number(process.env.PORT ?? 3456);
const HOST = process.env.HOST ?? '127.0.0.1';
const API_KEY = process.env.API_KEY; // optional bearer on loopback, required anywhere else
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !API_KEY) {
  console.error(`HOST=${HOST} is reachable from other machines: set API_KEY first`);
  process.exit(1);
}
const health = { lastOk: null, blocked: null }; // blocked = 'logged_out' | 'captcha' until the next success
// The page has two independent switches, 深度思考 (thinking) and 智能搜索 (search): four combinations = four models.
const MODELS = {
  'deepseek-web': { thinking: false, search: false },
  'deepseek-web-reasoner': { thinking: true, search: false },
  'deepseek-web-search': { thinking: false, search: true },
  'deepseek-web-reasoner-search': { thinking: true, search: true },
};

const text = (c) => (typeof c === 'string' ? c : (c ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'));
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const sha = (s) => createHash('sha1').update(s).digest('hex');

// OpenAI clients are stateless: every request carries the whole history. We remember, per answered history, which
// DeepSeek chat it lives in, so the next request continues THAT chat and sends only the new message (the real
// assistant words are already in the chat). A history matches when
//   1. its normalized text is identical, or
//   2. same first user message + same number of messages + (same start of the last assistant message, or it is the
//      only candidate), so a client that tidies up our earlier answers still lands in the right chat.
const STORE = 'convos.json';
const MAX_CONVOS = 500;
const convos = new Map(existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')).filter(([, v]) => v && typeof v === 'object') : []);
const historyKey = (msgs) => sha(JSON.stringify(msgs.map((m) => [m.role, norm(text(m.content))])));
const firstUser = (msgs) => sha(norm(text(msgs.find((m) => m.role === 'user')?.content)));
const lastHead = (msgs) => norm(text(msgs.at(-1).content)).slice(0, 60);

function findChat(hist) {
  const exact = convos.get(historyKey(hist));
  if (exact) return exact.url;
  const first = firstUser(hist);
  const same = [...convos.values()].filter((c) => c.first === first && c.count === hist.length);
  const head = lastHead(hist);
  return (same.findLast((c) => c.head === head) ?? (same.length === 1 ? same[0] : undefined))?.url;
}
function remember(msgs, url) { // msgs = history including the answer we just produced
  const key = historyKey(msgs);
  convos.delete(key); // re-insert = most recent
  convos.set(key, { url, first: firstUser(msgs), count: msgs.length, head: lastHead(msgs) });
  while (convos.size > MAX_CONVOS) convos.delete(convos.keys().next().value);
  writeFileSync(STORE, JSON.stringify([...convos]));
}

// Fallback for a chat we have never seen: the earlier messages go into one attached .txt, assistant words verbatim.
// Role labels are unavoidable inside a transcript file (otherwise nobody can tell who said what).
function transcript(hist) {
  const who = { user: '我', assistant: '你' };
  const lines = hist.map((m) => (m.role === 'system' ? `（背景设定：${text(m.content)}）` : `${who[m.role] ?? m.role}：${text(m.content)}`));
  return `以下是我们之前的对话记录。\n\n${lines.join('\n\n')}\n`;
}

let queue = Promise.resolve(); // one browser, so strictly one request at a time
const enqueue = (fn) => (queue = queue.then(fn, fn));

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const err = (res, code, message, type = 'bridge_error') => json(res, code, { error: { message, type } });
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o })); // one line per request, grep/jq friendly

async function chat(req, res, body) {
  const model = body.model in MODELS ? body.model : 'deepseek-web';
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return err(res, 400, 'messages is required');
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const stream = !!body.stream;
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  let gone = false; // client hung up; a request already typing into the page still has to finish
  res.on('close', () => { gone = true; });
  let keepalive;
  const t0 = Date.now();
  let mode;
  if (stream) {
    // headers go out now: the request may wait in the queue and the page may "think" silently for a while
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(chunk({ role: 'assistant', content: '' }, null));
    keepalive = setInterval(() => { if (!gone) res.write(': keepalive\n\n'); }, 10_000);
  }
  try {
    const answer = await enqueue(async () => {
      if (gone) throw new Error('client disconnected while queued');
      const onDelta = stream ? (d) => { if (!gone) res.write(chunk({ content: d }, null)); } : undefined;
      const opts = { ...MODELS[model], onDelta };
      const last = msgs.at(-1);
      const hist = msgs.slice(0, -1);
      const lastText = text(last.content);
      const url = last.role === 'user' && hist.at(-1)?.role === 'assistant' ? findChat(hist) : undefined;

      const fresh = () => {
        if (hist.some((m) => m.role !== 'system')) {
          return ask(`请先阅读附件里我们之前的对话记录，再回答我的新问题：${lastText}`, { ...opts, history: transcript(hist) });
        }
        const sys = hist.map((m) => text(m.content)).join('\n'); // only system messages before the first question
        return ask(sys ? `${sys}\n\n${lastText}` : lastText, opts);
      };
      let r;
      try {
        r = url ? await ask(lastText, { ...opts, url }) : await fresh();
      } catch (e) {
        if (!(e instanceof ContinueError)) throw e; // chat gone or unreachable: nothing was sent yet, redo as a new chat
        console.log('continue failed, starting a new chat:', e.message);
        r = await fresh();
      }
      remember([...msgs, { role: 'assistant', content: r.text }], r.url);
      mode = r.mode;
      return r.text;
    });
    health.lastOk = new Date().toISOString();
    health.blocked = null;
    log({ ok: true, model, stream, mode, ms: Date.now() - t0, chars: answer.length });
    if (stream) {
      res.write(chunk({}, 'stop'));
      return res.end('data: [DONE]\n\n');
    }
    const usage = { prompt_tokens: Math.ceil(msgs.reduce((n, m) => n + text(m.content).length, 0) / 2), completion_tokens: Math.ceil(answer.length / 2) };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens; // estimate, the web page reports no usage
    json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage });
  } catch (e) {
    const blocked = e instanceof BridgeError; // a human has to act: log in again / pass a captcha
    if (blocked) health.blocked = e.kind;
    const type = blocked ? e.kind : 'bridge_error';
    log({ ok: false, model, stream, ms: Date.now() - t0, kind: type, error: e.message });
    if (!stream) return err(res, blocked ? 503 : 502, e.message, type);
    if (!gone) res.write(`data: ${JSON.stringify({ error: { message: e.message, type } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } finally {
    clearInterval(keepalive);
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && path === '/health') { // open on purpose (platform health checks); leaks nothing sensitive
    const ok = isAlive() && !health.blocked;
    return json(res, ok ? 200 : 503, { ok, browser: isAlive(), blocked: health.blocked, lastOk: health.lastOk });
  }
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) return err(res, 401, 'invalid api key');
  if (req.method === 'GET' && path === '/v1/models') {
    return json(res, 200, { object: 'list', data: Object.keys(MODELS).map((id) => ({ id, object: 'model', owned_by: 'deepseek-web' })) });
  }
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    let raw = '';
    for await (const c of req) raw += c;
    let body;
    try { body = JSON.parse(raw); } catch { return err(res, 400, 'invalid json'); }
    return chat(req, res, body);
  }
  err(res, 404, 'not found');
});

await start();
server.listen(PORT, HOST, () => console.log(`READY http://${HOST}:${PORT}/v1`));

async function quit() {
  server.close();
  await stop();
  process.exit(0);
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
setInterval(() => { if (existsSync('quit.flag')) { rmSync('quit.flag'); quit(); } }, 1000); // Windows has no soft kill for background runs
