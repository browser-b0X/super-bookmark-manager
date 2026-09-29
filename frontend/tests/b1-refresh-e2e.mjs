import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
assert.ok(process.env.B1_RUN);
const output = await mkdtemp(join(process.env.B1_RUN, 'browser-'));
const { chromium } = createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE);
const seed = JSON.parse(await readFile(join(root, 'frontend/tests/fixtures/retrieval-library.json'), 'utf8'));
for (const p of seed) delete p.thumbnailUrl;
const travel = seed.find(p => p.url.includes('journeys.'));
const reference = seed.find(p => p.url === 'https://example.invalid/reference');
for (const [p, category] of [[travel, 'travel'], [reference, 'other']]) {
  Object.assign(p, { title: 'Owner title ' + category, userNotes: 'Owner note ' + category, tags: ['MiXeD', category], favorite: true,
    status: 'archived', categories: [category], categoryMode: 'manual', categoryReview: false });
}
const sorted = posts => [...posts].sort((a,b) => a.id.localeCompare(b.id));
const report = { results: [], events: [], requests: [], responses: [], snapshots: [], errors: [], denied: [], screenshots: [] };
const pending = new Map();
let child, exited, browser, context, page, base;
const control = command => new Promise(resolve => { pending.set(command, resolve); child.stdin.write(JSON.stringify({ command }) + '\n'); });
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state);
const baselineIds = process.argv[2] === 'files' ? [] : seed.map(p => p.id);
const saved = async count => {
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  await page.waitForFunction(({count, baselineIds}) => {
    const s=JSON.parse(localStorage.getItem('library-store-v1')).state;
    return s.posts.length===count && !Object.keys(s.pending).length
      && s.posts.every(p=>baselineIds.includes(p.id)||['enriched','failed'].includes(p.metadataStatus));
  }, {count, baselineIds});
};
const enrichmentRequests = () => report.requests.filter(r=>r.url.endsWith('/api/enrich'));
function assertNewOnlyMetadata(posts) {
  const added=posts.filter(p=>!baselineIds.includes(p.id));
  const requests=enrichmentRequests();
  assert.equal(requests.length,added.length);
  assert.ok(requests.every(r=>r.method==='POST'));
  assert.deepEqual(requests.map(r=>JSON.parse(r.body).url).sort(),added.map(p=>p.url).sort());
  assert.ok(added.every(p=>p.metadataStatus==='failed'));
}
async function snapshot(name, count) {
  await saved(count);
  const sqlite = (await control('snapshot')).result;
  const local = await state();
  const api = await page.evaluate(async () => (await (await fetch('/api/library')).json()));
  assert.deepEqual(sorted(local.posts), sorted(sqlite.posts)); assert.deepEqual(sorted(api.posts), sorted(sqlite.posts));
  assert.equal(sqlite.legacyCount, 0); assert.deepEqual(sqlite.blocked, []);
  const entry = { name, browser: sorted(local.posts), api, sqlite, pending: local.pending };
  report.snapshots.push(entry); return entry.browser;
}
const result = () => page.getByRole('status', { name: 'Telegram refresh result' });
const button = () => page.getByRole('button', { name: 'Refresh Telegram Saved Messages', exact: true });
async function refresh(pattern) {
  await button().click(); await result().filter({ hasText: pattern }).waitFor();
  assert.equal(await button().isEnabled(), true);
  return await result().innerText();
}
async function snap(name) {
  await button().scrollIntoViewIfNeeded();
  await page.screenshot({path: join(output,name), animations:'disabled'}); report.screenshots.push(name);
}
function pass(name, detail) { report.results.push({name,status:'PASS',detail}); console.log('PASS',name); }
try {
  child = spawn(process.env.C6_PYTHON, ['-B',join(root,'frontend/tests/b1_fixture.py'),join(output,'fixture.sqlite'),'0'],
    {cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',TELEGRAM_API_ID:'0',TELEGRAM_API_HASH:'',MAX_MESSAGES:'200'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  exited=once(child,'exit'); child.stderr.on('data', bytes=>void appendFile(join(output,'server.txt'),bytes));
  const ready=await new Promise((resolve,reject)=>{
    child.once('error',reject); child.once('exit',code=>reject(new Error('Fixture exited '+code)));
    createInterface({input:child.stdout}).on('line',line=>{ const data=JSON.parse(line); report.events.push(data);
      if(data.ready)resolve(data); if(data.command){pending.get(data.command)?.(data);pending.delete(data.command);} });
  });
  base=`http://127.0.0.1:${ready.port}`; report.origin=base;
  browser=await chromium.launch({headless:true,channel:'msedge'});
  context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{ const url=new URL(route.request().url());
    if(url.origin!==base){report.denied.push(url.href);return route.abort();} return route.continue(); });
  page=await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('request',r=>report.requests.push({url:r.url(),method:r.method(),body:r.postData()}));
  page.on('response',r=>{if(r.status()>=400)report.responses.push({url:r.url(),status:r.status()});});
  await page.goto(base+'/library/settings');
  await page.getByRole('status',{name:'SQLite save status'}).filter({hasText:/^Library saved to SQLite$/}).waitFor();
  assert.deepEqual((await control('calls')).calls,[]);
  assert.equal(report.requests.filter(r=>r.url.endsWith('/api/telegram/refresh')).length,0);
  if (process.argv[2] === 'files') {
    const fixtures=join(root,'frontend/tests/fixtures');
    const bookmarkInput=page.getByLabel('Import bookmarks HTML');
    const jsonInput=page.getByLabel('Import Telegram JSON');
    for(const [name,added] of [['firefox',3],['chromium',2]]){
      await bookmarkInput.setInputFiles(join(fixtures,`bookmarks-${name}.html`));
      await page.getByRole('status').filter({hasText:`Bookmark import complete — ${added} new`}).waitFor();
    }
    await saved(5);
    await jsonInput.setInputFiles(join(fixtures,'telegram-saved-messages.json'));
    await page.getByRole('status',{name:'Telegram import result'}).filter({hasText:'3 new, 1 already present'}).waitFor();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.every(p=>p.categoryMode==='automatic'));
    const imported=await snapshot('file-imports',8);
    assert.equal(imported.filter(p=>p.telegramMessage?.id==='97001').length,2);
    for(const name of ['firefox','chromium']){
      await bookmarkInput.setInputFiles(join(fixtures,`bookmarks-${name}.html`));
      await page.getByRole('status').filter({hasText:'Bookmark import complete — 0 new'}).waitFor();
    }
    await jsonInput.setInputFiles(join(fixtures,'telegram-saved-messages.json'));
    await page.getByRole('status',{name:'Telegram import result'}).filter({hasText:'0 new, 4 already present'}).waitFor();
    assert.deepEqual(await snapshot('file-reimports',8),imported);
    assert.deepEqual((await control('calls')).calls,[]);
    assert.equal(report.requests.filter(r=>r.url.endsWith('/api/telegram/refresh')).length,0);
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.denied,[]);
    pass('fresh-built HTML5 + JSON4 with overlap =8; multi-link retained; reimport8 exact; no live auth/refresh');
  } else {
  await page.evaluate(async posts=>{ const r=await fetch('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({posts,deletedUrls:[]})});if(!r.ok)throw new Error('Seed failed'); },seed);
  await page.reload(); await saved(8); await snap('refresh-idle.png');
  assert.deepEqual((await control('calls')).calls,[]);
  const before=await snapshot('before-refresh',8); assert.deepEqual(before,sorted(seed));
  pass('explicit control; startup/settings/reload never invoke Telegram; seed 8', {limit:200});
  const text=await refresh(/4 new links/);
  assert.match(text,/Checked 200 messages \(limit 200\)/); assert.match(text,/2 already present/);
  assert.match(text,/1 duplicate occurrences/); assert.match(text,/1 unsupported targets/); assert.match(text,/1 malformed messages/);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.filter(p=>p.url.includes('live.example')).every(p=>p.categoryMode==='automatic'));
  const first=await snapshot('first-refresh',12);
  for(const p of before) assert.deepEqual(first.find(q=>q.id===p.id),p);
  const expected={cooking:'food-drink',programming:'technology',exercise:'health-fitness',art:'arts-culture'};
  for(const [path,category] of Object.entries(expected)){
    const p=first.find(p=>p.url==='https://live.example.invalid/'+path); assert.ok(p); assert.deepEqual(p.categories,[category]);
    assert.equal(p.source,'telegram'); assert.ok(p.sourceMessageId); assert.equal(p.createdAt,'2026-09-24T00:00:00+00:00'); assert.ok(p.telegramMessage.text);
  }
  assert.equal(new Set(first.map(p=>p.id)).size,12);
  assert.ok(!first.some(p=>p.url.includes('outside-window')||p.url.startsWith('ftp:')));
  await snap('refresh-success.png');
  pass('200-message bound; dedupe/multi-link/labeled/linkless/unsupported/malformed; source data; new-only local categories',text);
  pass('all existing complete documents retained, including manual other, title, note, tag, favorite, archive and ID');
  const classifyCount=report.requests.filter(r=>r.url.endsWith('/api/categorize')).length;
  await refresh(/0 new links/); const repeated=await snapshot('repeat-refresh',12); assert.deepEqual(repeated,first);
  assert.equal(report.requests.filter(r=>r.url.endsWith('/api/categorize')).length,classifyCount);
  pass('repeat adds 0; exact 12 documents unchanged; no existing record recategorized');
  for(const [mode,pattern] of [['missing',/needs Telethon/],['unauthorized',/not authorized/],['network',/failed or timed out/],['malformed',/only malformed/],['empty',/Checked 0 messages/]]){
    await control('mode:'+mode); await refresh(pattern); assert.deepEqual(await snapshot(mode,12),first);
    if(mode==='missing')await snap('refresh-telethon-error.png');
    if(mode==='unauthorized')await snap('refresh-session-error.png');
    pass(mode+' controlled result; library unchanged');
  }
  await control('mode:extra'); await control('fail-on');
  const beforeUnsaved=report.requests.filter(r=>r.url.endsWith('/api/categorize')||r.url.endsWith('/api/enrich')).length;
  await refresh(/1 new links/);
  await page.getByRole('button',{name:'Retry SQLite save',exact:true}).waitFor();
  const unsaved=await state(), failedDb=(await control('snapshot')).result;
  assert.equal(unsaved.posts.length,13); assert.ok(Object.keys(unsaved.pending).length);
  assert.deepEqual(sorted(failedDb.posts),first);
  const queued=unsaved.posts.find(p=>p.url.includes('/provider-failure')); assert.ok(queued);
  assert.notEqual(queued.categoryMode,'automatic'); assert.notEqual(queued.metadataStatus,'failed');
  report.snapshots.push({name:'failed-write',browser:sorted(unsaved.posts),pending:unsaved.pending,sqlite:failedDb});
  await snap('refresh-pending-failure.png');
  assert.equal(report.requests.filter(r=>r.url.endsWith('/api/categorize')||r.url.endsWith('/api/enrich')).length,beforeUnsaved);
  pass('SQLite failure stays pending, DB12 unchanged; unsaved new item13 sends no categorize/enrich request');
  await control('fail-off'); await page.getByRole('button',{name:'Retry SQLite save',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p=>p.url.includes('/provider-failure'))?.categoryMode==='automatic');
  const recovered=await snapshot('retry-saved',13);
  const fallback=recovered.find(p=>p.id===queued.id); assert.deepEqual(fallback.categories,['other']); assert.equal(fallback.categoryReview,true); assert.equal(fallback.metadataStatus,'failed');
  for(const p of first) assert.deepEqual(recovered.find(q=>q.id===p.id),p);
  await page.reload(); assert.deepEqual(await snapshot('reload',13),recovered);
  await control('mode:normal');
  await page.goto(base+'/library'); await saved(13);
  const search=page.getByPlaceholder('Search… ( / )'); await search.fill('Owner title travel');
  await page.waitForFunction(()=>document.querySelectorAll('main article').length===1);
  await page.locator(`main a[href="/library/item/${travel.id}"]`).click();
  const dialog=page.getByRole('dialog',{name:'Saved post detail'}); await dialog.waitFor();
  assert.ok((await dialog.innerText()).includes('Owner title travel'));
  assert.equal(await dialog.locator('textarea').inputValue(),travel.userNotes);
  await dialog.getByTitle('Close',{exact:true}).click(); await search.fill('');
  await page.waitForFunction(()=>document.querySelectorAll('main article').length===13);
  const calls=(await control('calls')).calls.length;
  await page.goto(base+'/'); await saved(13); await page.locator('.catchup-card').first().waitFor();
  assert.equal((await control('calls')).calls.length,calls);
  assert.deepEqual(await snapshot('sanity-end',13),recovered);
  pass('Retry/reload durable13; Library title search/detail note/reset and Catch Up; no auto Telegram');
  assert.deepEqual(report.errors,[]); assert.deepEqual(report.denied,[]);
  }
  assertNewOnlyMetadata((await state()).posts);
  assert.ok(report.requests.every(r=>!r.url.includes('/thumb/')));
  assert.ok(report.responses.every(r=>r.status===503 && ['/api/telegram/refresh','/api/library','/api/categorize','/api/enrich'].some(p=>r.url.endsWith(p))));
  assert.deepEqual((await control('snapshot')).result.blocked,[]);
  pass('exactly one metadata503 per genuinely new URL; no existing-row/startup/reimport enrichment; no external/session/provider/personal data access');
} catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);}
finally{
  if(browser){await browser.close();report.browserClosed=true;}
  if(child&&child.exitCode===null)child.stdin.end('{"command":"stop"}\n');
  if(exited){const [code]=await exited;report.fixtureExit=code;if(code!==0)process.exitCode=1;}
  await writeFile(join(output,'runtime.json'),JSON.stringify(report,null,2));console.log('Evidence',output);
}
