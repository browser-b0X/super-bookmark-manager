// After a big import the app stays responsive and keeps saving: previews and automatic
// shelves arrive many per second, and each one used to re-check the whole library,
// re-render the page and push the SQLite save back again. 2,000 synthetic bookmarks,
// previews answered by a slow stand-in (no network). Timing-sensitive: run it on its
// own, not alongside other browser suites.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importThroughField } from './importField.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'import-lag-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys, time
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
import storage, app, metadata_fetcher
def slow_preview(url):
    time.sleep(0.25)
    return {"title": "", "summary": "A synthetic description for " + url[-12:], "thumbnail": "", "status": "partial", "error": ""}
metadata_fetcher.fetch_metadata = slow_preview
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`); }
}
const N = 2000;
const words = ['notes', 'guide', 'thread', 'ideas', 'list', 'review', 'page', 'collection', 'tips', 'story', 'design', 'tool'];
const links = Array.from({ length: N }, (_, i) =>
  `<DT><A HREF="https://site${i % 37}.example.invalid/item/${i}" ADD_DATE="${1700000000 + i}">${words[i % 12]} ${words[(i * 7) % 12]} number ${i}</A>`);
const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n<DT><H3>Bookmarks bar</H3>\n<DL><p>\n${links.join('\n')}\n</DL><p>\n</DL><p>\n`;
const file = join(evidence, 'bookmarks.html');
await writeFile(file, html);
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saves = [];
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/library') saves.push(Date.now()); });
  await page.goto(base + '/library/settings');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const result = await importThroughField(page, file);
  assert.equal(result.added, N, result.text);
  await page.waitForTimeout(1000);   // the import itself is one busy moment; measure what follows

  const window = Date.now();
  const lag = await page.evaluate(async ms => {
    const lags = []; const end = performance.now() + ms;
    while (performance.now() < end) { const t = performance.now(); await new Promise(r => setTimeout(r, 50)); lags.push(performance.now() - t - 50); }
    lags.sort((a, b) => a - b);
    return { median: lags[lags.length >> 1], p95: lags[Math.floor(lags.length * 0.95)], samples: lags.length };
  }, 10000);
  const savesInWindow = saves.filter(t => t >= window).length;
  const status = (await page.getByRole('status', { name: 'SQLite save status' }).innerText()).replace(/\s+/g, ' ');
  console.log(`timer lag median ${lag.median.toFixed(1)} ms, p95 ${lag.p95.toFixed(1)} ms over ${lag.samples} samples; ${savesInWindow} saves in 10 s; status "${status}"`);

  await check('the page stays responsive while previews and shelves arrive', async () => {
    // Before the fix the median delay was 30-50 ms (every result re-checked 2,000 links).
    assert.ok(lag.median < 15, `median timer delay ${lag.median.toFixed(1)} ms`);
  });
  await check('SQLite keeps saving while the changes keep coming (no half-minute wait)', async () => {
    assert.ok(savesInWindow >= 3, `${savesInWindow} saves in 10 s`);
    const pending = Number(/(\d+) changes? pending/.exec(status)?.[1] ?? 0);
    assert.ok(pending < 300, `${pending} changes waiting`);
  });
  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
