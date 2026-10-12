// Saving X and TikTok posts, end to end in the real app, and the optional
// TikTok video helper in Settings. Synthetic data only: X's embed address,
// TikTok's oEmbed address, their media hosts and yt-dlp's release address
// all point at an owned loopback server, and the "helper" is a small script
// that behaves like yt-dlp. Nothing leaves this machine.
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
const evidence = await mkdtemp(join(root, '.verify', 'social-posts-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const X_URL = 'https://x.com/fixture_user/status/1800000000000000001';
const X_GONE = 'https://x.com/fixture_user/status/1800000000000000009';
const TT_URL = 'https://www.tiktok.com/@kitchen.notes/video/7551234567890123456';

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import base64, hashlib, json, os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_HELPER_DIR"] = ${JSON.stringify(join(evidence, 'helpers'))}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
from metadata_fixture import ControlledHTTP, BASE_URL, JPEG
import storage, app, archive, metadata_fetcher, x_post, tiktok_post, video_helper
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
CDN = "http://cdn.fixture.test"
archive.HOST_SPACING = archive.X_SPACING = 0.0
x_post.SYNDICATION = BASE_URL + "/tweet-result"
x_post._MEDIA_HOSTS = frozenset({"cdn.fixture.test"}); x_post._MEDIA_SCHEMES = ("http", "https")
tiktok_post.OEMBED = BASE_URL + "/oembed?url="
tiktok_post._PICTURE_SUFFIXES = (".fixture.test",); tiktok_post._PICTURE_SCHEMES = ("http", "https")
video_helper.RELEASE = BASE_URL + "/rel/"
site = ControlledHTTP().__enter__()
MP4 = b"\\x00\\x00\\x00\\x18ftypisom" + b"synthetic-mp4" * 300
helper = ("#!" + sys.executable + "\\nimport sys\\nargs = sys.argv[1:]\\n"
          "if args == ['--version']:\\n    print('2026.08.19'); sys.exit(0)\\n"
          "open(args[args.index('-o') + 1].replace('%(ext)s', 'mp4'), 'wb').write(" + repr(MP4) + ")\\n").encode()
site.routes["/rel/SHA2-256SUMS"] = (200, {"Content-Type": "text/plain"}, (hashlib.sha256(helper).hexdigest() + "  " + video_helper.ASSET + "\\n").encode())
site.routes["/rel/" + video_helper.ASSET] = (200, {"Content-Type": "application/octet-stream"}, helper)
for path in ("/media/one?format=jpg&name=large", "/ext_tw_video_thumb/9/poster?format=jpg&name=large", "/obj/cover.jpeg"):
    site.routes[path] = (200, {"Content-Type": "image/jpeg"}, JPEG)
site.routes["/vid/720.mp4"] = (200, {"Content-Type": "video/mp4"}, MP4)
embed = {"__typename": "Tweet", "id_str": "1800000000000000001", "created_at": "2026-10-01T14:05:09.000Z",
         "text": "A synthetic post with a photo and a clip", "user": {"name": "Fixture User", "screen_name": "fixture_user"},
         "mediaDetails": [{"type": "photo", "media_url_https": CDN + "/media/one.jpg"},
                          {"type": "video", "media_url_https": CDN + "/ext_tw_video_thumb/9/poster.jpg",
                           "video_info": {"variants": [{"content_type": "video/mp4", "bitrate": 832000, "url": CDN + "/vid/720.mp4"}]}}]}
site.routes[x_post.data_url("1800000000000000001")[len(BASE_URL):]] = (200, {"Content-Type": "application/json"}, json.dumps(embed).encode())
site.routes[x_post.data_url("1800000000000000009")[len(BASE_URL):]] = (404, {"Content-Type": "application/json"}, b"")
oembed = {"title": "Overnight focaccia, the lazy way #bread", "author_name": "Kitchen Notes",
          "author_url": "https://www.tiktok.com/@kitchen.notes", "thumbnail_url": CDN + "/obj/cover.jpeg"}
site.routes[tiktok_post.data_url(${JSON.stringify(TT_URL)})[len(BASE_URL):]] = (200, {"Content-Type": "application/json"}, json.dumps(oembed).encode())
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', chunk => { serverLog += chunk; });

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const api = async (path, init) => (await fetch(base + path, init)).json();
  const linkByUrl = async url => (await api('/api/library')).posts.find(p => p.url === url);
  const until = async (what, test, ms = 20000) => {
    const end = Date.now() + ms; let last;
    while (Date.now() < end) { last = await test(); if (last) return last; await new Promise(r => setTimeout(r, 150)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const addLink = async url => {
    await page.goto(base + '/library');
    await page.getByRole('button', { name: 'Add link', exact: true }).first().click();
    await page.getByRole('dialog', { name: 'Add link' }).getByRole('textbox').fill(url);
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
  };
  const panel = async url => {
    const link = await linkByUrl(url);
    await page.goto(`${base}/library/item/${encodeURIComponent(link.id)}`);
    await page.getByRole('dialog', { name: 'Saved post detail' }).waitFor();
    return page.locator('section[aria-label="Saved copy"]');
  };
  await page.goto(base + '/library');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();

  await check('an X post is saved with its photo and video and reads in the app', async () => {
    await addLink(X_URL);
    const saved = await until('the X copy', async () => { const p = await linkByUrl(X_URL); return p?.archiveStatus === 'saved' && p; });
    assert.equal(saved.archiveNoVideo, undefined);
    const section = await panel(X_URL);
    await section.getByText('Saved copy', { exact: true }).waitFor();
    await section.getByRole('button', { name: 'Read saved copy' }).click();
    const frame = page.frameLocator('iframe.copy-reader__frame');
    await frame.locator('article.post').waitFor({ state: 'attached' });
    assert.equal(await frame.locator('img[alt="Photo 1"]').count(), 1);
    assert.equal(await frame.locator(`video[src^="${saved.archiveKey}.mp4?t="]`).count(), 1);
  });

  await check('a post X will not share says so, and the link is kept', async () => {
    await addLink(X_GONE);
    await until('the failure', async () => (await linkByUrl(X_GONE))?.archiveStatus === 'failed');
    const section = await panel(X_GONE);
    await section.getByText(/The site won't share this post: it was deleted, its account is private/).waitFor();
  });

  await check('a TikTok post without the helper keeps caption and cover, and points to Settings', async () => {
    await addLink(TT_URL);
    const saved = await until('the TikTok copy', async () => { const p = await linkByUrl(TT_URL); return p?.archiveStatus === 'saved' && p; });
    assert.equal(saved.archiveNoVideo, true);
    const section = await panel(TT_URL);
    await section.getByText('Saved copy, without the video').waitFor();
    await section.getByText(/The caption and cover picture are saved/).waitFor();
    await section.screenshot({ path: join(evidence, 'panel-without-video.png') });
    await section.getByRole('button', { name: 'Get the video helper' }).click();
    await page.waitForURL(/\/library\/settings#social-posts$/);
    await page.locator('#social-posts').getByText(/the app needs the free video helper/).waitFor();
    await page.locator('#social-posts').screenshot({ path: join(evidence, 'settings-no-helper.png') });
  });

  await check('Settings says what each site keeps, Instagram and Reddit included', async () => {
    const kept = page.getByRole('table', { name: 'What social posts keep' });
    assert.deepEqual(await kept.locator('tbody th').allInnerTexts(), ['X', 'TikTok', 'Reddit', 'Instagram']);
    assert.match(await kept.locator('tbody tr').nth(1).innerText(), /With the video helper below/);
    assert.match(await kept.locator('tbody tr').nth(3).innerText(), /up to 10 pictures[\s\S]*Cover picture only[\s\S]*browser extension \(v0\.4\.0\)/);
  });

  await check('Settings gets the helper, checks its checksum and shows the version', async () => {
    const block = page.locator('#social-posts');
    await block.getByRole('button', { name: 'Get the video helper' }).click();
    await block.getByText(/Video helper yt-dlp 2026\.08\.19 · checksum checked/).waitFor({ timeout: 20000 });
    const status = await api('/api/helpers/video');
    assert.equal(status.installed, true);
    await block.getByRole('button', { name: 'Check for updates' }).waitFor();
    await block.getByRole('button', { name: 'Remove the helper' }).waitFor();
    // Checking finds the same release: no update offered, the same version stays.
    await block.getByRole('button', { name: 'Check for updates' }).click();
    await page.waitForTimeout(1500);
    await block.getByText(/Video helper yt-dlp 2026\.08\.19/).waitFor();
    assert.equal(await block.getByRole('status', { name: 'Video helper update' }).count(), 0);
    assert.equal(await block.getByRole('button', { name: 'Update the helper' }).count(), 0);
    assert.match(await page.getByRole('table', { name: 'What social posts keep' }).locator('tbody tr').nth(2).innerText(), /Saved with the helper/);
    await block.screenshot({ path: join(evidence, 'settings-helper-ready.png') });
  });

  await check('with the helper, Update keeps the TikTok video', async () => {
    const section = await panel(TT_URL);
    await section.getByText('Saved copy, without the video').waitFor();
    assert.equal(await section.getByRole('button', { name: 'Get the video helper' }).count(), 0, 'no helper button once it is there');
    await section.getByRole('button', { name: 'Update' }).click();
    const saved = await until('the updated copy', async () => { const p = await linkByUrl(TT_URL); return p?.archiveStatus === 'saved' && !p.archiveNoVideo && p; });
    await section.getByText('Saved copy', { exact: true }).waitFor();
    await section.getByRole('button', { name: 'Read saved copy' }).click();
    const frame = page.frameLocator('iframe.copy-reader__frame');
    await frame.locator(`video[src^="${saved.archiveKey}.mp4?t="]`).waitFor({ state: 'attached' });
    assert.equal(await frame.locator('a', { hasText: 'View on TikTok' }).count(), 1);
  });

  await check('removing the helper goes back to the first state', async () => {
    await page.goto(base + '/library/settings#social-posts');
    const block = page.locator('#social-posts');
    await block.getByRole('button', { name: 'Remove the helper' }).click();
    await block.getByRole('button', { name: 'Get the video helper' }).waitFor();
    assert.equal((await api('/api/helpers/video')).installed, false);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
  await context.close();
} catch (error) {
  failures.push('setup'); console.error('FAIL setup:', error.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `FAILED ${failures.length} | evidence: ${evidence}` : `ALL PASS | evidence: ${evidence}`);
process.exit(failures.length ? 1 : 0);
