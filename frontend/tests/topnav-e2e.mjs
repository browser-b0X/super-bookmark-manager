// The new look's top bar (phase 5): tabs, the menu behind the initials, the
// GitHub button and the hint that says where it goes, the page transition, the
// four themes with the moving background in each theme's colours, the Portrait/Wide switch and the search box.
// Synthetic data only, on an owned loopback server.
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
const evidence = await mkdtemp(join(root, '.verify', 'topnav-'));
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
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const post = (n, changes = {}) => ({ id: `nav-${n}`, url: `https://example.org/${n}`, source: 'manual', platform: 'web', domain: 'example.org',
  status: n <= 3 ? 'inbox' : 'reference', title: `Synthetic link ${n}`, categories: [n % 2 ? 'travel' : 'technology'], tags: [], projectIds: [],
  favorite: n === 5, createdAt: `2026-10-0${n}T10:00:00Z`, updatedAt: `2026-10-0${n}T10:00:00Z`, metadataStatus: 'enriched', ...changes });
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const eightMonths = new Date(); eightMonths.setMonth(eightMonths.getMonth() - 8);
  const posts = [...[1, 2, 3, 4, 5, 6].map(n => post(n, n === 6 ? { title: 'Hedgerow walk notes' } : {})),
    post(7, { title: 'The quiet joy of slow travel', favorite: true, createdAt: eightMonths.toISOString(), updatedAt: eightMonths.toISOString() })];
  assert.deepEqual((await (await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) })).json()).rejected, []);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const bar = page.locator('header.topnav');
  const sections = page.getByRole('navigation', { name: 'Sections' });

  await check('no sidebar; the tabs lead to their sections and New shows its count', async () => {
    assert.equal(await page.getByRole('complementary', { name: 'Navigation' }).count(), 0);
    assert.deepEqual((await sections.getByRole('link').allTextContents()).map(t => t.trim()), ['Home', 'New3', 'Later', 'Favourites', 'All shelves']);
    const throwback = page.getByRole('region', { name: 'The quiet joy of slow travel' });
    assert.match(await throwback.innerText(), /FROM 8 MONTHS AGO[\s\S]*a favourite/i);
    assert.equal(await throwback.getByRole('link', { name: 'Read it again' }).getAttribute('href'), '/library/item/nav-7');
    for (const [name, url] of [['Later', /status=to-review/], ['Favourites', /status=favorites/], ['All shelves', /\/shelves$/], [/^New/, /\/library\/inbox$/], ['Home', /\/$/]]) {
      await sections.getByRole('link', { name }).click();
      await page.waitForURL(url);
      assert.equal(await sections.getByRole('link', { name }).getAttribute('aria-current'), 'page');
    }
  });

  // Waits for an element's CSS transitions/animations to end, so a busy machine doesn't fail a fixed delay.
  const settled = locator => locator.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})))).then(() => page.waitForTimeout(30));

  await check('the GitHub button says where it goes on hover and on keyboard focus', async () => {
    const link = bar.getByRole('link', { name: 'Report a bug or suggest an idea on GitHub' });
    assert.equal(await link.getAttribute('href'), 'https://github.com/browser-b0X/super-bookmark-manager/issues');
    assert.equal(await link.getAttribute('target'), '_blank');
    const hint = page.getByRole('tooltip');
    assert.equal(await hint.evaluate(el => getComputedStyle(el).opacity), '0');
    await link.hover(); await page.waitForTimeout(100); await settled(hint);
    assert.equal(await hint.evaluate(el => getComputedStyle(el).opacity), '1');
    assert.match(await hint.innerText(), /Bugs and suggestions[\s\S]*github\.com\/browser-b0X\/super-bookmark-manager/);
    await page.mouse.move(10, 600); await page.waitForTimeout(100); await settled(hint);
    assert.equal(await hint.evaluate(el => getComputedStyle(el).opacity), '0');
    await link.focus(); await page.waitForTimeout(100); await settled(hint);
    assert.equal(await hint.evaluate(el => getComputedStyle(el).opacity), '1');
    await bar.screenshot({ path: join(evidence, 'bar-with-hint.png') });
    await link.blur();
  });

  await check('the menu behind the initials: Settings, Theme, closes on Escape and outside clicks', async () => {
    await page.goto(base + '/shelves');
    const button = bar.getByRole('button', { name: 'Menu' });
    // Settings is in this menu only: no second gear button in the bar (owner, mockup p10-1).
    assert.equal(await bar.getByRole('link', { name: 'Settings', exact: true }).count(), 0);
    await page.screenshot({ path: join(evidence, 'before-menu.png') });
    await button.click();
    const menu = page.getByRole('menu', { name: 'Menu' });
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.deepEqual((await menu.getByRole('menuitemradio').allTextContents()).map(t => t.trim()), ['Classic dark', 'Classic light', 'Lime', 'Coral']);
    assert.equal(await menu.getByRole('menuitemradio', { name: 'Classic dark' }).getAttribute('aria-checked'), 'true');
    const support = menu.getByRole('menuitem', { name: /^Support/ });
    assert.equal(await support.getAttribute('href'), 'https://bio.site/browserb0x');
    assert.equal(await support.getAttribute('target'), '_blank');
    assert.match(await support.getAttribute('rel'), /noopener/);
    assert.match(await support.innerText(), /bio\.site\/browserb0x/);
    assert.ok(await menu.evaluate(el => {
      const radios = [...el.querySelectorAll('[role="menuitemradio"]')], link = el.querySelector('a.topnav__support');
      return radios.length === 4 && !!(radios[3].compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'Support sits right under the themes');
    await menu.getByRole('menuitemradio', { name: 'Classic light' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await button.click(); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    await button.click(); await page.mouse.click(700, 860); await menu.waitFor({ state: 'detached' });
    await button.click(); await menu.getByRole('menuitem', { name: /^Settings/ }).click();
    await page.waitForURL(/\/library\/settings$/);
    await bar.getByRole('button', { name: 'Menu' }).click(); await menu.getByRole('menuitemradio', { name: 'Classic dark' }).click();   // back to the first theme
  });

  await check('a section change plays the page transition; opening a link panel does not', async () => {
    await page.goto(base + '/library?status=reference');
    await page.locator('main article[data-post-id]').first().waitFor();
    await sections.getByRole('link', { name: 'All shelves' }).click();
    const animation = await page.locator('.page-transition').evaluate(el => el.getAnimations().map(a => a.animationName));
    assert.deepEqual(animation, ['page-in']);
    await settled(page.locator('.page-transition'));
    assert.equal(await page.locator('.page-transition').evaluate(el => getComputedStyle(el).transform), 'none', 'nothing left behind for fixed panels');
    await sections.getByRole('link', { name: 'Later' }).click();
    await page.goto(base + '/library?status=reference');
    await page.locator('main article[data-post-id]').first().waitFor(); await page.waitForTimeout(500);
    await page.locator('.page-transition').evaluate(el => { el.dataset.marker = 'kept'; });
    await page.locator('main article[data-post-id]').first().locator('.tile__title').click();
    await page.getByRole('dialog', { name: 'Saved post detail' }).waitFor();
    assert.equal(await page.locator('.page-transition[data-marker="kept"]').count(), 1, 'the list behind the panel stays');
    await page.keyboard.press('Escape');
  });

  await check('four themes: colours, fonts and the moving background change together; nothing is fetched from outside', async () => {
    const outside = []; const fonts = new Set();
    const watch = r => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1') outside.push(u.href); if (u.pathname.startsWith('/fonts/')) fonts.add(u.pathname.slice(7)); };
    page.on('request', watch);
    const info = () => page.evaluate(() => {
      const el = document.querySelector('.backdrop');
      const square = el?.querySelector('.backdrop__shape.is-square');
      return { shapes: el?.querySelectorAll('.backdrop__shape').length, hidden: el?.getAttribute('aria-hidden'),
        pointer: el && getComputedStyle(el).pointerEvents, moving: el ? el.getAnimations({ subtree: true }).length : 0,
        bg: getComputedStyle(document.body).backgroundColor, shape: square && getComputedStyle(square).borderTopColor,
        body: getComputedStyle(document.body).fontFamily, head: getComputedStyle(document.querySelector('h1, h2')).fontFamily,
        keep: getComputedStyle(document.querySelector('.btn-primary')).color };
    });
    await page.goto(base + '/'); await page.locator('.deck__card').waitFor();
    const seen = {};
    await bar.getByRole('button', { name: 'Menu' }).click();   // stays open while you try the themes
    for (const name of ['Classic dark', 'Classic light', 'Lime', 'Coral']) {
      await page.getByRole('menuitemradio', { name }).click();
      await page.waitForTimeout(400);
      seen[name] = await info();
      const now = seen[name];
      assert.ok(now.shapes >= 12 && now.hidden === 'true' && now.pointer === 'none' && now.moving > 0, `${name}: ${JSON.stringify(now)}`);
    }
    assert.equal(new Set(Object.values(seen).map(s => s.bg)).size, 4, 'each theme has its own background');
    assert.equal(new Set(Object.values(seen).map(s => s.shape)).size, 3, 'the shapes take Lime and Coral colours (Classic light keeps the dark shapes, fainter)');
    assert.match(seen.Lime.body, /^"?Instrument Sans/); assert.match(seen.Lime.head, /^"?Space Grotesk/);
    assert.match(seen.Coral.body, /^"?Figtree/); assert.match(seen.Coral.head, /^"?Bricolage Grotesque/);
    assert.doesNotMatch(seen['Classic dark'].body, /Instrument|Figtree/);
    assert.equal(seen.Lime.keep, 'rgb(19, 32, 10)', 'dark text on the lime button');
    const loaded = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')));
    assert.ok(loaded.includes('Bricolage Grotesque') && loaded.includes('Figtree'), 'Coral fonts loaded: ' + loaded.join());
    assert.ok([...fonts].some(f => f.startsWith('space-grotesk')) && [...fonts].some(f => f.startsWith('figtree')), [...fonts].join());
    assert.deepEqual(outside, []);
    await page.screenshot({ path: join(evidence, 'home-coral.png') });
    await page.keyboard.press('Escape');
    page.off('request', watch);
  });

  await check('Settings > Appearance picks a theme; the choice is remembered and older saved values still work', async () => {
    await page.goto(base + '/library/settings#appearance');
    const cards = page.getByRole('radiogroup', { name: 'Theme' });
    assert.deepEqual((await cards.getByRole('radio').allInnerTexts()).map(t => t.split('\n')[0].trim()), ['Classic dark', 'Classic light', 'Lime', 'Coral']);
    assert.equal(await cards.getByRole('radio', { name: /Coral/ }).getAttribute('aria-checked'), 'true');
    await cards.getByRole('radio', { name: /Lime/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'lime');
    await page.locator('#appearance').screenshot({ path: join(evidence, 'appearance-lime.png') });
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'lime');
    const setStored = value => page.evaluate(v => {
      const key = Object.keys(localStorage).find(k => k.endsWith('prefs-store-v1'));
      const saved = JSON.parse(localStorage.getItem(key)); saved.state.theme = v; localStorage.setItem(key, JSON.stringify(saved));
    }, value);
    await setStored('light'); await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'a value from an older build');
    await setStored('neon'); await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'an unknown value falls back to Classic dark');
  });

  await check('Up next keeps long titles and pictures inside its card, in Wide and Portrait', async () => {
    const long = post(2, { title: 'An extremely long synthetic title that keeps going well past the width of any reasonable card '.repeat(3), updatedAt: new Date().toISOString() });
    assert.deepEqual((await (await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [long], deletedUrls: [] }) })).json()).rejected, []);
    await page.goto(base + '/'); await page.locator('.up-next__list li').first().waitFor();
    for (const layout of ['Wide', 'Portrait']) {
      await bar.getByRole('radio', { name: new RegExp(layout) }).click(); await page.waitForTimeout(200);
      const out = await page.evaluate(() => {
        const card = document.querySelector('.up-next').getBoundingClientRect();
        return [...document.querySelectorAll('.up-next__list li, .up-next__list li *')].map(el => el.getBoundingClientRect())
          .filter(r => r.width && (r.right > card.right + 0.5 || r.left < card.left - 0.5)).length;
      });
      assert.equal(out, 0, `${layout}: nothing sticks out of the card`);
    }
    await page.screenshot({ path: join(evidence, 'up-next-long-title.png') });
  });

  await check('Portrait/Wide changes Home and is remembered on this device', async () => {
    await page.goto(base + '/');
    const seg = bar.getByRole('radiogroup', { name: 'Home layout' });
    const card = page.locator('.deck__card');
    await seg.getByRole('radio', { name: /Wide/ }).click();
    assert.equal(await page.locator('.home').getAttribute('class'), 'home home--wide');
    const wide = await card.boundingBox();
    await seg.getByRole('radio', { name: /Portrait/ }).click();
    assert.equal(await page.locator('.home').getAttribute('class'), 'home home--portrait');
    const tall = await card.boundingBox();
    assert.ok(tall.height > wide.height && tall.width >= wide.width, 'portrait: picture on top in one centred column');
    await page.screenshot({ path: join(evidence, 'home-portrait.png') });
    await page.reload();
    assert.equal(await bar.getByRole('radio', { name: /Portrait/ }).getAttribute('aria-checked'), 'true');
    await bar.getByRole('radio', { name: /Wide/ }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state.homeLayout), 'wide');
  });

  await check('the search box finds links from any page', async () => {
    await page.goto(base + '/shelves');
    await bar.getByRole('searchbox', { name: 'Search your library' }).fill('hedgerow');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/library\?q=hedgerow$/);
    await page.waitForTimeout(300);
    assert.deepEqual(await page.locator('main article[data-post-id]').evaluateAll(els => els.map(e => e.dataset.postId)), ['nav-6']);
  });

  await check('a narrow window wraps the bar instead of scrolling sideways', async () => {
    for (const width of [1000, 720, 600]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `width ${width}`);
      const [barBox, mainBox] = [await bar.boundingBox(), await page.locator('main').boundingBox()];
      assert.equal(Math.round(mainBox.y), Math.round(barBox.y + barBox.height), `page starts under the bar at ${width}`);
    }
    await page.screenshot({ path: join(evidence, 'narrow-600.png') });
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
