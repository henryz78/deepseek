// Run where you logged in (stop the server first: the free license has one browser seat).
//   npm run export-login            -> writes login.json (cookies + localStorage of chat.deepseek.com)
// If you are logged out, a window opens: log in by hand, then this script exports.
import { launchPersistentContext } from 'cloakbrowser';
import { chmodSync, writeFileSync } from 'node:fs';
import { blockKind } from './detect.mjs';
import { HOME, launchOptions } from './deepseek.mjs';

const OUT = process.argv[2] ?? 'login.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await launchPersistentContext({ ...launchOptions(), headless: false }); // you may need to see it
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  const loggedIn = async () => !blockKind(page.url(), '') && (await page.locator('textarea').count()) > 0;
  if (!(await loggedIn())) {
    console.log('Not logged in: log in in the browser window (up to 10 minutes)...');
    for (let i = 0; i < 300 && !(await loggedIn()); i++) await sleep(2000);
    if (!(await loggedIn())) throw new Error('still not logged in, nothing exported');
  }
  await sleep(2000); // let the page finish writing its tokens
  const state = await ctx.storageState();
  const keys = state.origins.find((o) => o.origin === HOME.slice(0, -1))?.localStorage.length ?? 0;
  writeFileSync(OUT, JSON.stringify(state), { mode: 0o600 });
  try { chmodSync(OUT, 0o600); } catch {}
  console.log(`wrote ${OUT}: ${state.cookies.length} cookies, ${keys} localStorage items. Treat it like a password.`);
} finally {
  await ctx.close(); // frees the license seat
}
