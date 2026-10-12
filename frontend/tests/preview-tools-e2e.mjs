// Settings → Previews & thumbnails in a browser, synthetic links and a stand-in preview fetcher
// (no network): the missing-preview count, what a fetch came to, links that keep failing set
// aside and retried on request, and gone links reviewed before they are archived.
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
const evidence = await mkdtemp(join(root, '.verify', 'preview-tools-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
import random, struct, zlib
import storage, app, metadata_fetcher
def picture():
    # A real 200x120 picture: like the app, the stand-in keeps the file behind every /thumb/ address it gives.
    rng = random.Random(7)
    raw = b"".join(b"\\x00" + rng.randbytes(600) for _ in range(120))
    chunk = lambda kind, body: struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    return b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 200, 120, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
assert metadata_fetcher.install_thumb("kept", picture(), "image/png")
def stand_in(url):
    if "/img/" in url:
        return {"title": "Fetched title", "summary": "Fetched words.", "thumbnail": metadata_fetcher.install_thumb("fetched", picture(), "image/png"), "status": "ok", "error": ""}
    if "/noimg/" in url:
        return {"title": "Fetched title", "summary": "A page without a picture.", "thumbnail": "", "status": "ok", "error": ""}
    for marker, code, extra in (("/refuse/", 403, {}), ("/down/", 503, {}), ("/gone/", 404, {"linkStatus": "gone"})):
        if marker in url:
            return {"title": "", "summary": "", "thumbnail": "", "status": "failed", "error": "http_error", "httpStatus": code, **extra}
    return {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
metadata_fetcher.fetch_metadata = stand_in
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`); }
}

const at = '2026-09-20T10:00:00.000Z';
let n = 0;
const post = (kind, extra = {}) => {
  const i = n++;
  return { id: `pt-${i}`, url: `https://site${i}.example.invalid/${kind}/${i}`, source: 'browser', platform: 'web', domain: `site${i}.example.invalid`,
    status: 'reference', createdAt: at, updatedAt: at, categories: ['technology'], categoryMode: 'manual', tags: [], projectIds: [],
    title: `Link ${i} (${kind})`, metadataStatus: 'failed', metadataError: 'Metadata unavailable. The saved link is unchanged; retry later.', ...extra };
};
const posts = [
  ...['img', 'img', 'img', 'img', 'noimg', 'noimg', 'noimg', 'refuse', 'refuse', 'down', 'gone'].map(kind => post(kind)),
  // Carried over from the old database, never fetched here: still missing.
  post('img', { metadataStatus: 'partial', metadataError: undefined }), post('img', { metadataStatus: 'enriched', metadataError: undefined }),
  // Read fine but no picture of their own, or a picture already: not missing.
  post('noimg', { metadataStatus: 'enriched', enrichedAt: at, metadataError: undefined }),
  post('noimg', { metadataStatus: 'partial', enrichedAt: at, metadataError: undefined }),
  post('img', { metadataStatus: 'partial', enrichedAt: at, thumbnailUrl: '/thumb/kept', metadataError: undefined }),
  // Gone already (one of them archived before).
  post('old', { linkStatus: 'gone', httpStatus: 404, title: 'Spring sale page' }), post('old', { linkStatus: 'gone', httpStatus: 410, title: 'Closed job post' }),
  post('old', { linkStatus: 'gone', httpStatus: 404, title: 'Old event page' }), post('old', { linkStatus: 'gone', httpStatus: 404, status: 'archived', title: 'Archived before' }),
];

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
  assert.ok(seeded.ok, await seeded.text());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const open = async () => {
    // A real reload: going to the same address with the same #fragment would not reload the page.
    if (page.url().startsWith(base)) await page.reload(); else await page.goto(base + '/library/settings#ai');
    await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
    const panel = page.getByRole('region', { name: 'Previews & thumbnails' }).or(page.locator('section[aria-labelledby="preview-tools-heading"]')).first();
    await panel.scrollIntoViewIfNeeded();
    return panel;
  };
  let panel = await open();
  const fetchButton = () => panel.getByRole('button', { name: /Fetch missing previews/ });
  const result = () => panel.getByRole('status', { name: 'Preview fetch result' });

  await check('the count leaves out pages that were read and simply have no picture', async () => {
    // 11 failed + 2 never fetched; not the 2 pages without a picture, the one with a picture, or gone links.
    assert.equal((await fetchButton().innerText()).trim(), 'Fetch missing previews (13)');
  });

  await check('fetching says what came of it, and the count goes down to what is really left', async () => {
    await fetchButton().click();
    await result().filter({ hasText: /Checked 13 links/ }).waitFor({ timeout: 30000 });
    const text = (await result().innerText()).replace(/\s+/g, ' ');
    assert.match(text, /6 now have a picture/);
    assert.match(text, /3 have no picture of their own/);
    assert.match(text, /3 couldn't be fetched/);
    assert.match(text, /1 is gone/);
    await page.waitForFunction(() => /\(0\)/.test([...document.querySelectorAll('button')].find(b => /Fetch missing previews/.test(b.textContent))?.textContent ?? ''));
  });

  await check('the links that couldn\'t be fetched are listed with the reason', async () => {
    await result().getByRole('button', { name: /Show the 3 links that couldn't be fetched/ }).click();
    const rows = result().locator('.link-rows li');
    assert.equal(await rows.count(), 3);
    const text = (await result().innerText()).replace(/\s+/g, ' ');
    assert.equal((text.match(/The site refused \(403\)/g) ?? []).length, 2);
    assert.match(text, /The site had an error \(503\)/);
  });

  await check('after a reload they stay out of the count and can be tried again', async () => {
    panel = await open();
    assert.equal((await fetchButton().innerText()).trim(), 'Fetch missing previews (0)');
    await panel.getByText(/3 links couldn't be fetched when you last asked/).waitFor();
    await panel.getByRole('button', { name: 'Try them again' }).click();
    await result().filter({ hasText: /Checked 3 links/ }).waitFor({ timeout: 30000 });
    assert.match((await result().innerText()).replace(/\s+/g, ' '), /3 couldn't be fetched/);
  });

  await check('gone links are shown before archiving, and only the ticked ones are archived', async () => {
    await panel.getByRole('button', { name: 'Archive 4 gone links…' }).click();
    const review = panel.getByRole('region', { name: 'Gone links to archive' });
    await review.waitFor();
    const rows = review.getByRole('listitem');
    assert.equal(await rows.count(), 4, 'the three gone links plus the one found just now; not the archived one');
    const text = (await review.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /Spring sale page/); assert.match(text, /Not found \(410\)/); assert.doesNotMatch(text, /Archived before/);
    await review.getByRole('checkbox', { name: /Old event page/ }).uncheck();
    await review.getByRole('button', { name: 'Archive 3 links' }).click();
    await panel.getByRole('status', { name: 'Library tools result' }).filter({ hasText: /Archived 3 links/ }).waitFor();
    await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
    panel = await open();
    await panel.getByRole('button', { name: 'Archive 1 gone link…' }).waitFor();
    const saved = await (await fetch(base + '/api/library')).json();
    const byTitle = Object.fromEntries(saved.posts.map(p => [p.title, p.status]));
    assert.equal(byTitle['Spring sale page'], 'archived');
    assert.equal(byTitle['Closed job post'], 'archived');
    assert.equal(byTitle['Old event page'], 'reference', 'the unticked one stays where it was');
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
  await page.screenshot({ path: join(evidence, 'previews.png'), fullPage: false });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
