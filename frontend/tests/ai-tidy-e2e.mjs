// "Tidy up with AI": busy free tiers are waited out instead of settling for
// keyword guesses, every link ends up answered, Stop works mid-wait, and the
// summary says what is left. Synthetic data; the AI endpoint is mocked in-page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'ai-tidy-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const now = Date.now();
const posts = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, url: `https://s${i}.example.invalid/post/${i}`, source: 'browser',
  platform: 'web', domain: `s${i}.example.invalid`, status: 'reference', createdAt: new Date(now - i * 3600e3).toISOString(),
  updatedAt: new Date(now - i * 3600e3).toISOString(), metadataStatus: 'enriched', categories: ['other'], categoryMode: 'automatic',
  tags: [], projectIds: [], title: `Unsorted thing ${i}`, description: `Words about thing ${i}` }));
await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });

const providers = { available: true, ready: ['groq'], providers: [{ id: 'groq', label: 'Groq', note: '', signup: '', configured: true,
  enabled: true, keySource: 'settings', keyHint: '…0000', model: 'm', defaultModel: 'm', baseUrl: '', state: 'ready', retryIn: 0,
  today: { requests: 0, failures: 0, tokens: 0 }, detail: '' }] };

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const page = await (await browser.newContext({ viewport: { width: 1365, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/ai/providers', route => route.fulfill({ json: providers }));
  let mode = 'busy-then-ok';
  const calls = []; const spreads = [];
  await page.route('**/api/ai/suggest', async route => {
    const { items, spread } = route.request().postDataJSON();
    spreads.push(spread);
    const ids = items.map(i => i.id);
    calls.push(ids);
    const answer = list => list.map(id => ({ id, shelf: 'technology', tags: ['sorted'] }));
    if (mode === 'always-busy') {
      return route.fulfill({ json: { ok: true, engine: 'keywords', fallbackReason: 'rate_limited', retryIn: 30, missing: ids,
        items: ids.map(id => ({ id, shelf: 'other' })) } });
    }
    // The first ask for each batch gets only half the links back (rate limit hit midway).
    const first = calls.filter(c => c[0] === ids[0]).length === 1 && ids.length > 1;
    if (first) {
      const half = Math.ceil(ids.length / 2);
      return route.fulfill({ json: { ok: true, engine: 'groq', fallbackReason: 'rate_limited', retryIn: 1,
        missing: ids.slice(half), items: [...answer(ids.slice(0, half)), ...ids.slice(half).map(id => ({ id, shelf: 'other' }))] } });
    }
    return route.fulfill({ json: { ok: true, engine: 'groq', items: answer(ids) } });
  });
  await page.goto(base + '/library/settings#ai');
  const section = page.getByRole('region', { name: 'Tidy up with AI' });
  await section.waitFor();
  const progress = section.getByRole('status', { name: 'AI suggestion progress' });

  await check('busy providers are waited out and every unsorted link gets an AI answer', async () => {
    await section.getByRole('button', { name: /Suggest for 9 links/ }).click();
    await progress.filter({ hasText: /providers busy, trying again/ }).waitFor({ timeout: 10000 });
    await progress.filter({ hasText: /^9\/9 checked/ }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(300);
    await section.getByRole('list', { name: 'AI suggestions' }).waitFor();
    assert.equal(await section.locator('.ai-review-row').count(), 9);
    // Only the links left out were asked again.
    assert.deepEqual(calls.map(c => c.length).sort((x, y) => x - y), [1, 1, 3, 3, 6]);
    // Both batches were in flight together and asked different providers first.
    assert.deepEqual([...new Set(spreads)].sort(), [0, 1]);
    assert.equal(await section.getByRole('status', { name: 'AI review result' }).count(), 0);
  });

  await check('applying moves every link out of "other"', async () => {
    await section.getByRole('button', { name: /Apply 9/ }).click();
    await page.waitForFunction(async url => {
      const lib = await (await fetch(url)).json();
      return lib.posts.every(p => p.categories[0] === 'technology');
    }, base + '/api/library', { timeout: 15000, polling: 300 });
  });

  await check('Stop ends a long wait at once and says so', async () => {
    mode = 'always-busy';
    const more = posts.map((p, i) => ({ ...p, id: `u${i}`, url: `https://u${i}.example.invalid/post/${i}`, title: `Another thing ${i}` }));
    await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: more, deletedUrls: [] }) });
    await page.reload();
    await section.getByRole('button', { name: /Suggest for 9 links/ }).click();
    await progress.filter({ hasText: /trying again in/ }).waitFor({ timeout: 10000 });
    const stopped = Date.now();
    await section.getByRole('button', { name: 'Stop' }).click();
    await section.getByRole('status', { name: 'AI review result' }).filter({ hasText: /Stopped/ }).waitFor({ timeout: 5000 });
    assert.ok(Date.now() - stopped < 4000, 'Stop waited out the retry timer');
    assert.equal(await section.getByRole('button', { name: /Suggest for 9 links/ }).isEnabled(), true);
  });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS ai tidy e2e; evidence ${evidence}`);
