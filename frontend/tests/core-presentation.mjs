import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// G5 presentation checks share the actual import journey's page/build. Extra
// visual states use fresh contexts and local API fixtures, never its SQLite DB.
export async function verifyPresentation({ page, browser, origin, evidenceDir, baseline, getState, saved, snapshot, setApiOffline, check }) {
  assert.equal(baseline.length, 8);
  const report = { integrated: true, variantDurabilityClaim: false, measurements: [], screenshots: [], variants: [], contextsClosed: 0 };
  const sorted = posts => [...posts].sort((a, b) => a.url.localeCompare(b.url));
  const clone = value => JSON.parse(JSON.stringify(value));
  const initial = sorted(clone(baseline));
  const state = p => p.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1') || '{}').state);
  const cards = p => p.locator('main article[data-post-id]');
  const card = (p, post) => p.locator(`main article[data-post-id="${post.id}"]`);
  const status = p => p.getByRole('status', { name: 'SQLite save status', exact: true });
  const search = p => p.getByPlaceholder('Search… ( / )');
  const menu = p => p.locator('header.topnav').getByRole('button', { name: 'Menu', exact: true });
  const sections = p => p.getByRole('navigation', { name: 'Sections', exact: true });
  const settled = p => p.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    // Only finite animations can settle (the background loops forever).
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  async function measured(name, detail) { report.measurements.push({ name, detail }); return detail; }
  async function shot(p, name, kind = 'integrated') {
    await settled(p);
    const file = name + '.png';
    await p.screenshot({ path: join(evidenceDir, file), animations: 'disabled' });
    report.screenshots.push({ file, kind });
  }
  async function tabTo(p, target, limit = 100) {
    assert.equal(await target.count(), 1);
    for (let i = 0; i < limit; i++) {
      if (await target.evaluate(el => el === document.activeElement)) return;
      await p.keyboard.press('Tab');
    }
    throw new Error('Core control was not reachable by Tab');
  }
  async function unobstructed(p) {
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal page overflow');
    const blocked = await p.locator('main a, main button, main select, header.topnav a, header.topnav button').evaluateAll(elements => elements.flatMap(el => {
      const barBottom = el.closest('header.topnav') ? 0 : document.querySelector('header.topnav').getBoundingClientRect().bottom;
      const style = getComputedStyle(el);
      if (el.closest('[inert]') || style.visibility !== 'visible' || style.opacity === '0') return [];
      const r = el.getBoundingClientRect();
      let left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(barBottom, r.top), bottom = Math.min(innerHeight - 10, r.bottom);
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const s = getComputedStyle(parent), b = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
      }
      if (right <= left || bottom <= top) return [];
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return hit && el.contains(hit) ? [] : [el.getAttribute('aria-label') || el.textContent?.trim()];
    }));
    assert.deepEqual(blocked, [], 'Visible core controls are unobscured');
  }
  // The new look has a top bar and no sidebar: the page starts under it, nothing scrolls sideways,
  // the save status floats outside it, and every control in it is a real, unobscured target.
  async function topBarGeometry(p) {
    const detail = await p.locator('header.topnav').evaluate(bar => {
      const rect = el => el.getBoundingClientRect().toJSON();
      const status = document.querySelector('[aria-label="SQLite save status"]');
      return { bar: rect(bar), main: rect(document.querySelector('main')), status: rect(status), inBar: bar.contains(status),
        statusPosition: getComputedStyle(status).position, overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...bar.querySelectorAll(':scope > * a, :scope > * button, :scope > a, :scope > button, input')].filter(el => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.offsetParent !== null).map(el => {
          const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { name: el.getAttribute('aria-label') || el.textContent.trim(), rect: rect(el), hit: !!hit && el.contains(hit) };
        }) };
    });
    assert.equal(detail.bar.x, 0); assert.equal(detail.main.x, 0); assert.equal(detail.main.y, detail.bar.bottom);
    assert.equal(detail.overflow, false); assert.equal(detail.inBar, false); assert.equal(detail.statusPosition, 'fixed');
    for (const c of detail.controls) {
      assert.equal(c.hit, true, c.name + ' hit target');
      assert.ok(c.rect.x >= -1 && c.rect.right <= detail.bar.right + 1 && c.rect.top >= detail.bar.top - 1 && c.rect.bottom <= detail.bar.bottom + 1, c.name + ' inside the bar');
    }
    for (const name of ['Home', 'New', 'Later', 'Favourites', 'All shelves']) assert.ok(await sections(p).getByRole('link', { name: new RegExp('^' + name) }).isVisible(), name);
    assert.match(await status(p).ariaSnapshot(), /Library saved to SQLite/);
    return detail;
  }

  const preview = await readFile(new URL('./fixtures/landing-preview.svg', import.meta.url), 'utf8');
  async function variant(name, posts, run, { unavailable = false, reducedMotion = 'no-preference' } = {}) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block', reducedMotion });
    const record = { name, source: 'deep clone of actual G5 imported/curated baseline', persistence: 'local API fixture only; no SQLite durability claim', writes: [], intercepted: [], errors: [], routeErrors: [], apiRequests: [] };
    report.variants.push(record);
    let documents = clone(posts), deletedUrls = [], rejectRoute;
    const routeFailure = new Promise((_, reject) => { rejectRoute = reject; });
    routeFailure.catch(() => {});
    try {
      await context.route('**/*', async route => {
        try {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== origin) { record.intercepted.push(url.href); return await route.abort(); }
          if (url.pathname.startsWith('/__fixture/')) {
            if (url.pathname.endsWith('/broken.svg')) return await route.fulfill({ status: 404, body: 'Synthetic missing preview' });
            return await route.fulfill({ contentType: 'image/svg+xml', body: url.pathname.endsWith('/tiny.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6c8cff"/></svg>' : preview });
          }
          if (url.pathname.startsWith('/api/')) {
            record.apiRequests.push({ path: url.pathname, method: request.method() });
            // Explicit first-party allowlist for the presentation scenarios. The empty-library variant
            // opens "Import saved links" -> /library/settings, whose accepted component mount effects issue
            // /api/telegram/config (TelegramConfig.tsx:64) and /api/telegram/auth (TelegramAccount.tsx:107);
            // /api/stats is the backendAvailable health probe and /api/library is persistence. CategoryManager
            // is not mounted on this surface, so /api/categories never fires. Kept explicit (no /api/* wildcard,
            // no startsWith, no regex) so any unexpected route still fails loudly. Focused rerun recorded exactly these.
            // Settings > AI & previews reads provider status (no keys, no provider traffic): /api/ai/providers.
            // The app asks once at startup whether the server makes saved copies: GET /api/archive (answered "no" here).
            assert.ok(['/api/library', '/api/stats', '/api/telegram/config', '/api/telegram/auth', '/api/ai/providers', '/api/archive'].includes(url.pathname), 'Presentation fixture must not exercise unrelated APIs');
            if (url.pathname === '/api/archive') { assert.equal(request.method(), 'GET'); assert.equal(url.search, ''); return await route.fulfill({ status: 200, json: { ok: true, enabled: false, count: 0, bytes: 0 } }); }
            if (url.pathname === '/api/ai/providers') { assert.equal(request.method(), 'GET'); return await route.fulfill({ status: 200, json: { ok: true, providers: [], ready: [], available: false } }); }
            if (url.pathname === '/api/stats') assert.equal(request.method(), 'GET');
            else assert.ok(['GET', 'POST'].includes(request.method()));
            if (unavailable) return await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"G5 synthetic backend unavailable"}' });
            if (url.pathname === '/api/stats') return await route.fulfill({ status: 200, json: {} });
            if (request.method() === 'POST') {
              const delta = request.postDataJSON(); record.writes.push(clone(delta));
              for (const post of delta.posts) { documents = documents.filter(p => p.url !== post.url); documents.push(post); }
              deletedUrls = [...new Set([...deletedUrls, ...delta.deletedUrls])]; documents = documents.filter(p => !deletedUrls.includes(p.url));
            }
            return await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, posts: documents, deletedUrls, legacyRows: [] }) });
          }
          return await route.continue();
        } catch (error) {
          record.routeErrors.push(error.message);
          rejectRoute(error);
          await route.abort().catch(abortError => { record.routeErrors.push(abortError.message); });
        }
      });
      const p = await context.newPage(); p.setDefaultTimeout(10000);
      p.on('pageerror', e => record.errors.push(e.message));
      await Promise.race([routeFailure, (async () => {
        await p.goto(origin + '/');
        if (!unavailable) {
          await status(p).filter({ hasText: 'Library saved to SQLite' }).waitFor();
          assert.deepEqual(sorted((await state(p)).posts), sorted(posts));
        }
        await run(p, record);
        assert.deepEqual(record.errors, []);
      })()]);
    } finally { await context.close(); report.contextsClosed++; }
    assert.deepEqual(record.routeErrors, []);
  }

  try {
    await check('C7 integrated Home: the deck shows the newest new link; Up next and the shelf rows follow', async () => {
      await page.setViewportSize({ width: 1365, height: 900 }); await page.goto(origin + '/'); await saved(8);
      const queue = initial.filter(p => p.status === 'inbox').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const deck = page.getByRole('region', { name: 'New to sort' });
      assert.ok(queue.length > 0, 'fixture has new links');
      await deck.locator('article[data-post-id]').waitFor({ timeout: 10000 });
      const shown = await deck.locator('article[data-post-id]').getAttribute('data-post-id');
      assert.equal(shown, queue[0].id);
      for (const name of ['Keep', 'Later', 'Archive']) assert.equal(await deck.getByRole('button', { name: new RegExp('^' + name + ':') }).count(), 1);
      assert.equal(await deck.locator('article[data-post-id] a').first().getAttribute('href'), '/library/item/' + queue[0].id);
      if (queue.length > 1) {
        const next = await page.getByRole('region', { name: 'Up next' }).getByRole('listitem').locator('a').evaluateAll(els => els.map(a => a.getAttribute('href')));
        assert.deepEqual(next, queue.slice(1, 4).map(p => '/library/item/' + p.id));
      }
      assert.equal(await page.getByRole('link', { name: /Report a bug or suggest an idea/ }).getAttribute('href'), 'https://github.com/browser-b0X/super-bookmark-manager/issues');
      await shot(page, 'g5-home-populated');
      assert.deepEqual(sorted((await getState()).posts), initial);
      return measured('integrated-home', { deck: shown, queue: queue.map(p => p.id) });
    });

    await check('C7 integrated Library landscape, captions, hover/focus and desktop responsiveness', async () => {
      await page.goto(origin + '/library'); await saved(8); await page.getByRole('radio', { name: 'grid', exact: true }).click();
      await settled(page); assert.equal(await cards(page).count(), 8);
      await page.mouse.move(0, 0); await search(page).focus();
      const withCaption = initial.find(p => p.description || p.userNotes || p.aiSummary || p.excerpt);
      // Feed revamp: details live in a pop-up cell under the picture, never over it.
      assert.ok(withCaption); const target = card(page, withCaption), overlay = target.locator('.tile__pop');
      assert.equal(await overlay.evaluate(el => getComputedStyle(el).opacity), '0');
      const before = await target.boundingBox(); await target.hover(); await settled(page);
      await page.waitForFunction(el => getComputedStyle(el).opacity === '1', await overlay.elementHandle());
      assert.deepEqual(await target.boundingBox(), before, 'Hover does not shift the card');
      await page.mouse.move(0, 0); await search(page).focus();
      await tabTo(page, target.locator('.tile__title')); await settled(page);
      assert.equal(await target.locator('.tile__title').evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true);
      await page.waitForFunction(el => getComputedStyle(el).opacity === '1', await overlay.elementHandle());
      await page.mouse.move(0, 0); await search(page).focus();
      const layouts = [];
      for (const width of [1365, 1024, 768]) {
        await page.setViewportSize({ width, height: 900 }); await settled(page);
        const detail = await page.locator('.tile-grid').evaluate(grid => ({ width: innerWidth, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          overflow: document.documentElement.scrollWidth > innerWidth,
          cards: [...grid.querySelectorAll('article')].map(el => {
            const image = el.querySelector('.tile__media').getBoundingClientRect(), caption = el.querySelector('.tile__caption'), title = caption.querySelector('.tile__title');
            return { id: el.dataset.postId, ratio: image.width / image.height, title: title.textContent, caption: el.querySelector('.tile__pop').textContent, box: el.getBoundingClientRect().toJSON(), titleBox: title.getBoundingClientRect().toJSON() };
          }) }));
        assert.equal(detail.cards.length, 8); assert.equal(detail.overflow, false); assert.ok(detail.columns >= 2);
        for (const item of detail.cards) {
          assert.ok(Math.abs(item.ratio - 4 / 3) < .02); assert.ok(item.title.trim());
          assert.ok(item.titleBox.left >= item.box.left && item.titleBox.right <= item.box.right + 1);
          assert.ok(item.caption.includes(initial.find(p => p.id === item.id).domain));
        }
        await unobstructed(page); layouts.push(detail);
      }
      await page.setViewportSize({ width: 1365, height: 900 }); await search(page).focus(); await page.mouse.move(0, 0);
      await page.locator('main').evaluate(el => { el.scrollTop = 0; }); await shot(page, 'g5-library-8-records');
      assert.deepEqual(sorted((await getState()).posts), initial);
      return measured('library-desktop', layouts);
    });

    await check('C7 integrated top bar, SQLite placement and keyboard menu', async () => {
      await page.setViewportSize({ width: 1365, height: 900 }); await page.goto(origin + '/library'); await saved(8); await settled(page);
      const wide = await topBarGeometry(page); await shot(page, 'g5-top-bar');
      await search(page).focus(); await page.keyboard.press('Shift+Tab');
      await tabTo(page, menu(page)); await page.keyboard.press('Enter');
      const dropdown = page.getByRole('menu', { name: 'Menu' }); await dropdown.waitFor();
      assert.ok(await dropdown.getByRole('menuitem', { name: /^Settings/ }).isVisible());
      await page.keyboard.press('Escape'); await dropdown.waitFor({ state: 'detached' });
      await tabTo(page, sections(page).getByRole('link', { name: 'All shelves' })); await page.keyboard.press('Enter');
      await page.waitForURL(/\/shelves$/); await page.getByRole('heading', { name: 'All shelves' }).waitFor();
      await page.goto(origin + '/library'); await saved(8);
      return measured('top-bar', wide);
    });

    await check('C7 integrated narrow-window boundaries keep the bar whole and the preferences', async () => {
      const measurements = [];
      const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1') || '{}').state);
      for (const width of [1101, 1100, 1099, 721, 720, 719]) {
        await page.setViewportSize({ width, height: 900 }); await settled(page);
        const detail = await topBarGeometry(page); await unobstructed(page);
        measurements.push({ width, barHeight: detail.bar.height, controls: detail.controls.length });
      }
      assert.ok(measurements.find(m => m.width === 1099).barHeight > measurements.find(m => m.width === 1101).barHeight, 'the bar wraps into two rows in a narrow window');
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1') || '{}').state), prefs);
      await page.setViewportSize({ width: 1365, height: 900 });
      assert.deepEqual(sorted((await getState()).posts), initial);
      return measured('narrow-window-boundaries', measurements);
    });

    await check('C7 integrated backend-unavailable cache is clearly labeled and remains browsable', async () => {
      try {
        await setApiOffline(true); await page.goto(origin + '/');
        await status(page).filter({ hasText: 'SQLite unavailable' }).waitFor();
        assert.match(await status(page).innerText(), /browser cache/); assert.doesNotMatch(await status(page).innerText(), /Library saved to SQLite/);
        assert.equal((await getState()).demo, false); assert.deepEqual(sorted((await getState()).posts), initial);
        await shot(page, 'g5-degraded'); await sections(page).getByRole('link', { name: 'All shelves' }).click();
        await page.getByRole('link', { name: /^All saved / }).click();
        await search(page).fill(initial[0].title); await settled(page); assert.equal(await cards(page).count(), 1);
        await search(page).fill(''); await settled(page); assert.equal(await cards(page).count(), 8);
      } finally { await setApiOffline(false); await page.reload(); await saved(8); }
      assert.deepEqual(sorted((await getState()).posts), initial);
      return 'Actual imported 8 retained; clear browser-cache/unavailable status; title search and clearing still work';
    });

    const visualPosts = clone(initial).map((post, i) => ({ ...post, status: 'inbox', ...(i < 3 ? { thumbnailUrl: ['/__fixture/preview.svg', '/__fixture/broken.svg', '/__fixture/tiny.svg'][i] } : {}) }));
    await check('C7 local preview success/broken/tiny/missing fallbacks preserve title and actions', async () => variant('preview-variants', visualPosts, async p => {
      await p.goto(origin + '/library'); await saved(8);
      const measurements = [];
      for (let i = 0; i < 4; i++) {
        const post = visualPosts[i]; const target = card(p, post); await target.scrollIntoViewIfNeeded();
        if (i === 0) {
          await target.locator('img.is-loaded').waitFor();
          const image = await target.locator('img').evaluate(el => ({ naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, fit: getComputedStyle(el).objectFit, opacity: getComputedStyle(el).opacity }));
          assert.equal(image.naturalWidth, 640); assert.ok(image.naturalHeight >= 80); assert.equal(image.fit, 'cover'); assert.equal(image.opacity, '1'); measurements.push(image);
        } else { await target.getByLabel('No content preview available').waitFor(); assert.equal(await target.locator('img').count(), 0); }
        assert.ok((await target.locator('.tile__title').innerText()).includes(post.title));
      }
      return measured('preview-variants', measurements);
    }));

    for (const reducedMotion of ['no-preference', 'reduce']) await check('C7 sort deck triage ' + reducedMotion, async () => variant('triage-' + reducedMotion, visualPosts, async p => {
      const deck = p.getByRole('region', { name: 'New to sort' }); await deck.locator('article[data-post-id]').waitFor();
      if (reducedMotion === 'reduce') assert.equal(await deck.locator('.deck__card').evaluate(el => getComputedStyle(el).animationName), 'none');
      const queue = [...visualPosts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), transitions = [];
      for (const [i, [action, label]] of [['reference', 'Keep'], ['archived', 'Archive'], ['to-review', 'Later']].entries()) {
        const post = queue[i];
        await deck.locator(`article[data-post-id="${post.id}"]`).waitFor();
        await deck.getByRole('button', { name: new RegExp('^' + label + ':') }).click();
        await p.waitForFunction(([id, action]) => JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p => p.id === id)?.status === action, [post.id, action]);
        transitions.push({ id: post.id, action });
      }
      await measured('triage-' + reducedMotion, transitions);
    }, { reducedMotion }));

    await check('C7 zero-inbox retains useful Library path and eight curated records', async () => variant('zero-inbox', clone(initial).map(post => ({ ...post, status: post.status === 'inbox' ? 'reference' : post.status })), async p => {
      await p.getByRole('region', { name: 'New to sort' }).getByText('Nothing new to sort.').waitFor();
      assert.doesNotMatch(await p.locator('main').innerText(), /Your library is empty/);
      assert.ok(await p.locator('.shelf-row .row-card').count() > 0, 'the shelves still show as rows');
      await shot(p, 'g5-zero-inbox', 'local API presentation variant');
      await p.goto(origin + '/library'); assert.equal(await cards(p).count(), 8); assert.equal((await state(p)).posts.length, 8);
    }));

    await check('C7 true empty library is distinct from retained library and sample data', async () => variant('empty-library', [], async p => {
      await p.getByRole('heading', { name: 'Your library is empty', exact: true }).waitFor();
      assert.equal((await state(p)).demo, false); assert.equal(await cards(p).count(), 0);
      assert.doesNotMatch(await p.locator('main').innerText(), /sample library|demo only/i);
      const [health] = await Promise.all([
        p.waitForResponse(response => new URL(response.url()).pathname === '/api/stats' && response.request().method() === 'GET'),
        p.getByRole('button', { name: 'Import links', exact: true }).click(),
      ]);
      assert.equal(health.status(), 200);
      assert.equal(await p.getByLabel('Choose a file to import').count(), 1); assert.equal(await p.getByLabel('Import Telegram JSON').count(), 1);
    }));

    await check('C7 fresh unavailable backend labels samples as demo, never personal imports', async () => variant('unavailable-demo', [], async p => {
      await p.locator('main').getByRole('status').filter({ hasText: 'Sample library' }).waitFor();
      assert.equal((await state(p)).demo, true); assert.match(await p.locator('main').innerText(), /not your imported content and are not saved to SQLite/);
      assert.match(await status(p).innerText(), /Demo only.*not saved to SQLite/);
      assert.equal(await p.getByRole('region', { name: 'New to sort' }).locator('article[data-post-id]').count(), 1);
      assert.match(await p.getByRole('region', { name: 'New to sort' }).innerText(), /1 of 5/);
    }, { unavailable: true }));

    await check('C7 presentation work preserves actual integrated browser/API/SQLite state', async () => {
      await page.setViewportSize({ width: 1365, height: 900 }); await page.goto(origin + '/library'); await saved(8);
      assert.deepEqual(sorted((await getState()).posts), initial);
      const sqlite = await snapshot(); assert.deepEqual(sorted(sqlite.posts), initial);
      return { count: 8, exactDocumentsPreserved: true, variantContextsClosed: report.contextsClosed };
    });
  } finally {
    await writeFile(join(evidenceDir, 'presentation-results.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
