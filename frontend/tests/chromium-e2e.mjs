import {malformed,wrap,node} from './chromium-cases.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
assert.ok(process.env.B2_RUN);
const output = await mkdtemp(join(process.env.B2_RUN, 'b2-'));
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
const saved = async count => {
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  await page.waitForFunction(count => {
    const s=JSON.parse(localStorage.getItem('library-store-v1')).state;
    // This scenario starts empty: every row was genuinely imported here.
    return s.posts.length===count && !Object.keys(s.pending).length
      && s.posts.every(p=>['enriched','failed'].includes(p.metadataStatus));
  }, count);
};
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
  const fixtures=join(root,'frontend/tests/fixtures');
  const nativeFile=join(fixtures,'chromium-bookmarks.json');
  const raw=await readFile(nativeFile,'utf8');
  const nativeInput=()=>page.getByLabel('Select copied Chromium Bookmarks file');
  const nativeResult=()=>page.getByRole('status',{name:'Chromium import result'});
  const nativeButton=()=>page.getByRole('button',{name:'Import Chromium Bookmarks file',exact:true});
  const html=async(name,added)=>{await page.getByLabel('Import bookmarks HTML').setInputFiles(join(fixtures,`bookmarks-${name}.html`));await page.getByRole('status').filter({hasText:`Bookmark import complete — ${added} new`}).waitFor();};
  const telegram=async(added)=>{await page.getByLabel('Import Telegram JSON').setInputFiles(join(fixtures,'telegram-saved-messages.json'));await page.getByRole('status',{name:'Telegram import result'}).filter({hasText:`${added} new`}).waitFor();};
  const classified=()=>page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.every(p=>p.categoryMode));
  const capture=async name=>{await page.screenshot({path:join(output,name),animations:'disabled'});report.screenshots.push(name);};
  const importNative=async(content,pattern)=>{await nativeInput().setInputFiles({name:'Bookmarks',mimeType:'application/json',buffer:Buffer.from(content)});await nativeResult().filter({hasText:pattern}).waitFor();assert.equal(await nativeButton().isEnabled(),true);};
  await nativeButton().scrollIntoViewIfNeeded();await capture('b2-settings-import-control.png');
  await html('firefox',3);await saved(3);await html('chromium',2);await saved(5);await telegram(3);await classified();
  const imported=await snapshot('HTML5 + Telegram4 overlap =8',8);
  assert.equal(imported.filter(p=>p.telegramMessage?.id==='97001').length,2);
  const curated=structuredClone(imported);
  const overlap=curated.find(p=>p.url==='https://example.invalid/programming#typescript');
  const exercise=curated.find(p=>p.url==='http://example.invalid/exercise');
  for(const [p,category] of [[overlap,'other'],[exercise,'health-fitness']])Object.assign(p,{title:'Owner '+(p===overlap?'Programming':'Exercise'),userNotes:'Owner note '+category,tags:['MiXeD',category],favorite:true,status:'archived',categories:[category],categoryMode:'manual',categoryReview:false});
  await page.evaluate(async posts=>{const r=await fetch('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({posts,deletedUrls:[]})});if(!r.ok)throw Error('Curation fixture setup failed');},curated);
  await page.reload();const before=await snapshot('curated baseline8',8);assert.deepEqual(before,sorted(curated));
  pass('HTML Firefox3 + Chromium2 + Telegram3 =8; two links same Telegram message; curated baseline saved');
  const search=()=>page.getByPlaceholder('Search… ( / )');
  const vd=()=>page.getByRole('dialog',{name:'Saved Views',exact:true});
  const articles=()=>page.locator('main article');
  async function saveView(name,q,n=1){await search().fill(q);await page.waitForFunction(n=>document.querySelectorAll('main article').length===n,n);await page.getByRole('button',{name:'Saved Views',exact:true}).click();await vd().getByLabel('View name',{exact:true}).fill(name);await vd().getByRole('button',{name:'Save current',exact:true}).click();await vd().getByRole('status').filter({hasText:'View saved.'}).waitFor();await vd().getByRole('button',{name:'Close',exact:true}).click();}
  await page.goto(base+'/library');await saved(8);
  // Broad programming text also occurs in Travel's caption; use URL to isolate.
  await saveView('Native matching','native.example.invalid/programming',0);
  await saveView('Unchanged exercise','exercise');
  const views=(await state()).views;
  await page.goto(base+'/library/settings');await saved(8);
  for(const [name,content] of malformed){
    const localBefore=await state();const postsBefore=report.requests.filter(r=>r.method==='POST').length;
    await importNative(content,/empty|valid JSON|Unsupported|Invalid|No HTTP/);
    assert.deepEqual(await state(),localBefore,name);assert.deepEqual(await snapshot('invalid '+name,8),before,name);
    assert.equal(report.requests.filter(r=>r.method==='POST').length,postsBefore,name);
  }
  await nativeResult().scrollIntoViewIfNeeded();await capture('b2-import-error.png');
  pass('15 malformed/unsupported cases: readable error, exact browser state/API/SQLite and zero POST mutation');
  // Simulate an unreadable/locked selected file without accessing a live file.
  await page.evaluate(()=>{window.b2FileText=File.prototype.text;File.prototype.text=async()=>{throw Error('Synthetic locked file');};});
  await importNative(raw,/copied\/exported Bookmarks file/);assert.deepEqual(await snapshot('unreadable copy',8),before);
  await page.evaluate(()=>{File.prototype.text=window.b2FileText;delete window.b2FileText;});
  pass('unreadable selected file: copy/export guidance, no mutation or forced access');
  // Reach the actual button by Tab and activate its file chooser with Enter.
  let reachable=false;for(let i=0;i<160;i++){if(await nativeButton().evaluate(e=>e===document.activeElement)){reachable=true;break;}await page.keyboard.press('Tab');}
  assert.equal(reachable,true);
  const chooser=page.waitForEvent('filechooser');await page.keyboard.press('Enter');await (await chooser).setFiles(nativeFile);
  await nativeResult().filter({hasText:'3 valid unique links found, 2 new, 1 already present, 1 duplicate entries'}).waitFor();
  assert.match(await nativeResult().innerText(),/1 unsupported-scheme/);await classified();
  const first=await snapshot('native import10',10);
  for(const p of before)assert.deepEqual(first.find(q=>q.id===p.id),p);
  const programming=first.find(p=>p.url.includes('native.example.invalid/programming'));
  const cooking=first.find(p=>p.url==='https://native.example.invalid/cooking');
  assert.equal(programming.title,'Programming JavaScript tutorial — supplied');assert.equal(cooking.title,'Cooking recipe kitchen — supplied');
  assert.equal(programming.canonicalUrl,'https://native.example.invalid/programming?lesson=1&lesson=2#code');
  assert.deepEqual(programming.categories,['technology']);assert.deepEqual(cooking.categories,['food-drink']);
  assert.equal(programming.source,'browser');assert.equal(cooking.source,'browser');
  await nativeResult().scrollIntoViewIfNeeded();await capture('b2-import-success.png');
  pass('keyboard chooser; nested3 unique, duplicate1, unsupported1, overlap1 ->2 new; supplied titles/query/fragment; keyword technology/food-drink; exact original8');
  await importNative(raw,/0 new, 3 already present/);await html('firefox',0);await html('chromium',0);await telegram(0);await classified();
  assert.deepEqual(await snapshot('all reimports10',10),first);assert.deepEqual((await state()).views,views);
  await page.reload();assert.deepEqual(await snapshot('reload10',10),first);
  pass('native + both HTML + Telegram reimport: exact10 IDs/documents; title/note/tag/favorite/status/manual/other preserved; reload durable');
  // Apply original definitions: a URL-specific view remains unchanged.
  await page.goto(base+'/library');await saved(10);
  async function applyView(name,n){await page.getByRole('button',{name:'Saved Views',exact:true}).click();await vd().getByLabel('Saved view',{exact:true}).selectOption({label:name});await vd().getByRole('button',{name:'Apply view',exact:true}).click();await page.waitForFunction(n=>document.querySelectorAll('main article').length===n,n);}
  await applyView('Unchanged exercise',1);await applyView('Native matching',1);
  assert.deepEqual((await state()).views,views);
  // Existing view criteria are dynamic: add a matching query/fragment URL variant.
  await page.goto(base+'/library/settings');await saved(10);
  const matching=wrap([node('https://native.example.invalid/programming#typescript','Programming dynamic tutorial')]);
  await importNative(matching,/1 new/);await classified();await snapshot('matching additional fixture11',11);
  await page.goto(base+'/library');await saved(11);await applyView('Native matching',2);await applyView('Unchanged exercise',1);
  assert.deepEqual((await state()).views,views);assert.ok(views.every(v=>!('postIds' in v)&&!('ids' in v)));
  pass('B4 dynamic definitions unchanged: matching view1→2 after native import, nonmatching exercise1; no member snapshots');
  await page.getByRole('button',{name:'Clear search and filters',exact:true}).click();await search().fill('native.example.invalid');
  await page.waitForFunction(()=>document.querySelectorAll('main article').length===3);await capture('b2-library-after-import.png');
  await page.locator(`main a[href="/library/item/${programming.id}"]`).click();
  await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();await page.reload();await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();
  await page.goto(base+'/');await saved(11);await page.locator('.catchup-card').first().waitFor();
  assert.deepEqual((await control('calls')).calls,[]);assert.equal(report.requests.filter(r=>r.url.endsWith('/api/telegram/refresh')).length,0);
  pass('Library domain search3/detail/deep refresh and Catch Up; no automatic Telegram calls');
  await page.goto(base+'/library/settings');await saved(11);
  const beforeFailure=await snapshot('before provider/write failure11',11);
  await control('mode:extra');await control('fail-on');
  const beforeUnsaved=report.requests.filter(r=>r.url.endsWith('/api/categorize')||r.url.endsWith('/api/enrich')).length;
  await importNative(wrap([node('https://native.example.invalid/unavailable','Unknown item')]),/1 new/);
  await page.getByRole('button',{name:'Retry SQLite save',exact:true}).waitFor();
  const failed=await state(),dbFailed=(await control('snapshot')).result;
  assert.equal(failed.posts.length,12);assert.deepEqual(sorted(dbFailed.posts),beforeFailure);assert.ok(Object.keys(failed.pending).length);
  const queued=failed.posts.find(p=>p.url.endsWith('/unavailable'));assert.ok(queued);assert.notEqual(queued.categoryMode,'automatic');assert.notEqual(queued.metadataStatus,'failed');
  assert.equal(report.requests.filter(r=>r.url.endsWith('/api/categorize')||r.url.endsWith('/api/enrich')).length,beforeUnsaved);
  report.snapshots.push({name:'provider503/write failure',browser:sorted(failed.posts),sqlite:dbFailed,pending:failed.pending});
  await control('fail-off');await page.getByRole('button',{name:'Retry SQLite save',exact:true}).click();await classified();
  const recovered=await snapshot('retry12',12);for(const p of beforeFailure)assert.deepEqual(recovered.find(q=>q.id===p.id),p);
  const fallback=recovered.find(p=>p.id===queued.id);assert.deepEqual(fallback.categories,['other']);assert.equal(fallback.categoryReview,true);assert.equal(fallback.metadataStatus,'failed');
  pass('unsaved row sends no categorize/enrich; SQLite pending DB11 unchanged; Retry saves12, classifier other/review and metadata failed, no curation loss');
  await control('mode:normal');
  const count=report.requests.filter(r=>r.url.endsWith('/api/telegram/refresh')).length;
  await refresh(/5 new links/);await classified();const live=await snapshot('mock refresh17',17);
  for(const p of recovered)assert.deepEqual(live.find(q=>q.id===p.id),p);
  assert.equal(live.filter(p=>p.telegramMessage?.id==='503').length,2);
  assert.equal(report.requests.filter(r=>r.url.endsWith('/api/telegram/refresh')).length,count+1);
  pass('B1 explicit mocked refresh adds5 (one existing reference), multi-link503 retained; original12 exact');
  for(const width of [1365,768,390,320]){
    await page.setViewportSize({width,height:900});await nativeButton().scrollIntoViewIfNeeded();
    const g=await nativeButton().boundingBox();assert.ok(g.x>=0&&g.x+g.width<=width+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await capture(`b2-settings-${width}.png`);
  }
  pass('responsive Settings1365/768/390/320: native import control contained, no document overflow');
  assert.equal(await readFile(nativeFile,'utf8'),raw);assert.deepEqual(report.errors,[]);assert.deepEqual(report.denied,[]);
  const metadataRequests=report.requests.filter(r=>r.url.endsWith('/api/enrich'));
  assert.equal(metadataRequests.length,live.length);assert.ok(metadataRequests.every(r=>r.method==='POST'));
  assert.deepEqual(metadataRequests.map(r=>JSON.parse(r.body).url).sort(),live.map(p=>p.url).sort());
  assert.ok(live.every(p=>p.metadataStatus==='failed'));
  assert.ok(report.requests.every(r=>!r.url.includes('/thumb/')));
  assert.ok(report.responses.every(r=>r.status===503&&['/api/library','/api/categorize','/api/enrich'].some(p=>r.url.endsWith(p))));
  assert.deepEqual((await control('snapshot')).result.blocked,[]);
  report.finalViews=(await state()).views;assert.deepEqual(report.finalViews,views);
  pass('source file unchanged; one metadata503 per new URL, no repeat/startup sweep; no external/profile/provider/cache requests; guarded SQLite only');

} catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);}
finally{
  if(browser){await browser.close();report.browserClosed=true;}
  if(child&&child.exitCode===null)child.stdin.end('{"command":"stop"}\n');
  if(exited){const [code]=await exited;report.fixtureExit=code;if(code!==0)process.exitCode=1;}
  await writeFile(join(output,'runtime.json'),JSON.stringify(report,null,2));console.log('Evidence',output);
}
