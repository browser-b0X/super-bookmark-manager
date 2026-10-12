// Settings → AI providers in a browser: one line per provider, opened on demand, and FreeLLMAPI
// set up against a stand-in FreeLLMAPI on this computer (synthetic keys, no internet).
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
const evidence = await mkdtemp(join(root, '.verify', 'ai-providers-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const fake = port + 1;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
for name in ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "FREELLMAPI_KEY", "LLM_BASE_URL"):
    os.environ.pop(name, None)
seen = []
class FreeLLMAPI(BaseHTTPRequestHandler):
    """Answers like FreeLLMAPI's OpenAI-compatible /v1 (only with its unified key)."""
    def log_message(self, *a): pass
    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def ok(self):
        seen.append((self.path, self.headers.get("Authorization")))
        return self.headers.get("Authorization") == "Bearer freellmapi-synthetic-0001"
    def do_GET(self):
        if not self.ok(): return self.reply({"error": "unauthorized"}, 401)
        self.reply({"data": [{"id": "auto"}, {"id": "auto:fast"}, {"id": "auto:smart"}]})
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0); self.rfile.read(length)
        if not self.ok(): return self.reply({"error": "unauthorized"}, 401)
        self.reply({"choices": [{"message": {"content": '{"ok": true}'}}], "usage": {"total_tokens": 9}})
threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", ${fake}), FreeLLMAPI).serve_forever, daemon=True).start()
import ai_providers, storage, app
ai_providers.PROVIDERS["freellmapi"]["base"] = "http://127.0.0.1:${fake}/v1"
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`); }
}

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/library/settings#ai');
  const section = page.getByRole('region', { name: 'AI providers' });
  await section.getByRole('listitem').first().waitFor();
  const rows = section.getByRole('listitem');
  const toggle = name => section.getByRole('button', { name: new RegExp(`^${name}\\b`) });

  await check('FreeLLMAPI and the local model come first; the single services are folded away under "Other providers"', async () => {
    const labels = await rows.evaluateAll(items => items.map(li => li.getAttribute('aria-label')));
    assert.deepEqual(labels, ['FreeLLMAPI provider', 'Local server provider', 'Other providers']);
    assert.equal(await section.locator('input').count(), 0, 'no fields until a provider is opened');
    for (const name of ['FreeLLMAPI', 'Local server', 'Other providers']) {
      assert.equal(await toggle(name).getAttribute('aria-expanded'), 'false', name);
    }
    await section.getByText('None set up yet: FreeLLMAPI gives the most free use with one key.').waitFor();
    await section.getByText(/Google Gemini, Groq, OpenRouter, NVIDIA NIM · only needed without FreeLLMAPI/).waitFor();
    await toggle('Other providers').click();
    const all = await rows.evaluateAll(items => items.map(li => li.getAttribute('aria-label')));
    assert.deepEqual(all, ['FreeLLMAPI provider', 'Local server provider', 'Other providers',
      'Google Gemini provider', 'Groq provider', 'OpenRouter provider', 'NVIDIA NIM provider']);
    for (const name of ['Google Gemini', 'Groq', 'OpenRouter', 'NVIDIA NIM']) {
      assert.equal(await toggle(name).getAttribute('aria-expanded'), 'false', name);
    }
  });

  await check('opening one shows only its fields, and it folds away again (keyboard too)', async () => {
    await toggle('Groq').click();
    assert.equal(await toggle('Groq').getAttribute('aria-expanded'), 'true');
    await section.getByRole('textbox', { name: 'Groq API key' }).or(section.getByLabel('Groq API key')).first().waitFor();
    assert.equal(await section.getByLabel(/API key$/).count(), 1, 'only the opened provider shows a key field');
    await toggle('Groq').focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle('Groq').getAttribute('aria-expanded'), 'false');
    assert.equal(await section.locator('input').count(), 0);
    await toggle('Other providers').click();
    assert.equal(await section.getByRole('listitem', { name: 'Groq provider' }).count(), 0, 'folded away again');
  });

  await check('FreeLLMAPI is set up with its key and answers the test', async () => {
    await toggle('FreeLLMAPI').click();
    const address = section.getByLabel('FreeLLMAPI address');
    assert.equal(await address.inputValue(), `http://127.0.0.1:${fake}/v1`);
    await section.getByRole('link', { name: /Get FreeLLMAPI/ }).waitFor();
    const save = section.getByRole('listitem', { name: 'FreeLLMAPI provider' }).getByRole('button', { name: 'Save' });
    assert.equal(await save.isDisabled(), true, 'nothing to save yet');
    await section.getByLabel('FreeLLMAPI API key').fill('freellmapi-synthetic-0001');
    await save.click();
    const row = section.getByRole('listitem', { name: 'FreeLLMAPI provider' });
    await row.getByRole('status').filter({ hasText: /Working/ }).waitFor({ timeout: 20000 });
    await row.getByText('Ready', { exact: true }).waitFor();
    await section.getByText(/1 of 6 set up · in use: FreeLLMAPI/).waitFor();
    const saved = await (await fetch(base + '/api/ai/providers')).json();
    assert.equal(saved.providers[0].id, 'freellmapi');
    assert.equal(saved.providers[0].keyHint, '…0001');
    assert.ok(!JSON.stringify(saved).includes('freellmapi-synthetic-0001'), 'the key never comes back to the browser');
  });

  await check('a folded row still says it is set up, and Use can be switched without opening it', async () => {
    await toggle('FreeLLMAPI').click();
    const row = section.getByRole('listitem', { name: 'FreeLLMAPI provider' });
    await row.getByText('Key …0001').waitFor();
    assert.equal(await row.locator('input[type=password], input:not([type=checkbox])').count(), 0);
    // The box follows the saved setting, so it flips once the server has answered.
    await row.getByRole('checkbox', { name: /Use/ }).click();
    await section.getByText(/1 of 6 set up · in use: none/).waitFor();
    assert.equal(await row.getByRole('checkbox', { name: /Use/ }).isChecked(), false);
    await row.getByRole('checkbox', { name: /Use/ }).click();
    await section.getByText(/in use: FreeLLMAPI/).waitFor();
  });

  await check('phone width: rows fit without sideways scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= client, `${scroll} > ${client}`);
    await section.screenshot({ path: join(evidence, 'providers-phone.png') });
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
