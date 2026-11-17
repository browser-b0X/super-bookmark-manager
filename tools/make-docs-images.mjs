// Rebuilds the README's pictures in docs/ from the real app and made-up links: the header banners, the demo GIFs, the
// screenshots and the social preview. Run it after the look changes:
//
//   node tools/make-docs-images.mjs           everything
//   node tools/make-docs-images.mjs banner    only the banners
//   node tools/make-docs-images.mjs demo      only the GIFs
//   node tools/make-docs-images.mjs shots     only the screenshots
//   node tools/make-docs-images.mjs social    only the social preview
//
// It needs what the browser tests need (see frontend/tests/run.mjs), plus ffmpeg on the PATH, and takes the same
// settings: PYTHON or C4_PYTHON, C4_PLAYWRIGHT_MODULE, C4_BROWSER_CHANNEL (msedge where Playwright's Chromium won't
// start), and C4_EXTENSION_CHANNEL (the same, for the browser that loads the extension). Set SBM_DOCS_OUT to write the
// pictures to another folder, to look at them before they replace the ones in docs/.
//
// The app never runs from this folder. It is exported from the commit you are on (git archive reads only git's own
// store) into a temp folder and built there, then run on a free loopback port with every data location in that temp
// folder, so nothing here can read or change a real library, Telegram session or key. Set SBM_DOCS_SRC to reuse an
// export that is already built.
import { execFileSync, execSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY, FEED, feedPage, LINKS, NEW_POST, PICTURES, scenes, SHOT_LINKS, WEBSITE_LINKS } from './docs-sample.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const docs = process.env.SBM_DOCS_OUT || join(root, 'docs');
const require = createRequire(join(root, 'frontend', 'package.json'));
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const python = process.env.PYTHON || process.env.C4_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const channel = process.env.C4_BROWSER_CHANNEL || undefined;

const FPS = 20, VIEW = { width: 1280, height: 800 }, TAGLINE = 'Saved for a reason. Found when it matters.';
const BRAND = {
  dark: { ground: '#1a1a2e', ink: '#f3f1fb', dim: '#b4b1cf', logo: ['#9c8cf2', '#4cc9f0'] },
  light: { ground: '#f1f0fa', ink: '#1b1930', dim: '#585470', logo: ['#6e5bd8', '#2fa4d6'] },
};
// No third-party marks in the pictures: the app's GitHub button and the sites' logos among its icons are hidden, and
// the layout is kept. Site names stay, as text.
const NO_MARKS = '[aria-label="Report a bug or suggest an idea on GitHub"],.lucide-twitter,.lucide-youtube,.lucide-github,.lucide-facebook,.lucide-linkedin{visibility:hidden!important}';

function exportApp(scratch) {
  const src = join(scratch, 'src');
  mkdirSync(src);
  execFileSync('git', ['-C', root, 'archive', '--format=tar', '-o', join(scratch, 'src.tar'), 'HEAD']);
  execFileSync('tar', ['-xf', join('..', 'src.tar')], { cwd: src });
  for (const command of ['npm ci --no-audit --no-fund', 'npm run build']) execSync(command, { cwd: join(src, 'frontend'), stdio: 'inherit' });
  return src;
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// A stand-in for the site the saved copy comes from: the app's own queue fetches the page from the fixture, over the
// fixture's plain socket. Its picture must be drawn before the app starts.
const COPY_SITE = `
class PlainTLS:
    def wrap_socket(self, sock, server_hostname=None, do_handshake_on_connect=True):
        return PlainTLSSocket(sock)
tls_trust.client_context = lambda *args, **kwargs: PlainTLS()
archive.HOST_SPACING = 0.0
site.dns[${JSON.stringify(COPY.host)}] = [PUBLIC_IP]
site.html(${JSON.stringify(COPY.path)}, ${JSON.stringify(COPY.html)})
with open(os.path.join(metadata_fetcher.THUMB_CACHE_DIR, ${JSON.stringify(`docs-${COPY.picture}`)}), "rb") as picture:
    site.routes[${JSON.stringify(COPY.picturePath)}] = (200, {"Content-Type": "image/jpeg"}, picture.read())
`;

// The fence is the one frontend/tests/run.mjs puts round every suite, plus the pictures, LOCALAPPDATA and APPDATA.
// Outgoing HTTP goes to the tests' ControlledHTTP fixture, so nothing can leave the machine.
async function startApp(src, data, copies = false) {
  const port = await freePort();
  const fence = {
    SAVED_POSTS_DB_PATH: join(data, 'library.sqlite'), SBM_TELEGRAM_SESSION_FILE: join(data, 'telegram.session'),
    SBM_AI_CONFIG_FILE: join(data, 'ai.json'), SBM_ARCHIVE_DIR: join(data, 'archive'), SBM_HELPER_DIR: join(data, 'helpers'),
    SUPER_BOOKMARK_MANAGER_DATA_DIR: join(data, 'data'), SBM_THUMB_CACHE_DIR: join(data, 'thumbs'),
    LOCALAPPDATA: join(data, 'localappdata'), APPDATA: join(data, 'appdata'), ...(copies ? {} : { SBM_SAVED_COPIES: 'off' }),
  };
  for (const folder of ['thumbs', 'localappdata', 'appdata']) mkdirSync(join(data, folder), { recursive: true });
  const server = spawn(python, ['-B', '-c', `
import os, sys
for key in list(os.environ):
    if key.endswith("_API_KEY") or key in ("LLM_BASE_URL", "TELEGRAM_API_ID", "TELEGRAM_API_HASH"):
        del os.environ[key]
sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.join("frontend", "tests"))
from metadata_fixture import ControlledHTTP, PUBLIC_IP, PlainTLSSocket
import app, archive, config, metadata_fetcher, storage, tls_trust
for path in (config.DB_PATH, config.TELEGRAM_SESSION_FILE, metadata_fetcher.THUMB_CACHE_DIR, archive.ARCHIVE_DIR):
    assert os.path.abspath(path).startswith(os.path.abspath(${JSON.stringify(data)})), path
site = ControlledHTTP().__enter__()
${copies ? COPY_SITE : ''}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: src, env: { ...process.env, ...fence, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  server.stderr.on('data', chunk => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (server.exitCode !== null || i > 300) throw new Error(`the app did not start: ${log.slice(-800)}`);
    try { if ((await fetch(`${base}/api/stats`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { base, data, stop: () => server.kill() };
}

async function drawPictures(browser, thumbs) {
  mkdirSync(thumbs, { recursive: true });
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  for (const [name, [scene, width, height, options]] of Object.entries(PICTURES)) {
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><body style="margin:0">${scenes[scene](width, height, options)}</body>`);
    await page.screenshot({ path: join(thumbs, `docs-${name}`), type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width, height } });
  }
  await page.close();
}

async function saveLinks(app, now, links = LINKS) {
  const posts = links.map(({ hoursAgo, picture, favorite, useOften, followUpToday, ...link }) => {
    const at = new Date(now - hoursAgo * 3600e3).toISOString();
    return {
      canonicalUrl: link.url, platform: 'web', mediaType: 'article', categoryMode: 'manual', tags: [], projectIds: [],
      createdAt: at, updatedAt: at, metadataStatus: 'enriched', enrichedAt: at, ...link,
      ...(picture ? { thumbnailUrl: `/thumb/docs-${picture}` } : {}),
      ...(favorite ? { favorite: true } : {}), ...(useOften ? { useOften: true } : {}),
      // the local date, as the app counts it, not UTC's
      ...(followUpToday ? { followUpAt: new Date(now - new Date(now).getTimezoneOffset() * 60000).toISOString().slice(0, 10) } : {}),
    };
  });
  const answer = await (await fetch(`${app.base}/api/library`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) })).json();
  if (answer.rejected?.length) throw new Error(`rejected: ${JSON.stringify(answer.rejected)}`);
}

// Every animation stands still and moves only when told to, so each frame is taken at its exact moment. The backdrop's
// shapes stay frozen: the loop then reads cleanly, and only the sorting moves.
function stepAnimations(ms) {
  const ages = (window.docsAges ??= new WeakMap());
  for (const animation of document.getAnimations()) {
    const seen = ages.has(animation);
    if (!seen) animation.pause();
    if (animation.effect?.target?.closest?.('.backdrop')) { if (!seen) animation.currentTime = 4000; ages.set(animation, 0); continue; }
    const age = seen ? ages.get(animation) + ms : 0;
    ages.set(animation, age);
    animation.currentTime = age;
  }
}

// The app's preferences for the theme, in every page of a browser context.
const prefer = (context, theme) => context.addInitScript(state => {
  localStorage.setItem('prefs-store-v1', JSON.stringify({ state, version: 0 }));
  let seed = 7; // the backdrop's stars land in the same places every run
  Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}, { theme, homeLayout: 'wide' });

async function demo(browser, app, theme, now) {
  const context = await browser.newContext({ viewport: VIEW, colorScheme: theme, reducedMotion: 'no-preference', locale: 'en-GB' });
  await prefer(context, theme);
  await context.route('**/*', route => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  const page = await context.newPage();
  const frames = mkdtempSync(join(app.data, 'frames-'));
  const frame = i => join(frames, `${String(i).padStart(4, '0')}.png`);
  await page.clock.install({ time: now });
  await page.goto(app.base);
  await page.addStyleTag({ content: NO_MARKS });
  await page.getByRole('heading', { name: 'New to sort' }).waitFor({ timeout: 90000 });
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0), null, { timeout: 90000 });
  await page.mouse.move(VIEW.width - 4, VIEW.height - 4);
  await page.waitForTimeout(1500);
  await page.clock.pauseAt(now + 120000);
  await page.evaluate(stepAnimations, 0);

  // The real buttons: the pointer rests on one so it lights up, then presses it. The card goes the way the button points.
  const button = name => page.getByRole('button', { name: new RegExp(`^${name}:`) });
  const press = (at, name) => ({
    [at]: async () => { const box = await button(name).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); },
    [at + 3]: () => page.mouse.down(),
    [at + 4]: () => page.mouse.up(),
  });
  const REST = Math.round(0.4 * FPS), EACH = 20;
  const hands = { ...press(REST, 'Keep'), ...press(REST + EACH, 'Later'), ...press(REST + 2 * EACH, 'Archive') };
  const total = REST + 3 * EACH + 4;
  await page.screenshot({ path: frame(0) });
  for (let i = 1; i < REST; i++) copyFileSync(frame(0), frame(i));
  for (let i = REST; i < total; i++) {
    await hands[i]?.();
    await page.clock.runFor(1000 / FPS);
    await page.evaluate(() => new Promise(done => { const hop = new MessageChannel(); hop.port1.onmessage = done; hop.port2.postMessage(0); }));
    await page.evaluate(stepAnimations, 1000 / FPS);
    await page.screenshot({ path: frame(i) });
  }
  await context.close();
  const out = join(docs, `demo-${theme}.gif`);
  // A palette from every frame, not only what changes: the link pictures hold still, and would turn the wrong colours.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', join(frames, '%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=160:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', out]);
  rmSync(frames, { recursive: true, force: true });
}

const figtree = (src, weight) => `@font-face{font-family:Figtree;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(join(src, 'frontend', 'public', 'fonts', `figtree-latin-${weight}-normal.woff2`)).toString('base64')})}`;
const jar = (src, from, to) => readFileSync(join(src, 'frontend', 'public', 'brand-logo.svg'), 'utf8').replace('#7c6cff', from).replace('#38b6e8', to);

function bannerPage(src, { ground, ink, dim, logo: [from, to] }) {
  return `<!doctype html><meta charset="utf-8"><style>${figtree(src, 500)}${figtree(src, 700)}
html,body{margin:0;height:100%;background:transparent}
.card{box-sizing:border-box;height:100%;border-radius:20px;background:${ground};display:flex;align-items:center;justify-content:center;gap:40px;font-family:Figtree}
.card svg{width:148px;height:148px}
h1{margin:0;color:${ink};font-size:92px;line-height:1;font-weight:700;letter-spacing:-.025em}
h1 span{background:linear-gradient(100deg,${from},${to});-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin:12px 0 0;color:${dim};font-size:29px;font-weight:500}
</style><div class="card">${jar(src, from, to)}<div><h1>Super<span>Bookmarks</span></h1><p>${TAGLINE}</p></div></div>`;
}

async function banners(browser, src) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 300 }, deviceScaleFactor: 2 });
  for (const [theme, colours] of Object.entries(BRAND)) {
    await page.setContent(bannerPage(src, colours));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(docs, `banner-${theme}.png`), omitBackground: true });
  }
  await page.close();
}

// The screenshots' sizes: docs/index.html says the same.
const SHOT_WIDTH = 1440;
const SHOT_SIZES = { home: 1064, library: 820, 'saved-copy': 900, 'by-website': 730, 'save-posts': 730, creators: 730, search: 730, cleanup: 730 };
const SAVE_WINDOW = { width: 480, height: 640 }; // what the extension asks for
const stored = async app => (await fetch(`${app.base}/api/library`)).json();
const until = async (what, test, ms = 45000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 200))) {
    const value = await test();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const open = async (page, app, path, name) => {
  await page.setViewportSize({ width: SHOT_WIDTH, height: SHOT_SIZES[name] });
  await page.goto(app.base + path);
  await page.addStyleTag({ content: NO_MARKS });
  await page.mouse.move(SHOT_WIDTH - 4, SHOT_SIZES[name] - 4);
};

// Taken at twice the size and scaled down, so small text stays clean. The PNG stays in the app's temp folder; with
// keep = false that's all (Home for the social preview alone, the Save window before it is framed).
async function still(page, app, name, theme, keep = true) {
  // Only the pictures in view: a lazy one further along a shelf row never loads.
  await page.waitForFunction(() => [...document.images].filter(image => { const box = image.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth; })
    .every(image => image.complete && image.naturalWidth > 0), null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.save-toast.is-visible'), null, { timeout: 30000 }); // the "Saved" note goes
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  const png = join(app.data, `${name}.png`);
  await page.screenshot({ path: png, animations: 'disabled' });
  if (keep) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-vf', `scale=${SHOT_WIDTH}:-1:flags=lanczos`,
    '-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', join(docs, 'screenshots', `${name}-${theme}.webp`)]);
}

async function screens(browser, src, app, theme, now, everything) {
  const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'no-preference', locale: 'en-GB' });
  await prefer(context, theme);
  await context.route('**/*', route => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  const page = await context.newPage();
  const take = name => still(page, app, name, theme);
  const tile = name => page.locator('article.tile', { hasText: name });

  await open(page, app, '/', 'home');
  await page.getByRole('heading', { name: 'New to sort' }).waitFor({ timeout: 90000 });
  await still(page, app, 'home', theme, everything);
  if (!everything) return context.close();

  await open(page, app, '/library', 'library');
  await tile('How to shape a boule').waitFor();
  await page.waitForTimeout(1000); // the tiles settle
  const box = await tile('How to shape a boule').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3); // the pointer alone: a locator's hover may scroll the page
  await take('library');

  await saveLinks(app, now, WEBSITE_LINKS);
  await open(page, app, '/library/category/technology', 'by-website');
  await page.getByRole('button', { name: 'By website', exact: true }).click();
  await page.locator('.site-groups section.site-group').first().waitFor();
  await take('by-website');

  await open(page, app, '/library', 'search');
  await page.locator('input[placeholder="Search… ( / )"]').fill('(#bread or #rye) -sourdough saved:30d');
  await page.getByLabel('How the search is read').waitFor();
  await take('search');

  // Who made the posts, as the owner finds them; then a post arrives after the owner last looked at its creator.
  await open(page, app, '/creators', 'creators');
  await page.getByRole('button', { name: 'Find creators in your saved posts' }).click();
  await page.getByRole('dialog', { name: 'Creators in your saved posts' }).getByRole('button', { name: /^Add \d+ creators/ }).click();
  const kit = await until('the creators', async () => (await stored(app)).docs?.creators?.find(creator => creator.name === 'Bakehouse Kit'));
  await page.goto(`${app.base}/creators/${kit.id}`);
  await page.waitForTimeout(3500); // a visit counts after a second and a half
  await saveLinks(app, Date.now() + 1000, [{ ...NEW_POST, creatorId: kit.id }]);
  await open(page, app, '/creators', 'creators');
  await page.getByText('+1 new since you looked').waitFor();
  await take('creators');

  // A link removed, then a bulk edit, so the edit comes first in History.
  await open(page, app, '/library/item/rye-crackers', 'cleanup');
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await until('the removal', async () => (await stored(app)).docs?.removed?.some(record => record.post.id === 'rye-crackers'));
  await open(page, app, '/library', 'cleanup');
  for (const name of ['Cabin rentals to compare', 'Ferry times for the islands']) await tile(name).getByRole('checkbox', { name: 'Select post' }).check();
  await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Edit…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit 2 links' });
  await edit.getByLabel('Tag to add to the list').fill('autumn');
  await edit.getByLabel('Tag to add to the list').press('Enter');
  await edit.getByRole('button', { name: 'Apply to 2 links' }).click();
  await until('the bulk edit', async () => (await stored(app)).posts.find(post => post.id === 'ferry')?.tags.includes('autumn'));
  await page.waitForTimeout(1500); // History is kept in this browser
  await open(page, app, '/library/settings', 'cleanup');
  await page.getByRole('region', { name: 'History' }).getByText('Bulk edit: added #autumn').waitFor();
  await page.locator('#cleanup').evaluate(section => section.scrollIntoView({ block: 'start' }));
  await page.mouse.wheel(0, 16); // History's first row comes fully into view
  await page.waitForTimeout(300);
  await take('cleanup');

  // The app's own queue saves the copy; it is then read in the app's reader.
  await saveLinks(app, now, [{ ...LINKS.find(link => link.id === COPY.link), followUpToday: true, archiveStatus: 'pending', updatedAt: new Date().toISOString() }]);
  await open(page, app, `/library/item/${COPY.link}`, 'saved-copy');
  await until('the saved copy', async () => (await stored(app)).posts.find(post => post.id === COPY.link)?.archiveStatus === 'saved');
  await open(page, app, `/library/item/${COPY.link}`, 'saved-copy');
  await page.getByRole('button', { name: 'Read saved copy' }).click();
  await page.getByLabel('Saved copy reader').getByText('opens without the internet', { exact: false }).first().waitFor();
  await page.mouse.move(SHOT_WIDTH - 4, SHOT_SIZES['saved-copy'] - 4);
  await take('saved-copy');
  await context.close();

  await savePosts(browser, src, app, theme, now);
}

// The Save window as the extension opens it: the extension itself, in a throwaway profile, reads the made-up X search
// in a tab and hands the posts to the app's window. Only the toolbar click is played by a call, as a test can't make it.
// The window is a small one of its own, so it goes on the theme's ground to fill the picture.
async function savePosts(browser, src, app, theme, now) {
  await saveLinks(app, now, [FEED.saved]);
  const extension = join(app.data, 'extension');
  cpSync(join(src, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
  // In real use the click grants the tab; a test has to allow the site up front, as extension-e2e.mjs does.
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: [...manifest.host_permissions, ...manifest.optional_host_permissions] }));
  const context = await chromium.launchPersistentContext(join(app.data, 'profile'), {
    channel: process.env.C4_EXTENSION_CHANNEL || 'chromium', headless: true, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-GB',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await prefer(context, theme);
    await context.route('**/*', route => {
      const { hostname, protocol } = new URL(route.request().url());
      if (route.request().url() === FEED.url) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: feedPage(now) });
      return hostname === '127.0.0.1' || protocol === 'chrome-extension:' ? route.continue() : route.abort();
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const post = (path, headers, body) => fetch(app.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const { code } = (await (await post('/api/extension/code', { 'Sec-Fetch-Site': 'same-origin' }, {})).json()).code;
    const paired = await (await post('/api/extension/pair', { Origin: `chrome-extension://${id}` }, { code, browser: 'Edge' })).json();
    await worker.evaluate(settings => chrome.storage.local.set(settings), { app: app.base, token: paired.token, connId: paired.id });

    const feed = await context.newPage();
    await feed.goto(FEED.url);
    const [page] = await Promise.all([context.waitForEvent('page'), worker.evaluate(async ({ url, title }) => {
      const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
      await sbm.saveFromTab({ id: tab.id, url, title });
    }, { url: FEED.url, title: FEED.title })]);
    await page.setViewportSize(SAVE_WINDOW);
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForLoadState();
    await page.addStyleTag({ content: NO_MARKS });
    await page.getByRole('tab', { name: `Posts on this page (${FEED.posts.length})`, selected: true }).waitFor({ timeout: 20000 });
    const list = page.getByLabel('Posts on this page');
    await list.getByText('✓ Already saved').waitFor();
    for (const name of FEED.ticked) await list.getByRole('checkbox', { name: new RegExp(name) }).check();
    await page.getByLabel('Tags').fill(FEED.tags);
    await page.getByRole('button', { name: `Save ${FEED.ticked.length} posts` }).waitFor();
    await still(page, app, 'save-window', theme, false);
  } finally {
    await context.close();
  }
  const frame = await browser.newPage({ viewport: { width: SHOT_WIDTH, height: SHOT_SIZES['save-posts'] }, deviceScaleFactor: 2 });
  const [from, to] = BRAND[theme].logo;
  await frame.setContent(`<!doctype html><style>html,body{margin:0;height:100%}
body{display:flex;align-items:center;justify-content:center;background:radial-gradient(45% 70% at 28% 40%,${from}30,transparent),radial-gradient(40% 65% at 74% 62%,${to}26,transparent),${BRAND[theme].ground}}
img{width:${SAVE_WINDOW.width}px;border-radius:14px;box-shadow:0 22px 60px #0b08264d;outline:1px solid #8886a838}
</style><img alt="" src="data:image/png;base64,${readFileSync(join(app.data, 'save-window.png')).toString('base64')}">`);
  await still(frame, app, 'save-posts', theme);
  await frame.close();
}

// Logo, name and the README's bold opening on the left; Home, from the real app, cropped on the right. GitHub takes up
// to 1 MB: ffmpeg's strongest PNG settings get there without a palette, whose dither shows when the picture is scaled.
async function socialPreview(browser, src, data) {
  const { ground, ink, dim, logo: [from, to] } = BRAND.dark;
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${figtree(src, 500)}${figtree(src, 700)}
html,body{margin:0;width:1280px;height:640px;overflow:hidden;background:linear-gradient(120deg,#26224a,${ground} 60%);font-family:Figtree;-webkit-font-smoothing:antialiased}
.text{position:absolute;left:64px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center}
.text svg{width:96px;height:96px;margin-left:-8px}
h1{margin:14px 0 0;color:${ink};font-size:62px;line-height:1.05;font-weight:700;letter-spacing:-.025em}
h1 span{background:linear-gradient(100deg,${from},${to});-webkit-background-clip:text;background-clip:text;color:transparent}
.bold{margin:22px 0 0;color:${ink};font-size:31px;line-height:1.22;font-weight:700;letter-spacing:-.01em}
.rest{margin:14px 0 0;color:${dim};font-size:22px;line-height:1.36;font-weight:500}
img{position:absolute;left:610px;top:46px;width:940px;border-radius:18px;transform:perspective(2200px) rotateY(-11deg) rotateZ(-2.5deg);box-shadow:0 30px 70px rgba(0,0,0,.5);outline:1px solid rgba(255,255,255,.12)}
</style><div class="text">${jar(src, from, to)}<h1>Super<span>Bookmarks</span></h1>
<p class="bold">One library for every link you've saved, on your own PC.</p><p class="rest">Pages are copied as they come in, so a link still opens after the site is gone.</p></div>
<img alt="" src="data:image/png;base64,${readFileSync(join(data, 'home.png')).toString('base64')}">`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: join(data, 'social.png') });
  await page.close();
  const out = join(docs, 'assets', 'social-preview.png');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(data, 'social.png'), '-compression_level', '9', '-pred', 'mixed', out]);
  if (statSync(out).size >= 1e6) throw new Error('the social preview is over 1 MB');
}

const wanted = process.argv.slice(2);
if (wanted.some(job => !['banner', 'demo', 'shots', 'social'].includes(job))) throw new Error('Usage: node tools/make-docs-images.mjs [banner] [demo] [shots] [social]');
const job = name => !wanted.length || wanted.includes(name);
const scratch = mkdtempSync(join(tmpdir(), 'sbm-docs-'));
const browser = await chromium.launch({ headless: true, channel });
try {
  for (const folder of ['screenshots', 'assets']) mkdirSync(join(docs, folder), { recursive: true });
  const src = process.env.SBM_DOCS_SRC || exportApp(scratch);
  if (job('banner')) await banners(browser, src);
  if (job('demo')) {
    const now = Date.now();
    // A fresh library for each theme: links sorted in the first run are gone from New to sort in the second.
    for (const theme of Object.keys(BRAND)) {
      const app = await startApp(src, join(scratch, theme));
      try {
        await drawPictures(browser, join(app.data, 'thumbs'));
        await saveLinks(app, now);
        await demo(browser, app, theme, now);
      } finally {
        app.stop();
      }
    }
  }
  if (job('shots') || job('social')) {
    const now = Date.now();
    for (const theme of job('shots') ? Object.keys(BRAND) : ['dark']) {
      const data = join(scratch, `shots-${theme}`);
      await drawPictures(browser, join(data, 'thumbs'));
      const app = await startApp(src, data, true);
      try {
        await saveLinks(app, now, [...LINKS, ...SHOT_LINKS]);
        await screens(browser, src, app, theme, now, job('shots'));
      } finally {
        app.stop();
      }
    }
    if (job('social')) await socialPreview(browser, src, join(scratch, 'shots-dark'));
  }
} finally {
  await browser.close();
  await new Promise(resolve => setTimeout(resolve, 500));
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const shotFiles = Object.keys(SHOT_SIZES).flatMap(name => Object.keys(BRAND).map(theme => `screenshots/${name}-${theme}.webp`));
for (const file of ['banner-dark.png', 'banner-light.png', 'demo-dark.gif', 'demo-light.gif', ...shotFiles, 'assets/social-preview.png']) {
  try { console.log(file, `${Math.round(statSync(join(docs, file)).size / 1024)} KB`); } catch {}
}
