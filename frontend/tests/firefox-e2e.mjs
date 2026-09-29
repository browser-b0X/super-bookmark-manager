import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
const evidence=join(root,'.verify/b2-firefox-places-20260925');
const output=await mkdtemp(join(evidence,'e2e-'));
const fixtures=join(evidence,'fixtures');
const {chromium}=createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE);
const report={checks:[],snapshots:[],events:[],errors:[],denied:[],screenshots:[]};
const sorted=posts=>[...posts].sort((a,b)=>a.id.localeCompare(b.id));
const pending=new Map();let seq=0,child,closed,browser,page,context,base,ready;
const bound=(promise,ms,name)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(name+' timeout')),ms);})]).finally(()=>clearTimeout(timer));};
function control(command){const id=++seq;return bound(new Promise(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({id,command})+'\n');}),10000,command).finally(()=>pending.delete(id));}
const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('library-store-v1')).state);
async function settled(n){await page.getByRole('status',{name:'SQLite save status'}).filter({hasText:/^Library saved to SQLite$/}).waitFor();await page.waitForFunction(n=>{const s=JSON.parse(localStorage.getItem('library-store-v1')).state;return s.posts.length===n&&!Object.keys(s.pending).length&&s.posts.every(p=>p.categoryMode&&['enriched','failed'].includes(p.metadataStatus));},n);}
async function snapshot(name,n){await settled(n);const local=await state();const db=(await control('snapshot')).result;const api=await page.evaluate(async()=> (await (await fetch('/api/library')).json()));assert.deepEqual(sorted(local.posts),sorted(db.posts));assert.deepEqual(sorted(api.posts),sorted(db.posts));assert.deepEqual(db.blocked,[]);assert.equal(db.legacyCount,0);report.snapshots.push({name,posts:sorted(local.posts)});return sorted(local.posts);}
const pass=name=>{report.checks.push({name,status:'PASS'});console.log('PASS',name);};
const input=()=>page.getByLabel('Select copied Firefox places.sqlite');
const button=()=>page.getByRole('button',{name:'Import Firefox bookmarks database copy',exact:true});
const result=()=>page.getByRole('status',{name:'Firefox import result'});
async function shot(name){await page.screenshot({path:join(output,name),animations:'disabled'});report.screenshots.push(name);}
async function select(name,pattern){await input().setInputFiles({name:name==='valid'?'places.sqlite':name,mimeType:'application/octet-stream',buffer:await readFile(join(fixtures,name))});await result().filter({hasText:pattern}).waitFor();assert.equal(await button().isEnabled(),true);}
async function newContext(){context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'});await context.route('**/*',route=>{const url=route.request().url();if(url===ready.preview)return route.fulfill({status:200,contentType:'image/png',body:Buffer.from(ready.png,'base64')});if(new URL(url).origin!==base){report.denied.push(url);return route.abort();}return route.continue();});page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));}
try{
  const beforeBytes=await readFile(join(fixtures,'valid'));report.copyHash=createHash('sha256').update(beforeBytes).digest('hex');
  let resolveReady;const readyPromise=new Promise(resolve=>{resolveReady=resolve;});
  child=spawn(process.env.C6_PYTHON,['-B',join(root,'frontend/tests/metadata_e2e_fixture.py'),join(output,'fixture.sqlite')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:output,TMP:output,FIREFOX_TEST:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',TELEGRAM_API_ID:'0',TELEGRAM_API_HASH:''}});
  closed=new Promise(resolve=>child.once('close',code=>{resolve(code);resolveReady({failed:code});}));
  child.on('error',e=>resolveReady({failed:e.message}));child.stderr.on('data',b=>void appendFile(join(output,'server.txt'),b));
  createInterface({input:child.stdout}).on('line',line=>{const data=JSON.parse(line);report.events.push(data.ready?{...data,png:'omitted synthetic image'}:data);if(data.ready)resolveReady(data);if(data.id)pending.get(data.id)?.(data);});
  ready=await bound(readyPromise,20000,'fixture');assert.ok(ready.ready,JSON.stringify(ready));base=`http://127.0.0.1:${ready.port}`;report.origin=base;
  browser=await chromium.launch({headless:true,channel:'msedge'});await newContext();await page.goto(base+'/library/settings');
  await page.getByRole('status',{name:'SQLite save status'}).filter({hasText:/^Library saved to SQLite$/}).waitFor();
  await button().scrollIntoViewIfNeeded();await shot('b2-firefox-settings-control.png');
  assert.equal(await input().getAttribute('accept'),null);assert.match(await page.locator('#firefox-import-hint').innerText(),/Only bookmarks are imported/);
  const originals=join(root,'frontend/tests/fixtures');
  for(const [name,n] of [['firefox',3],['chromium',5]]){await page.getByLabel('Import bookmarks HTML').setInputFiles(join(originals,`bookmarks-${name}.html`));await settled(n);}
  await page.getByLabel('Import Telegram JSON').setInputFiles(join(originals,'telegram-saved-messages.json'));await settled(8);
  const initial=await snapshot('HTML + Telegram8',8);
  const overlap=initial.find(p=>p.url==='https://example.invalid/programming#typescript');
  Object.assign(overlap,{title:'Owner title',userNotes:'Owner note',tags:['MiXeD'],favorite:true,status:'archived',categories:['other'],categoryMode:'manual',categoryReview:false});
  const exercise=initial.find(p=>p.url==='http://example.invalid/exercise');Object.assign(exercise,{categories:['health-fitness'],categoryMode:'manual',userNotes:'Second owner note'});
  await page.evaluate(async posts=>{const r=await fetch('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({posts,deletedUrls:[]})});if(!r.ok)throw Error('seed failed');},initial);
  await page.reload();const before=await snapshot('curated8',8);pass('Existing Firefox/Chromium HTML and Telegram JSON seed8; manual other and manual topical curation durable');
  // Save a criterion that matches the newly imported URLs, without member IDs.
  await page.goto(base+'/library');await page.getByPlaceholder('Search… ( / )').fill('metadata.fixture.test');
  await page.getByRole('button',{name:'Saved Views',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Saved Views',exact:true});
  await dialog.getByLabel('View name',{exact:true}).fill('Firefox dynamic');await dialog.getByRole('button',{name:'Save current',exact:true}).click();await dialog.getByRole('status').filter({hasText:'View saved.'}).waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).click();
  const views=(await state()).views;await page.goto(base+'/library/settings');
  for(const name of ['empty','not-sqlite','truncated','missing-bookmarks','missing-places','schema','bad-fk','view','malformed','unsupported']){
    await select(name,/empty|SQLite|schema|Malformed|Invalid|No HTTP/);assert.deepEqual(await snapshot(name,8),before,name);
  }
  await result().scrollIntoViewIfNeeded();await shot('b2-firefox-import-error.png');
  pass('10 empty/non-SQLite/truncated/missing/incompatible/bad-fk/malformed/unsupported cases: controlled and zero mutation');
  await page.evaluate(()=>{window.originalArrayBuffer=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async()=>{throw Error('synthetic locked file');};});
  await select('valid',/Firefox may still be using this database/);await page.evaluate(()=>{File.prototype.arrayBuffer=window.originalArrayBuffer;delete window.originalArrayBuffer;});assert.deepEqual(await snapshot('locked read',8),before);pass('Locked/unreadable selected-file simulation: guidance, no bypass or mutation');
  await select('duplicates',/1 valid unique bookmark URLs, 0 new, 1 already present, 4 duplicate/);assert.deepEqual(await snapshot('duplicate-only',8),before);pass('Duplicate-only copied database succeeds with zero additions and no curation changes');
  // Reach through keyboard and activate the native file picker.
  let reachable=false;for(let i=0;i<180;i++){if(await button().evaluate(e=>e===document.activeElement)){reachable=true;break;}await page.keyboard.press('Tab');}
  assert.ok(reachable);const chooser=page.waitForEvent('filechooser');await page.keyboard.press('Enter');await(await chooser).setFiles({name:'renamed-copy-no-extension',mimeType:'application/octet-stream',buffer:beforeBytes});
  await result().filter({hasText:'3 valid unique bookmark URLs, 2 new, 1 already present, 1 duplicate entries, 1 unsupported entries, 0 malformed entries, 3 history-only rows ignored'}).waitFor();
  const first=await snapshot('Firefox adds2 ->10',10);for(const old of before)assert.deepEqual(first.find(p=>p.id===old.id),old);
  const fresh=first.find(p=>p.url==='http://metadata.fixture.test/firefox?lesson=1&lesson=2#code');const untitled=first.find(p=>p.url==='http://metadata.fixture.test/classify-failure');
  assert.equal(fresh.canonicalUrl,fresh.url);assert.equal(fresh.title,'Cooking recipe supplied');assert.equal(fresh.source,'browser');assert.deepEqual(fresh.categories,['technology']);assert.equal(fresh.metadataStatus,'enriched');assert.match(fresh.description,/Firefox gzip/);assert.equal(fresh.thumbnailUrl,ready.preview);
  assert.equal(untitled.title,'Fetched Classifier failure title');assert.deepEqual(untitled.categories,['other']);assert.equal(untitled.categoryReview,true);assert.equal(untitled.metadataStatus,'enriched');
  assert.ok(first.every(p=>!p.url.includes('history-only.invalid')));await result().scrollIntoViewIfNeeded();await shot('b2-firefox-import-success.png');
  pass('Keyboard/renamed copy, nested3 unique, duplicate1, overlap1, unsupported1, history3 excluded; query/fragment retained; exact prior8');
  pass('Gzip description/image and untitled-title enrichment; supplied title retained; classifier failure independent and other/review honest');
  const eventCount=(await control('events')).httpRequests.length;
  await select('valid',/3 valid unique bookmark URLs, 0 new, 3 already present/);assert.deepEqual(await snapshot('reimport exact10',10),first);assert.equal((await control('events')).httpRequests.length,eventCount);assert.deepEqual((await state()).views,views);
  pass('Reimport exact10 including curation/manual other/IDs; no new enrichment requests; views unchanged');
  await page.goto(base+'/library');await page.getByRole('button',{name:'Saved Views',exact:true}).click();const viewsDialog=page.getByRole('dialog',{name:'Saved Views',exact:true});await viewsDialog.getByLabel('Saved view',{exact:true}).selectOption({label:'Firefox dynamic'});await viewsDialog.getByRole('button',{name:'Apply view',exact:true}).click();await viewsDialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelectorAll('main article').length===2);pass('Saved View dynamically contains2 Firefox records');
  const link=page.locator(`main a[href="/library/item/${fresh.id}"]`);await link.click();await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();await page.reload();await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();
  await page.waitForFunction(src=>[...document.images].some(img=>img.src===src&&img.complete&&img.naturalWidth===320),ready.preview);
  await page.goto(base+'/');assert.ok(await page.getByRole('link',{name:/library/i}).count());pass('Library result/detail direct refresh and decoded thumbnail; Catch Up reachable');
  await page.goto(base+'/library/settings');await select('failure',/1 valid unique bookmark URLs, 1 new/);const failed=await snapshot('failure retained11',11);assert.equal(failed.find(p=>p.url.endsWith('/failure')).metadataStatus,'failed');for(const old of first)assert.deepEqual(failed.find(p=>p.id===old.id),old);pass('Metadata503 does not roll back import or curation;11 durable');
  const backup=await page.evaluate(async()=>{const r=await fetch('/api/backup/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});return {code:r.status,body:await r.json()};});assert.equal(backup.code,200);report.backup=backup.body;
  await context.close();await newContext();await page.goto(base+'/library');assert.deepEqual(await snapshot('fresh browser11',11),failed);pass('Fresh browser exact11 recovery and backup export available');
  await page.goto(base+'/library/settings');for(const width of [1365,768,390,320]){await page.setViewportSize({width,height:900});await button().scrollIntoViewIfNeeded();const b=await button().boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width+1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}
  pass('Settings control contained at1365/768/390/320; no horizontal overflow');
  const events=await control('events');report.transport=events;for(const e of events.events.filter(e=>e.kind==='enrich-start'))assert.ok(e.durable,'enrich before durable');assert.ok(events.events.filter(e=>e.kind==='categorize').every(e=>e.keywordsOnly===true));assert.ok(events.connections.every(c=>c[0]==='93.184.216.34'));assert.deepEqual(report.denied,[]);assert.deepEqual(report.errors,[]);
  assert.equal(createHash('sha256').update(await readFile(join(fixtures,'valid'))).digest('hex'),report.copyHash);pass('Durable-before-category/enrich, keyword-only requests, public-fixture pinned transport, unchanged selected copy, zero denied access');
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e);if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}
finally{if(browser){await browser.close();report.browserClosed=true;}if(child?.exitCode===null)child.stdin.end(JSON.stringify({id:++seq,command:'stop'})+'\n');if(closed){report.fixtureExit=await bound(closed,15000,'cleanup');if(report.fixtureExit!==0)process.exitCode=1;}await writeFile(join(output,'runtime.json'),JSON.stringify(report,null,2));console.log('Evidence',output);}
