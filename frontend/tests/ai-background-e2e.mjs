// "Sort them in the background" (Tidy up with AI), in a browser with synthetic links: it applies
// as it goes, keeps going on other pages (the save note counts), can be stopped and undone, leaves
// links without an answer for later instead of guessing, and "Keep sorting new links" starts by
// itself. The AI endpoint is answered in the page; nothing is sent anywhere.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importThroughField } from './importField.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'ai-background-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
// Polls from Node: page.waitForFunction doesn't wait for an async check (its promise counts as true at once).
const until = async (what, test, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise(r => setTimeout(r, 300)); }
  throw new Error(`timed out waiting for ${what}`);
};
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`); }
}

const now = Date.now();
const link = (id, i) => ({ id, url: `https://s${id}.example.invalid/post/${i}`, source: 'browser', platform: 'web', domain: `s${id}.example.invalid`,
  status: 'reference', createdAt: new Date(now - i * 3600e3).toISOString(), updatedAt: new Date(now - i * 3600e3).toISOString(),
  metadataStatus: 'enriched', categories: ['other'], categoryMode: 'automatic', categoryReview: true, tags: [], projectIds: [],
  title: `caption ${i} #stuff on Instagram`, description: `Words about thing ${i}` });
const posts = Array.from({ length: 20 }, (_, i) => link(`b${i}`, i));
const library = async () => Object.fromEntries((await (await fetch(base + '/api/library')).json()).posts.map(p => [p.id, p]));
const providers = { available: true, ready: ['freellmapi'], providers: [{ id: 'freellmapi', label: 'FreeLLMAPI', note: '', signup: '', configured: true,
  enabled: true, keySource: 'settings', keyHint: '…0001', model: 'auto:fast', defaultModel: 'auto:fast', baseUrl: 'http://127.0.0.1:3001/v1',
  state: 'ready', retryIn: 0, today: { requests: 0, failures: 0, tokens: 0 }, detail: '' }] };

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
  assert.ok(seeded.ok, await seeded.text());

  const page = await (await browser.newContext({ viewport: { width: 1365, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/ai/providers', route => route.fulfill({ json: providers }));
  let mode = 'answer';
  let asked = 0;
  await page.route('**/api/ai/suggest', async route => {
    const { items } = route.request().postDataJSON();
    asked += items.length;
    await new Promise(r => setTimeout(r, mode === 'slow' ? 8000 : 450));
    if (mode === 'busy') {
      return route.fulfill({ json: { ok: true, engine: 'keywords', fallbackReason: 'rate_limited', retryIn: 1, missing: items.map(i => i.id),
        items: items.map(i => ({ id: i.id, shelf: 'technology', tags: ['keyword-guess'] })) } }).catch(() => {});
    }
    // Even-numbered links fit "technology"; odd ones fit nothing ("other") but get tags and a clean title.
    return route.fulfill({ json: { ok: true, engine: 'freellmapi', items: items.map(i => {
      const n = Number(i.id.replace(/\D/g, ''));
      return { id: i.id, shelf: n % 2 ? 'other' : 'technology', tags: ['sorted'], title: `Thing ${n}`, summary: 'Worth a look.' };
    }) } }).catch(() => {});
  });
  const saved = () => page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor({ timeout: 30000 });
  const go = path => page.evaluate(to => { history.pushState({}, '', to); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await page.goto(base + '/library/settings#ai');
  await saved();
  const panel = page.getByRole('region', { name: 'Tidy up with AI' });
  await panel.waitFor();
  const result = panel.getByRole('status', { name: 'AI review result' });
  const toast = page.locator('.save-toast__text');

  await check('sorting in the background applies as it goes and keeps going on another page; the save note counts', async () => {
    await panel.getByRole('button', { name: 'Sort them in the background' }).click();
    await go('/');
    let label = '';
    for (let i = 0; i < 40 && !/Sorting with AI · \d+\/20/.test(label); i++) { label = await toast.getAttribute('data-label') ?? ''; await page.waitForTimeout(100); }
    assert.match(label, /Sorting with AI · \d+\/20/);
    await go('/library/settings#ai');
    await result.filter({ hasText: /Done: sorted 20 links in the background — 10 filed onto shelves, 10 left in "other"/ }).waitFor({ timeout: 30000 });
    await saved();
    const lib = await library();
    for (let i = 0; i < 20; i++) {
      const p = lib[`b${i}`];
      assert.ok(p.aiCheckedAt, `b${i} checked`);
      assert.deepEqual([p.categories, p.categoryMode], i % 2 ? [['other'], 'automatic'] : [['technology'], 'automatic'], `b${i}`);
      assert.equal(p.title, `Thing ${i}`);
      assert.equal(p.originalTitle, `caption ${i} #stuff on Instagram`);
    }
    assert.equal(await panel.getByRole('button', { name: /Suggest for 0 links/ }).count(), 1, 'nothing left to sort');
  });

  await check('Undo puts every link back as it was before the AI sorted it', async () => {
    await panel.getByRole('button', { name: "Undo the AI's changes (20)" }).click();
    await result.filter({ hasText: 'Put 20 links back as they were before the AI sorted them.' }).waitFor();
    await saved();
    const lib = await library();
    for (let i = 0; i < 20; i++) {
      const p = lib[`b${i}`];
      assert.deepEqual([p.categories, p.categoryMode, p.categoryReview, p.tags, p.title], [['other'], 'automatic', true, [], `caption ${i} #stuff on Instagram`], `b${i}`);
      assert.ok(!p.aiCheckedAt && !p.originalTitle && !p.aiSummary, `b${i} has no trace of the AI`);
    }
  });

  await check('Stop ends a background run at once, with nothing half done', async () => {
    mode = 'slow';
    try {
      await panel.getByRole('button', { name: /Suggest for 20 links/ }).waitFor();
      await panel.getByRole('button', { name: 'Sort them in the background' }).click();
      await panel.getByRole('button', { name: 'Stop' }).waitFor();
      await page.waitForTimeout(800);
      const stopped = Date.now();
      await panel.getByRole('button', { name: 'Stop' }).click();
      await result.filter({ hasText: /^Stopped: sorted 0 links in the background/ }).waitFor({ timeout: 5000 });
      assert.ok(Date.now() - stopped < 3000, 'the answers in flight were not waited for');
      assert.equal(await panel.getByRole('button', { name: /Undo the AI's changes/ }).count(), 0, 'nothing to undo');
      const lib = await library();
      assert.ok(Object.values(lib).every(p => !p.aiCheckedAt && p.categories[0] === 'other'));
    } finally { mode = 'answer'; }
  });

  await check('links without an answer are left for later, never filed by keyword guesses', async () => {
    mode = 'busy';
    try {
      await panel.getByRole('button', { name: 'Sort them in the background' }).click();
      await result.filter({ hasText: /20 links got no answer yet; they are tried again later/ }).waitFor({ timeout: 60000 });
      await saved();
      const lib = await library();
      assert.ok(Object.values(lib).every(p => p.categories[0] === 'other' && !p.aiCheckedAt && !p.tags.includes('keyword-guess')));
    } finally { mode = 'answer'; }
  });

  await check('"Keep sorting new links" sorts links waiting when the app opens, and links that arrive later', async () => {
    await panel.getByRole('checkbox', { name: /Keep sorting new links in the background/ }).check();
    // The app opens again: the 20 still unsorted are sorted by themselves.
    await page.reload();
    await saved();
    await until('the 20 waiting links sorted by themselves after the app opened', async () => Object.values(await library()).every(p => p.aiCheckedAt), 60000);
    // New links arrive while the app is open (a bookmarks import): sorted too, without a click.
    const before = asked;
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><TITLE>Bookmarks</TITLE><H1>Bookmarks</H1><DL><p>'
      + Array.from({ length: 5 }, (_, i) => `<DT><A HREF="https://new${i}.example.invalid/page">Untitled thing ${i}</A>`).join('') + '</DL><p>';
    await go('/library/settings#sources');
    const imported = await importThroughField(page, { name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    assert.equal(imported.added, 5, imported.text);
    await until('the 5 imported links sorted by themselves', async () => {
      const fresh = Object.values(await library()).filter(p => p.url.includes('.example.invalid/page'));
      return fresh.length === 5 && fresh.every(p => p.aiCheckedAt);
    }, 60000);
    assert.equal(asked - before, 5, 'only the new links were asked about');
    await go('/library/settings#ai');
  });

  await check('Undo while "Keep sorting new links" is on turns it off, so the links are not sorted straight back', async () => {
    const keep = panel.getByRole('checkbox', { name: /Keep sorting new links in the background/ });
    assert.equal(await keep.isChecked(), true);
    await panel.getByRole('button', { name: /Undo the AI's changes \(25\)/ }).click();
    await result.filter({ hasText: /Put 25 links back as they were before the AI sorted them\. "Keep sorting new links" is now off/ }).waitFor();
    assert.equal(await keep.isChecked(), false);
    await saved();
    const before = asked;
    await page.waitForTimeout(6500);
    assert.equal(asked, before, 'nothing was sorted by itself');
    assert.ok(Object.values(await library()).every(p => !p.aiCheckedAt));
  });

  await check('Stop holds "Keep sorting new links" back instead of starting again a few seconds later', async () => {
    mode = 'slow';
    try {
      const keep = panel.getByRole('checkbox', { name: /Keep sorting new links in the background/ });
      await keep.check();
      await panel.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 15000 });   // started by itself
      await page.waitForTimeout(500);
      await panel.getByRole('button', { name: 'Stop' }).click();
      await result.filter({ hasText: /"Keep sorting new links" waits until you start a run or open the app again/ }).waitFor({ timeout: 5000 });
      const before = asked;
      await page.waitForTimeout(6500);
      assert.equal(asked, before, 'no new run after the Stop');
      await keep.uncheck();
    } finally { mode = 'answer'; }
  });

  await check('phone width: the panel fits without sideways scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= client, `${scroll} > ${client}`);
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
