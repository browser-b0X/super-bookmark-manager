// Keep large videos and audio (v0.4.0, mockups in Claude outputs/v040-review/phase8/): the switch in Settings →
// Library & sync is kept across a reload, says what the cap is and what it covers (X, Telegram videos and audio, not
// TikTok), and the social posts table says 2 GB when it is on. Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/large-videos-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'large-videos-'));
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
os.environ["SBM_SAVED_COPIES"] = "on"
from metadata_fixture import ControlledHTTP
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
site = ControlledHTTP().__enter__()          # nothing may leave the machine
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const errors = []; context.on('weberror', e => errors.push(e.error().message));
const page = await context.newPage();

try {
  await check('Keep large videos and audio: off by default, switched on, kept across a reload, switched off again', async () => {
    await page.goto(`${base}/library/settings`);
    const panel = page.getByRole('region', { name: 'Saved copies' });
    const name = { name: 'Keep large videos and audio', exact: true };
    const toggle = panel.getByRole('switch', name);
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await page.waitForFunction(async () => (await (await fetch('/api/archive/large-videos')).json()).on === true);
    await page.reload();
    await panel.getByRole('switch', name).waitFor();
    assert.equal(await panel.getByRole('switch', name).getAttribute('aria-checked'), 'true');
    const hint = panel.getByText(/up to 2 GB each/);
    await hint.waitFor();
    assert.match(await hint.innerText(), /X videos, and Telegram videos and audio sent with your links, bigger than 50 MB are kept too/);
    assert.match(await hint.innerText(), /Large Telegram files download in the background after a refresh\. .*TikTok videos keep the 50 MB limit\./);
    await page.screenshot({ path: join(evidence, 'settings-on.png') });
    await panel.getByRole('switch', name).click();
    await page.waitForFunction(async () => (await (await fetch('/api/archive/large-videos')).json()).on === false);
  });

  await check('the social posts table says what X keeps, and changes with the switch', async () => {
    await page.goto(`${base}/library/settings`);
    const row = page.getByRole('row').filter({ hasText: 'X' }).filter({ hasText: 'Text, photos' });
    await row.getByText('up to 50 MB').waitFor();
    assert.match(await row.innerText(), /up to 50 MB, or up to 2 GB with “Keep large videos and audio”/);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
