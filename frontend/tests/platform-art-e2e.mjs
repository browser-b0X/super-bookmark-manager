// Social and messaging links without a picture, in a browser (synthetic links, no network): site
// artwork in the library and on Home, text cards for posts that have words, and no logos or
// fetched images standing in for one.
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
const evidence = await mkdtemp(join(root, '.verify', 'platform-art-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`); }
}

let n = 0;
const post = (url, platform, extra = {}) => {
  const i = n++;
  const at = new Date(Date.parse('2026-10-09T12:00:00Z') - i * 3600e3).toISOString();
  return { id: `pa-${i}`, url, canonicalUrl: url, source: 'browser', platform, domain: new URL(url).hostname.replace(/^www\./, ''), status: 'reference',
    createdAt: at, updatedAt: at, metadataStatus: 'enriched', enrichedAt: at, categories: ['social-media'], categoryMode: 'manual', tags: [], projectIds: [],
    title: '', ...extra };
};
// No picture and no words: each gets its site's artwork.
const art = [
  ['https://www.facebook.com/groups/gardening/posts/1', 'facebook', 'Facebook', 'Group post'],
  ['https://www.instagram.com/reel/Cx1abc/', 'instagram', 'Instagram', 'Reel'],
  ['https://www.youtube.com/watch?v=abcDEF12345', 'youtube', 'YouTube', 'Video'],
  ['https://chat.whatsapp.com/Invite123', 'web', 'WhatsApp', 'Group invite'],
  ['https://www.tiktok.com/@cook/video/7000000000001', 'tiktok', 'TikTok', 'Video'],
  ['https://mp.weixin.qq.com/s/AbCd', 'web', 'WeChat', 'Article'],
  ['https://t.me/designdigest/120', 'web', 'Telegram', 'Channel post'],
  ['https://www.linkedin.com/posts/sam_hiring-1', 'linkedin', 'LinkedIn', 'Post'],
  ['https://www.snapchat.com/spotlight/W7_1', 'web', 'Snapchat', 'Spotlight'],
  ['https://www.reddit.com/r/cooking/comments/a1/b/', 'reddit', 'Reddit', 'Thread'],
  ['https://x.com/notes/status/1800000000001', 'x', 'X', 'Post'],
  ['https://www.pinterest.com/pin/9900001/', 'pinterest', 'Pinterest', 'Pin'],
];
const posts = [
  ...art.map(([url, platform]) => post(url, platform)),
  // A title that only names the site is not words: artwork.
  post('https://www.instagram.com/p/Generic1/', 'instagram', { title: 'Instagram post' }),
  // Posts with words keep the text card.
  post('https://www.instagram.com/p/Words1/', 'instagram', { description: 'Sunday market haul: figs, sourdough and far too many tomatoes' }),
  post('https://www.youtube.com/watch?v=wordsWORDS1', 'youtube', { title: 'How I organise 2,000 bookmarks' }),
  post('https://t.me/travelnotes/77', 'web', { description: 'Weekly roundup: five tools for colour palettes and a font pairing guide.' }),
  // Untitled, and no one to name: "Facebook post" (not "Facebook on Facebook").
  post('https://www.facebook.com/watch/?v=1000001', 'facebook'),
];

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
  assert.ok(seeded.ok, await seeded.text());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1400 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/library/category/social-media');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const card = id => page.locator(`article[data-post-id="${id}"]`);
  await card('pa-0').waitFor();

  await check('each of the twelve sites gets its own artwork: colours, motif and its name as text', async () => {
    for (let i = 0; i < art.length; i++) {
      const [, , name, kind] = art[i];
      const artwork = card(`pa-${i}`).locator('.platform-art');
      await artwork.waitFor();
      assert.equal(await artwork.getAttribute('data-brand'), name.toLowerCase(), name);
      assert.equal((await artwork.locator('.platform-art__name').innerText()).trim(), name);
      assert.equal((await artwork.locator('.platform-art__kind').innerText()).trim().toLowerCase(), kind.toLowerCase());
      assert.equal(await artwork.getAttribute('aria-label'), 'No content preview available');
      // Artwork, not a fetched picture: drawn shapes, no image and no text inside the drawing.
      assert.equal(await artwork.locator('img').count(), 0);
      assert.equal(await artwork.locator('svg text').count(), 0);
      const background = await artwork.evaluate(el => getComputedStyle(el).backgroundImage);
      assert.match(background, /gradient/, `${name} has its colours`);
    }
  });

  await check('a title that only names the site gets the artwork, not a text card saying "Instagram post"', async () => {
    await card('pa-12').locator('.platform-art[data-brand="instagram"]').waitFor();
    assert.equal(await card('pa-12').locator('.social-card').count(), 0);
  });

  await check('posts with words keep the text card; YouTube shows a timeline, not a red play button', async () => {
    const words = card('pa-13').locator('.social-card[data-brand="instagram"]');
    await words.waitFor();
    assert.match(await words.locator('.social-card__text').getAttribute('data-label'), /Sunday market haul/);
    const video = card('pa-14').locator('.social-card[data-brand="youtube"]');
    await video.locator('.social-card__timeline').waitFor();
    assert.equal(await page.locator('.social-card__play').count(), 0);
    // Telegram is filed under "web" but its text card has Telegram's name and colours.
    const telegram = card('pa-15').locator('.social-card[data-brand="telegram"]');
    await telegram.waitFor();
    assert.match(await telegram.innerText(), /Telegram/);
  });

  await check('Home: shelf rows use the artwork with the site name, and untitled posts read sensibly', async () => {
    await page.goto(base + '/');
    const row = page.locator('section.shelf-row', { has: page.getByRole('heading', { name: 'social-media' }) });
    await row.waitFor();
    assert.ok(await row.locator('.platform-art').count() >= 6);
    assert.equal(await row.locator('.platform-art__kind').count(), 0, 'small cards show the name only');
    // Each shelf row shows its 12 newest; the rest are a click away.
    const titles = await row.locator('.row-card__title').allInnerTexts();
    for (const expected of ['gardening on Facebook', '@notes on X', 'r/cooking on Reddit', 'WhatsApp group invite', 'designdigest on Telegram', 'WeChat article', 'Snapchat spotlight']) {
      assert.ok(titles.includes(expected), `${expected}: ${titles.join(' | ')}`);
    }
    assert.ok(!titles.some(t => /^https?:/.test(t) || /^(\w+) on \1$/.test(t)), titles.join(' | '));
    await page.goto(base + '/library/category/social-media');
    await card('pa-16').locator('.platform-art[data-brand="facebook"]').waitFor();
    assert.match(await card('pa-16').innerText(), /Facebook post/);
  });

  await check('phone width: no sideways scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/library/category/social-media');
    await card('pa-0').waitFor();
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= client, `${scroll} > ${client}`);
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(evidence, 'social-shelf.png') });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
