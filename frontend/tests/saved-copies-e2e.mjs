// Save a copy, end to end in the real app: the browser queue, auto-save, the
// link panel, the reading pane, bulk saving, the tile badge and Settings.
// Synthetic data only: an owned loopback server plays every "website" (the
// metadata fixture maps a few fixture hosts to it); nothing leaves this machine.
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
const evidence = await mkdtemp(join(root, '.verify', 'saved-copies-'));
const SITE = 'http://metadata.fixture.test';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function startServer(name, extraEnv = {}) {
  const port = 15000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import base64, os, sys, threading, time
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, name + '.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, name + '-ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, name + '-archive'))}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, name + '-thumbs'))}
from metadata_fixture import ControlledHTTP
import storage, app, archive, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
archive.HOST_SPACING = 0.0
site = ControlledHTTP().__enter__()
words = "Plain words of the article. " * 30
def article(n, extra=""):
    return f"""<html lang="en"><head><title>Synthetic article {n}</title><link rel="stylesheet" href="/site.css">
<script>window.pwned = 1</script></head><body><h1 id="headline">Synthetic headline {n}</h1>
<p class="lead">{words}</p><img id="pic" src="/pic.png" alt="Synthetic picture">{extra}</body></html>"""
for n in range(1, 13):
    site.html(f"/article/{n}", article(n))
site.html("/changing", article("first version"))
site.html("/app-shell", '<title>Shell</title><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>')
site.routes["/site.css"] = (200, {"Content-Type": "text/css"}, b".lead{color:rgb(1, 2, 3)}")
site.routes["/pic.png"] = (200, {"Content-Type": "image/png"}, base64.b64decode("${PNG}"))
site.routes["/gone"] = (404, {"Content-Type": "text/html"}, b"<h1>gone</h1>")
site.routes["/file.pdf"] = (200, {"Content-Type": "application/pdf"}, b"%PDF-1.7 synthetic")
active, peak = [0], [0]
gate = threading.Lock()
def slow(handler):
    with gate:
        active[0] += 1; peak[0] = max(peak[0], active[0])
    time.sleep(0.35)
    with gate:
        active[0] -= 1
    body = article("slow").encode()
    handler.send_response(200); handler.send_header("Content-Type", "text/html"); handler.send_header("Content-Length", str(len(body)))
    handler.end_headers(); handler.wfile.write(body)
for n in range(1, 31):
    site.routes[f"/slow/{n}"] = slow
storage.init_db()
from flask import jsonify, request
calls = {"post": 0, "outstanding_peak": 0}
@app.app.before_request
def record():
    if request.path == "/api/archive" and request.method == "POST":
        calls["post"] += 1
        with archive._lock:
            busy = sum(1 for job in archive._jobs.values() if job["status"] in ("queued", "saving"))
        calls["outstanding_peak"] = max(calls["outstanding_peak"], busy + 1)
@app.app.route("/__copies")
def report():
    return jsonify(calls=calls, site=[r[0] for r in site.requests], files=sorted(os.listdir(archive.ARCHIVE_DIR)) if os.path.isdir(archive.ARCHIVE_DIR) else [])
@app.app.route("/__set", methods=["POST"])
def change():
    data = request.get_json()
    if data.get("status"):
        site.routes[data["path"]] = (data["status"], {"Content-Type": "text/html"}, b"down")
    else:
        site.html(data["path"], article(data["label"]))
    return jsonify(ok=True)
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...extraEnv } });
  let log = ''; child.stderr.on('data', chunk => { log += chunk; });
  return { child, base: `http://127.0.0.1:${port}`, log: () => log };
}
async function ready(server) {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(server.base + '/api/stats')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start: ' + server.log().slice(-400));
}

const main = startServer('main');
const off = startServer('off', { SBM_SAVED_COPIES: 'off' });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const post = (n, changes = {}) => ({
  id: `copy-e2e-${n}`, url: `${SITE}/slow/${n}`, source: 'manual', platform: 'web', domain: 'metadata.fixture.test', status: 'inbox',
  title: `Synthetic link ${n}`, categories: [], tags: [], projectIds: [], createdAt: new Date(Date.now() - n * 60000).toISOString(),
  updatedAt: new Date(Date.now() - n * 60000).toISOString(), metadataStatus: 'none', ...changes,
});

try {
  await Promise.all([ready(main), ready(off)]);
  const base = main.base;
  const api = async (path, init) => (await fetch(base + path, init)).json();
  const library = async () => (await api('/api/library')).posts;
  const linkByUrl = async url => (await library()).find(p => p.url === url || p.url === url + '/');
  const until = async (what, test, ms = 15000) => {
    const end = Date.now() + ms; let last;
    while (Date.now() < end) { last = await test(); if (last) return last; await new Promise(r => setTimeout(r, 150)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const toast = page.getByRole('status', { name: 'SQLite save status' });
  const toastText = () => toast.locator('.save-toast__text').getAttribute('data-label');
  const addLink = async url => {
    await page.getByRole('button', { name: 'Add link', exact: true }).first().click();
    await page.getByRole('dialog', { name: 'Add link' }).getByRole('textbox').fill(url);
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
  };
  const setAutoSave = (target, value) => target.evaluate(on => {
    const stored = JSON.parse(localStorage.getItem('prefs-store-v1') || '{"state":{},"version":0}');
    stored.state.autoSaveCopies = on; localStorage.setItem('prefs-store-v1', JSON.stringify(stored));
  }, value);
  await page.goto(base + '/library');
  await toast.filter({ hasText: /Library saved to SQLite/ }).waitFor();

  // ── Step 5: the queue and auto-save ────────────────────────────────────────
  await check('a new link gets a copy by itself (auto-save is on by default)', async () => {
    await addLink(`${SITE}/article/1`);
    const saved = await until('the copy', async () => { const p = await linkByUrl(`${SITE}/article/1`); return p?.archiveStatus === 'saved' && p; });
    assert.match(saved.archiveKey, /^[0-9a-f]{32}$/);
    assert.ok(saved.archiveBytes > 500 && /^\d{4}-\d\d-\d\dT/.test(saved.archivedAt));
    const report = await api('/__copies');
    assert.deepEqual(report.files, [saved.archiveKey + '.html', saved.archiveKey + '.json']);
    assert.ok(report.site.includes('/article/1') && report.site.includes('/pic.png'));
    const view = await fetch(`${base}/archive/${saved.archiveKey}`);
    assert.equal(view.status, 200);
    assert.ok((await view.text()).includes('Synthetic headline 1'));
    await page.keyboard.press('Escape');
  });

  await check('with auto-save off a new link gets no copy', async () => {
    await setAutoSave(page, false);
    await page.reload();
    await toast.filter({ hasText: /Library saved to SQLite/ }).waitFor();
    const before = (await api('/__copies')).calls.post;
    await addLink(`${SITE}/article/2`);
    await until('the link', async () => linkByUrl(`${SITE}/article/2`));
    await page.waitForTimeout(1200);
    const link = await linkByUrl(`${SITE}/article/2`);
    assert.equal(link.archiveStatus, undefined);
    assert.equal((await api('/__copies')).calls.post, before);
    await page.keyboard.press('Escape');
    await setAutoSave(page, true);
  });

  await check('links left "pending" are picked up after a restart, six at a time at most, with progress in the toast', async () => {
    const waitingLinks = Array.from({ length: 14 }, (_, i) => post(i + 1, { archiveStatus: 'pending' }));
    const saved = await api('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: waitingLinks, deletedUrls: [] }) });
    assert.deepEqual(saved.rejected, []);
    await page.reload();
    const seen = new Set();
    await until('all copies', async () => {
      const label = await toastText(); if (label) seen.add(label.replace(/\d+/g, 'N'));
      return (await library()).filter(p => p.id.startsWith('copy-e2e-') && p.archiveStatus === 'saved').length === 14;
    }, 30000);
    assert.ok(seen.has('Saving copies · N/N'), 'toast labels seen: ' + [...seen].join(' | '));
    const report = await api('/__copies');
    assert.ok(report.calls.outstanding_peak <= 6, `outstanding peaked at ${report.calls.outstanding_peak}`);
    assert.equal(report.site.filter(p => p.startsWith('/slow/')).length, 14, 'each page fetched once');
    await toast.filter({ hasText: /Library saved to SQLite/ }).waitFor();
    await until('the toast to fade', async () => (await toast.evaluate(el => Number(getComputedStyle(el).opacity))) === 0, 8000);
  });

  await check('a copy that cannot be made is recorded with its reason, and the link stays', async () => {
    for (const [path, status, code] of [['/gone', 'failed', 'http_error'], ['/file.pdf', 'failed', 'not_html']]) {
      await addLink(SITE + path);
      const link = await until(path, async () => { const p = await linkByUrl(SITE + path); return p && p.archiveStatus && p.archiveStatus !== 'pending' && p; });
      assert.equal(link.archiveStatus, status);
      assert.equal(link.archiveError, code);
      assert.equal(link.archiveKey, undefined);
      await page.keyboard.press('Escape');
    }
  });

  await check('a server with copies switched off: nothing is queued or fetched', async () => {
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await other.newPage();
    await p2.goto(off.base + '/library');
    await p2.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
    await p2.getByRole('button', { name: 'Add link', exact: true }).first().click();
    await p2.getByRole('dialog', { name: 'Add link' }).getByRole('textbox').fill(`${SITE}/article/3`);
    await p2.getByRole('button', { name: 'Save link', exact: true }).click();
    await p2.waitForTimeout(1500);
    const posts = (await (await fetch(off.base + '/api/library')).json()).posts;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].archiveStatus, undefined);
    const report = await (await fetch(off.base + '/__copies')).json();
    assert.equal(report.calls.post, 0);
    assert.deepEqual(report.site.filter(p => p.startsWith('/article')), []);
    await other.close();
  });

  // ── Step 6: the link panel and the reading pane ────────────────────────────
  const drawer = page.getByRole('dialog', { name: 'Saved post detail' });
  const panel = drawer.getByRole('region', { name: 'Saved copy', exact: true });
  const reader = page.getByRole('region', { name: 'Saved copy reader' });
  const openLink = async url => {
    const link = await linkByUrl(url);
    await page.goto(`${base}/library/item/${encodeURIComponent(link.id)}`);
    await drawer.waitFor();
    return link;
  };
  const frame = () => page.frameLocator('iframe[title^="Saved copy of"]');
  // Closing with Escape goes back in history, which may be another link; start from the library instead.
  const closeDrawer = async () => { await page.goto(base + '/library'); await drawer.waitFor({ state: 'detached' }); };

  await check('the link panel shows the copy; Read opens it beside the panel, inert', async () => {
    const link = await openLink(`${SITE}/article/1`);
    await panel.getByText('Saved copy', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /Saved copy\s+\S.*\d{4} · \d+ KB/);
    assert.equal(await drawer.getByRole('button', { name: 'Save a copy' }).count(), 0);
    await panel.getByRole('button', { name: 'Read saved copy' }).click();
    await reader.waitFor();
    await frame().locator('#headline').waitFor();
    assert.equal(await frame().locator('#headline').innerText(), 'Synthetic headline 1');
    assert.equal(await frame().locator('.lead').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)');
    assert.equal(await frame().locator('#pic').evaluate(el => el.naturalWidth), 1);
    assert.equal(await frame().locator('script').count(), 0);
    assert.ok(!(await frame().locator('[data-sbm-saved-copy]').isVisible()), 'the copy\'s own strip is hidden inside the app');
    const iframe = page.locator('iframe[title^="Saved copy of"]');
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
    assert.equal(await iframe.getAttribute('src'), `/archive/${link.archiveKey}?banner=0`);
    await page.waitForTimeout(400);                       // let the slide-in finish
    const [readerBox, drawerBox] = [await reader.boundingBox(), await drawer.boundingBox()];
    assert.ok(readerBox.x === 0 && Math.abs(readerBox.x + readerBox.width - drawerBox.x) <= 1, `reader fills the space left of the panel: ${JSON.stringify([readerBox, drawerBox])}`);
    assert.equal(await drawer.locator('.copy-reader').count(), 1, 'inside the dialog, so Tab reaches it');
    assert.match(await reader.locator('.copy-reader__meta').innerText(), /^saved \S.*\d{4} from metadata\.fixture\.test · \d+ KB · opens without the internet$/);
    await page.screenshot({ path: join(evidence, 'reader.png') });

    await reader.getByRole('button', { name: 'Text only' }).click();
    await frame().locator('#headline').waitFor();
    await until('text-only styling', async () => (await frame().locator('.lead').evaluate(el => getComputedStyle(el).color)) !== 'rgb(1, 2, 3)');
    assert.equal(await reader.getByRole('button', { name: 'Text only' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await reader.getByRole('link', { name: 'Open in new tab' }).getAttribute('href'), `/archive/${link.archiveKey}?view=plain`);
    await reader.getByRole('button', { name: 'As saved' }).click();
    assert.equal(await reader.getByRole('link', { name: 'Open in new tab' }).getAttribute('href'), `/archive/${link.archiveKey}`);

    await reader.getByRole('button', { name: 'Close saved copy' }).focus();
    await page.keyboard.press('Escape');
    await reader.waitFor({ state: 'detached' });
    assert.ok(await drawer.isVisible(), 'Escape closed the copy, not the link panel');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    await closeDrawer();
  });

  await check('Save a copy on a link without one; then Delete copy needs a second click and keeps the link', async () => {
    const link = await openLink(`${SITE}/article/2`);
    assert.equal(await panel.count(), 0);
    await drawer.getByRole('button', { name: 'Save a copy' }).click();
    await panel.getByRole('button', { name: 'Read saved copy' }).waitFor();
    const saved = await until('the saved link', async () => { const p = await linkByUrl(link.url); return p.archiveStatus === 'saved' && p; });
    assert.ok((await api('/__copies')).files.includes(saved.archiveKey + '.html'));
    await panel.getByRole('button', { name: 'Delete copy' }).click();
    assert.ok((await api('/__copies')).files.includes(saved.archiveKey + '.html'), 'one click deletes nothing');
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await panel.getByRole('button', { name: 'Delete copy' }).click();
    await panel.getByRole('button', { name: 'Confirm delete' }).click();
    await drawer.getByRole('button', { name: 'Save a copy' }).waitFor();
    assert.equal(await panel.count(), 0);
    assert.ok(!(await api('/__copies')).files.includes(saved.archiveKey + '.html'));
    const after = await until('the link without copy fields', async () => { const p = await linkByUrl(link.url); return !p.archiveStatus && p; });
    assert.equal(after.archiveKey, undefined);
    await closeDrawer();
  });

  await check('Update replaces the copy; a failed update keeps the earlier one and says so', async () => {
    await page.goto(base + '/library');
    await addLink(`${SITE}/changing`);
    await panel.getByRole('button', { name: 'Read saved copy' }).waitFor();
    // The panel shows the copy before the library reaches SQLite: wait for the stored key.
    const first = await until('the first copy in SQLite', async () => { const link = await linkByUrl(`${SITE}/changing`); return link?.archiveKey ? link : null; });
    await api('/__set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/changing', label: 'second version' }) });
    await panel.getByRole('button', { name: 'Update' }).click();
    await until('the updated copy', async () => (await (await fetch(`${base}/archive/${first.archiveKey}`)).text()).includes('Synthetic headline second version'));
    await panel.getByRole('button', { name: 'Read saved copy' }).waitFor();
    await api('/__set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/changing', status: 500 }) });
    await panel.getByRole('button', { name: 'Update' }).click();
    await panel.getByText("The update didn't work. The site refused the request, or the page is gone. Your earlier copy is kept.").waitFor();
    assert.ok((await (await fetch(`${base}/archive/${first.archiveKey}`)).text()).includes('second version'));
    const kept = await until('the kept copy in SQLite', async () => { const p = await linkByUrl(`${SITE}/changing`); return p?.archiveError && p; });
    assert.equal(kept.archiveStatus, 'saved');
    assert.equal(kept.archiveKey, first.archiveKey);
    await panel.getByRole('button', { name: 'Read saved copy' }).click();
    await frame().locator('#headline').waitFor();
    await reader.getByRole('button', { name: 'Close saved copy' }).click();
    await closeDrawer();
  });

  await check('a failed copy explains itself; Try again works once the site answers; a PDF offers no retry', async () => {
    await openLink(`${SITE}/gone`);
    await panel.getByText('No copy saved').waitFor();
    await panel.getByText('The site refused the request, or the page is gone. The link itself is unchanged.').waitFor();
    await api('/__set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/gone', label: 'back again' }) });
    await panel.getByRole('button', { name: 'Try again' }).click();
    await panel.getByRole('button', { name: 'Read saved copy' }).waitFor();
    await openLink(`${SITE}/file.pdf`);
    await panel.getByText('This link is a file, not a web page, so there is no page to copy. The link itself is unchanged.').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Try again' }).count(), 0);
    await closeDrawer();
  });

  await check('a script-built page is marked as a limited copy', async () => {
    await page.goto(base + '/library');
    await addLink(`${SITE}/app-shell`);
    await panel.getByText('Saved copy, limited').waitFor();
    await panel.getByText('This page builds itself with scripts, so the copy holds little more than its title.').waitFor();
    await until('the limited mark in SQLite', async () => (await linkByUrl(`${SITE}/app-shell`))?.archiveLimited === true);
    await closeDrawer();
  });

  await check('a copy that is no longer on disk is noticed when the link is opened', async () => {
    const link = await linkByUrl(`${SITE}/article/1`);
    await fetch(`${base}/api/archive/${link.archiveKey}`, { method: 'DELETE' });
    await openLink(`${SITE}/article/1`);
    await drawer.getByRole('button', { name: 'Save a copy' }).waitFor();
    assert.equal(await panel.count(), 0);
    await drawer.getByRole('button', { name: 'Save a copy' }).click();
    await panel.getByRole('button', { name: 'Read saved copy' }).waitFor();
    await closeDrawer();
  });

  await check('deleting a link deletes its copy', async () => {
    const link = await openLink(`${SITE}/changing`);
    assert.ok((await api('/__copies')).files.includes(link.archiveKey + '.html'));
    await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
    await drawer.getByRole('button', { name: 'Confirm delete' }).click();
    await until('the copy to go', async () => !(await api('/__copies')).files.includes(link.archiveKey + '.html'));
  });

  await check('on a phone-width window the copy takes the whole screen', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p2 = await phone.newPage();
    const link = await linkByUrl(`${SITE}/article/1`);
    await p2.goto(`${base}/library/item/${encodeURIComponent(link.id)}`);
    const d2 = p2.getByRole('dialog', { name: 'Saved post detail' });
    await d2.getByRole('button', { name: 'Read saved copy' }).click();
    const r2 = p2.getByRole('region', { name: 'Saved copy reader' });
    await p2.frameLocator('iframe[title^="Saved copy of"]').locator('#headline').waitFor();
    await p2.waitForTimeout(400);                       // let the slide-in finish
    const box = await r2.boundingBox();
    assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 844]);
    const bar = await r2.locator('.copy-reader__bar').boundingBox();
    assert.ok(bar.height <= 60, `toolbar is one row (${bar.height}px)`);
    assert.ok(await r2.getByRole('button', { name: 'Close saved copy' }).isVisible());
    await p2.screenshot({ path: join(evidence, 'reader-phone.png') });
    await r2.getByRole('button', { name: 'Close saved copy' }).click();
    assert.ok(await d2.isVisible());
    await phone.close();
  });

  // ── Step 7: bulk saving, the tile mark, the toast beside the bar ───────────
  await check('tiles with a copy carry a mark; Save copies handles the selected links that have none', async () => {
    const fresh = [21, 22, 23].map(n => post(n));
    await api('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: fresh, deletedUrls: [] }) });
    await page.goto(base + '/library');
    await page.locator('.tile[data-post-id="copy-e2e-21"]').waitFor();
    const all = await library();
    const withCopy = all.filter(p => p.archiveStatus === 'saved').map(p => p.id).sort();
    const marked = (await page.locator('.tile:has(.tile__copy)').evaluateAll(tiles => tiles.map(t => t.dataset.postId))).sort();
    assert.deepEqual(marked, withCopy);
    assert.ok(!marked.includes('copy-e2e-21'));
    assert.equal(await page.locator('.tile[data-post-id="copy-e2e-1"] .tile__copy').getAttribute('aria-label'), 'Has a saved copy');

    const before = (await api('/__copies')).site.length;
    for (const id of ['copy-e2e-21', 'copy-e2e-22', 'copy-e2e-23', 'copy-e2e-1']) await page.locator(`.tile[data-post-id="${id}"] .tile__select`).click({ force: true });
    const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
    await bar.getByText('4 selected').waitFor();
    const barBox = await bar.boundingBox();
    assert.ok(barBox.height <= 62, `bulk bar is one row at 1440px (${barBox.height}px high)`);
    assert.ok(barBox.x >= 0 && barBox.x + barBox.width <= 1440, 'bar stays inside the window');
    await bar.getByRole('button', { name: 'Save copies' }).click();
    await until('three new copies', async () => (await library()).filter(p => ['copy-e2e-21', 'copy-e2e-22', 'copy-e2e-23'].includes(p.id) && p.archiveStatus === 'saved').length === 3, 20000);
    const fetched = (await api('/__copies')).site.slice(before).filter(p => p.startsWith('/slow/'));
    assert.deepEqual(fetched.sort(), ['/slow/21', '/slow/22', '/slow/23'], 'the link that already had a copy was left alone');
    await page.locator('.tile[data-post-id="copy-e2e-22"] .tile__copy').waitFor();
    await until('Save copies to switch off', async () => bar.getByRole('button', { name: 'Save copies' }).isDisabled());
    await page.screenshot({ path: join(evidence, 'library-bulk.png') });
    await bar.getByRole('button', { name: 'Clear selection' }).click();
  });

  await check('the save toast steps above the bulk bar instead of under it', async () => {
    await page.locator('.tile[data-post-id="copy-e2e-21"] .tile__select').click({ force: true });
    const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
    await bar.waitFor();
    const [barBox, toastBox] = [await bar.boundingBox(), await toast.boundingBox()];
    assert.ok(toastBox.y + toastBox.height <= barBox.y, `toast ${JSON.stringify(toastBox)} bar ${JSON.stringify(barBox)}`);
    await bar.getByRole('button', { name: 'Clear selection' }).click();
    await bar.waitFor({ state: 'detached' });
    // Back down at its resting place. Read from its style: the toast also slides 8px as it shows
    // and hides, and on a busy machine it may already have faded out by now.
    await until('the toast back at its resting place', async () => (await toast.evaluate(el => getComputedStyle(el).bottom)) === '16px', 3000);
  });

  // ── Step 8: Settings and the zip ────────────────────────────────────────────
  await check('Settings shows the switch and real numbers', async () => {
    await page.goto(base + '/library/settings#library');
    const card = page.getByRole('region', { name: 'Saved copies' });
    await card.waitFor();
    const summary = await api('/api/archive');
    const numbers = card.getByLabel('Saved copies in numbers');
    await until('the copy count', async () => (await numbers.innerText()).includes(String(summary.count)));
    const text = (await numbers.innerText()).replace(/\s+/g, ' ');
    const without = (await library()).filter(p => p.archiveStatus !== 'saved').length;
    assert.match(text, new RegExp(`Copies ${summary.count} Space used \\d+(\\.\\d)? (KB|MB) Links without a copy ${without}$`));
    const toggle = card.getByRole('switch', { name: 'Automatically save a copy of new links' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state.autoSaveCopies), false);
    await toggle.focus(); await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state.autoSaveCopies), true);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, 'settings.png') });
  });

  await check('Backup offers the zip with saved copies, and the download is a valid zip', async () => {
    const backup = page.locator('#backup');
    const button = backup.getByRole('button', { name: /^Export backup with saved copies \(\.zip, about \d+(\.\d)? (KB|MB)\)$/ });
    await button.waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    assert.match(download.suggestedFilename(), /^saved-posts-with-copies-[0-9T-]+\.zip$/);
    const file = join(evidence, 'export.zip');
    await download.saveAs(file);
    const { spawnSync } = await import('node:child_process');
    const listed = spawnSync(process.env.C4_PYTHON || 'python3', ['-c',
      'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({"names": z.namelist(), "records": json.loads(z.read("library.json"))["recordCount"]}))', file], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    const zip = JSON.parse(listed.stdout);
    const links = await library();
    assert.equal(zip.records, links.length);
    assert.ok(zip.names.includes('index.html') && zip.names.includes('library.json'));
    const keys = links.filter(p => p.archiveStatus === 'saved').map(p => `copies/${p.archiveKey}.html`).sort();
    assert.deepEqual(zip.names.filter(n => n.endsWith('.html') && n.startsWith('copies/')).sort(), keys);
    await backup.getByText(/Exported the library and its saved copies as one zip\. Download: saved-posts-with-copies-/).waitFor();
    // The ordinary export is still a JSON file.
    const [plain] = await Promise.all([page.waitForEvent('download'), backup.getByRole('button', { name: 'Export backup', exact: true }).click()]);
    assert.match(plain.suggestedFilename(), /\.json$/);
  });

  await check('with copies switched off the app shows no copy controls', async () => {
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await other.newPage();
    const posts = (await (await fetch(off.base + '/api/library')).json()).posts;
    await p2.goto(`${off.base}/library/item/${encodeURIComponent(posts[0].id)}`);
    const d2 = p2.getByRole('dialog', { name: 'Saved post detail' });
    await d2.getByRole('button', { name: 'Refresh metadata' }).waitFor();
    assert.equal(await d2.getByRole('button', { name: 'Save a copy' }).count(), 0);
    await p2.goto(off.base + '/library/settings#library');
    await p2.getByRole('region', { name: 'Saved copies' }).getByText('Saved copies are switched off for this run of the app.').waitFor();
    // The one switch left is Telegram's check at start, which has nothing to do with copies.
    assert.deepEqual(await p2.getByRole('switch').evaluateAll(all => all.map(s => s.getAttribute('aria-label'))), ['Check when the app starts']);
    assert.equal(await p2.getByRole('button', { name: /Export backup with saved copies/ }).count(), 0);
    await other.close();
  });

  // ── Save every link without a copy; restore copies from the zip ────────────
  await check('Settings saves copies of every link without one, after a second click, skipping ones that cannot work', async () => {
    const fresh = [31, 32, 33].map(n => post(n));
    await api('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: fresh, deletedUrls: [] }) });
    await page.goto(base + '/library');                       // a real load, so the new links sync in
    await page.goto(base + '/library/settings#library');
    const card = page.getByRole('region', { name: 'Saved copies' });
    const links = await library();
    const eligible = links.filter(p => p.archiveStatus !== 'saved' && !(p.archiveStatus === 'failed' && ['not_html', 'too_large', 'invalid_url', 'blocked_url'].includes(p.archiveError)) && p.archiveStatus !== 'too_large');
    assert.ok(eligible.length >= 3, 'fixture has links to copy');
    assert.ok(links.some(p => p.archiveError === 'not_html'), 'fixture has a link that can never be copied');
    const button = card.getByRole('button', { name: `Save copies of the ${eligible.length} links without one` });
    await card.getByRole('button', { name: /^Save copies of the/ }).waitFor();
    // The page shows the browser's copy first; wait for SQLite's links to arrive.
    await until('the library to sync', async () => (await button.count()) > 0, 8000).catch(() => {});
    if (!(await button.count())) throw new Error(`button reads "${await card.getByRole('button', { name: /^Save copies of the/ }).innerText()}"; expected ${eligible.length}: ${JSON.stringify(eligible.map(p => [p.url, p.archiveStatus, p.archiveError]))}`);
    const before = (await api('/__copies')).site.length;
    await button.click();
    const confirm = card.getByRole('group', { name: 'Confirm saving copies' });
    await confirm.getByText(`Save copies of ${eligible.length} links?`, { exact: false }).waitFor();
    assert.equal((await api('/__copies')).site.length, before, 'nothing is fetched before the second click');
    await page.screenshot({ path: join(evidence, 'settings-save-all.png') });
    await confirm.getByRole('button', { name: `Save ${eligible.length} copies` }).click();
    await until('every eligible link saved', async () => {
      const now = await library();
      return eligible.every(e => now.find(p => p.id === e.id)?.archiveStatus === 'saved');
    }, 30000);
    assert.ok(!(await api('/__copies')).site.slice(before).includes('/file.pdf'), 'the PDF was not fetched again');
    await until('the button to go', async () => (await card.getByRole('button', { name: /^Save copies of the/ }).count()) === 0);
  });

  await check('Backup restores copies from the zip and records them on their links', async () => {
    const zip = join(evidence, 'export-for-restore.zip');
    const response = await fetch(base + '/api/archive/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(zip, Buffer.from(await response.arrayBuffer()));
    const lost = await linkByUrl(`${SITE}/slow/31`);
    await fetch(`${base}/api/archive/${lost.archiveKey}`, { method: 'DELETE' });
    await openLink(lost.url);                                    // opening notices the copy is gone
    await drawer.getByRole('button', { name: 'Save a copy' }).waitFor();
    await until('the link to forget its copy', async () => !(await linkByUrl(lost.url)).archiveStatus);
    const saved = (await library()).filter(p => p.archiveStatus === 'saved').length;
    await page.goto(base + '/library/settings#backup');
    await page.getByLabel('Select backup zip with saved copies').setInputFiles(zip);
    const result = page.locator('#backup').getByRole('status', { name: 'Backup result' });
    await result.waitFor();
    await until('a restore message', async () => /Restored|No saved copies/.test(await result.innerText()));
    assert.equal(await result.innerText(), `Restored 1 saved copy. ${saved} were already here and were kept.`);
    const back = await until('the link to have its copy again', async () => { const p = await linkByUrl(lost.url); return p.archiveStatus === 'saved' && p; });
    assert.equal(back.archiveKey, lost.archiveKey);
    assert.ok((await api('/__copies')).files.includes(lost.archiveKey + '.html'));
    await page.screenshot({ path: join(evidence, 'backup-restore.png') });
    // Not a backup zip: a clear message, nothing changes.
    const bogus = join(evidence, 'holiday.zip');
    await writeFile(bogus, Buffer.from('not a zip'));
    await page.getByLabel('Select backup zip with saved copies').setInputFiles(bogus);
    await result.getByText('That file is not a zip made by Export backup with saved copies.').waitFor();
  });

  //STEPS

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  main.child.kill(); off.child.kill();
}
console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASS', '| evidence:', evidence);
process.exit(failures.length ? 1 : 0);
