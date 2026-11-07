// Each of the 4 models once: the answer must come back clean (no search-citation junk) and the page must have used the right switches.
const ask = async (model, q) => { const t = Date.now(); const r = await fetch('http://127.0.0.1:3456/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: q }] }) }).then((r) => r.json()); console.log(`\n== ${model}  ${Date.now() - t}ms\n${r.error?.message ?? r.choices[0].message.content}`); };
const models = await fetch('http://127.0.0.1:3456/v1/models').then((r) => r.json());
console.log(models.data.map((m) => m.id).join(', '));
await ask('deepseek-web', '1+1等于几？只回答数字');
await ask('deepseek-web-reasoner', '1+1等于几？只回答数字');
await ask('deepseek-web-search', '搜索一下今天的日期和 Node.js 当前的 LTS 大版本号，用两行回答');
await ask('deepseek-web-reasoner-search', '搜索一下今天的日期和 Node.js 当前的 LTS 大版本号，用两行回答');
