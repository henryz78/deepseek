// 1) exact continuation, 2) fuzzy continuation (client tidied our answer), 3) unseen history -> attached transcript that
// contains words ONLY the assistant said. Prints the chat URL of each step via convos.json so reuse can be checked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const post = (messages) => fetch('http://127.0.0.1:3456/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-web', messages }) }).then((r) => r.json());
const say = async (label, messages) => { const t = Date.now(); const r = await post(messages); assert.ok(!r.error, r.error?.message); const c = r.choices[0].message.content; console.log(`[${label}] ${Date.now() - t}ms  ${c.slice(0, 100).replace(/\n/g, ' ')}`); return c; };
const urls = () => [...new Set(JSON.parse(readFileSync('convos.json', 'utf8')).map(([, v]) => v.url))];

const m = [{ role: 'user', content: '记住这个暗号：蓝色海豚7。只回答"记住了"' }];
m.push({ role: 'assistant', content: await say('turn1 new chat', m) });
m.push({ role: 'user', content: '暗号是什么？只回答暗号本身' });
const a2 = await say('turn2 exact', m);
assert.match(a2, /蓝色海豚7/);
assert.equal(urls().length, 1, 'turn 2 reused the chat');

// client "tidies" our assistant message (adds a full stop and a space): still the same chat
m.push({ role: 'assistant', content: ` ${a2}。` }, { role: 'user', content: '把它翻译成英文，只回答译文' });
const a3 = await say('turn3 fuzzy', m);
assert.match(a3, /dolphin/i);
assert.equal(urls().length, 1, 'fuzzy match reused the chat');

// history never seen: the secret exists only in what the ASSISTANT said
const a4 = await say('unseen history -> attach', [
  { role: 'system', content: '你是简洁的助手' },
  { role: 'user', content: '给我起个暗号' },
  { role: 'assistant', content: '暗号是：紫色蜻蜓42' },
  { role: 'user', content: '你刚才给我的暗号是什么？只回答暗号本身' },
]);
assert.match(a4, /紫色蜻蜓42/, 'assistant words survive via the attached transcript');
assert.equal(urls().length, 2, 'unseen history opened a second chat');
console.log('HISTORY OK');
