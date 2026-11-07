// M0: open DeepSeek in CloakBrowser with a persistent profile, dump DOM on demand.
// Usage: node --env-file=.env m0.mjs ; then `echo <name> > dump.flag` to write dump-<name>.json
import { launchPersistentContext } from 'cloakbrowser';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // not page.waitForTimeout (CDP-detectable)

const ctx = await launchPersistentContext({
  userDataDir: './profile',
  headless: false,
  humanize: true,
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
console.log('READY', page.url());

async function dump(name) {
  const data = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const sel = 'textarea,[contenteditable="true"],input,button,[role=button],[role=switch],[role=textbox],a[href]';
    const items = [...document.querySelectorAll(sel)].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        aria: el.getAttribute('aria-label'),
        ph: el.getAttribute('placeholder'),
        cls: (el.className && el.className.toString().slice(0, 80)) || null,
        text: (el.innerText || '').trim().slice(0, 40),
        visible: vis(el),
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    });
    return {
      url: location.href,
      title: document.title,
      webdriver: navigator.webdriver,
      ua: navigator.userAgent,
      items: items.filter((i) => i.visible),
      bodyText: document.body.innerText.slice(0, 1500),
    };
  });
  writeFileSync(`dump-${name}.json`, JSON.stringify(data, null, 2));
  console.log('DUMPED', name, data.url, data.items.length);
}

async function ev() {
  const code = readFileSync('eval.js', 'utf8');
  rmSync('eval.js');
  try {
    // eval.js may use `page` and `sleep` (full Playwright, humanized) via AsyncFunction
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const r = await new AsyncFunction('page', 'ctx', 'sleep', code)(page, ctx, sleep);
    writeFileSync('eval-out.json', JSON.stringify(r ?? null, null, 2));
    console.log('EVAL_OK');
  } catch (e) {
    writeFileSync('eval-out.json', JSON.stringify({ error: e.message }));
    console.log('EVAL_ERR', e.message);
  }
}

// Free license = 1 seat; a hard kill holds the seat ~4 min, so always exit via quit.flag / Ctrl+C.
async function quit() { try { await ctx.close(); } catch {} process.exit(0); }
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

while (true) {
  if (existsSync('quit.flag')) { rmSync('quit.flag'); await quit(); }
  if (existsSync('eval.js')) await ev();
  if (existsSync('shot.flag')) {
    rmSync('shot.flag');
    await page.screenshot({ path: 'shot.png' });
    console.log('SHOT');
  }
  if (existsSync('dump.flag')) {
    const name = readFileSync('dump.flag', 'utf8').trim() || 'x';
    rmSync('dump.flag');
    try { await dump(name); } catch (e) { console.log('DUMP_ERR', e.message); }
  }
  await sleep(1000);
}
