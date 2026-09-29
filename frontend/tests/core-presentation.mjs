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
  const menu = p => p.locator('header').getByRole('button', { name: 'Menu', exact: true, includeHidden: true });
  const navigation = p => p.getByRole('dialog', { name: 'Mobile navigation', exact: true });
  const settled = p => p.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})));
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
    const blocked = await p.locator('main a, main button, main select, .sidebar-footer a, .sidebar-footer button').evaluateAll(elements => elements.flatMap(el => {
      const style = getComputedStyle(el);
      if (el.closest('[inert]') || style.visibility !== 'visible' || style.opacity === '0') return [];
      const r = el.getBoundingClientRect();
      let left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(60, r.top), bottom = Math.min(innerHeight - 10, r.bottom);
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
  async function expand(p, post) {
    await card(p, post).locator('[data-expand]').focus();
    await p.waitForFunction(id => document.querySelector('.catchup-card.is-expanded')?.dataset.postId === id, post.id);
    await card(p, post).scrollIntoViewIfNeeded(); await settled(p);
  }
  async function collapseTo(p, collapsed) {
    const current = await p.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1') || '{}').state?.sidebarCollapsed || false);
    if (current !== collapsed) await p.getByTitle(collapsed ? 'Collapse' : 'Expand', { exact: true }).click();
    await settled(p);
    assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state.sidebarCollapsed), collapsed);
  }
  async function sidebarGeometry(p, collapsed) {
    const detail = await p.getByRole('complementary', { name: 'Navigation', exact: true }).evaluate(sidebar => {
      const rect = el => el.getBoundingClientRect().toJSON();
      const status = sidebar.querySelector('[role="status"]'), footer = sidebar.querySelector('.sidebar-footer');
      const overlays = [];
      for (let node = status; node && node !== sidebar; node = node.parentElement) {
        if (['absolute', 'fixed', 'sticky'].includes(getComputedStyle(node).position)) overlays.push(node.className);
      }
      return { sidebar: rect(sidebar), status: rect(status), footer: rect(footer), overlays,
        main: rect(document.querySelector('main')), header: rect(document.querySelector('.shell-topbar')),
        overflow: document.documentElement.scrollWidth > innerWidth,
        widths: [sidebar, status, footer].map(el => ({ scroll: el.scrollWidth, client: el.clientWidth })),
        controls: [...footer.querySelectorAll('a,button')].map(el => {
          const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { title: el.title, rect: rect(el), hit: !!hit && el.contains(hit), visibility: getComputedStyle(el).visibility };
        }) };
    });
    assert.equal(detail.sidebar.width, collapsed ? 56 : 236);
    assert.equal(detail.main.x, detail.sidebar.right); assert.equal(detail.header.x, detail.sidebar.right);
    assert.equal(detail.overflow, false); assert.deepEqual(detail.overlays, []);
    assert.ok(detail.status.x >= detail.sidebar.x && detail.status.right <= detail.sidebar.right);
    assert.ok(detail.status.bottom <= detail.footer.top);
    for (const width of detail.widths) assert.ok(width.scroll <= width.client + 1);
    assert.deepEqual(detail.controls.map(c => c.title), ['Settings', 'Toggle theme', collapsed ? 'Expand' : 'Collapse']);
    for (const c of detail.controls) {
      assert.equal(c.hit, true, c.title + ' hit target'); assert.equal(c.visibility, 'visible');
      assert.ok(c.rect.x >= detail.footer.x && c.rect.right <= detail.footer.right);
      assert.ok(c.rect.top >= detail.footer.top && c.rect.bottom <= detail.footer.bottom);
    }
    if (collapsed) for (let i = 1; i < detail.controls.length; i++) assert.ok(detail.controls[i - 1].rect.bottom <= detail.controls[i].rect.top);
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
            assert.ok(['/api/library', '/api/stats', '/api/telegram/config', '/api/telegram/auth'].includes(url.pathname), 'Presentation fixture must not exercise unrelated APIs');
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
    await check('C7 integrated imported home: source/title/caption/state/actions and no obstruction', async () => {
      await page.setViewportSize({ width: 1365, height: 900 }); await page.goto(origin + '/'); await saved(8);
      const queue = initial.filter(p => p.status === 'inbox').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      assert.ok(queue.some(p => p.source === 'browser') && queue.some(p => p.source === 'telegram'));
      assert.deepEqual(await cards(page).evaluateAll(els => els.map(el => el.dataset.postId)), queue.map(p => p.id));
      const seen = [];
      for (const post of queue) {
        await expand(page, post); const target = card(page, post), text = await target.innerText();
        assert.ok(text.includes(post.title) && text.includes(post.domain) && text.includes(post.categories[0]) && text.includes('Inbox'));
        assert.ok(text.includes(post.source === 'browser' ? 'Browser bookmark' : 'Telegram'));
        const summary = post.description || post.aiSummary || post.excerpt;
        if (summary) assert.equal(await target.locator('.catchup-summary').innerText(), summary);
        assert.equal(await target.getByRole('link', { name: 'Open original' }).getAttribute('href'), post.url);
        assert.equal(await target.getByRole('link', { name: 'Details', exact: true }).getAttribute('href'), '/library/item/' + post.id);
        for (const name of ['Keep', 'Later', 'Archive']) assert.equal(await target.getByRole('button', { name, exact: true }).isVisible(), true);
        const title = await target.locator('.catchup-title').evaluate(el => ({ text: el.innerText, size: parseFloat(getComputedStyle(el).fontSize), box: el.getBoundingClientRect().toJSON() }));
        assert.ok(title.size >= 18 && title.box.width > 0 && title.box.height > 0);
        await unobstructed(page); seen.push({ id: post.id, source: post.source, title, caption: summary || null });
      }
      assert.equal(await page.getByRole('button', { name: /Search or jump to/ }).isVisible(), true);
      await expand(page, queue.find(p => p.source === 'telegram')); await shot(page, 'g5-home-populated');
      assert.deepEqual(sorted((await getState()).posts), initial);
      return measured('integrated-home', seen);
    });

    await check('C7 integrated Library landscape, captions, hover/focus and desktop responsiveness', async () => {
      await page.goto(origin + '/library'); await saved(8); await page.getByRole('radio', { name: 'grid', exact: true }).click();
      await settled(page); assert.equal(await cards(page).count(), 8);
      await page.mouse.move(0, 0); await search(page).focus();
      const withCaption = initial.find(p => p.description || p.userNotes || p.aiSummary || p.excerpt);
      assert.ok(withCaption); const target = card(page, withCaption), overlay = target.locator('.cell-overlay');
      assert.equal(await overlay.evaluate(el => getComputedStyle(el).opacity), '0');
      const before = await target.boundingBox(); await target.hover(); await settled(page);
      assert.equal(await overlay.evaluate(el => getComputedStyle(el).opacity), '1');
      assert.deepEqual(await target.boundingBox(), before, 'Hover does not shift the card');
      await page.mouse.move(0, 0); await search(page).focus();
      await tabTo(page, target.locator('.cell-title')); await settled(page);
      assert.equal(await target.locator('.cell-title').evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true);
      assert.equal(await overlay.evaluate(el => getComputedStyle(el).opacity), '1');
      const layouts = [];
      for (const width of [1365, 1024, 768]) {
        await page.setViewportSize({ width, height: 900 }); await settled(page);
        const detail = await page.locator('.cell-grid').evaluate(grid => ({ width: innerWidth, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          overflow: document.documentElement.scrollWidth > innerWidth,
          cards: [...grid.querySelectorAll('article')].map(el => {
            const image = el.querySelector('.cell-image').getBoundingClientRect(), caption = el.querySelector('.cell-caption'), title = caption.querySelector('.cell-title');
            return { id: el.dataset.postId, ratio: image.width / image.height, title: title.textContent, caption: caption.textContent, box: el.getBoundingClientRect().toJSON(), titleBox: title.getBoundingClientRect().toJSON() };
          }) }));
        assert.equal(detail.cards.length, 8); assert.equal(detail.overflow, false); assert.ok(detail.columns >= 2);
        for (const item of detail.cards) {
          assert.ok(Math.abs(item.ratio - 1.5) < .02); assert.ok(item.title.trim());
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

    await check('C7 integrated collapsed footer, SQLite placement and pointer/keyboard Expand', async () => {
      await collapseTo(page, true); const collapsed = await sidebarGeometry(page, true); await shot(page, 'g5-sidebar-collapsed');
      await page.getByTitle('Expand', { exact: true }).click(); await settled(page); await sidebarGeometry(page, false);
      await page.getByTitle('Collapse', { exact: true }).click(); await settled(page);
      const expandButton = page.getByTitle('Expand', { exact: true });
      await search(page).focus(); await tabTo(page, expandButton); await page.keyboard.press('Enter'); await settled(page);
      await sidebarGeometry(page, false); await tabTo(page, page.getByTitle('Collapse', { exact: true }));
      await page.keyboard.press('Space'); await settled(page); await sidebarGeometry(page, true);
      return measured('sidebar-collapsed', collapsed);
    });

    await check('C7 integrated 719/720/721 boundaries preserve both real-control preferences', async () => {
      const measurements = [];
      for (const collapsed of [false, true]) {
        await page.setViewportSize({ width: 1365, height: 900 }); await collapseTo(page, collapsed);
        const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state);
        for (const width of [719, 720]) {
          await page.setViewportSize({ width, height: 900 }); await settled(page);
          assert.equal(await menu(page).isVisible(), true); assert.equal(await navigation(page).isVisible(), false);
          await menu(page).click(); await navigation(page).waitFor();
          assert.equal(await navigation(page).getByText('Super Bookmark Manager', { exact: true }).isVisible(), true);
          assert.equal(await navigation(page).getByRole('button', { name: 'Close navigation', exact: true }).evaluate(el => el === document.activeElement), true);
          assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state), prefs);
          await page.setViewportSize({ width: 721, height: 900 }); await settled(page);
          assert.equal(await menu(page).isVisible(), false); assert.equal(await navigation(page).count(), 0);
          assert.equal(await page.locator('dialog:modal').count(), 0);
          const focus = await page.getByRole('complementary', { name: 'Navigation', exact: true }).evaluate(el => ({ width: el.getBoundingClientRect().width, focused: el.contains(document.activeElement), box: document.activeElement.getBoundingClientRect().toJSON() }));
          assert.equal(focus.width, collapsed ? 56 : 236); assert.equal(focus.focused, true); assert.ok(focus.box.width > 0 && focus.box.height > 0);
          assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state), prefs);
          measurements.push({ collapsed, from: width, to: 721, focus });
        }
      }
      await page.setViewportSize({ width: 1365, height: 900 }); await collapseTo(page, false);
      assert.deepEqual(sorted((await getState()).posts), initial);
      return measured('sidebar-boundaries', measurements);
    });

    await check('C7 integrated backend-unavailable cache is clearly labeled and remains browsable', async () => {
      try {
        await setApiOffline(true); await page.goto(origin + '/');
        await status(page).filter({ hasText: 'SQLite unavailable' }).waitFor();
        assert.match(await status(page).innerText(), /browser cache/); assert.doesNotMatch(await status(page).innerText(), /Library saved to SQLite/);
        assert.equal((await getState()).demo, false); assert.deepEqual(sorted((await getState()).posts), initial);
        await shot(page, 'g5-degraded'); await page.locator('main').getByRole('link', { name: 'Library', exact: true }).click();
        await search(page).fill(initial[0].title); await settled(page); assert.equal(await cards(page).count(), 1);
        await search(page).fill(''); await settled(page); assert.equal(await cards(page).count(), 8);
      } finally { await setApiOffline(false); await page.reload(); await saved(8); }
      assert.deepEqual(sorted((await getState()).posts), initial);
      return 'Actual imported 8 retained; clear browser-cache/unavailable status; title search and clearing still work';
    });

    const visualPosts = clone(initial).map((post, i) => ({ ...post, status: 'inbox', ...(i < 3 ? { thumbnailUrl: ['/__fixture/preview.svg', '/__fixture/broken.svg', '/__fixture/tiny.svg'][i] } : {}) }));
    await check('C7 local preview success/broken/tiny/missing fallbacks preserve title and actions', async () => variant('preview-variants', visualPosts, async p => {
      const measurements = [];
      for (let i = 0; i < 4; i++) {
        const post = visualPosts[i]; await expand(p, post); const target = card(p, post);
        if (i === 0) {
          await target.locator('img.is-loaded').waitFor();
          const image = await target.locator('img').evaluate(el => ({ naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, fit: getComputedStyle(el).objectFit, opacity: getComputedStyle(el).opacity }));
          assert.equal(image.naturalWidth, 640); assert.ok(image.naturalHeight >= 80); assert.equal(image.fit, 'cover'); assert.equal(image.opacity, '1'); measurements.push(image);
        } else { await target.getByLabel('No content preview available').waitFor(); assert.equal(await target.locator('img').count(), 0); }
        assert.ok((await target.locator('.catchup-title').innerText()).includes(post.title));
        assert.equal(await target.getByRole('link', { name: 'Open original' }).isVisible(), true); await unobstructed(p);
      }
      await expand(p, visualPosts[0]);
      return measured('preview-variants', measurements);
    }));

    for (const reducedMotion of ['no-preference', 'reduce']) await check('C7 Catch Up triage/Undo/focus ' + reducedMotion, async () => variant('triage-' + reducedMotion, visualPosts, async p => {
      const queue = [...visualPosts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), transitions = [];
      await p.mouse.move(0, 0);
      for (const action of ['reference', 'archived', 'to-review']) {
        const post = queue[0]; await expand(p, post);
        if (reducedMotion === 'reduce') {
          const duration = await card(p, post).evaluate(el => getComputedStyle(el).transitionDuration);
          assert.ok(duration.split(',').every(value => parseFloat(value) <= .001));
        }
        await tabTo(p, card(p, post).locator(`[data-triage="${action}"]`)); await p.keyboard.press('Enter');
        await card(p, post).waitFor({ state: 'detached' }); await settled(p);
        const focus = await p.evaluate(() => ({ id: document.activeElement?.closest('[data-post-id]')?.dataset.postId, action: document.activeElement?.getAttribute('data-triage'), inert: !!document.activeElement?.closest('[inert]') }));
        assert.deepEqual(focus, { id: queue[1].id, action, inert: false }); assert.equal((await state(p)).posts.find(post => post.id === queue[0].id).status, action);
        await p.getByRole('button', { name: 'Undo', exact: true }).click(); await card(p, post).waitFor(); await settled(p);
        assert.equal(await card(p, post).locator('[data-expand]').evaluate(el => el === document.activeElement), true);
        assert.equal((await state(p)).posts.find(post => post.id === queue[0].id).status, 'inbox'); transitions.push({ action, focus, undo: true });
      }
      const withoutTime = posts => sorted(posts).map(({ updatedAt, ...post }) => post);
      assert.deepEqual(withoutTime((await state(p)).posts), withoutTime(visualPosts));
      await measured('triage-' + reducedMotion, transitions);
    }, { reducedMotion }));

    await check('C7 zero-inbox retains useful Library path and eight curated records', async () => variant('zero-inbox', clone(initial).map(post => ({ ...post, status: post.status === 'inbox' ? 'reference' : post.status })), async p => {
      await p.getByRole('heading', { name: 'All caught up', exact: true }).waitFor();
      assert.match(await p.locator('main').innerText(), /8 saved links are still in your library/);
      assert.doesNotMatch(await p.locator('main').innerText(), /Your library is empty/);
      await shot(p, 'g5-zero-inbox', 'local API presentation variant');
      await tabTo(p, p.getByRole('link', { name: 'Browse the library', exact: true })); await p.keyboard.press('Enter');
      assert.equal(await cards(p).count(), 8); assert.equal((await state(p)).posts.length, 8);
    }));

    await check('C7 true empty library is distinct from retained library and sample data', async () => variant('empty-library', [], async p => {
      await p.getByRole('heading', { name: 'Your library is empty', exact: true }).waitFor();
      assert.equal((await state(p)).demo, false); assert.equal(await cards(p).count(), 0);
      assert.doesNotMatch(await p.locator('main').innerText(), /All caught up|sample library|demo only/i);
      const [health] = await Promise.all([
        p.waitForResponse(response => new URL(response.url()).pathname === '/api/stats' && response.request().method() === 'GET'),
        p.getByRole('link', { name: 'Import saved links', exact: true }).click(),
      ]);
      assert.equal(health.status(), 200);
      assert.equal(await p.getByLabel('Import bookmarks HTML').count(), 1); assert.equal(await p.getByLabel('Import Telegram JSON').count(), 1);
    }));

    await check('C7 fresh unavailable backend labels samples as demo, never personal imports', async () => variant('unavailable-demo', [], async p => {
      await p.locator('main').getByRole('status').filter({ hasText: 'Sample library' }).waitFor();
      assert.equal((await state(p)).demo, true); assert.match(await p.locator('main').innerText(), /not your imported content and are not saved to SQLite/);
      assert.match(await status(p).innerText(), /Demo only.*not saved to SQLite/);
      assert.equal(await cards(p).count(), 5);
      assert.match(await p.locator('.catchup-card.is-expanded .catchup-origin').innerText(), /^Sample/);
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
