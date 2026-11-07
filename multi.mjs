// Multi-turn check: turn 2 must remember turn 1 (so the same chat is reused), and a fabricated history must still work.
import assert from 'node:assert/strict';
const base = process.env.BASE ?? 'http://127.0.0.1:3456/v1';
const post = (messages) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-web', messages }) }).then((r) => r.json());
const say = async (messages) => { const t = Date.now(); const r = await post(messages); assert.ok(!r.error, r.error?.message); const c = r.choices[0].message.content; console.log(`[${Date.now() - t}ms] ${c.slice(0, 120).replace(/\n/g, ' ')}`); return c; };

const m = [{ role: 'user', content: '记住这个暗号：蓝色海豚7。只回答"记住了"' }];
m.push({ role: 'assistant', content: await say(m) });
m.push({ role: 'user', content: '我刚才让你记住的暗号是什么？只回答暗号本身' });
const a2 = await say(m);
assert.match(a2, /蓝色海豚7/, 'turn 2 remembers turn 1 (same chat reused)');
m.push({ role: 'assistant', content: a2 }, { role: 'user', content: '把它翻译成英文，只回答译文' });
const a3 = await say(m);
assert.match(a3, /dolphin/i, 'turn 3 still in the same chat');

// history we never produced -> new chat with flattened history
const a4 = await say([{ role: 'user', content: '我的名字是阿福' }, { role: 'assistant', content: '你好，阿福！' }, { role: 'user', content: '我叫什么名字？只回答名字' }]);
assert.match(a4, /阿福/, 'unknown history is flattened into a new chat');
console.log('MULTI OK');
