import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const root=fileURLToPath(new URL('../../',import.meta.url));
assert.ok(process.env.B4_RUN);
const output=await mkdtemp(join(process.env.B4_RUN,'views-'));
const {chromium}=createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE);
const seed=JSON.parse(await readFile(join(root,'frontend/tests/fixtures/retrieval-library.json'),'utf8'));
const programming=seed.find(p=>p.url.includes('/programming')),cooking=seed.find(p=>p.url.includes('/cooking'));
const sorted=posts=>[...posts].sort((a,b)=>a.id.localeCompare(b.id));
const baselineIds=seed.map(p=>p.id);
const report={results:[],events:[],snapshots:[],requests:[],responses:[],errors:[],denied:[],screenshots:[],comparisons:[]};
let child,exited,browser,page,base,port=0;
const pending=new Map();
const control=command=>new Promise(resolve=>{pending.set(command,resolve);child.stdin.write(JSON.stringify({command})+'\n');});
async function start(){
  child=spawn(process.env.C6_PYTHON,['-B',join(root,'frontend/tests/b1_fixture.py'),join(output,'fixture.sqlite'),String(port)],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',TELEGRAM_API_ID:'0',TELEGRAM_API_HASH:'',MAX_MESSAGES:'200'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  exited=once(child,'exit');child.stderr.on('data',bytes=>void appendFile(join(output,'server.txt'),bytes));
  const ready=await new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('exit',code=>reject(new Error('Fixture exited '+code)));
    createInterface({input:child.stdout}).on('line',line=>{const data=JSON.parse(line);report.events.push(data);if(data.ready)resolve(data);if(data.command){pending.get(data.command)?.(data);pending.delete(data.command);}});
  });port=ready.port;base=`http://127.0.0.1:${port}`;
}
async function stop(){if(child&&child.exitCode===null)child.stdin.end('{"command":"stop"}\n');if(exited){const [code]=await exited;report.events.push({pid:child.pid,exit:code});assert.equal(code,0);exited=undefined;}}
const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('library-store-v1')).state);
const definitions=async()=> (await state()).views;
const search=()=>page.getByPlaceholder('Search… ( / )');
const dialog=()=>page.getByRole('dialog',{name:'Saved Views',exact:true});
const trigger=()=>page.getByRole('button',{name:'Saved Views',exact:true});
const ids=()=>page.locator('main article').evaluateAll(nodes=>nodes.map(n=>n.dataset.postId).sort());
async function tabTo(target){assert.equal(await target.count(),1);for(let i=0;i<160;i++){if(await target.evaluate(el=>el===document.activeElement))return;await page.keyboard.press('Tab');}throw new Error('Keyboard unreachable');}
async function key(target){await tabTo(target);await page.keyboard.press('Enter');}
async function open(){await key(trigger());await dialog().waitFor();}
async function close(){await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});assert.equal(await trigger().evaluate(el=>el===document.activeElement),true);}
async function saved(count){
  await page.getByRole('status',{name:'SQLite save status'}).filter({hasText:/^Library saved to SQLite$/}).waitFor();
  await page.waitForFunction(({count,baselineIds})=>{
    const s=JSON.parse(localStorage.getItem('library-store-v1')).state;
    return s.posts.length===count&&!Object.keys(s.pending).length
      &&s.posts.every(p=>baselineIds.includes(p.id)||['enriched','failed'].includes(p.metadataStatus));
  },{count,baselineIds});
}
async function snapshot(name,count){await saved(count);const local=await state(),sqlite=(await control('snapshot')).result;
  const api=await page.evaluate(async()=> (await (await fetch('/api/library')).json()));
  assert.deepEqual(sorted(local.posts),sorted(sqlite.posts));assert.deepEqual(sorted(api.posts),sorted(sqlite.posts));assert.deepEqual(sqlite.blocked,[]);
  report.snapshots.push({name,browser:sorted(local.posts),api,sqlite,views:local.views});return sorted(local.posts);
}
async function snap(name){await page.screenshot({path:join(output,name),animations:'disabled'});report.screenshots.push(name);}
function pass(name,detail){report.results.push({name,status:'PASS',detail});console.log('PASS',name);}
async function manual(path,q,expected){await page.goto(base+path);await saved(expected===undefined?(await state()).posts.length:8);await search().fill(q);await page.waitForFunction(n=>document.querySelectorAll('main article').length===n,expected?.length??0);}
async function save(name){await open();await dialog().getByLabel('View name',{exact:true}).fill(name);await key(dialog().getByRole('button',{name:'Save current',exact:true}));await dialog().getByRole('status').filter({hasText:'View saved.'}).waitFor();await close();}
async function apply(name){await open();await dialog().getByLabel('Saved view',{exact:true}).selectOption({label:name});await key(dialog().getByRole('button',{name:'Apply view',exact:true}));await dialog().waitFor({state:'hidden'});assert.equal(await trigger().evaluate(el=>el===document.activeElement),true);}
async function clear(){await key(page.getByRole('button',{name:'Clear search and filters',exact:true}));}
try{
  await start();browser=await chromium.launch({headless:true,channel:'msedge'});
  if (process.argv[2] !== 'dynamic') {
  // Actual view-specific store methods, with no running application or requests.
  const bundle=await build({stdin:{contents:'export {useLibrary} from "./src/store/library"; export {viewCriteria,viewPath} from "./src/lib/savedViews";',resolveDir:join(root,'frontend')},bundle:true,write:false,format:'iife',globalName:'unit',define:{'process.env.NODE_ENV':'"test"'}});
  const uc=await browser.newContext({serviceWorkers:'block'});await uc.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<title>Synthetic state test</title>'}));
  const up=await uc.newPage();await up.goto('http://unit.invalid');await up.addScriptTag({content:bundle.outputFiles[0].text});
  const unit=await up.evaluate(seed=>{
    const s=unit.useLibrary;s.setState({posts:seed,pending:{},views:[]});const before=JSON.stringify(s.getState().posts),out=[];
    const id=s.getState().saveView('  Favorites  ',{kind:'favorites',search:'',ids:['forbidden']});
    for(const name of ['', '   ','x'.repeat(81),'fAvOrItEs']){let rejected=false;try{s.getState().saveView(name,{kind:'all'});}catch{rejected=true;}if(!rejected)throw new Error('Name accepted '+name);out.push(name.length);}
    const b=s.getState().saveView('Second',{kind:'category',categoryId:'gone',search:'note'});
    let rejected=false;try{s.getState().renameView(b,'FAVORITES');}catch{rejected=true;}if(!rejected)throw new Error('Rename collision');
    s.getState().renameView(id,'Renamed');s.getState().updateView(id,{kind:'tag',tag:'MiXeD',search:'note',postId:'forbidden'});
    const updated=s.getState().views.find(v=>v.id===id);if(JSON.stringify(updated.filter)!==JSON.stringify({kind:'tag',search:'note',tag:'MiXeD'}))throw new Error('Unexpected criteria');
    s.getState().deleteView(id);if(s.getState().views.length!==1||JSON.stringify(s.getState().posts)!==before||Object.keys(s.getState().pending).length)throw new Error('Record mutation');
    return {invalidLengths:out,updated,remaining:s.getState().views,persisted:JSON.parse(localStorage.getItem('library-store-v1')).state.views};
  },seed);
  pass('state: trim/80-char/blank/duplicate/rename collision, criteria-only update/delete, no post/pending mutations',unit);await uc.close();
  }
  const context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){report.denied.push(route.request().url());return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>report.requests.push({url:r.url(),method:r.method(),body:r.postData()}));
  page.on('response',r=>{if(r.status()>=400)report.responses.push({url:r.url(),status:r.status()});});
  await page.goto(base+'/library');await saved(0);
  await page.evaluate(async posts=>{const r=await fetch('/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({posts,deletedUrls:[]})});if(!r.ok)throw new Error('Seed failed');},seed);
  await page.reload();const baseline=await snapshot('baseline',8);assert.deepEqual(baseline,sorted(seed));
  if (process.argv[2] !== 'dynamic') {
  await snap('b4-saved-views-default.png');
  const cases=[['Favorites','/library?status=favorites','',[cooking.id]],['Programming note','/library/category/technology','LambdaNotebook',[programming.id]],['Archived cooking','/library?status=archived','cooking',[cooking.id]],['Mixed-case tag','/library','mIxEdCaSe',[programming.id]],['Empty legitimate','/library','zz-no-fixture-match',[]],['Stale category','/library/category/removed-shelf','',[]]];
  for(const [name,path,q,expected] of cases){
    await manual(path,q,expected);const manualIds=await ids();assert.deepEqual(manualIds,[...expected].sort());await save(name);await clear();await apply(name);
    await page.waitForFunction(n=>document.querySelectorAll('main article').length===n,expected.length);assert.deepEqual(await ids(),manualIds);assert.equal(await search().inputValue(),q);
    report.comparisons.push({name,manual:manualIds,saved:await ids()});assert.deepEqual(await snapshot(name,8),baseline);
    if(name==='Programming note')await snap('b4-saved-view-applied.png');if(name==='Empty legitimate')await snap('b4-saved-view-empty.png');
  }
  pass('A–E plus stale category: saved/manual result IDs identical; visible criteria restored; all8 records unchanged');
  await clear();await apply('Programming note');const beforeManual=await definitions();await search().fill('different');
  await page.getByText('Programming note — modified',{exact:true}).waitFor();assert.deepEqual(await definitions(),beforeManual);
  await clear();await page.waitForFunction(()=>document.querySelectorAll('main article').length===8);
  await open();await dialog().getByLabel('View name',{exact:true}).fill('  ');await key(dialog().getByRole('button',{name:'Save current',exact:true}));await dialog().getByRole('status').filter({hasText:'between 1 and 80'}).waitFor();
  await dialog().getByLabel('View name',{exact:true}).fill('FAVORITES');await key(dialog().getByRole('button',{name:'Save current',exact:true}));await dialog().getByRole('status').filter({hasText:'already exists'}).waitFor();
  await dialog().getByLabel('Saved view',{exact:true}).selectOption({label:'Empty legitimate'});
  await dialog().getByLabel('View name',{exact:true}).fill('Renamed empty');await key(dialog().getByRole('button',{name:'Rename',exact:true}));
  await key(dialog().getByRole('button',{name:'Update criteria',exact:true}));await key(dialog().getByRole('button',{name:'Cancel',exact:true}));
  assert.equal((await definitions()).find(v=>v.name==='Renamed empty').filter.search,'zz-no-fixture-match');
  await key(dialog().getByRole('button',{name:'Update criteria',exact:true}));await key(dialog().getByRole('button',{name:'Confirm update',exact:true}));
  assert.deepEqual((await definitions()).find(v=>v.name==='Renamed empty').filter,{kind:'all',search:''});
  await key(dialog().getByRole('button',{name:'Delete view',exact:true}));await key(dialog().getByRole('button',{name:'Confirm delete',exact:true}));
  assert.equal(await dialog().getByLabel('View name',{exact:true}).evaluate(el=>el===document.activeElement),true);assert.ok(!(await definitions()).some(v=>v.name==='Renamed empty'));
  await snap('b4-saved-views-menu.png');await close();
  assert.deepEqual(await snapshot('management',8),baseline);assert.equal(report.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/api/library')).length,1);
  pass('keyboard save/apply/rename/update confirmation/cancel/delete/Escape/focus; duplicate/blank feedback; manual edit never rewrites view; Clear8; zero Library writes');
  const retained=await definitions();await page.reload();await saved(8);assert.deepEqual(await definitions(),retained);
  await page.goto(base+'/');await page.locator('.rail-card').first().waitFor();await page.goto(base+'/library');await saved(8);assert.deepEqual(await definitions(),retained);
  await stop();await start();await page.reload();await saved(8);assert.deepEqual(await definitions(),retained);assert.deepEqual(await snapshot('backend-restart',8),baseline);
  pass('reload/navigation/backend restart same-origin retains definitions and exact8; no cross-profile persistence claim');
  for(const width of [1365,1024,768,390]){
    await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});await clear();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await open();const box=await dialog().boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
    const closeButton=dialog().getByRole('button',{name:'Close',exact:true});await tabTo(closeButton);
    assert.equal(await closeButton.evaluate(el=>el.matches(':focus-visible')),true);
    for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement===document.body||!!document.activeElement.closest('dialog')),true);}
    if(width===390)await snap('b4-saved-views-mobile.png');await close();
    await apply('Favorites');await page.waitForFunction(()=>document.querySelectorAll('main article').length===1);assert.deepEqual(await ids(),[cooking.id]);await clear();
    if(width===390){await page.locator('header').getByRole('button',{name:'Menu',exact:true}).click();await page.getByRole('dialog',{name:'Mobile navigation'}).waitFor();await page.keyboard.press('Escape');}
    report.comparisons.push({width,overflow:false,dialogBox:box,keyboard:true});
  }
  pass('1365/1024/768/390 controls/dialog contained, keyboard focus/modal trap/Escape, reduced motion and mobile drawer coexist');
  }
  await page.setViewportSize({width:1365,height:900});await page.goto(base+'/library/category/technology');await saved(8);await search().fill('programming');await save('Dynamic programming');const dynamicDefs=await definitions();
  await open();const chooser=dialog().getByLabel('Saved view',{exact:true});await tabTo(chooser);
  await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Tab');
  assert.equal(await chooser.inputValue(),dynamicDefs[0].id);await close();
  const fixtures=[['html','<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://book.example.invalid/programming">Programming new bookmark</A><DT><A HREF="https://book.example.invalid/cooking">Cooking nonmatch</A></DL>',10,2],['json',JSON.stringify({messages:[{id:401,type:'message',date:'2026-09-24',text:'https://json.example.invalid/programming https://json.example.invalid/travel'}]}),12,3]];
  for(const [kind,body,count,matches] of fixtures){
    await page.goto(base+'/library/settings');await page.getByLabel(kind==='html'?'Import bookmarks HTML':'Import Telegram JSON').setInputFiles({name:'synthetic.'+kind,mimeType:kind==='html'?'text/html':'application/json',buffer:Buffer.from(body)});
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.every(p=>p.categoryMode));
    await saved(count);await page.goto(base+'/library');await saved(count);await apply('Dynamic programming');await page.waitForFunction(n=>document.querySelectorAll('main article').length===n,matches);assert.deepEqual(await definitions(),dynamicDefs);
    report.comparisons.push({import:kind,matches:await ids()});
  }
  await page.goto(base+'/library/settings');await page.getByRole('button',{name:'Refresh Telegram Saved Messages',exact:true}).click();
  await page.getByRole('status',{name:'Telegram refresh result'}).filter({hasText:'4 new links'}).waitFor();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('library-store-v1')).state.posts.every(p=>p.categoryMode));await saved(16);
  await page.goto(base+'/library');await apply('Dynamic programming');await page.waitForFunction(()=>document.querySelectorAll('main article').length===4);assert.deepEqual(await definitions(),dynamicDefs);
  const final=await snapshot('dynamic-imports',16);for(const old of baseline)assert.deepEqual(final.find(p=>p.id===old.id),old);
  await clear();await page.waitForFunction(()=>document.querySelectorAll('main article').length===16);
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.denied,[]);assert.deepEqual((await control('snapshot')).result.blocked,[]);
  const added=final.filter(p=>!baselineIds.includes(p.id)),metadataRequests=report.requests.filter(r=>r.url.endsWith('/api/enrich'));
  assert.equal(metadataRequests.length,added.length);assert.ok(metadataRequests.every(r=>r.method==='POST'));
  assert.deepEqual(metadataRequests.map(r=>JSON.parse(r.body).url).sort(),added.map(p=>p.url).sort());
  assert.ok(added.every(p=>p.metadataStatus==='failed'));
  assert.ok(report.responses.every(r=>r.status===503&&r.url.endsWith('/api/enrich')));
  pass('HTML/JSON/mock B1 adds current records dynamically: programming1→2→3→4, nonmatches excluded; definitions and original8 unchanged; Clear16; new-only metadata503');
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}
finally{if(browser){await browser.close();report.browserClosed=true;}await stop();await writeFile(join(output,'runtime.json'),JSON.stringify(report,null,2));console.log('Evidence',output);}
