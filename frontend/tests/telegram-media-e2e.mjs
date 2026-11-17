// Telegram photos, videos and audio, large files downloading after a refresh, and
// the optional check when the app starts, in the real app. Synthetic data only: the
// Telegram read and the background download are replaced in the server by scripted
// answers, the files are synthetic and nothing leaves this machine.
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
const evidence = await mkdtemp(join(root, '.verify', 'telegram-media-'));
const WITH = 'https://example.test/focaccia';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const port = 15000 + Math.floor(Math.random() * 20000);
const child = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import base64, os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'synthetic.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
import storage, app, archive, metadata_fetcher, telegram_refresh
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
storage.init_db()
png = base64.b64decode("${PNG}")
mp4 = b"\\x00\\x00\\x00\\x18ftypisom" + b"\\x00" * 4000
mp3 = b"ID3\\x04\\x00\\x00\\x00\\x00\\x00\\x00" + b"\\x00" * 4000
ogg = b"OggS\\x00\\x02" + b"\\x00" * 4000
archive.save_telegram_media("${WITH}", {"text": "Try this one this weekend", "date": "2026-10-07T18:22:00+00:00"},
    [{"kind": "photo", "data": png}, {"kind": "photo", "data": png}, {"kind": "video", "data": mp4, "duration": 42},
     {"kind": "audio", "data": mp3, "duration": 2891, "title": "Bread Club \\u2013 Levain basics"},
     {"kind": "audio", "data": ogg, "duration": 48, "voice": True}])
calls = []
unkept = {"on": False}
download = {"running": False, "total": 0, "done": 0, "kept": 0, "failed": 0, "received": 0, "size": 0, "reason": ""}
def scripted(keep_media=False, retry=False):
    calls.append({"media": keep_media, **({"retry": True} if retry else {})})
    first = len(calls) == 1 and keep_media
    if first:   # the first refresh leaves one large video downloading in the background
        download.update(running=True, total=1, received=312 * 1024 * 1024, size=int(1.2 * 1024 ** 3))
    return {"ok": True, "limit": 200, "checked": 1, "malformed": 0, "previews": {},
            "media": {"links": 1, "photos": 2 if keep_media else 0, "videos": 1 if keep_media else 0, "audio": 0, "kept": 0, "skipped": 0,
                      "failed": 0, "waiting": 1 if first else 0, "over": 0, "not_mp4": 1 if unkept["on"] else 0, "too_big": 1 if unkept["on"] else 0,
                      "not_added": 1 if unkept["on"] else 0},
            "export": {"type": "saved_messages", "messages": [{"id": 900 + len(calls), "type": "message",
               "date": "2026-10-08T09:00:00+00:00", "text": "new one https://example.test/new-" + str(len(calls)),
               "text_entities": [{"type": "plain", "text": "new one https://example.test/new-" + str(len(calls))}]}]}}
telegram_refresh.refresh_saved_messages = scripted
telegram_refresh.large_state = lambda: dict(download)
def stop():
    download.update(running=False, done=1, failed=1, reason="stopped", received=0, size=0)
    return True
telegram_refresh.stop_large = stop
from flask import jsonify, request
@app.app.route("/__unkept", methods=["POST"])
def say_unkept():
    unkept["on"] = True
    return jsonify(ok=True)
@app.app.route("/__calls")
def report():
    return jsonify(calls=calls, startup=telegram_refresh._startup["claimed"])
@app.app.before_request
def remember():
    if request.path == "/api/telegram/refresh":
        body = request.get_json(silent=True) or {}
        if body.get("startup"):
            calls.append({"startup": True})
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let log = ''; child.stderr.on('data', chunk => { log += chunk; });
const base = `http://127.0.0.1:${port}`;

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const post = (id, url, changes = {}) => ({
  id, url, source: 'telegram', platform: 'web', domain: 'example.test', status: 'inbox', title: `Synthetic ${id}`,
  categories: [], tags: [], projectIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  metadataStatus: 'none', ...changes,
});
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/stats')).ok) break; } catch {}
    if (i > 150) throw new Error('server did not start: ' + log.slice(-400));
    await new Promise(r => setTimeout(r, 100));
  }
  const api = async (path, init) => (await fetch(base + path, init)).json();
  const seeded = await api('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [
    post('tg-with', WITH, { title: 'Overnight focaccia', telegramMessage: { id: '77', date: '2026-10-07T18:22:00Z', text: 'Try this one this weekend' } }),
    post('tg-without', 'https://example.test/plain', { title: 'No photos here', telegramMessage: { id: '78', text: 'plain' } }),
  ], deletedUrls: [] }) });
  assert.deepEqual(seeded.rejected, []);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const toast = page.getByRole('status', { name: 'SQLite save status' });
  const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1') || '{"state":{}}').state);
  const calls = async () => (await api('/__calls')).calls;

  await page.goto(base + '/library/settings#sources');
  await toast.filter({ hasText: /Library saved to SQLite/ }).waitFor();

  const keepName = { name: 'Keep photos, videos and audio sent with your links' };
  await check('Settings has the two switches: check at start off, keep photos, videos and audio on', async () => {
    const start = page.getByRole('switch', { name: 'Check when the app starts' });
    const keep = page.getByRole('switch', keepName);
    assert.equal(await start.getAttribute('aria-checked'), 'false');
    assert.equal(await keep.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await calls(), [], 'no Telegram read happens by itself');
  });

  await check('Refresh asks for photos and videos and says what was kept', async () => {
    await page.getByRole('button', { name: 'Refresh Telegram Saved Messages', exact: true }).click();
    const result = page.getByRole('status', { name: 'Telegram refresh result' });
    await result.filter({ hasText: /Checked 1 message \(/ }).waitFor();
    assert.match(await result.innerText(), /Kept 2 photos and 1 video sent with your links\./);
    assert.match(await result.innerText(), /1 large video or audio file is downloading in the background; it shows below\./);
    assert.deepEqual(await calls(), [{ media: true, retry: true }], 'the button also tries broken-off downloads again');
  });

  await check('the large file downloading after the refresh shows how far it got, and Stop stops it', async () => {
    const line = page.getByRole('status', { name: 'Large files from Telegram' });
    await line.filter({ hasText: 'Downloading a large file from Telegram · 312 MB of 1.2 GB · 1 of 1' }).waitFor();
    assert.match(await line.innerText(), /The links are already in your library\. Refreshing and Disconnect wait until this finishes or you stop it\./);
    await line.screenshot({ path: join(evidence, 'large-download.png') });
    await line.getByRole('button', { name: 'Stop', exact: true }).click();
    await line.filter({ hasText: 'Stopped. What was stopped is tried again when SuperBookmarks starts again.' }).waitFor();
    assert.equal(await line.getByRole('button').count(), 0);
  });

  await check('a video that can\'t be kept is said, not passed over', async () => {
    await fetch(base + '/__unkept', { method: 'POST' });
    await page.getByRole('button', { name: 'Refresh Telegram Saved Messages', exact: true }).click();
    const result = page.getByRole('status', { name: 'Telegram refresh result' });
    await result.filter({ hasText: /isn't an MP4 file/ }).waitFor();
    assert.match(await result.innerText(), /1 video sent with your links isn't an MP4 file, so it wasn't kept: SuperBookmarks keeps MP4 videos\./);
    assert.match(await result.innerText(), /1 video or audio file over 2 GB was left out\./);
    assert.match(await result.innerText(), /1 photo, video or audio file sent with a link that already keeps 10 files wasn't added\./);
  });

  await check('with the switch off, Refresh downloads no photos or videos', async () => {
    await page.getByRole('switch', keepName).click();
    assert.equal((await prefs()).telegramKeepMedia, false);
    await page.getByRole('button', { name: 'Refresh Telegram Saved Messages', exact: true }).click();
    await page.getByRole('status', { name: 'Telegram refresh result' }).filter({ hasNotText: /Kept/ }).waitFor();
    assert.deepEqual((await calls()).at(-1), { media: false, retry: true });
    await page.getByRole('switch', keepName).click();
  });

  await check('check at start runs once per app run and the toast says what it found', async () => {
    await page.getByRole('switch', { name: 'Check when the app starts' }).click();
    assert.equal((await prefs()).telegramCheckOnStart, true);
    const before = (await calls()).length;
    await page.waitForTimeout(1500);
    assert.equal((await calls()).length, before, 'turning the switch on does not start a check mid-session');
    await page.goto(base + '/');
    const notice = page.getByRole('status', { name: 'Notice' });
    await notice.filter({ hasText: 'Telegram: 1 new link from Saved Messages, with 2 photos and 1 video' }).waitFor({ timeout: 30000 })
      .catch(async error => { throw new Error(`${error.message.split('\n')[0]} calls=${JSON.stringify((await calls()).slice(before))} notice=${JSON.stringify(await notice.innerText())}`); });
    assert.deepEqual((await calls()).slice(before), [{ startup: true }, { media: true }]);
    await page.screenshot({ path: join(evidence, 'startup-notice.png') });
    await page.goto(base + '/library');
    await toast.filter({ hasText: /Library saved to SQLite/ }).waitFor();
    await page.waitForTimeout(1500);
    assert.deepEqual((await calls()).slice(before + 2), [{ startup: true }], 'a second load asks, and the server says it already checked');
    assert.equal(await notice.innerText(), '');
  });

  await check('the link panel shows the message, the photos, the video and the audio', async () => {
    await page.goto(base + '/library/item/tg-with');
    const group = page.getByRole('region', { name: 'From your Telegram message' });
    await group.waitFor();
    assert.match(await group.innerText(), /From your Telegram message · 7 Oct, \d\d:22/);
    assert.match(await group.innerText(), /“Try this one this weekend”/);
    assert.match(await group.innerText(), /2 photos, 1 video and 2 audio files, kept on this computer\. They open without Telegram\./);
    const audio = group.getByRole('list', { name: 'Audio from Telegram' }).getByRole('listitem');
    assert.equal(await audio.count(), 2);
    assert.match(await audio.nth(0).innerText(), /Bread Club – Levain basics\s*48:11/);
    assert.match(await audio.nth(1).innerText(), /Voice message\s*0:48/);
    const player = audio.nth(0).locator('audio');
    assert.equal(await player.getAttribute('preload'), 'none', 'a long recording is read only when played');
    assert.equal(await player.getAttribute('aria-label'), 'Play Bread Club – Levain basics');
    const sound = await fetch(base + await player.getAttribute('src'));
    assert.equal(sound.headers.get('content-type'), 'audio/mpeg');
    assert.match(sound.headers.get('content-security-policy'), /sandbox/);
    const tiles = group.getByRole('link');
    assert.equal(await tiles.count(), 3);
    assert.equal(await tiles.nth(2).getAttribute('aria-label'), 'Open video (0:42)');
    await page.waitForFunction(() => [...document.querySelectorAll('.tg-media img')].every(img => img.complete && img.naturalWidth > 0));
    const href = await tiles.first().getAttribute('href');
    const file = await fetch(base + href);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.match(file.headers.get('content-security-policy'), /sandbox/);
    await group.screenshot({ path: join(evidence, 'panel.png') });
  });

  await check('a Telegram link without kept files shows nothing extra', async () => {
    await page.goto(base + '/library/item/tg-without');
    await page.getByText('No photos here').first().waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.getByRole('region', { name: 'From your Telegram message' }).count(), 0);
  });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  child.kill();
}
console.log(failures.length ? `FAILED ${failures.length}: ${failures.join('; ')}` : 'ALL PASS');
process.exit(failures.length ? 1 : 0);
