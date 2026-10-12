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
// Polls from Node: page.waitForFunction doesn't wait for an async check (its promise counts as true at once).
const until = async (what, test, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise(r => setTimeout(r, 300)); }
  throw new Error(`timed out waiting for ${what}`);
};
const library = async () => (await (await fetch(base + '/api/library')).json()).posts;
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
    if (mode === 'no-answer') {
      // A provider that never answers: the server would hold the request for up to 100 s.
      await new Promise(resolve => setTimeout(resolve, 60000));
      return route.fulfill({ json: { ok: true, engine: 'groq', items: [] } }).catch(() => {});
    }
    if (mode === 'some-fit') {
      // Even-numbered links fit a shelf; odd ones fit nothing (the AI says "other") but get tags.
      return route.fulfill({ json: { ok: true, engine: 'groq', items: ids.map(id => (Number(id.slice(1)) % 2
        ? { id, shelf: 'other', tags: ['run-' + calls.length] } : { id, shelf: 'technology', tags: ['sorted'] })) } });
    }
    if (mode === 'one-refused' && ids.includes('w3')) {
      // What the server answered for a link with a long id until v0.3.0's fix: the whole run used to stop here.
      return route.fulfill({ status: 400, json: { ok: false, error: 'Each link needs an id.' } });
    }
    if (mode === 'one-refused') return route.fulfill({ json: { ok: true, engine: 'freellmapi', items: answer(ids) } });
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
    // Only the links left out were asked again (batches of 8 and 1; each first ask comes back half answered: 8, 4, 2, 1).
    assert.deepEqual(calls.map(c => c.length).sort((x, y) => x - y), [1, 1, 2, 4, 8]);
    // Both batches were in flight together and asked different providers first.
    assert.deepEqual([...new Set(spreads)].sort(), [0, 1]);
    assert.equal(await section.getByRole('status', { name: 'AI review result' }).count(), 0);
  });

  await check('applying moves every link out of "other"', async () => {
    await section.getByRole('button', { name: /Apply 9/ }).click();
    await until('every link on "technology" in SQLite', async () => (await library()).every(p => p.categories[0] === 'technology'));
  });

  await check('links the AI cannot place are not asked about again, until their preview changes', async () => {
    mode = 'some-fit';
    const four = [0, 1, 2, 3].map(i => ({ ...posts[0], id: `o${i}`, url: `https://o${i}.example.invalid/post/${i}`, domain: `o${i}.example.invalid`,
      title: `Odd thing ${i}`, updatedAt: new Date().toISOString() }));
    await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: four, deletedUrls: [] }) });
    await page.reload();
    await section.getByRole('button', { name: /Suggest for 4 links/ }).click();
    await progress.filter({ hasText: /^4\/4 checked/ }).waitFor({ timeout: 30000 });
    await section.getByRole('status', { name: 'AI review result' }).filter({ hasText: /2 links don't fit any of your shelves/ }).waitFor();
    await section.getByRole('button', { name: /Apply 4/ }).click();
    // Applied: the two that fit moved; the two that don't are not offered again (they came back with new tags every run).
    await section.getByRole('button', { name: /Suggest for 0 links/ }).waitFor({ timeout: 10000 });
    await until('the two odd links checked and left in "other"', async () => {
      const odd = (await library()).filter(p => p.id === 'o1' || p.id === 'o3');
      return odd.length === 2 && odd.every(p => p.aiCheckedAt && p.categories[0] === 'other');
    });
    // A newer preview for one of them: worth asking again.
    const lib = await (await fetch(base + '/api/library')).json();
    const o1 = lib.posts.find(p => p.id === 'o1');
    await page.waitForTimeout(20);
    const later = new Date().toISOString();
    await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts: [{ ...o1, description: 'A preview that says what this is', enrichedAt: later, updatedAt: later }], deletedUrls: [] }) });
    await page.reload();
    await section.getByRole('button', { name: /Suggest for 1 link\b/ }).click();
    await progress.filter({ hasText: /^1\/1 checked/ }).waitFor({ timeout: 30000 });
    await section.getByRole('button', { name: /Apply 1/ }).click();
    await section.getByRole('button', { name: /Suggest for 0 links/ }).waitFor({ timeout: 10000 });
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

  await check('Stop answers at once while a request is still waiting for a provider', async () => {
    mode = 'no-answer';
    await page.reload();
    await section.getByRole('button', { name: /Suggest for 9 links/ }).click();
    await progress.filter({ hasText: /waiting for a slow answer/ }).waitFor({ timeout: 15000 });
    const stopped = Date.now();
    await section.getByRole('button', { name: 'Stop' }).click();
    await section.getByRole('status', { name: 'AI review result' }).filter({ hasText: /Stopped/ }).waitFor({ timeout: 5000 });
    assert.ok(Date.now() - stopped < 3000, `Stop took ${Date.now() - stopped} ms`);
    assert.equal(await section.getByRole('button', { name: /Suggest for 9 links/ }).isEnabled(), true);
  });

  await check('a batch the server refuses is set aside and the run carries on through the rest', async () => {
    mode = 'one-refused';
    const extra = Array.from({ length: 11 }, (_, i) => ({ ...posts[0], id: `w${i}`, url: `https://w${i}.example.invalid/p/${i}`,
      domain: `w${i}.example.invalid`, title: `More things ${i}`, updatedAt: new Date().toISOString() }));
    await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: extra, deletedUrls: [] }) });
    await page.reload();
    calls.length = 0;
    await section.getByRole('button', { name: /Suggest for 20 links/ }).click();
    await progress.filter({ hasText: /^20\/20 checked/ }).waitFor({ timeout: 30000 });
    const note = section.getByRole('status', { name: 'AI review result' });
    await note.filter({ hasText: /couldn't be checked \(Each link needs an id\); run it again later/ }).waitFor({ timeout: 10000 });
    const skipped = Number((await note.innerText()).match(/(\d+) links? couldn't be checked/)[1]);
    const refused = calls.find(c => c.includes('w3')).length;
    assert.equal(skipped, refused, 'the refused batch is the one set aside');
    assert.equal(await section.locator('.ai-review-row').count(), 20 - refused, 'every other batch was answered');
    assert.equal(calls.filter(c => c.includes('w3')).length, 2, 'the refused batch is tried twice, then set aside');
  });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS ai tidy e2e; evidence ${evidence}`);
