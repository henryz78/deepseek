// End-to-end check against a running server: node smoke.mjs
import assert from 'node:assert/strict';

const base = process.env.BASE ?? 'http://127.0.0.1:3456/v1';
const post = (body) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const models = await fetch(`${base}/models`).then((r) => r.json());
assert.ok(models.data.some((m) => m.id === 'deepseek-web'), 'models lists deepseek-web');

const t0 = Date.now();
const r = await post({ model: 'deepseek-web', messages: [{ role: 'user', content: '用一句话介绍你自己，再给一个打印 hello 的 python 代码块' }] });
assert.ok(!r.error, `server error: ${r.error?.message}`);
const content = r.choices?.[0]?.message?.content ?? '';
console.log(`${Date.now() - t0}ms\n${content}`);
assert.match(content, /```python\n[\s\S]*print[\s\S]*```/, 'code fence survives DOM -> markdown');
console.log('SMOKE OK');

// streaming: several content chunks, first one well before the last, and the joined text keeps its code fence
const ts = Date.now();
const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-web', stream: true, messages: [{ role: 'user', content: '写一个 Python 快速排序函数，带中文注释，再用两句话说明原理' }] }) });
const dec = new TextDecoder();
let buf = '', text = '', n = 0, first = 0, done = false;
for await (const part of res.body) {
  buf += dec.decode(part, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const ev = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!ev.startsWith('data: ')) continue;
    if (ev === 'data: [DONE]') { done = true; continue; }
    const j = JSON.parse(ev.slice(6));
    assert.ok(!j.error, `stream error: ${j.error?.message}`);
    const c = j.choices[0].delta.content;
    if (c) { n++; text += c; first ||= Date.now() - ts; }
  }
}
console.log(`stream: ${n} chunks, first at ${first}ms, total ${Date.now() - ts}ms\n${text}`);
assert.ok(done, 'stream ends with [DONE]');
assert.ok(n >= 3, 'more than a couple of content chunks');
assert.match(text, /```python\n[\s\S]*def [\s\S]*```/, 'streamed text keeps a closed code fence');
console.log('STREAM OK');
