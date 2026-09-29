import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
assert.ok(process.env.B6_BACKUP_RUN);
const output=await mkdtemp(join(process.env.B6_BACKUP_RUN,'roundtrip-'));
const {chromium}=createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE);
const fixture=JSON.parse(await readFile(join(root,'frontend/tests/fixtures/backup-library.json'),'utf8'));
const sorted=posts=>[...posts].sort((a,b)=>a.id.localeCompare(b.id));
const report={results:[],events:[],snapshots:[],requests:[],errors:[],denied:[],screenshots:[]};
let child,exited,browser,page,context,base,port=0,db=join(output,'source.sqlite');
const pending=new Map();
const control=command=>new Promise(resolve=>{pending.set(command,resolve);child.stdin.write(JSON.stringify({command})+'\n');});
async function start(){
  child=spawn(process.env.C6_PYTHON,['-B',join(root,'frontend/tests/backup_fixture.py'),db,String(port)],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  exited=once(child,'exit');child.stderr.on('data',b=>void appendFile(join(output,'server.txt'),b));
  const ready=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error('Fixture exited '+code)));createInterface({input:child.stdout}).on('line',line=>{const d=JSON.parse(line);report.events.push(d);if(d.ready)resolve(d);if(d.command){pending.get(d.command)?.(d);pending.delete(d.command);}});});
  port=ready.port;base=`http://127.0.0.1:${port}`;
}
async function stop(){if(child?.exitCode===null)child.stdin.end('{"command":"stop"}\n');if(exited){const [code]=await exited;report.events.push({pid:child.pid,exit:code});exited=undefined;assert.equal(code,0);}}
async function fresh(){
  context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){report.denied.push(route.request().url());return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>report.requests.push({url:r.url(),method:r.method()}));
}
const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('library-store-v1')).state);
async function saved(n){await page.getByRole('status',{name:'SQLite save status'}).filter({hasText:/^Library saved to SQLite$/}).waitFor();await page.waitForFunction(n=>{const s=JSON.parse(localStorage.getItem('library-store-v1')).state;return s.posts.length===n&&!Object.keys(s.pending).length;},n);}
async function snapshot(name,n){await saved(n);const local=await state(),sqlite=(await control('snapshot')).result;const api=await page.evaluate(async()=> (await (await fetch('/api/library')).json()));assert.deepEqual(sorted(local.posts),sorted(sqlite.posts));assert.deepEqual(sorted(api.posts),sorted(sqlite.posts));assert.deepEqual(local.deletedUrls,sqlite.deletedUrls);assert.deepEqual(sqlite.blocked,[]);report.snapshots.push({name,browser:sorted(local.posts),api,sqlite,views:local.views});return sorted(local.posts);}
async function shot(name){await page.screenshot({path:join(output,name),animations:'disabled'});report.screenshots.push(name);}
function pass(name,detail){report.results.push({name,status:'PASS',detail});console.log('PASS',name);}
const result=()=>page.getByRole('status',{name:'Backup result'});
const region=()=>page.getByRole('region',{name:'Restore preview'});
async function tabTo(target){for(let i=0;i<180;i++){if(await target.evaluate(e=>e===document.activeElement))return;await page.keyboard.press('Tab');}throw Error('Keyboard target unreachable');}
async function select(raw){await page.getByLabel('Select library backup').setInputFiles({name:'synthetic-backup.json',mimeType:'application/json',buffer:Buffer.from(raw)});}
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>canonical(k)+':'+canonical(v[k])).join(',')+'}';
function sign(d){const c=structuredClone(d);delete c.sha256;c.sha256=createHash('sha256').update(canonical(c)).digest('hex');return JSON.stringify(c);}
async function post(path,data){return page.evaluate(async({path,data})=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,data:await r.json()};},{path,data});}
try{
  await start();browser=await chromium.launch({headless:true,channel:'msedge'});await fresh();await page.goto(base+'/library/settings');await saved(0);
  assert.equal(report.requests.filter(r=>r.url.includes('/api/backup/')).length,0);
  const deleted={...fixture[0],id:'backup-deleted',url:'https://backup.example.invalid/deleted',canonicalUrl:'https://backup.example.invalid/deleted'};
  assert.equal((await post('/api/library',{posts:[...fixture,deleted],deletedUrls:[]})).status,200);
  assert.equal((await post('/api/library',{posts:[],deletedUrls:[deleted.url]})).status,200);
  await page.reload();const before=await snapshot('source17 + retained-ID tombstone',17);assert.deepEqual(before,sorted(fixture));
  await page.goto(base+'/library');await saved(17);
  await page.getByPlaceholder('Search… ( / )').fill('native.example.invalid/programming');await page.waitForFunction(()=>document.querySelectorAll('main article').length===2);
  await page.getByRole('button',{name:'Saved Views',exact:true}).click();const vd=page.getByRole('dialog',{name:'Saved Views',exact:true});await vd.getByLabel('View name',{exact:true}).fill('Backup dynamic native');await vd.getByRole('button',{name:'Save current',exact:true}).click();await vd.getByRole('status').filter({hasText:'View saved.'}).waitFor();await vd.getByRole('button',{name:'Close',exact:true}).click();
  const views=(await state()).views;await page.goto(base+'/library/settings');await saved(17);
  const sourceBefore=await control('backup-snapshot');assert.deepEqual(sourceBefore.result.tombstones,[{url:deleted.url,id:deleted.id}]);
  await page.getByRole('heading',{name:'Backup & Restore'}).scrollIntoViewIfNeeded();await shot('b6-backup-settings.png');
  const exportButton=page.getByRole('button',{name:'Export backup',exact:true});await tabTo(exportButton);
  const downloadWait=page.waitForEvent('download');await page.keyboard.press('Enter');const download=await downloadWait;const file=join(output,download.suggestedFilename());await download.saveAs(file);
  await result().filter({hasText:'Exported 17 SQLite-saved items'}).waitFor();await shot('b6-export-success.png');
  const raw=await readFile(file,'utf8'),backup=JSON.parse(raw);assert.equal(backup.version,1);assert.equal(backup.recordCount,17);assert.equal(JSON.parse(sign(backup)).sha256,backup.sha256);
  assert.deepEqual(backup.library,sourceBefore.result);assert.equal('views' in backup.library,false);
  const sourceAfter=await control('backup-snapshot');assert.deepEqual(sourceAfter.result,sourceBefore.result);assert.equal(sourceAfter.sourceHash,sourceBefore.sourceHash);
  report.backup={filename:download.suggestedFilename(),artifactSha256:createHash('sha256').update(raw).digest('hex'),checksum:backup.sha256};
  pass('explicit keyboard export17; metadata/SHA256/full Unicode curation/IDs/source/tombstone/category snapshot exact; source DB hash unchanged; preferences excluded');
  const restoreButton=page.getByRole('button',{name:'Restore backup',exact:true});await tabTo(restoreButton);
  report.pickerBefore=await restoreButton.evaluate(e=>({focused:e===document.activeElement,documentFocused:document.hasFocus(),disabled:e.disabled,inputDisabled:document.querySelector('[aria-label="Select library backup"]').disabled}));
  await page.evaluate(()=>{window.backupKeyboardEvents=[];for(const type of ['keydown','keyup','click','focusin','focusout'])document.addEventListener(type,e=>window.backupKeyboardEvents.push({type:e.type,key:e.key,target:e.target.getAttribute('aria-label')||e.target.textContent?.slice(0,80),trusted:e.isTrusted,focused:document.hasFocus(),active:navigator.userActivation.isActive}),true);});
  const choose=page.waitForEvent('filechooser');
  try{await page.keyboard.press('Enter');await (await choose).setFiles(file);}finally{report.pickerEvents=await page.evaluate(()=>window.backupKeyboardEvents);}
  await region().waitFor();
  assert.match(await region().innerText(),/Version 1 · 17 items · 1 deletion markers/);await region().scrollIntoViewIfNeeded();await shot('b6-restore-preview.png');
  await tabTo(page.getByRole('button',{name:'Cancel restore'}));await page.keyboard.press('Enter');await result().filter({hasText:'Restore canceled'}).waitFor();
  assert.equal(await restoreButton.evaluate(e=>e===document.activeElement),true);assert.deepEqual((await control('backup-snapshot')).files,[]);assert.deepEqual(await snapshot('cancel unchanged',17),before);assert.deepEqual((await state()).views,views);
  pass('keyboard file chooser/preview counts/version/date; cancel creates no files and leaves source/browser/views exact');
  const mutate=fn=>{const d=structuredClone(backup);fn(d);return sign(d);};
  const cases=[['empty',''],['malformed','{'],['null','null'],['wrong version',mutate(d=>d.version=2)],['missing section',mutate(d=>delete d.library.tombstones)],['duplicate ID',mutate(d=>d.library.posts[1].id=d.library.posts[0].id)],['duplicate URL',mutate(d=>d.library.posts[1].url=d.library.posts[0].url)],['invalid URL',mutate(d=>d.library.posts[0].url='javascript:alert(1)')],['truncated',raw.slice(0,-20)],['checksum',JSON.stringify({...backup,sha256:'0'.repeat(64)})],['bad count',mutate(d=>d.recordCount=99)],['invalid tombstone',mutate(d=>d.library.tombstones[0].url='file:///test')],['duplicate category',mutate(d=>d.library.categories.push(d.library.categories[0]))],['nonascii checksum',JSON.stringify({...backup,sha256:'日'.repeat(64)})]];
  for(const [name,content] of cases){
    const local=await state();await select(content);await result().filter({hasText:/malformed|Unsupported|requires|Duplicate|valid HTTP|checksum|count|deletedUrls|category/}).waitFor();assert.equal(await region().count(),0);
    const response=await post('/api/backup/restore',{content,sha256:backup.sha256,confirm:true});assert.equal(response.status,400,name);
    assert.deepEqual(await state(),local,name);const s=await control('backup-snapshot');assert.deepEqual(s.result,sourceBefore.result,name);assert.deepEqual(s.files,[],name);
  }
  await result().scrollIntoViewIfNeeded();await shot('b6-restore-error.png');
  assert.equal((await post('/api/backup/restore',{content:raw,sha256:backup.sha256})).status,400);
  assert.equal((await post('/api/backup/restore',{content:raw,sha256:'wrong',confirm:true})).status,400);
  pass('14 invalid/corrupt backups rejected in both preview and restore; exact no mutation/no files; missing or stale confirmation rejected');
  for(const mode of ['restore','publish']){
    await control(mode+'-fail-on');await select(raw);await region().waitFor();await page.getByRole('button',{name:'Confirm restore to new database'}).click();await result().filter({hasText:'Backup storage unavailable'}).waitFor();
    const s=await control('backup-snapshot');assert.deepEqual(s.result,sourceBefore.result);assert.equal(s.sourceHash,sourceBefore.sourceHash);assert.deepEqual(s.files,[]);assert.deepEqual((await state()).views,views);
    await control(mode+'-fail-off');
  }
  pass('injected partial temporary write and publication failure: current DB hash/state exact, no published or leftover partial file; retry available');
  await select(raw);await region().waitFor();await tabTo(page.getByRole('button',{name:'Confirm restore to new database'}));await page.keyboard.press('Enter');await result().filter({hasText:'Restored 17 items into a new database'}).waitFor();
  const restored=await page.locator('[data-restored-path]').innerText();assert.ok(restored.includes('restored-libraries'));report.restoredPath=restored;
  await result().scrollIntoViewIfNeeded();await shot('b6-restore-success.png');
  assert.deepEqual(await snapshot('current source after new DB restore',17),before);assert.deepEqual((await state()).views,views);
  const finalSource=await control('backup-snapshot');assert.deepEqual(finalSource.result,sourceBefore.result);assert.equal(finalSource.sourceHash,sourceBefore.sourceHash);assert.equal(finalSource.files.filter(f=>f.endsWith('.sqlite')).length,1);
  pass('confirmed restore publishes one independent new file; current source and preferences unchanged; manual switch instructions explicit');
  await stop();db=restored;await start();await page.reload();await saved(17);
  assert.deepEqual(await snapshot('same origin views preserved on restored exact library',17),before);assert.deepEqual((await state()).views,views);
  await page.goto(base+'/library');await page.getByRole('button',{name:'Saved Views',exact:true}).click();const d=page.getByRole('dialog',{name:'Saved Views',exact:true});await d.getByLabel('Saved view',{exact:true}).selectOption({label:'Backup dynamic native'});await d.getByRole('button',{name:'Apply view',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('main article').length===2);
  assert.deepEqual((await state()).views,views);await context.close();await fresh();await page.goto(base+'/library/settings');
  assert.deepEqual(await snapshot('fresh browser restored17',17),before);assert.deepEqual((await state()).views,[]);
  const roundtrip=await control('backup-snapshot');assert.deepEqual(roundtrip.result,sourceBefore.result);
  pass('manual new-DB startup; independent SQLite/API/fresh-browser17 documents/tombstone/categories exact; original Saved Views unchanged/dynamic, fresh profile correctly has none');
  const fixtures=join(root,'frontend/tests/fixtures');
  for(const name of ['firefox','chromium']){await page.getByLabel('Import bookmarks HTML').setInputFiles(join(fixtures,`bookmarks-${name}.html`));await page.getByRole('status').filter({hasText:'Bookmark import complete — 0 new'}).waitFor();}
  await page.getByLabel('Import Telegram JSON').setInputFiles(join(fixtures,'telegram-saved-messages.json'));await page.getByRole('status',{name:'Telegram import result'}).filter({hasText:'0 new'}).waitFor();
  await page.getByLabel('Select copied Chromium Bookmarks file').setInputFiles(join(fixtures,'chromium-bookmarks.json'));await page.getByRole('status',{name:'Chromium import result'}).filter({hasText:'0 new'}).waitFor();
  await page.getByRole('button',{name:'Refresh Telegram Saved Messages',exact:true}).click();await page.getByRole('status',{name:'Telegram refresh result'}).filter({hasText:'0 new links'}).waitFor();
  assert.deepEqual(await snapshot('all overlap reimports17',17),before);
  const enrichRequests=()=>report.requests.filter(r=>new URL(r.url).pathname==='/api/enrich');
  assert.equal(enrichRequests().length,0,'Restores and overlapping imports must not request metadata');
  const html=`<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><A HREF="${deleted.url}">Deleted must stay deleted</A><A HREF="https://backup.example.invalid/new">Programming new only</A></DL>`;
  await page.getByLabel('Import bookmarks HTML').setInputFiles({name:'overlap.html',mimeType:'text/html',buffer:Buffer.from(html)});await page.getByRole('status').filter({hasText:'Bookmark import complete — 1 new'}).waitFor();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p=>p.url==='https://backup.example.invalid/new')?.categoryMode==='automatic');
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p=>p.url==='https://backup.example.invalid/new')?.metadataStatus==='failed');
  const after=await snapshot('new only18 tombstone preserved',18);for(const p of before)assert.deepEqual(after.find(q=>q.id===p.id),p);assert.ok(!after.some(p=>p.url===deleted.url));
  assert.deepEqual(enrichRequests(),[{url:base+'/api/enrich',method:'POST'}],'Only the genuinely new import requests metadata once');
  pass('restored HTML/Telegram/B2/B1 overlaps add0 and preserve full17; tombstone cannot resurrect; only genuine new item adds1→18');
  await page.goto(base+'/library');await saved(18);await page.getByPlaceholder('Search… ( / )').fill('native.example.invalid/cooking');await page.waitForFunction(()=>document.querySelectorAll('main article').length===1);const unicode=before.find(p=>p.url==='https://native.example.invalid/cooking');await page.locator(`main a[href="/library/item/${unicode.id}"]`).click();await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();assert.equal(await page.getByRole('dialog',{name:'Saved post detail'}).locator('textarea').inputValue(),unicode.userNotes);await page.reload();await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();await page.goto(base+'/');await saved(18);await page.locator('.catchup-card').first().waitFor();
  await page.goto(base+'/library/settings');await saved(18);
  for(const width of [1365,768,390,320]){await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'Restore backup',exact:true}).scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await shot(`b6-settings-${width}.png`);}
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.denied,[]);assert.deepEqual((await control('snapshot')).result.blocked,[]);
  pass('Library URL search/detail Unicode note/deep refresh/Catch Up, keyboard controls and responsive Settings; no unexpected script/provider/profile access');
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);}
finally{if(browser){await browser.close();report.browserClosed=true;}await stop();await writeFile(join(output,'runtime.json'),JSON.stringify(report,null,2));console.log('Evidence',output);}
