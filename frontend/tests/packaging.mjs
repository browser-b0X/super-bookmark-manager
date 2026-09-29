import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp,cp,rename,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
const evidence=join(root,'.verify/b6-packaging-20260924');
const output=await mkdtemp(join(evidence,'package-test-'));
const pristine=JSON.parse(await readFile(join(evidence,'package-build.txt'),'utf8')).output;
const first=join(output,'First package with spaces'),moved=join(output,'Moved elsewhere');
await cp(pristine,first,{recursive:true});await cp(pristine,moved,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE);
const seed=JSON.parse(await readFile(join(root,'frontend/tests/fixtures/backup-library.json'),'utf8'));
const report={results:[],events:[],errors:[],denied:[],requests:[],snapshots:[],output,pristine};
let child,exited,log='',browser,context,page,base,port=0;
const pending=new Map();
const hash=b=>createHash('sha256').update(b).digest('hex');
const sorted=p=>[...p].sort((a,b)=>a.id.localeCompare(b.id));
const control=command=>new Promise(resolve=>{pending.set(command,resolve);child.stdin.write(JSON.stringify({command})+'\n');});
function launch(directory,args=[],extra={}){
  log='';const env={...process.env,PYTHONPATH:join(root,'frontend/tests/package_site'),PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',SAVED_POSTS_NO_PAUSE:'1',PACKAGE_FIXTURE_ROOT:output,PACKAGE_TEST_PORT:String(port),TELEGRAM_API_ID:'0',TELEGRAM_API_HASH:'',...extra};
  if(!('SAVED_POSTS_DB_PATH' in extra))delete env.SAVED_POSTS_DB_PATH;
  child=spawn('cmd.exe',['/d','/s','/c',`""${join(directory,'Start Super Bookmark Manager.bat')}" ${args.join(' ')}"`],{cwd:output,windowsHide:true,windowsVerbatimArguments:true,env,stdio:['pipe','pipe','pipe']});
  exited=once(child,'exit');child.stderr.on('data',b=>{log+=b;});
  createInterface({input:child.stdout}).on('line',line=>{log+=line+'\n';if(line.startsWith('FIXTURE ')){const d=JSON.parse(line.slice(8));report.events.push(d);if(d.command){pending.get(d.command)?.(d);pending.delete(d.command);}}});
}
async function start(directory,args=[],extra={}){
  const count=report.events.length;launch(directory,args,extra);
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Startup timeout: '+log));},20000);const poll=setInterval(()=>{const r=report.events.slice(count).find(d=>d.ready);if(r){clearTimeout(timer);clearInterval(poll);resolve(r);}else if(child.exitCode!==null){clearTimeout(timer);clearInterval(poll);reject(Error(log));}},30);});
  port=ready.port;base=`http://127.0.0.1:${port}`;return ready;
}
async function stop(){if(child?.exitCode===null)child.stdin.end('{"command":"stop"}\n');if(exited){const [code]=await exited;report.events.push({cmdExit:code});await appendFile(join(output,'startup.txt'),log+'\n');exited=undefined;if(!report.failure)assert.equal(code,0);}}
async function fresh(){context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'});await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){report.denied.push(route.request().url());return route.abort();}return route.continue();});page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>report.requests.push({url:r.url(),method:r.method()}));}
const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('library-store-v1')).state);
async function saved(n){await page.getByRole('status',{name:'SQLite save status'}).filter({hasText:/^Library saved to SQLite$/}).waitFor();await page.waitForFunction(n=>{const s=JSON.parse(localStorage.getItem('library-store-v1')).state;return s.posts.length===n&&!Object.keys(s.pending).length;},n);}
async function snapshot(name,n){await saved(n);const s=await control('snapshot'),local=await state(),api=await page.evaluate(async()=> (await (await fetch('/api/library')).json()));assert.deepEqual(sorted(local.posts),sorted(s.result.posts));assert.deepEqual(sorted(api.posts),sorted(s.result.posts));assert.deepEqual(s.blocked,[]);report.snapshots.push({name,storage:s.result,browser:local.posts,views:local.views});return s.result;}
function pass(name,detail){report.results.push({name,status:'PASS',detail});console.log('PASS',name);}
try{
  const manifest=JSON.parse(await readFile(join(pristine,'PACKAGE_CONTENTS.json'),'utf8'));
  for(const [path,expected] of Object.entries(manifest.files))assert.equal(hash(await readFile(join(pristine,path))),expected,path);
  assert.equal(manifest.pythonBundled,false);assert.deepEqual(manifest.optionalDependenciesBundled,[]);
  pass('21-file allowlisted package hashes verified; Python/optional deps and personal data not bundled');
  const ready=await start(first);assert.equal(ready.db,join(first,'saved_posts.db'));
  browser=await chromium.launch({headless:true,channel:'msedge'});await fresh();await page.goto(base+'/library/settings');await saved(0);
  assert.deepEqual((await control('snapshot')).result.posts,[]);
  const expected=await readFile(join(pristine,'frontend/dist/index.html'),'utf8');
  for(const path of ['/','/library','/library/settings','/library/item/synthetic-deep-link']){const r=await fetch(base+path);assert.equal(r.status,200);assert.equal(await r.text(),expected);}
  for(const [path,h] of Object.entries(manifest.files).filter(([p])=>p.startsWith('frontend/dist/'))){const url='/'+path.slice('frontend/dist/'.length);const r=await fetch(base+url);assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),h);}
  assert.equal(report.requests.filter(r=>r.url.includes('/api/backup/')||r.url.includes('/api/telegram/refresh')||r.url.includes('/api/categorize')).length,0);
  pass('actual BAT/default launcher; empty app-local DB;4 SPA routes and all static hashes; no automatic backup/Telegram/category calls',ready);
  await page.evaluate(async posts=>{const r=await fetch('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({posts,deletedUrls:[]})});if(!r.ok)throw Error('Seed failed');},seed);await page.reload();const before=await snapshot('packaged seed17',17);assert.deepEqual(sorted(before.posts),sorted(seed));
  await page.getByRole('button',{name:'Refresh Telegram Saved Messages',exact:true}).click();await page.getByRole('status',{name:'Telegram refresh result'}).filter({hasText:'needs Telethon'}).waitFor();assert.deepEqual(await snapshot('optional unavailable17',17),before);
  await page.getByRole('button',{name:'Import Chromium Bookmarks file',exact:true}).waitFor();await page.getByLabel('Select copied Chromium Bookmarks file').setInputFiles(join(root,'frontend/tests/fixtures/chromium-bookmarks.json'));await page.getByRole('status',{name:'Chromium import result'}).filter({hasText:'0 new'}).waitFor();assert.deepEqual(await snapshot('B2 overlap17',17),before);
  pass('packaged B1 missing optional Telethon readable/no mutation; B2 UI/native overlap no duplicates');
  await page.goto(base+'/library');await saved(17);const search=page.getByPlaceholder('Search… ( / )');await search.fill('native.example.invalid/programming');await page.waitForFunction(()=>document.querySelectorAll('main article').length===2);await page.getByRole('button',{name:'Saved Views',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Saved Views',exact:true});await dialog.getByLabel('View name',{exact:true}).fill('Packaged native view');await dialog.getByRole('button',{name:'Save current',exact:true}).click();await dialog.getByRole('status').filter({hasText:'View saved.'}).waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).click();const views=(await state()).views;await page.getByRole('button',{name:'Clear search and filters',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('main article').length===17);await page.getByRole('button',{name:'Saved Views',exact:true}).click();await dialog.getByLabel('Saved view',{exact:true}).selectOption({label:'Packaged native view'});await dialog.getByRole('button',{name:'Apply view',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('main article').length===2);assert.deepEqual((await state()).views,views);
  const p=seed.find(p=>p.url==='https://native.example.invalid/programming?lesson=1&lesson=2#code');await page.locator(`main a[href="/library/item/${p.id}"]`).click();await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();await page.reload();await page.getByRole('dialog',{name:'Saved post detail'}).waitFor();await page.goto(base+'/');await saved(17);await page.locator('.catchup-card').first().waitFor();
  pass('packaged Saved View save/apply/clear dynamic2/reset17; Library search/detail/deep refresh and Catch Up');
  await page.goto(base+'/library/settings');await saved(17);const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Export backup',exact:true}).click();const download=await downloading;const backupFile=join(output,'packaged-backup.json');await download.saveAs(backupFile);const backup=JSON.parse(await readFile(backupFile,'utf8'));assert.deepEqual(backup.library,before);await page.getByLabel('Select library backup').setInputFiles(backupFile);await page.getByRole('region',{name:'Restore preview'}).waitFor();await page.getByRole('button',{name:'Confirm restore to new database'}).click();await page.getByRole('status',{name:'Backup result'}).filter({hasText:'Restored 17 items into a new database'}).waitFor();assert.deepEqual((await control('restored')).results,[before]);assert.deepEqual(await snapshot('packaged backup restore source17',17),before);await page.screenshot({path:join(output,'packaged-backup.png'),animations:'disabled'});
  pass('packaged B6 export/download/preview/new-file restore17 exact; current source and preferences intact');
  await context.close();await stop();const again=await start(first,['--serve-only']);assert.equal(again.db,ready.db);await fresh();await page.goto(base+'/library');assert.deepEqual(await snapshot('restart existing17',17),before);await context.close();await stop();
  pass('actual BAT rerun --serve-only opens existing synthetic DB without record mutation; graceful shutdown');
  const relativeDb=relative(output,join(first,'saved_posts.db'));const relocated=await start(moved,['--serve-only'],{SAVED_POSTS_DB_PATH:relativeDb});assert.equal(relocated.db,ready.db);assert.equal(relocated.package,moved);await fresh();await page.goto(base+'/library');assert.deepEqual(await snapshot('moved package relative override17',17),before);assert.equal(await (await fetch(base+'/')).text(),expected);await context.close();await stop();
  pass('relocated independent copied folder starts; relative SQLite override resolves from caller cwd; all app modules loaded from moved folder');
  async function fails(name,extra,args,pattern){launch(moved,args,extra);const [code]=await exited;exited=undefined;assert.notEqual(code,0,name);assert.match(log,pattern,name);report.events.push({name,code,log});await appendFile(join(output,'failures.txt'),name+'\n'+log+'\n');}
  await fails('missing Python',{SAVED_POSTS_PYTHON:join(output,'absent-python.exe')},[],/Python 3.12 could not be started/);
  await fails('missing Flask',{PACKAGE_MISSING_FLASK:'1'},[],/Flask is missing/);
  const index=join(moved,'frontend/dist/index.html');await rename(index,index+'.held');try{await fails('missing frontend',{},[],/Packaged frontend is missing/);}finally{await rename(index+'.held',index);}
  await fails('explicit optional fetch missing',{},['--fetch-only'],/Telegram fetching requires the optional dependency/);
  pass('missing Python/Flask/build and explicit optional fetch give readable nonzero errors; no automatic install or workflow fallback');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.denied,[]);assert.ok(report.events.filter(e=>e.stopped).every(e=>e.blocked.length===0));
  pass('all packaged-runtime guards clean; no personal/session/cache/provider access; original data-free output unused and unchanged');
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);}
finally{if(browser){await browser.close();report.browserClosed=true;}await stop();await writeFile(join(output,'runtime.json'),JSON.stringify(report,null,2));console.log('Evidence',output);}
