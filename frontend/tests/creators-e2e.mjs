// Creators (v0.4.0 phase 6b, mockups in Claude outputs/v040-review/phase6b/): "Find creators in your saved posts"
// proposes creators from the posts themselves; a creator's page has its names (a name that is another creator's
// asks "same person?" and leads to a field-by-field merge with Undo), moving posts to a new creator, creator: in the
// search and "new since you looked". Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/creators-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'creators-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = ${JSON.stringify(join(evidence, 'data'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
os.environ["SBM_SAVED_COPIES"] = "off"
from metadata_fixture import ControlledHTTP, JPEG, PUBLIC_IP
import storage, app, metadata_fetcher
real_fetch = metadata_fetcher.fetch_metadata
# Only the stand-in profile page is really read (through the fixture); every other preview stays empty.
metadata_fetcher.fetch_metadata = lambda url: real_fetch(url) if url.startswith("http://profile.fixture.test/") else {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
site = ControlledHTTP().__enter__()          # nothing may leave the machine
site.dns["profile.fixture.test"] = [PUBLIC_IP]
site.html("/kit", '<html><head><meta property="og:title" content="Bakehouse Kit (@bakehouse_kit) / X"><meta property="og:description" content="Sourdough classes in Leeds."><meta property="og:image" content="http://profile.fixture.test/pic.jpg"></head></html>')
site.routes["/pic.jpg"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const at = n => new Date(Date.now() - n * 86400000).toISOString();
const link = (id, url, platform, title, author, age) => ({ id, url, source: 'browser', platform, domain: new URL(url).hostname.replace(/^www\./, ''),
  status: 'reference', createdAt: at(age), updatedAt: at(age), metadataStatus: 'partial', categories: ['food-drink'], categoryMode: 'manual',
  tags: [], projectIds: [], title, ...(author ? { author } : {}) });
const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [
  link('p1', 'https://x.com/bakehouse_kit/status/1001', 'x', 'Shaping a batard', 'Bakehouse Kit', 2),
  link('p2', 'https://x.com/bakehouse_kit/status/1002', 'x', 'Rye ratios', 'Bakehouse Kit', 9),
  link('p3', 'https://www.instagram.com/p/CkitOne1/', 'instagram', 'bakehouse.kit on Instagram', '', 3),
  link('p4', 'https://www.tiktok.com/@ana.field/video/7001', 'tiktok', 'Ten walks', 'Ana Field', 4),
  link('p5', 'https://example.org/an-article', 'web', 'An article', 'Someone', 5)] }) });
assert.ok(seeded.ok, 'library seeded');
const stored = async () => (await (await fetch(base + '/api/library')).json());
const until = async (test, what, timeout = 10000) => {
  const end = Date.now() + timeout;
  for (;;) { const value = await test(); if (value) return value; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 200)); }
};

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const errors = []; context.on('weberror', e => errors.push(e.error().message));
const page = await context.newPage();
const cards = page.getByLabel('Creators', { exact: true });
let kit = '';

try {
  await check('"Find creators" proposes them from the posts, and Apply makes them', async () => {
    await page.goto(`${base}/shelves`);
    await page.getByRole('link', { name: /^Creators 0/ }).click();
    await page.getByText('No creators yet.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Find creators in your saved posts' }).click();
    const dialog = page.getByRole('dialog', { name: 'Creators in your saved posts' });
    const fresh = dialog.getByRole('region', { name: 'New creators' }).or(dialog.locator('section[aria-label="New creators"]'));
    await fresh.getByText('Bakehouse Kit').waitFor();
    await fresh.getByText('X @bakehouse_kit · 2 posts').waitFor();
    await fresh.getByText('Instagram bakehouse.kit · 1 post').waitFor();
    assert.equal(await dialog.getByText('An article').count(), 0, 'a plain web page says nothing about who made it');
    await page.screenshot({ path: join(evidence, 'find.png') });
    await dialog.getByRole('button', { name: 'Add 3 creators, attach 4 posts' }).click();
    await page.getByRole('status').getByText('Added 3 creators; 4 posts now say who made them.').waitFor();
    await cards.getByRole('article', { name: 'Bakehouse Kit' }).getByText('2 saved', { exact: false }).waitFor();
    await until(async () => { const s = await stored(); return s.docs?.creators?.length === 3 && s.posts.filter(p => p.creatorId).length === 4; }, 'saved to SQLite');
    kit = (await stored()).docs.creators.find(c => c.name === 'Bakehouse Kit').id;
  });

  await check('a name that is another creator\'s asks "same person?", and the merge has Undo', async () => {
    await cards.getByRole('link', { name: 'Bakehouse Kit' }).click();
    await page.getByRole('button', { name: /^Bakehouse Kit/ }).click();
    await page.getByLabel('Another name for Bakehouse Kit').fill('bakehouse.kit');
    await page.getByLabel('Another name for Bakehouse Kit').press('Enter');
    const clash = page.getByRole('alert').filter({ hasText: 'is the name of another creator' });
    await clash.waitFor();
    await clash.getByRole('button', { name: 'Merge them…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Merge creators' });
    assert.equal(await dialog.getByLabel('Creator to merge').inputValue() !== kit, true);
    await dialog.getByText('1 post moves to Bakehouse Kit.').waitFor();
    await dialog.getByText('(“bakehouse.kit” becomes another name)').waitFor();
    await page.screenshot({ path: join(evidence, 'merge.png') });
    await dialog.getByRole('button', { name: 'Merge' }).click();
    await page.getByRole('status').getByText('Merged.').waitFor();
    await page.getByText('Instagram bakehouse.kit').waitFor();
    await until(async () => { const s = await stored(); return s.docs.creators.length === 2 && s.posts.find(p => p.id === 'p3').creatorId === kit; }, 'merged in SQLite');
    await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
    await until(async () => { const s = await stored(); return s.docs.creators.length === 3 && s.posts.find(p => p.id === 'p3').creatorId !== kit; }, 'undone in SQLite');
  });

  await check('moving a post to a new creator, with Undo', async () => {
    await page.goto(`${base}/creators/${kit}`);
    await page.locator('article[data-post-id="p2"]').getByRole('checkbox', { name: 'Select post' }).check();
    await page.getByRole('button', { name: 'Move 1 to another creator…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move 1 post to another creator' });
    await dialog.getByLabel('New creator\'s name').fill('Kit Bakes (second account)');
    await dialog.getByRole('button', { name: 'Move' }).click();
    await page.getByRole('status').getByText('Moved 1 post.').waitFor();
    await until(async () => { const s = await stored(); const made = s.docs.creators.find(c => c.name === 'Kit Bakes (second account)');
      return made && s.posts.find(p => p.id === 'p2').creatorId === made.id; }, 'moved in SQLite');
  });

  await check('creator: in the library search', async () => {
    await page.goto(`${base}/library`);
    await page.locator('input[placeholder="Search… ( / )"]').fill('creator:bakehouse');
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '2');   // Bakehouse Kit and bakehouse.kit
    await page.locator('input[placeholder="Search… ( / )"]').fill('creator:"bakehouse kit"');
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '1');
    await page.getByLabel('How the search is read').getByText('by bakehouse kit').waitFor();
  });

  await check('"new since you looked" counts posts that came in after the last visit', async () => {
    const before = (await stored()).docs.creators.find(c => c.id === kit);
    await page.goto(`${base}/creators/${kit}`);
    await page.waitForTimeout(3500);       // a visit counts after a second and a half; a save would follow it
    const s = await stored();
    assert.deepEqual(s.docs.creators.find(c => c.id === kit), before, 'looking is noted in this browser only: the creator SQLite has is untouched');
    const posted = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], epoch: s.epoch,
      posts: [{ ...link('p6', 'https://x.com/bakehouse_kit/status/1006', 'x', 'A new loaf', 'Bakehouse Kit', 0), createdAt: new Date(Date.now() + 1000).toISOString(), creatorId: kit }] }) });
    assert.ok(posted.ok);
    await page.goto(`${base}/creators`);
    await cards.getByRole('article', { name: 'Bakehouse Kit' }).getByText('+1 new since you looked').waitFor();
  });

  await check('refresh from the profile page: only what differs, keep or take, and "nothing new" the second time', async () => {
    const s = await stored();
    const profile = { id: 'c-profile1', name: 'Profile Test', aliases: [], handles: [], urls: ['http://profile.fixture.test/kit'], updatedAt: new Date().toISOString() };
    assert.ok((await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts: [], deletedUrls: [], epoch: s.epoch, docs: { creators: [profile] } }) })).ok);
    await page.goto(`${base}/creators/c-profile1`);
    await page.getByRole('button', { name: 'Refresh from the profile page' }).click();
    const dialog = page.getByRole('dialog', { name: 'Refresh Profile Test from the profile page' });
    const table = dialog.getByRole('table', { name: 'What the profile page shows' });
    await table.getByText('Sourdough classes in Leeds.').waitFor();
    assert.equal(await table.getByRole('radiogroup', { name: 'Name: keep or take' }).getByRole('radio', { name: 'keep' }).getAttribute('aria-checked'), 'true');
    assert.equal(await table.getByRole('radiogroup', { name: 'About: keep or take' }).getByRole('radio', { name: 'take' }).getAttribute('aria-checked'), 'true');
    await page.screenshot({ path: join(evidence, 'refresh.png') });
    await dialog.getByRole('button', { name: 'Apply 2' }).click();
    await page.getByRole('status').getByText('Took 2 changes from the profile page.').waitFor();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('paragraph').filter({ hasText: 'Sourdough classes in Leeds.' }).waitFor();
    await until(async () => { const c = (await stored()).docs.creators.find(x => x.id === 'c-profile1');
      return c.about === 'Sourdough classes in Leeds.' && c.picture.startsWith('/thumb/') && c.kept.name === 'Bakehouse Kit'; }, 'saved to SQLite');
    await page.getByRole('button', { name: 'Refresh from the profile page' }).click();
    await page.getByRole('dialog', { name: 'Refresh Profile Test from the profile page' }).getByText('Nothing new on the profile page.').waitFor();
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
