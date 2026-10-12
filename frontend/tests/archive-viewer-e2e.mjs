// Saved copies in a real browser: a copy can never run code, load anything or
// reach the app, even when a hostile file is planted straight into the archive
// folder (as if cleaning had missed everything). Also saves one synthetic page
// through the real API and checks it reads correctly. Synthetic data only: an
// owned loopback server plays the "website"; nothing leaves this machine.
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
const evidence = await mkdtemp(join(root, '.verify', 'archive-viewer-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const HOSTILE = 'ab'.repeat(16);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import base64, os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
from metadata_fixture import ControlledHTTP, BASE_URL
import storage, app, archive
site = ControlledHTTP().__enter__()
site.html("/article", """<html lang="en"><head><title>Synthetic article</title><link rel="stylesheet" href="/site.css">
<script>window.pwned = 1; document.title = "PWNED";</script></head><body onload="document.title='PWNED-ONLOAD'">
<h1 id="headline">A synthetic headline</h1><p class="lead">""" + "Plain words of the article. " * 30 + """</p>
<img id="pic" src="/pic.png" alt="Synthetic picture" onerror="document.title='PWNED-ONERROR'">
<p><a id="more" href="/more">Read more on the site</a></p><iframe src="/frame"></iframe>
<form action="/steal" method="post"><input name="q" value="x"><button>Send</button></form></body></html>""")
site.routes["/site.css"] = (200, {"Content-Type": "text/css"}, b'.icon{background-image:url("data:image/svg+xml;utf8,<svg xmlns=\\\\"http://www.w3.org/2000/svg\\\\" fill=\\\\"%23000\\\\"><path transform=\\\\"rotate(45)\\\\" d=\\\\"m1 2\\\\"/></svg>")}'
                                                                 b".lead{color:rgb(1, 2, 3)} h1{background:url(/track.png)}")
site.routes["/pic.png"] = (200, {"Content-Type": "image/png"}, base64.b64decode("${PNG}"))
os.makedirs(archive.ARCHIVE_DIR, exist_ok=True)
with open(os.path.join(archive.ARCHIVE_DIR, "${HOSTILE}.html"), "w", encoding="utf-8") as planted:
    planted.write("""<!DOCTYPE html><html><head><meta charset="utf-8"><title>Planted</title>
<meta http-equiv="refresh" content="1;url=/api/stats?leak=refresh">
<link rel="stylesheet" href="/api/stats?leak=css"><style>#styled{color:rgb(4, 5, 6)} body{background:url(/api/stats?leak=bg)}</style>
<script>window.pwned = 1; document.title = "PWNED";</script><script src="/api/stats?leak=script"></script></head>
<body onload="document.title='PWNED-ONLOAD'"><p id="styled">Planted text</p>
<img id="remote" src="/api/stats?leak=img" onerror="document.title='PWNED-ONERROR'">
<img id="inline" src="data:image/png;base64,${PNG}" onload="document.title='PWNED-IMG'">
<iframe src="/api/stats?leak=frame"></iframe><object data="/api/stats?leak=object"></object>
<video id="leakvid" preload="auto" src="/api/stats?leak=video"></video><video id="ownvid" preload="auto" src="${HOSTILE}.mp4"></video>
<form id="form" action="/api/library?leak=form" method="post"><input name="posts" value="x"><button id="send">Send</button></form>
<a id="out" href="${base}/api/stats?popup=1" target="_blank" rel="noopener noreferrer">Out</a>
<svg onload="document.title='PWNED-SVG'"><script>document.title='PWNED-SVGSCRIPT'</script></svg>
</body></html>""")
with open(os.path.join(archive.ARCHIVE_DIR, "${HOSTILE}.mp4"), "wb") as planted:
    planted.write(b"\\x00\\x00\\x00\\x18ftypmp42" + b"x" * 64)
storage.init_db()
from flask import jsonify, request
seen = []
@app.app.before_request
def record():                       # what really reached the server, whatever the browser reports
    if request.path != "/__seen":
        seen.append(request.full_path.rstrip("?"))
@app.app.route("/__seen")
def report():
    return jsonify(seen)
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', chunk => { serverLog += chunk; });
let up = false;
for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  assert.ok(up, 'fixture server did not start: ' + serverLog.slice(-400));
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  // Anything addressed to the synthetic "live site" from the browser is answered here.
  await context.route('http://metadata.fixture.test/**', route => route.fulfill({
    contentType: 'text/html', body: '<title>live</title><script>document.title = "live-js"</script>live site' }));
  const page = await context.newPage();
  // Answered requests only: the browser also reports ones its policy blocked before sending.
  const requests = [], blocked = [];
  context.on('response', response => requests.push(`${response.request().method()} ${response.url()}`));
  context.on('requestfailed', request => blocked.push(`${request.url()} ${request.failure()?.errorText}`));
  const reached = async () => (await (await fetch(base + '/__seen')).json());
  const leaks = async () => [
    ...requests.filter(r => r.includes('leak=') || r.includes('/steal') || r.includes('/frame') || r.includes('track.png')),
    ...(await reached()).filter(r => r.includes('leak=')),
  ];

  await check('a planted hostile file: no script runs, nothing loads, the page stays put', async () => {
    const response = await page.goto(`${base}/archive/${HOSTILE}`);
    const csp = response.headers()['content-security-policy'];
    assert.match(csp, /^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data:; media-src http:\/\/127\.0\.0\.1:\d+\/archive\/; style-src 'unsafe-inline'/);
    assert.ok(!csp.includes('allow-scripts') && !csp.includes('allow-same-origin'));
    await page.waitForTimeout(1800);                       // longer than the planted 1 s meta refresh
    assert.equal(page.url(), `${base}/archive/${HOSTILE}`);
    assert.equal(await page.title(), 'Planted');
    await page.locator('#styled').waitFor();
    assert.equal(await page.locator('#styled').evaluate(el => getComputedStyle(el).color), 'rgb(4, 5, 6)', 'inline <style> still applies');
    assert.equal(await page.locator('#inline').evaluate(el => el.naturalWidth), 1, 'a data: picture shows');
    assert.equal(await page.locator('#remote').evaluate(el => el.naturalWidth), 0, 'a remote picture does not load');
    assert.equal(await page.evaluate(() => typeof window.pwned), 'undefined');
    await page.locator('#send').click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
    assert.equal(page.url(), `${base}/archive/${HOSTILE}`, 'the form did not submit');
    assert.deepEqual(await leaks(), []);
    assert.deepEqual(requests.filter(r => !r.endsWith(`/archive/${HOSTILE}`) && !/\/archive\/[0-9a-f]{32}\.mp4(\?t=[0-9a-f]{32})?$/.test(r)), [],
      'the copy made no request of its own');
    assert.ok((await reached()).some(r => r.startsWith(`/archive/${HOSTILE}.mp4`)), 'a copy may play its own saved video');
    // Reaching the server is not enough: the browser must also accept the answer. A copy has an
    // origin of its own (sandbox), so a same-origin-only resource policy on the video blocks it.
    assert.deepEqual(blocked.filter(b => b.includes(`${HOSTILE}.mp4`)), [], 'the browser accepted the copy\'s own video');
    assert.ok(blocked.some(b => b.includes('leak=img') && /csp/i.test(b)), 'the policy, not luck, stopped the remote picture: ' + blocked.join(' | '));
  });

  await check('another website cannot load a saved video (no probing for what is saved)', async () => {
    const plain = await fetch(`${base}/archive/${HOSTILE}.mp4`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('cross-origin-resource-policy'), 'same-origin', 'without the copy\'s token the video stays same-origin');
    const copy = await (await fetch(`${base}/archive/${HOSTILE}`)).text();
    const token = copy.match(new RegExp(`src="${HOSTILE}\\.mp4\\?t=([0-9a-f]{32})"`));
    assert.ok(token, 'the served copy points its video at a tokened address');
    const tokened = await fetch(`${base}/archive/${HOSTILE}.mp4?t=${token[1]}`);
    assert.equal(tokened.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const forged = await fetch(`${base}/archive/${HOSTILE}.mp4?t=${'0'.repeat(32)}`);
    assert.equal(forged.headers.get('cross-origin-resource-policy'), 'same-origin', 'a guessed token does not open it up');
  });

  await check('a link in a copy opens the live site in a normal tab', async () => {
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('#out').click()]);
    await popup.waitForLoadState();
    assert.equal(popup.url(), `${base}/api/stats?popup=1`);
    assert.equal(page.url(), `${base}/archive/${HOSTILE}`, 'the copy itself did not navigate');
    await popup.close();
  });

  await check('inside the app (an iframe) the copy cannot reach the app or run code', async () => {
    requests.length = 0;
    await page.goto(base + '/command');
    await page.evaluate(key => new Promise(done => {
      window.name = 'app-window';
      const frame = document.createElement('iframe');
      frame.id = 'copy'; frame.src = `/archive/${key}`; frame.style.cssText = 'width:900px;height:600px';
      frame.onload = () => done(); document.body.append(frame);
    }), HOSTILE);
    const frame = page.frame({ url: new RegExp(`/archive/${HOSTILE}$`) });
    assert.ok(frame, 'the app can frame its own copy');
    await frame.locator('#styled').waitFor();
    assert.equal(await frame.evaluate(() => typeof window.pwned), 'undefined');
    assert.equal(await frame.evaluate(() => { try { return parent.document.title; } catch { return 'blocked'; } }), 'blocked');
    assert.equal(await frame.evaluate(() => { try { return String(localStorage.length); } catch { return 'blocked'; } }), 'blocked');
    assert.equal(await frame.evaluate(() => fetch('/api/stats').then(() => 'reached', () => 'blocked')), 'blocked');
    await page.waitForTimeout(1500);
    assert.match(await page.title(), /^(?!PWNED)/);
    assert.deepEqual(await leaks(), []);
  });

  await check('another site cannot frame a copy', async () => {
    const outsider = await context.newPage();
    await outsider.goto(`http://localhost:${port}/command`);     // a different origin served by the same app
    await outsider.evaluate(src => new Promise(done => {
      const frame = document.createElement('iframe');
      frame.id = 'copy'; frame.src = src; frame.onload = () => done(); frame.onerror = () => done();
      document.body.append(frame); setTimeout(done, 3000);
    }), `${base}/archive/${HOSTILE}`);
    const inner = outsider.frames().find(f => f !== outsider.mainFrame());
    const text = inner ? await inner.evaluate(() => document.body ? document.body.innerText : '').catch(() => '') : '';
    assert.ok(!text.includes('Planted text'), 'the copy rendered inside a foreign page');
    await outsider.close();
  });

  let key = '';
  await check('saving a page through the app gives a readable, inert copy', async () => {
    requests.length = 0;
    await page.goto(base + '/command');
    const first = await page.evaluate(url => fetch('/api/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }) }).then(async r => ({ status: r.status, body: await r.json() })), 'http://metadata.fixture.test/article');
    assert.equal(first.status, 202, JSON.stringify(first.body));
    key = first.body.key;
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await page.evaluate(k => fetch('/api/archive?keys=' + k).then(r => r.json()), key)).copies[key];
      if (!['queued', 'saving'].includes(state.status)) break;
      await page.waitForTimeout(100);
    }
    assert.equal(state.status, 'saved', JSON.stringify(state));
    assert.equal(state.title, 'Synthetic article');
    assert.equal(state.images, 1);
    await page.goto(`${base}/archive/${key}`);
    assert.equal(await page.title(), 'Synthetic article');
    assert.equal(await page.locator('#headline').innerText(), 'A synthetic headline');
    assert.equal(await page.locator('.lead').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)', 'the site stylesheet was inlined');
    assert.equal(await page.locator('#pic').evaluate(el => el.naturalWidth), 1, 'the picture was inlined');
    assert.equal(await page.locator('script, iframe, form, input, button').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.pwned), 'undefined');
    assert.match(await page.locator('[data-sbm-saved-copy]').innerText(), /Saved copy of .Synthetic article.[\s\S]*Saved on \d+ \w+ \d{4} from\s+http:\/\/metadata\.fixture\.test\/article/);
    assert.deepEqual(await leaks(), []);
    await page.screenshot({ path: join(evidence, 'copy.png') });
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('#more').click()]);
    await popup.waitForFunction(() => document.title === 'live-js');   // the live site is a normal tab: its scripts run
    assert.equal(popup.url(), 'http://metadata.fixture.test/more');
    await popup.close();
  });

  await check('plain view drops the site styling, keeps the content', async () => {
    await page.goto(`${base}/archive/${key}?view=plain`);
    assert.equal(await page.locator('#headline').innerText(), 'A synthetic headline');
    assert.notEqual(await page.locator('.lead').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)');
    assert.equal(await page.locator('#pic').evaluate(el => el.naturalWidth), 1);
    const width = await page.locator('body').evaluate(el => el.getBoundingClientRect().width);
    assert.ok(width <= 750, `reading column is ${width}px wide`);
    await page.screenshot({ path: join(evidence, 'copy-plain.png') });
    assert.ok(await page.locator('[data-sbm-saved-copy]').isVisible());
    await page.goto(`${base}/archive/${key}?banner=0`);
    assert.ok(await page.locator('#headline').isVisible());
    assert.ok(!(await page.locator('[data-sbm-saved-copy]').isVisible()), 'the app can hide the copy\'s own strip');
  });

  await check('deleting the copy removes it from the viewer', async () => {
    await page.goto(base + '/command');
    const gone = await page.evaluate(k => fetch('/api/archive/' + k, { method: 'DELETE' }).then(r => r.json()), key);
    assert.deepEqual(gone, { ok: true, deleted: true });
    assert.equal((await page.goto(`${base}/archive/${key}`)).status(), 404);
  });
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASS', '| evidence:', evidence);
process.exit(failures.length ? 1 : 0);
