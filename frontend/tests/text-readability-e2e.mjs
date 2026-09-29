import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify/g4-c7-text-fix-20260921/e2e-'));
const diagnose = process.env.TXT_DIAGNOSE === '1';
const { chromium } = createRequire(import.meta.url)(process.env.TXT_PLAYWRIGHT_MODULE || 'playwright');
const fixture = name => join(root, 'frontend/tests/fixtures', name);
const seed = JSON.parse(await readFile(fixture('text-readability-library.json'), 'utf8'));
const preview = await readFile(fixture('landing-preview.svg'), 'utf8');
const expected = [
  ['Research & Development', 'Plan & build'],
  ['It\'s useful "today"', '“Read” — then save'],
  ['Launch notes', 'Read code details'],
  ['Line one line two tab', 'ABC next line'],
  [seed[4].title, seed[4].excerpt],
  [seed[5].title, seed[5].excerpt],
  [seed[6].url, seed[6].excerpt],
  ['Research &amp; Development', 'Use <div> & literal \\u2014 text'],
];
const events = [], errors = [], denied = [], consoleMessages = [], results = [];
let browser, server, page, base;
const sorted = posts => [...posts].sort((a, b) => a.id.localeCompare(b.id));
const record = (name, data) => writeFile(join(evidence, name + '.json'), JSON.stringify(data, null, 2));
const card = post => page.locator(`main [data-post-id="${post.id}"]`);
const posts = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts);
async function start(name) {
  assert.ok(process.env.TXT_PYTHON, 'Set TXT_PYTHON');
  const child = spawn(process.env.TXT_PYTHON, ['-B', join(root, 'frontend/tests/library_fixture.py'), join(evidence, name + '.sqlite'), '0'], {
    cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', LLM_API_KEY: 'fixture', LITELLM_PROXY_KEY: 'fixture' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  server = { child, pending: new Map() };
  child.stderr.on('data', data => { void appendFile(join(evidence, name + '-server.txt'), data); });
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Fixture exited before ready: ' + code)));
    createInterface({ input: child.stdout }).on('line', line => {
      const data = JSON.parse(line);
      if (data.ready) resolve(data);
      else if (data.command) { server.pending.get(data.command)?.(data); server.pending.delete(data.command); }
      else events.push(data);
    });
  });
  events.push(ready); base = `http://127.0.0.1:${ready.port}`;
  console.log('Fixture ready', JSON.stringify(ready));
}
async function snapshot() {
  const pending = new Promise(resolve => server.pending.set('snapshot', resolve));
  server.child.stdin.write('{"command":"snapshot"}\n');
  const { result } = await pending;
  assert.deepEqual(result.blocked, []); assert.equal(result.legacyCount, 0); assert.deepEqual(result.deletedUrls, []);
  return result;
}
async function stop() {
  if (!server) return;
  const child = server.child;
  let code = child.exitCode;
  if (code === null) {
    const exited = once(child, 'exit');
    child.stdin.end('{"command":"stop"}\n');
    [code] = await exited;
  }
  events.push({ pid: child.pid, exitCode: code }); server = undefined;
  assert.equal(code, 0);
}
async function saved(count) {
  await page.waitForFunction(count => {
    const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
    return state?.posts.length === count && Object.keys(state.pending).length === 0;
  }, count);
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  const result = await snapshot(); assert.deepEqual(sorted(result.posts), sorted(await posts())); return result;
}
async function focus(post) {
  await card(post).locator('[data-expand]').focus();
  await page.waitForFunction(id => document.querySelector('.catchup-card.is-expanded')?.dataset.postId === id, post.id);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))); });
  await card(post).evaluate(el => el.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
}
async function importerDiagnosis() {
  const bundle = await build({ stdin: { contents: 'export { parseTelegramExport } from "./src/lib/telegram"; export { parseBookmarkHtml } from "./src/lib/bookmarks"; export { titleFromUrl } from "./src/lib/platform";', resolveDir: join(root, 'frontend') }, bundle: true, write: false, format: 'iife', globalName: 'imports' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => route.abort());
    const unit = await context.newPage(); unit.on('pageerror', e => errors.push(e.message));
    await unit.addScriptTag({ content: bundle.outputFiles[0].text });
    const data = await unit.evaluate(() => {
      const text = 'Research &amp; Development; It&#39;s useful &quot;today&quot;; <strong>Launch</strong> notes; <a href="https://example.invalid/x">read</a>';
      const telegram = imports.parseTelegramExport(JSON.stringify({ type: 'saved_messages', messages: [{ id: 1, type: 'message', date: '2026-09-21T12:00:00', text }] }));
      const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://example.invalid/art">Art &amp;amp; drawing ideas</A><DT><A HREF="https://example.invalid/cooking">Cooking &amp; Kitchen</A></DL>';
      const bookmarks = imports.parseBookmarkHtml(html);
      const encodedUnicode = imports.parseTelegramExport('{"messages":[{"id":2,"type":"message","text":"Caf\\u00e9 https://example.invalid/u"}]}');
      return { text, telegram, html, bookmarks, encodedUnicode, urlTitle: imports.titleFromUrl('https://example.invalid/Research-%26amp%3B-Development') };
    });
    assert.deepEqual(data.telegram.errors, []); assert.equal(data.telegram.posts[0].excerpt, data.text);
    assert.equal(data.bookmarks.error, undefined);
    assert.deepEqual(data.bookmarks.posts.map(p => p.title), ['Art &amp; drawing ideas', 'Cooking & Kitchen']);
    assert.equal(data.encodedUnicode.posts[0].excerpt, 'Café https://example.invalid/u');
    await record('diagnosis-import-artifacts', data);
    results.push('Importer reproduction: literal artifacts retained; ordinary bookmark entities and JSON Unicode already decoded');
  } finally { await context.close(); }
}
async function runLibrary(input, name, verify) {
  let context;
  try {
    await start(name);
    context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { denied.push(url.href); return route.abort(); }
      if (url.pathname === '/__fixture/preview.svg') return route.fulfill({ contentType: 'image/svg+xml', body: preview });
      if (url.pathname === '/api/categorize') return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') consoleMessages.push(m.text()); });
    await page.goto(base + '/'); await saved(0);
    await page.evaluate(async input => {
      const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: input, deletedUrls: [] }) });
      if (!response.ok) throw new Error(await response.text());
    }, input);
    await page.reload(); assert.deepEqual(sorted((await saved(input.length)).posts), sorted(input));
    const api = await page.evaluate(async () => (await fetch('/api/library')).json());
    const rendered = await page.locator('main [data-post-id]').evaluateAll(els => els.map(el => ({ id: el.dataset.postId, title: el.querySelector('.catchup-title span').textContent,
      summary: el.querySelector('.catchup-summary')?.textContent || '', label: el.getAttribute('aria-label'), expand: el.querySelector('[data-expand]').getAttribute('aria-label'),
      tooltip: el.querySelector('.catchup-title').getAttribute('title'), href: el.querySelector('.catchup-title').getAttribute('href') })));
    await record(name + '-rendered-vs-stored', { rendered, browser: await posts(), api, sqlite: await snapshot(), classification: verify ? 'display-only normalization' : 'React text equals literal stored strings; not render-introduced' });
    if (!verify) {
      for (const row of rendered) {
        const post = input.find(p => p.id === row.id);
        assert.equal(row.title, post.title || post.url); assert.equal(row.summary, post.description || post.aiSummary || post.excerpt || '');
        assert.equal(row.label, row.title); assert.equal(row.expand, 'Expand ' + row.title); assert.equal(row.tooltip, row.title); assert.equal(row.href, post.url);
      }
      await focus(input.filter(p => p.status === 'inbox').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]);
      await page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
      results.push(name + ': exact stored/rendered comparison'); return;
    }
    for (const [i, post] of input.entries()) {
      await focus(input[(i + 1) % input.length]);
      assert.equal(await card(post).locator('.catchup-content').evaluate(el => el.inert), true);
      assert.equal(await card(post).getAttribute('aria-label'), expected[i][0]);
      assert.equal(await card(post).locator('[data-expand]').getAttribute('aria-label'), 'Expand ' + expected[i][0]);
      await focus(post);
      assert.equal(await card(post).locator('.catchup-title span').textContent(), expected[i][0]);
      assert.equal(await card(post).locator('.catchup-title').getAttribute('title'), expected[i][0]);
      assert.equal(await card(post).locator('.catchup-summary').textContent(), expected[i][1]);
      assert.equal(await card(post).locator('.catchup-title').isVisible(), true);
      assert.equal(await card(post).locator('.catchup-summary').isVisible(), true);
      assert.equal(await card(post).locator('.catchup-summary *').count(), 0);
      for (const link of [card(post).locator('.catchup-title'), card(post).getByRole('link', { name: 'Open original' })]) assert.equal(await link.getAttribute('href'), post.url);
    }
    assert.deepEqual(sorted((await snapshot()).posts), sorted(input));
    await focus(input[0]);
    assert.equal(await card(input[0]).locator('img').getAttribute('alt'), 'Preview of ' + expected[0][0]);
    await page.screenshot({ path: join(evidence, 'catchup-text-fixed.png'), animations: 'disabled' });
    results.push('1–8: entity/markup/whitespace/punctuation/Unicode, exact URLs, collapsed labels and expanded text; raw documents unchanged');
    await card(input[0]).locator('[data-triage="reference"]').focus(); await page.keyboard.press('Enter');
    await card(input[0]).waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement.closest('[data-post-id]')?.dataset.postId, action: document.activeElement.getAttribute('data-triage'), inert: !!document.activeElement.closest('[inert]') })), { id: input[1].id, action: 'reference', inert: false });
    assert.equal((await saved(input.length)).posts.find(p => p.id === input[0].id).status, 'reference');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await card(input[0]).count(), 1);
    assert.equal(await card(input[0]).locator('[data-expand]').evaluate(el => el === document.activeElement), true);
    const final = await saved(input.length);
    for (const post of final.posts) {
      const original = input.find(p => p.id === post.id);
      assert.deepEqual({ ...post, updatedAt: original.updatedAt }, original);
    }
    await record('final-sqlite', final); results.push('9: Keep/next equivalent focus/Undo; only triaged updatedAt changed');
  } finally { if (context) await context.close(); await stop(); }
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.TXT_BROWSER_CHANNEL || undefined });
  if (diagnose) {
    await importerDiagnosis();
    await runLibrary(JSON.parse(await readFile(fixture('retrieval-library.json'), 'utf8')), 'catchup-baseline', false);
  }
  await runLibrary(seed, diagnose ? 'artifact-baseline' : 'text-fixed', !diagnose);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log('PASS', results);
} catch (error) {
  await record('failure', { message: error.message, stack: error.stack }); throw error;
} finally {
  if (browser) await browser.close(); await stop();
  await record('runtime', { diagnose, events, errors, denied, consoleMessages, results, stopped: !server, browserClosed: !browser?.isConnected() });
  console.log('CLEANUP; evidence', evidence);
}
