// Firefox pass (v0.4.0 phase 4), a manual check, not in run.mjs: the system Firefox on a throwaway profile, the
// add-on (built by extension/build.py) installed temporarily over WebDriver BiDi (unsigned is fine for a temporary
// add-on; signing for normal installs is the owner's step), the stand-in sites served over local HTTPS with a
// throwaway certificate (Firefox maps their names to 127.0.0.1), the app on 127.0.0.1 with synthetic data. Nothing
// real is contacted, and the owner's own Firefox profile is never used. The add-on's copy gets a test-only bridge
// (firefox/bridge-*.js): BiDi can't open the add-on's own pages or click its toolbar button.
// Needs Firefox (C:\Program Files\Mozilla Firefox), openssl on PATH (Git for Windows has one) and port 443 free on
// 127.0.0.1. Run from frontend/: node tests/firefox-pass.mjs (C4_PYTHON)
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, evaluate } from './firefox/bidi.mjs';
import { pairExtension } from './post-pages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'firefox-pass-'));
const pages = await import(pathToFileURL(join(root, 'frontend', 'tests', 'post-pages.mjs')).href);
const results = [];
const step = async (name, run) => {
  try { const detail = await run(); results.push(['PASS', name, detail ?? '']); console.log('PASS', name, detail ?? ''); }
  catch (error) { results.push(['FAIL', name, error.message]); console.log('FAIL', name, '|', error.message.split('\n').slice(0, 4).join(' | ')); }
};

// ── The stand-in sites over HTTPS ──
const work = await mkdtemp(join(tmpdir(), 'sbm-ffpass-'));
const hosts = ['x.com', 'twitter.com', 'www.instagram.com', 'www.tiktok.com', 'pbs.twimg.com', 'scontent.cdninstagram.com', 'p16-sign-va.tiktokcdn.com', 'walks.example.invalid'];
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'), '-days', '2',
  '-subj', '/CN=SuperBookmarks stand-ins', '-addext', `subjectAltName=${hosts.map(h => `DNS:${h}`).join(',')}`], { stdio: 'ignore' });
const standIns = createServer({ key: await readFile(join(work, 'key.pem')), cert: await readFile(join(work, 'cert.pem')) }, (req, res) => {
  const url = `https://${(req.headers.host || '').replace(/:443$/, '')}${req.url}`;
  if (/^https:\/\/(pbs\.twimg\.com|scontent\.cdninstagram\.com|p16-sign-va\.tiktokcdn\.com)\//.test(url)) {
    const video = url.split('?')[0].endsWith('.mp4');
    res.writeHead(200, { 'Content-Type': video ? 'video/mp4' : 'image/png', 'Access-Control-Allow-Origin': '*' });
    res.end(video ? pages.MP4 : pages.PICTURE);
    return;
  }
  if (url.startsWith('https://walks.example.invalid/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Ten walks</title><p>Walks</p>'); return; }
  const body = pages.PAGES[url];
  res.writeHead(body ? 200 : 404, { 'Content-Type': body ? 'text/html; charset=utf-8' : 'text/plain' });
  res.end(body ?? 'not a stand-in page');
});
await new Promise((resolve, reject) => { standIns.once('error', reject); standIns.listen(443, '127.0.0.1', resolve); });

// ── The app, synthetic data, copies on, nothing leaving the machine ──
const port = 26000 + Math.floor(Math.random() * 9000);
const base = `http://127.0.0.1:${port}`;
const startApp = () => spawn(process.env.C4_PYTHON, ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, os.path.join(${JSON.stringify(root)}, "frontend", "tests"))
d = ${JSON.stringify(work)}
os.environ.update(SAVED_POSTS_DB_PATH=os.path.join(d, "lib.sqlite"), SBM_AI_CONFIG_FILE=os.path.join(d, "ai.json"),
  SBM_ARCHIVE_DIR=os.path.join(d, "archive"), SBM_THUMB_CACHE_DIR=os.path.join(d, "thumbs"),
  SBM_TELEGRAM_SESSION_FILE=os.path.join(d, "tg.session"), SBM_HELPER_DIR=os.path.join(d, "helpers"),
  SUPER_BOOKMARK_MANAGER_DATA_DIR=os.path.join(d, "data"))
from metadata_fixture import ControlledHTTP
import storage, app, metadata_fetcher, archive
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
archive._picture = lambda url, deadline: ("", "unavailable")
site = ControlledHTTP().__enter__()
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let appServer = startApp();
const appUp = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/stats')).ok) return; } catch {} await new Promise(r => setTimeout(r, 200)); } throw new Error('app did not start'); };
await appUp();

// ── The add-on: the Firefox build, with the three sites allowed (a test can't click the toolbar for activeTab) ──
execFileSync(process.env.C4_PYTHON, [join(root, 'extension', 'build.py')], { cwd: root, stdio: 'ignore' });
const addon = join(work, 'addon');
await mkdir(addon);
execFileSync(process.env.C4_PYTHON, ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
  join(root, 'dist-extension', 'SuperBookmarks-extension-firefox.zip'), addon]);
const manifest = JSON.parse(await readFile(join(addon, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions, 'https://walks.example.invalid/*'];
// Test-only bridge: a control page the harness drives (BiDi can't open the add-on's own pages).
const here = new URL('./firefox/', import.meta.url);
await cp(new URL('bridge-background.js', here), join(addon, 'bridge-background.js'));
await cp(new URL('bridge-content.js', here), join(addon, 'bridge-content.js'));
manifest.background.scripts.push('bridge-background.js');
manifest.permissions.push('tabs');                // only so the bridge can see the add-on's own windows
manifest.content_scripts = [{ matches: ['https://walks.example.invalid/ffpass*'], js: ['bridge-content.js'] }];
await writeFile(join(addon, 'manifest.json'), JSON.stringify(manifest, null, 2));
const ID = manifest.browser_specific_settings.gecko.id;
const UUID = '5bd1b4a3-6c2e-4e7a-9a51-3f0d2b8c7e11';

const firefox = await launch({
  'network.dns.localDomains': hosts.join(','),
  'extensions.webextensions.uuids': JSON.stringify({ [ID]: UUID }),
  'extensions.originControls.grantByDefault': true,
  // Keep Firefox to itself while it runs.
  'browser.safebrowsing.malware.enabled': false, 'browser.safebrowsing.phishing.enabled': false,
  'browser.safebrowsing.downloads.enabled': false, 'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
  'app.normandy.enabled': false, 'toolkit.telemetry.enabled': false, 'datareporting.healthreport.uploadEnabled': false,
  'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false,
  'browser.newtabpage.enabled': false, 'browser.startup.page': 0, 'services.settings.server': 'http://127.0.0.1:9/',
});
const contexts = new Map();
firefox.on(message => {
  if (message.method === 'browsingContext.contextCreated' && !message.params.parent) contexts.set(message.params.context, message.params.url);
});
await firefox.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
await firefox.send('session.subscribe', { events: ['browsingContext.contextCreated'] });

const tree = async () => (await firefox.send('browsingContext.getTree', {})).contexts;
const open = async url => {
  const { context } = await firefox.send('browsingContext.create', { type: 'tab' });
  await firefox.send('browsingContext.navigate', { context, url, wait: 'complete' });
  return context;
};
const waitFor = async (context, expression, timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await evaluate(firefox, context, expression).catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${expression.slice(0, 80)}`);
    await new Promise(r => setTimeout(r, 300));
  }
};
/** A context that appears after `before` (a window the extension opened). */
const newContext = async (before, timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const fresh = (await tree()).find(c => !before.includes(c.context));
    if (fresh) return fresh.context;
    if (Date.now() > end) throw new Error('no new window');
    await new Promise(r => setTimeout(r, 300));
  }
};
const text = context => evaluate(firefox, context, 'document.body ? document.body.innerText : ""');

try {
  await step('the add-on installs temporarily (no signature needed for that)', async () => {
    const answer = await firefox.send('webExtension.install', { extensionData: { type: 'path', path: addon } });
    return answer.extension;
  });

  const control = await open('https://walks.example.invalid/ffpass');
  let next = 0;
  const cmd = async (name, extra = {}) => {
    const id = ++next;
    const raw = await evaluate(firefox, control, `new Promise(resolve => {
      const on = e => { if (e.data && e.data.ffpassResult === ${id}) { removeEventListener('message', on); resolve(e.data.result); } };
      addEventListener('message', on);
      window.postMessage({ id: ${id}, ffpassCmd: ${JSON.stringify(name)}, ...${JSON.stringify(extra)} }, '*');
      setTimeout(() => resolve(JSON.stringify({ error: 'no answer' })), 60000);
    })`);
    const value = JSON.parse(raw);
    if (value && value.error) throw new Error(`${name}: ${value.error}`);
    return value;
  };

  await step('paired with the app; the app proves itself to the add-on (its real address in the proof)', async () => {
    const code = (await (await fetch(base + '/api/extension/code', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' })).json()).code.code;
    const pair = await pairExtension(base, `moz-extension://${UUID}`, code, 'Firefox');
    if (!pair.token) throw new Error(JSON.stringify(pair));
    await cmd('set', { value: { app: base, token: pair.token, connId: pair.id } });
    const proof = await cmd('checkApp');
    if (proof !== 'ok') throw new Error(`proof: ${proof}`);
    return proof;
  });

  /** The add-on's own windows (BiDi shows them as about:blank and can't read them). */
  const ownWindow = async (prefix, timeout = 15000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const found = (await cmd('extensionTabs')).find(url => url.startsWith(`moz-extension://${UUID}/${prefix}`));
      if (found) return found;
      if (Date.now() > end) throw new Error(`no ${prefix} window`);
      await new Promise(r => setTimeout(r, 300));
    }
  };

  await step('the options page opens (its contents can only be checked by hand)', async () => {
    await cmd('openOptions');
    return ownWindow('options.html');
  });

  await step('a content script can read a picture server\'s file (what media.js does)', async () => {
    const steps = await cmd('contentFetch', { url: 'https://scontent.cdninstagram.com/v/probe.mp4' });
    if (!steps.some(s => s.startsWith('blob '))) throw new Error(steps.join(' | '));
    return steps.join(' | ');
  });

  const toolbar = async url => {
    const tab = await open(url);
    const before = (await tree()).map(c => c.context);
    await cmd('saveFromTab', { url });
    const win = await newContext([...before]);
    return { tab, win };
  };

  await step('a file made in a content script reaches the page as a file (what handover.js does)', async () => {
    await evaluate(firefox, control, `(window.__got = null, addEventListener('message', e => { if (e.data && e.data.type === 'probe-blob')
      window.__got = { isBlob: e.data.blob instanceof Blob, size: e.data.blob && e.data.blob.size, kind: Object.prototype.toString.call(e.data.blob) }; }), true)`);
    await cmd('postBlob');
    const got = await waitFor(control, 'window.__got && JSON.stringify(window.__got)', 5000);
    if (!JSON.parse(got).isBlob) throw new Error(got);
    return got;
  });

  await step('the toolbar button on an X search page: the Save window lists its posts', async () => {
    const { win } = await toolbar(pages.X_FEED_URL);
    const body = await waitFor(win, `document.body && document.body.innerText.includes('Posts on this page (4)') && document.body.innerText`);
    return body.split('\n').slice(0, 3).join(' | ');
  });

  await step('a Download button on each post once X is switched on', async () => {
    await cmd('set', { value: { marks: { x: true, instagram: false, tiktok: false } } });
    await cmd('syncMarks');
    const registered = await cmd('registered');
    if (!registered.includes('marks-x')) throw new Error(`registered: ${JSON.stringify(registered)}`);
    const feed = await open(pages.X_FEED_URL);
    const count = await waitFor(feed, `document.querySelectorAll('[data-sbm-mark]').length`);
    if (count !== 5) throw new Error(`buttons: ${count}`);
    return `${count} buttons`;
  });

  await step('an Instagram reel: the video comes from the tab and the copy keeps it', async () => {
    const { win } = await toolbar(pages.IG_REEL_URL);
    await waitFor(win, `document.body && document.body.innerText.includes('the video (0.3 MB)')`)
      .catch(async error => {
        const probe = await cmd('mediaProbe', { url: pages.IG_REEL_URL, value: [
          { url: 'https://scontent.cdninstagram.com/v/reel55_cover.jpg', kind: 'picture' }, { url: 'https://scontent.cdninstagram.com/v/reel55.mp4', kind: 'video' }] }).catch(e => String(e));
        const log = await cmd('transferLog').catch(e => String(e));
        throw new Error(`${error.message} | transfer: ${JSON.stringify(log).slice(0, 900)} | probe: ${JSON.stringify(probe).slice(0, 300)}`);
      });
    await evaluate(firefox, win, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click(), true`);
    await waitFor(win, `document.body && document.body.innerText.includes('Saved')`, 45000).catch(() => {});
    const posts = (await (await fetch(base + '/api/library')).json()).posts;
    const post = posts.find(p => p.url === 'https://www.instagram.com/reel/CreelOwn55/');
    const state = (await (await fetch(`${base}/api/archive?keys=${post.archiveKey}`)).json()).copies[post.archiveKey];
    if (!state.video) throw new Error(JSON.stringify(state));
    return 'copy with video';
  });

  await step('the app not running: the post is kept and the button counts it; running again, the Save window hands it over', async () => {
    appServer.kill();
    await new Promise(r => setTimeout(r, 800));
    await toolbar(pages.IG_KEPT_URL);
    const kept = await ownWindow('kept.html#kept=');
    const [badge, title] = await cmd('badge');
    if (badge !== '1') throw new Error(`badge ${badge} ${title}`);
    appServer = startApp();
    await appUp();
    const again = await toolbar('https://walks.example.invalid/other');
    await waitFor(again.win, `document.body && document.body.innerText.includes('Waiting (1)')`);
    await evaluate(firefox, again.win, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save 1').click(), true`);
    await waitFor(again.win, `document.body && document.body.innerText.includes('Saved 1 kept one')`, 45000);
    return decodeURIComponent(kept.split('#kept=')[1].split('&why=')[0]);
  });
} finally {
  await firefox.close().catch(() => {});
  appServer.kill();
  standIns.close();
  await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 1));
}
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(failed ? `FAILED ${failed} | evidence: ${evidence}` : `ALL PASS | evidence: ${evidence}`);
process.exit(failed ? 1 : 0);
