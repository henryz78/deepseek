// Drives chat.deepseek.com like a person (CloakBrowser, humanize=true). No internal API calls.
import { launchPersistentContext } from 'cloakbrowser';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, blockKind } from './detect.mjs';

export const HOME = 'https://chat.deepseek.com/';
export const PROFILE_DIR = process.env.PROFILE_DIR ?? './profile';
const LOGIN_STATE = process.env.LOGIN_STATE ?? './login.json'; // made by export-login.mjs on a machine where you logged in
export const launchOptions = () => ({
  userDataDir: PROFILE_DIR,
  headless: process.env.HEADLESS === '1',
  humanize: true,
  ...(process.env.PROXY ? { proxy: process.env.PROXY } : {}),
});
const TYPE_MAX = Number(process.env.TYPE_MAX ?? 80); // longer prompts are pasted, typing is ~0.25s/char
const TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS ?? 240_000);

// All selectors live here. Class names are hashed on this site, so only ds-* classes, text and aria are used.
export const SEL = {
  input: 'textarea',
  send: '.ds-button--primary.ds-button--circle',
  toggle: '.ds-toggle-button',
  answer: '.ds-markdown.ds-assistant-message-main-content',
  done: '[aria-label="朗读"]', // action bar under a finished answer
  newChat: '开启新对话',
  fileInput: 'input[type=file]',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // never page.waitForTimeout (CDP-detectable)

let ctx, page, stopping = false;

// Log in by importing login.json (cookies + localStorage) when it is new to this profile. Logins made on another
// OS cannot be copied as a profile (cookie encryption differs), so the state is exported and re-added instead.
async function importLogin() {
  if (!existsSync(LOGIN_STATE)) return;
  const raw = readFileSync(LOGIN_STATE, 'utf8');
  const marker = join(PROFILE_DIR, '.login-imported');
  const hash = createHash('sha1').update(raw).digest('hex');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === hash) return;
  const state = JSON.parse(raw);
  await ctx.addCookies(state.cookies ?? []);
  const items = state.origins?.find((o) => o.origin === HOME.slice(0, -1))?.localStorage ?? [];
  await page.goto(HOME, { waitUntil: 'domcontentloaded' }); // localStorage can only be set on the site's own origin
  await page.evaluate((kv) => kv.forEach(({ name, value }) => localStorage.setItem(name, value)), items);
  await page.reload({ waitUntil: 'domcontentloaded' });
  writeFileSync(marker, hash);
  console.log(`imported login state (${state.cookies?.length ?? 0} cookies, ${items.length} localStorage items)`);
}

export async function start() {
  ctx = await launchPersistentContext(launchOptions());
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: HOME.slice(0, -1) });
  page = ctx.pages()[0] || (await ctx.newPage());
  // a dead browser cannot be repaired from inside: exit and let the platform (systemd, Docker, the agent cloud) restart us
  const die = (why) => { if (!stopping) { console.error(`browser ${why}, exiting`); process.exit(1); } };
  ctx.on('close', () => die('closed'));
  page.on('crash', () => die('page crashed'));
  await importLogin();
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
}

// Free license has 1 seat: always close gracefully or the seat is stuck for ~4 min.
export async function stop() {
  stopping = true;
  try { await ctx?.close(); } catch {}
}

export const isAlive = () => !!page && !page.isClosed();

// Why did the page stop working? A login/captcha wall is a BridgeError (a human must act); anything else returns null.
async function classify() {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const kind = blockKind(page.url(), text);
  return kind ? new BridgeError(kind) : null;
}

async function newChat() {
  if (new URL(page.url()).pathname !== '/') {
    const btn = page.getByText(SEL.newChat).first();
    if (await btn.count()) await btn.click();
    else await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  }
  try {
    await page.locator(SEL.input).waitFor({ timeout: 20_000 });
  } catch (e) {
    throw (await classify()) ?? e;
  }
}

async function setToggle(label, wantOn) {
  const t = page.locator(SEL.toggle, { hasText: label });
  if (!(await t.count())) return;
  const on = (await t.getAttribute('aria-pressed')) === 'true';
  if (on !== wantOn) await t.click();
}

async function enter(text) {
  const ta = page.locator(SEL.input);
  await ta.click();
  // typed "\n" is an Enter keypress, which SENDS the message: anything multi-line must be pasted, never typed
  if (text.length <= TYPE_MAX && !text.includes('\n')) return ta.fill(text);
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+V'); // a person would paste a long text
}

// Runs inside the page: rendered answer DOM -> markdown (innerText loses code fences).
function toMarkdown(root) {
  const walk = (n) => {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1) return '';
    const tag = n.tagName.toLowerCase();
    const kids = () => [...n.childNodes].map(walk).join('');
    const cl = n.classList;
    if (tag === 'svg' || tag === 'button') return '';
    if (cl.contains('md-code-block')) {
      const lang = n.querySelector('.md-code-block-banner span')?.textContent.trim() ?? '';
      const code = (n.querySelector('pre')?.innerText ?? '').replace(/\n+$/, '');
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }
    if (cl.contains('katex-display') || cl.contains('katex')) {
      const tex = n.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (tex) return cl.contains('katex-display') ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
    }
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(+tag[1])} ${kids().trim()}\n\n`;
    switch (tag) {
      case 'p': return `${kids()}\n\n`;
      case 'br': return '\n';
      case 'strong': case 'b': return `**${kids()}**`;
      case 'em': case 'i': return `*${kids()}*`;
      case 'code': return `\`${kids()}\``;
      case 'a': return `[${kids().replace(/^-(\d+)$/, '$1')}](${n.getAttribute('href') ?? ''})`; // search citations are labelled "-1", "-4"…
      case 'hr': return '\n\n---\n\n';
      case 'blockquote': return `\n\n${kids().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'ul': case 'ol': {
        const items = [...n.children].filter((c) => c.tagName === 'LI').map((li, i) => {
          const body = [...li.childNodes].map(walk).join('').trim().replace(/\n+/g, '\n').split('\n').join('\n  ');
          return `${tag === 'ol' ? `${i + 1}.` : '-'} ${body}`;
        });
        return `\n\n${items.join('\n')}\n\n`;
      }
      case 'table': {
        const rows = [...n.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.innerText.trim().replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const line = (r) => `| ${r.join(' | ')} |`;
        return `\n\n${[line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
      }
      default: return kids();
    }
  };
  return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}

// Identity of the newest answer on screen. The page uses a virtual list, so counting answers is not reliable;
// the item key of the newest answer is, and the action bar sits in the same item.
const lastAnswer = () => page.evaluate(([a, d]) => {
  const all = document.querySelectorAll(a);
  const last = all[all.length - 1];
  const item = last?.closest('[data-virtual-list-item-key]');
  return { n: all.length, key: item?.dataset.virtualListItemKey ?? null, len: last ? last.innerText.length : 0, done: !!item?.querySelector(d) };
}, [SEL.answer, SEL.done]);

export class ContinueError extends Error {}

// Open an existing conversation; any failure means "start fresh instead" (deleted chat, redirected, logged out).
async function openChat(url) {
  try {
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator(SEL.input).waitFor({ timeout: 15_000 });
    if (page.url() !== url) throw new Error('redirected');
  } catch (e) {
    throw (await classify()) ?? new ContinueError(e.message);
  }
  // let the virtual list render the history before we remember what the newest answer is
  let prevSig = '';
  for (let i = 0; i < 16; i++) {
    const s = await lastAnswer();
    const sig = `${s.n}/${s.key}`;
    if (sig === prevSig) return;
    prevSig = sig;
    await sleep(700);
  }
}

const HISTORY_FILE = '之前的对话.txt';

// New chat but the caller has earlier messages: attach them as a .txt, the way a person uploads a document.
// The attach button is the element right before the hidden file input; clicking it opens a file chooser we answer.
async function attachHistory(transcript) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbridge-'));
  const file = join(dir, HISTORY_FILE);
  try {
    writeFileSync(file, transcript);
    const button = page.locator(SEL.fileInput).locator('xpath=preceding-sibling::*[1]');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), button.click()]);
    await chooser.setFiles(file);
    // uploaded = the chip shows the file name and its size label ("TXT 99B"); until then the label is not there
    await page.waitForFunction((name) => {
      const el = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent === name);
      return !!el && /\d ?[KMG]?B$/.test(el.parentElement.parentElement.textContent.trim()); // chip text = "<name>TXT 99B"
    }, HISTORY_FILE, { timeout: 60_000 });
    await sleep(800 + Math.random() * 1200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Ask in a conversation and return { text, url }. With `url` it continues that chat (only `prompt` is sent);
 * otherwise it opens a new chat, attaching `history` (a transcript) first if given. Caller must serialize calls.
 */
export async function ask(prompt, { thinking = false, search = false, onDelta, url, history } = {}) {
  if (url) await openChat(url);
  else await newChat();
  await setToggle('智能搜索', search);
  await setToggle('深度思考', thinking);
  if (!url && history) await attachHistory(history);
  const before = await lastAnswer();
  await enter(prompt);
  await page.locator(SEL.send).click();

  const startedAt = Date.now();
  let lastCheck = startedAt;
  const deadline = startedAt + TIMEOUT_MS;
  const md = () => page.locator(SEL.answer).last().evaluate(toMarkdown);
  let lastLen = -1, lastChange = Date.now(), prev = '', sent = 0;
  // Streaming = emit only text two consecutive snapshots agree on, minus a tail the renderer may still rewrite
  // (closing code fence, half-closed markers). Everything left is flushed once the answer is finished.
  const HOLD = 6;
  while (Date.now() < deadline) {
    await sleep(300);
    const s = await lastAnswer();
    const isNew = s.key !== before.key || s.n > before.n;
    if (!isNew || s.len === 0) {
      lastChange = Date.now();
      // nothing is coming back: after a while check whether a captcha/login wall is in the way
      if (Date.now() - startedAt > 30_000 && Date.now() - lastCheck > 15_000) {
        lastCheck = Date.now();
        const blocked = await classify();
        if (blocked) throw blocked;
      }
      continue;
    }
    if (s.len !== lastLen) {
      lastLen = s.len;
      lastChange = Date.now();
      if (onDelta) {
        const cur = await md();
        let k = 0;
        while (k < cur.length && k < prev.length && cur[k] === prev[k]) k++;
        const safe = Math.max(sent, k - HOLD);
        if (safe > sent) { onDelta(cur.slice(sent, safe)); sent = safe; }
        prev = cur;
      }
    }
    const quiet = Date.now() - lastChange;
    // finished = action bar appeared and text stopped changing; fallback if the bar selector ever breaks
    if ((s.done && quiet >= 1500) || quiet >= 10_000) {
      const text = await md();
      // shortcut: if the renderer rewrote text we already sent, the rest is still appended (slightly garbled)
      if (onDelta && text.length > sent) onDelta(text.slice(sent));
      return { text, url: page.url(), mode: url ? 'continue' : history ? 'attach' : 'new' };
    }
  }
  throw (await classify()) ?? new Error(`timeout after ${TIMEOUT_MS / 1000}s waiting for the answer`);
}
