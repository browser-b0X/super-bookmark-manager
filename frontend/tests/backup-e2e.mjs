// Backup & Restore in a browser against the real server, with synthetic links only.
// Found after a fresh install: "Restore backup" made a separate database and asked for
// PowerShell, and the library stayed empty. Restore now puts the backup into the library in use:
//  - an old install exports; a fresh install on the same address (so the browser still holds the
//    old install's cache) restores it, and the links are there without a reload;
//  - a library with links is saved first as a backup file, and restoring that file goes back;
//  - another browser still holding the replaced library, with a change on its way, doesn't write it back;
//  - broken backups and a restore that fails half-way change nothing;
//  - pictures stay with the old install (a JSON backup keeps their addresses only): they count as
//    missing previews on the new one, and fetching brings them back (owner report: the count said 0).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importThroughField } from './importField.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'backup-'));
const python = process.env.C4_PYTHON || 'python3';
const fixture = JSON.parse(await readFile(join(root, 'frontend/tests/fixtures/backup-library.json'), 'utf8'));
const byId = posts => [...posts].sort((a, b) => a.id.localeCompare(b.id));
const failures = [];
const errors = [];
const denied = [];

/** One install: the app on its own synthetic database. The same port twice is the same address in the browser. */
async function install(name, port = 0) {
  const db = join(evidence, name, 'library.sqlite');
  const child = spawn(python, ['-B', join(root, 'frontend/tests/backup_fixture.py'), db, String(port)],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = once(child, 'exit');
  const waiting = new Map();
  const ready = await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`fixture ${name} exited ${code}: ${log.slice(-800)}`)));
    createInterface({ input: child.stdout }).on('line', line => {
      const data = JSON.parse(line);
      if (data.ready) resolve(data);
      if (data.command) { waiting.get(data.command)?.(data); waiting.delete(data.command); }
    });
  });
  const control = command => new Promise(resolve => { waiting.set(command, resolve); child.stdin.write(JSON.stringify({ command }) + '\n'); });
  return {
    name, db, port: ready.port, base: `http://127.0.0.1:${ready.port}`, control,
    async stop() { if (child.exitCode === null) child.stdin.end('{"command":"stop"}\n'); const [code] = await exited; assert.equal(code, 0, log.slice(-800)); },
  };
}

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
async function profile(base) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' });
  // Only the app itself: anything else is refused and reported.
  await context.route('**/*', route => {
    if (!route.request().url().startsWith(base.replace(/:\d+$/, ':'))) { denied.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  return context;
}
async function open(context, path) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(path);
  return page;
}
// The browser's copy of the library (small ones live in localStorage).
const cache = page => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('library-store-v1')))).state);
async function saved(page, n) {
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  await page.waitForFunction(n => {
    const key = Object.keys(localStorage).find(k => k.endsWith('library-store-v1'));
    const s = key && JSON.parse(localStorage.getItem(key)).state;
    return s && s.posts.length === n && !Object.keys(s.pending).length;
  }, n);
}
const result = page => page.getByRole('status', { name: 'Backup result' });
const preview = page => page.getByRole('region', { name: 'Restore preview' });
async function tabTo(page, target) {
  for (let i = 0; i < 200; i++) {
    if (await target.evaluate(e => e === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard target unreachable');
}
const choose = (page, file) => page.getByLabel('Select library backup').setInputFiles(file);
async function restore(page, file, expectPreview) {
  await choose(page, file);
  await preview(page).waitFor();
  assert.match(await preview(page).innerText(), expectPreview);
  await page.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await result(page).filter({ hasText: /^Restored \d+ links? from the backup\.$/ }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Restore backup');
}
async function post(page, path, data) {
  return page.evaluate(async ({ path, data }) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, data: await r.json() };
  }, { path, data });
}
const canonical = v => (v === null || typeof v !== 'object'
  ? JSON.stringify(v).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : '{' + Object.keys(v).sort().map(k => canonical(k) + ':' + canonical(v[k])).join(',') + '}');
const sign = d => { const c = structuredClone(d); delete c.sha256; c.sha256 = createHash('sha256').update(canonical(c)).digest('hex'); return JSON.stringify(c); };
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack.split("\n").slice(0, 14).join(" | ")}`); throw error; }
}

const at = '2026-10-01T10:00:00Z';
const extra = (name, title = name) => ({ ...fixture[0], id: `backup-${name}`, url: `https://backup.example.invalid/${name}`,
  canonicalUrl: `https://backup.example.invalid/${name}`, title, userNotes: '', createdAt: at, updatedAt: at });
const deleted = extra('deleted');
// Like a real library: every link's preview was fetched before; three of them have a picture,
// kept in the old install's picture folder (the address is what the stand-in site gives).
const pictureCode = url => 'pic_' + createHash('sha256').update(url).digest('hex').slice(0, 16);
const library = fixture.map((p, i) => ({ ...p, metadataStatus: 'enriched', enrichedAt: at,
  ...(i < 3 ? { thumbnailUrl: `/thumb/${pictureCode(p.url)}` } : {}) }));
const pictures = library.slice(0, 3).map(p => pictureCode(p.url));
const fetchCount = page => page.evaluate(() => [...document.querySelectorAll('button')].find(b => /Fetch missing previews/.test(b.textContent))?.textContent.match(/\((\d+)\)/)?.[1]);
let old, fresh, context, page, file, backup;
try {
  await check('an old install exports its library (17 links and one deletion marker) from the keyboard', async () => {
    old = await install('old-install');
    context = await profile(old.base);
    page = await open(context, old.base + '/library/settings');
    await saved(page, 0);
    assert.equal((await post(page, '/api/library', { posts: [...library, deleted], deletedUrls: [] })).status, 200);
    assert.ok((await old.control('install-pictures:' + pictures.join(','))).installed.every(Boolean));
    assert.equal((await post(page, '/api/library', { posts: [], deletedUrls: [deleted.url] })).status, 200);
    await page.reload();
    await saved(page, 17);
    // A Saved View: a browser preference, which a restore leaves alone.
    await page.goto(old.base + '/library');
    await saved(page, 17);
    await page.getByRole('button', { name: 'Saved Views', exact: true }).click();
    const views = page.getByRole('dialog', { name: 'Saved Views', exact: true });
    await views.getByLabel('View name', { exact: true }).fill('Kept across a restore');
    await views.getByRole('button', { name: 'Save current', exact: true }).click();
    await views.getByRole('status').filter({ hasText: 'View saved.' }).waitFor();
    await views.getByRole('button', { name: 'Close', exact: true }).click();
    await page.goto(old.base + '/library/settings');
    await saved(page, 17);
    // Here the pictures are on this computer: nothing is missing.
    await page.waitForFunction(() => /Fetch missing previews \(0\)/.test(document.body.innerText));
    const exportButton = page.getByRole('button', { name: 'Export backup', exact: true });
    await tabTo(page, exportButton);
    const download = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    file = join(evidence, (await download).suggestedFilename());
    await (await download).saveAs(file);
    await result(page).filter({ hasText: 'Exported 17 SQLite-saved items' }).waitFor();
    backup = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(backup.recordCount, 17);
    assert.equal(JSON.parse(sign(backup)).sha256, backup.sha256);
    assert.deepEqual(backup.library, (await old.control('backup-snapshot')).result);
    assert.deepEqual(backup.library.tombstones, [{ url: deleted.url, id: null }]);
    await old.stop();
  });

  await check('a fresh install on the same address restores it: the links are there at once, though the browser still held the old cache', async () => {
    fresh = await install('fresh-install', old.port);
    await page.reload();
    // SQLite is empty; the browser still shows the old install's cached links.
    assert.equal((await fresh.control('backup-snapshot')).result.posts.length, 0);
    await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
    const views = (await cache(page)).views;
    assert.deepEqual(views.map(v => v.name), ['Kept across a restore']);
    // From the keyboard: choose the file, look at the preview, cancel; nothing changes.
    const restoreButton = page.getByRole('button', { name: 'Restore backup', exact: true });
    // Listen first: Playwright starts catching file choosers only once asked, and that takes a moment.
    const chooser = page.waitForEvent('filechooser');
    await tabTo(page, restoreButton);
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(file);
    await preview(page).waitFor();
    assert.match(await preview(page).innerText(), /Version 1 · 17 links · 1 deletion marker\b/);
    assert.match(await preview(page).innerText(), /This library is empty: the backup's 17 links become your library\./);
    await tabTo(page, page.getByRole('button', { name: 'Cancel restore' }));
    await page.keyboard.press('Enter');
    await result(page).filter({ hasText: 'Restore canceled. Nothing changed.' }).waitFor();
    assert.ok(await restoreButton.evaluate(e => e === document.activeElement));
    assert.equal((await fresh.control('backup-snapshot')).result.posts.length, 0);
    // Now restore it.
    await restore(page, file, /This library is empty/);
    assert.equal(await page.locator('[data-safety-copy]').count(), 0, 'an empty library has nothing to keep');
    await saved(page, 17);
    const after = await fresh.control('backup-snapshot');
    assert.deepEqual(after.result, backup.library, 'SQLite holds exactly the backup');
    assert.ok(after.epoch > 0);
    assert.deepEqual(after.folders.filter(f => f === 'restored-libraries' || f === 'backups'), []);
    const local = await cache(page);
    assert.deepEqual(byId(local.posts), byId(backup.library.posts), 'this tab holds exactly the backup, without a reload');
    assert.deepEqual(local.deletedUrls, [deleted.url]);
    assert.deepEqual(local.views, views, 'Saved Views stay');
    // The backup kept the pictures' addresses; the files stayed with the old install.
    assert.deepEqual((await post(page, '/api/thumbs/missing', { codes: pictures })).data.missing, pictures);
    // The library page, reached inside the app (no reload), lists the backup's links.
    await page.evaluate(() => { history.pushState({}, '', '/library'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByText('Owner Programming').first().waitFor();
    await page.getByText('Budget planning café').first().waitFor();
    // A fresh browser profile sees the same library.
    const other = await profile(fresh.base);
    const second = await open(other, fresh.base + '/library/settings');
    await saved(second, 17);
    assert.deepEqual(byId((await cache(second)).posts), byId(backup.library.posts));
    await other.close();
  });

  await check('pictures that stayed with the old install count as missing previews, and fetching brings them back', async () => {
    // Another tab shows the library while its pictures are missing.
    const shelf = await open(context, fresh.base + '/library');
    await shelf.setViewportSize({ width: 1365, height: 4000 });
    await saved(shelf, 17);
    await shelf.waitForFunction(codes => codes.every(c => !document.querySelector(`img[src="/thumb/${c}"]`)), pictures);
    await fresh.control('previews-on');                  // the stand-in sites answer from now on
    await page.goto(fresh.base + '/library/settings');
    await saved(page, 17);
    await page.waitForFunction(() => /Fetch missing previews \(3\)/.test(document.body.innerText));
    assert.equal(await fetchCount(page), '3', 'the three pictures that stayed behind');
    await page.getByRole('button', { name: /Fetch missing previews/ }).click();
    const run = page.getByRole('status', { name: 'Preview fetch result' });
    await run.filter({ hasText: 'Checked 3 links' }).waitFor();
    assert.match(await run.innerText(), /3\s*now have a picture/);
    await page.waitForFunction(() => /Fetch missing previews \(0\)/.test(document.body.innerText));
    assert.deepEqual((await post(page, '/api/thumbs/missing', { codes: pictures })).data.missing, []);
    // The other tab shows them, without a reload.
    await shelf.waitForFunction(codes => codes.every(c => [...document.querySelectorAll(`img[src="/thumb/${c}"]`)]
      .some(img => img.complete && img.naturalWidth >= 128)), pictures, { timeout: 15000 });
    await shelf.close();
    await fresh.control('previews-off');
  });

  let safety;
  const added = extra('later', 'Saved after the backup');
  await check('a library with links is saved first as a backup file, and the restore replaces it', async () => {
    await page.goto(fresh.base + '/library/settings');
    await saved(page, 17);
    const epoch = (await fresh.control('backup-snapshot')).epoch;
    assert.equal((await post(page, '/api/library', { posts: [added], deletedUrls: [], epoch })).status, 200);
    await page.reload();
    await saved(page, 18);
    const before = (await fresh.control('backup-snapshot')).result;
    await restore(page, file, /This replaces the 18 links in this library with the backup's 17 links\. This library is saved first as a backup file, so you can go back\./);
    safety = await page.locator('[data-safety-copy]').innerText();
    assert.equal(dirname(safety), join(dirname(fresh.db), 'backups'));
    const kept = JSON.parse(await readFile(safety, 'utf8'));
    assert.equal(kept.recordCount, 18);
    assert.equal(JSON.parse(sign(kept)).sha256, kept.sha256, 'the saved file is an ordinary, intact backup');
    assert.deepEqual(kept.library, before);
    await saved(page, 17);
    assert.deepEqual((await fresh.control('backup-snapshot')).result, backup.library);
    assert.ok(!(await cache(page)).posts.some(p => p.url === added.url));
    assert.deepEqual((await cache(page)).views.map(v => v.name), ['Kept across a restore']);
  });

  await check('restoring the saved file goes back, and never overwrites the first saved file', async () => {
    const before = (await fresh.control('backup-snapshot')).result;
    await restore(page, safety, /This replaces the 17 links in this library with the backup's 18 links\./);
    await saved(page, 18);
    const back = await fresh.control('backup-snapshot');
    assert.ok(back.result.posts.some(p => p.url === added.url));
    assert.equal(back.result.posts.length, 18);
    assert.equal(back.backups.length, 2);
    const second = await page.locator('[data-safety-copy]').innerText();
    assert.notEqual(second, safety);
    assert.deepEqual(JSON.parse(await readFile(second, 'utf8')).library, before);
  });

  await check('another browser with a change on its way when the restore lands does not write it into the restored library', async () => {
    // Another browser profile: no shared cache, so its change can reach SQLite only through its own save.
    // (Tabs of one browser share the cache; the store test covers how they merge after a restore.)
    const elsewhere = await profile(fresh.base);
    const tab = await open(elsewhere, fresh.base + '/library');
    await saved(tab, 18);
    // Hold the other tab's saves until after the restore.
    const held = [];
    await tab.route('**/api/library', route => (route.request().method() === 'POST' ? held.push(route) : route.continue()));
    await tab.getByRole('button', { name: 'Add link' }).first().click();
    await tab.getByRole('dialog', { name: 'Add link' }).getByPlaceholder('https://…').fill('https://backup.example.invalid/other-tab');
    await tab.getByRole('button', { name: 'Save link', exact: true }).click();
    for (let i = 0; i < 100 && !held.length; i++) await tab.waitForTimeout(50);
    assert.ok(held.length, 'the other tab tried to save its new link');
    await restore(page, file, /This replaces the 18 links in this library with the backup's 17 links\./);
    await saved(page, 17);
    for (const route of held.splice(0)) await route.continue();
    await tab.unroute('**/api/library');
    // Its save is refused (the library was replaced) and it takes the restored library, without a reload.
    await saved(tab, 17);
    const now = await fresh.control('backup-snapshot');
    assert.deepEqual(now.result, backup.library, 'the other browser\'s link was not written');
    assert.deepEqual(byId((await cache(tab)).posts), byId(backup.library.posts));
    // It had that link open: the link is gone with the replaced library.
    await tab.getByRole('status').filter({ hasText: 'This saved post no longer exists.' }).waitFor();
    await tab.getByRole('button', { name: 'Back to library', exact: true }).click();
    // And it saves normally afterwards.
    await tab.getByRole('button', { name: 'Add link' }).first().click();
    await tab.getByRole('dialog', { name: 'Add link' }).getByPlaceholder('https://…').fill('https://backup.example.invalid/after-restore');
    await tab.getByRole('button', { name: 'Save link', exact: true }).click();
    await saved(tab, 18);
    const later = await fresh.control('snapshot');
    assert.ok(later.posts.some(p => p.url === 'https://backup.example.invalid/after-restore'));
    assert.ok(!later.posts.some(p => p.url === 'https://backup.example.invalid/other-tab'));
    await elsewhere.close();
    await page.reload();
    await saved(page, 18);
  });

  await check('broken backups are refused in the preview and by the server, and change nothing', async () => {
    const before = await fresh.control('backup-snapshot');
    const raw = await readFile(file, 'utf8');
    const mutate = fn => { const d = structuredClone(backup); fn(d); return sign(d); };
    const cases = [['empty', ''], ['malformed', '{'], ['null', 'null'], ['wrong version', mutate(d => { d.version = 2; })],
      ['missing section', mutate(d => { delete d.library.tombstones; })], ['duplicate ID', mutate(d => { d.library.posts[1].id = d.library.posts[0].id; })],
      ['duplicate URL', mutate(d => { d.library.posts[1].url = d.library.posts[0].url; })], ['invalid URL', mutate(d => { d.library.posts[0].url = 'javascript:alert(1)'; })],
      ['truncated', raw.slice(0, -20)], ['checksum', JSON.stringify({ ...backup, sha256: '0'.repeat(64) })], ['bad count', mutate(d => { d.recordCount = 99; })],
      ['invalid tombstone', mutate(d => { d.library.tombstones[0].url = 'file:///test'; })],
      ['duplicate category', mutate(d => { d.library.categories.push(d.library.categories[0]); })], ['non-ASCII checksum', JSON.stringify({ ...backup, sha256: '日'.repeat(64) })]];
    for (const [name, content] of cases) {
      const answered = page.waitForResponse(r => r.url().endsWith('/api/backup/preview'));
      await choose(page, { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(content) });
      assert.equal((await answered).status(), 400, name);
      await page.waitForFunction(() => !document.querySelector('[role="status"][aria-label="Backup result"]')?.closest('section')?.textContent?.includes('Working on your backup'));
      assert.match(await result(page).innerText(), /malformed|Unsupported|requires|Duplicate|valid HTTP|checksum|count|deletedUrls|category/, name);
      assert.equal(await preview(page).count(), 0, name);
      assert.equal((await post(page, '/api/backup/restore', { content, sha256: backup.sha256, confirm: true })).status, 400, name);
      assert.deepEqual(await fresh.control('backup-snapshot'), before, name);
    }
    assert.equal((await post(page, '/api/backup/restore', { content: raw, sha256: backup.sha256 })).status, 400, 'not confirmed');
    assert.equal((await post(page, '/api/backup/restore', { content: raw, sha256: 'wrong', confirm: true })).status, 400, 'another preview');
    assert.deepEqual(await fresh.control('backup-snapshot'), before);
  });

  await check('a restore that fails half-way changes nothing and leaves no saved file behind', async () => {
    const before = await fresh.control('backup-snapshot');
    await fresh.control('restore-fail-on');
    await choose(page, file);
    await preview(page).waitFor();
    await page.getByRole('button', { name: 'Confirm restore', exact: true }).click();
    await result(page).filter({ hasText: 'nothing was changed' }).waitFor();
    await fresh.control('restore-fail-off');
    assert.deepEqual(await fresh.control('backup-snapshot'), before);
    await saved(page, 18);
  });

  await check('after a restore, a deletion marker from the backup still keeps that link out of an import', async () => {
    await restore(page, file, /backup's 17 links/);
    await saved(page, 17);
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><A HREF="${deleted.url}">Deleted must stay deleted</A><A HREF="https://backup.example.invalid/new">New only</A></DL>`;
    const imported = await importThroughField(page, { name: 'overlap.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    assert.equal(imported.added, 1, imported.text);
    await saved(page, 18);
    const now = await fresh.control('snapshot');
    assert.ok(now.posts.some(p => p.url === 'https://backup.example.invalid/new'));
    assert.ok(!now.posts.some(p => p.url === deleted.url));
    assert.ok(now.deletedUrls.includes(deleted.url));
  });

  await check('the panel fits from desktop to phone width with the preview open', async () => {
    await choose(page, file);
    await preview(page).waitFor();
    for (const width of [1365, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await preview(page).scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no sideways scroll at ${width}px`);
      await page.screenshot({ path: join(evidence, `restore-preview-${width}.png`) });
    }
    await page.getByRole('button', { name: 'Cancel restore' }).click();
  });

  await check('no page errors, no requests outside the app, nothing personal or external touched', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(denied, []);
    assert.deepEqual((await fresh.control('snapshot')).blocked, []);
  });
} catch {
  // Reported by check(); later checks depend on earlier ones.
} finally {
  await browser.close();
  await old?.stop().catch(e => { failures.push('fixture stop: ' + e.message); });
  await fresh?.stop().catch(e => { failures.push('fixture stop: ' + e.message); });
  console.log('Evidence', evidence);
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
