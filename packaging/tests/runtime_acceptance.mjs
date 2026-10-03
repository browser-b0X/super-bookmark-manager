import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
const {chromium}=createRequire(import.meta.url)(process.env.SBM_TEST_PLAYWRIGHT || 'playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const work=path.dirname(fileURLToPath(import.meta.url));
const python=process.env.SBM_TEST_PYTHON;
assert.ok(python,'Set SBM_TEST_PYTHON to a Windows Python 3.12 executable');
const executable=process.argv[2];
const label=executable?'packaged':'source';
const out=path.join(root,'.verify/release-safety-v0.1.1-20260929',label+'-'+Date.now());
await mkdir(out,{recursive:true});
const profile=path.join(out,'profile');await mkdir(profile);
const legacy=path.join(profile,'SavedPostsDashboard');await mkdir(legacy);
const sentinels={'saved_posts.db':'synthetic legacy database sentinel','config.json':JSON.stringify({telegram:{api_id:12345,api_hash:'a'.repeat(32)}}),'session.session':'synthetic legacy session','thumb_cache/marker.txt':'synthetic legacy cache','backups/marker.txt':'synthetic backup'};
for(const [name,value]of Object.entries(sentinels)){await mkdir(path.dirname(path.join(legacy,name)),{recursive:true});await writeFile(path.join(legacy,name),value);}
const data=path.join(profile,'SuperBookmarkManager');
const report={kind:label,checks:[],status:'FAIL',errors:[]};
let browser,context,child,base,info,blocker;
const processes=[];
const wait=async(predicate,timeout=15000)=>{let last;const until=Date.now()+timeout;while(Date.now()<until){try{const r=await predicate();if(r)return r;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}throw last||new Error('Timed out');};
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT'])if(process.env[key])env[key]=process.env[key];
env.PATH=path.join(env.SystemRoot || env.WINDIR,'System32');
Object.assign(env,{LOCALAPPDATA:profile,APPDATA:profile,USERPROFILE:profile,TEMP:profile,TMP:profile,
 PYTHONPATH:process.env.SBM_TEST_PYTHONPATH || '',SBM_TEST_ROOT:root,SAVED_POSTS_DB_PATH:path.join(legacy,'saved_posts.db'),
 TELEGRAM_API_ID:'12345',TELEGRAM_API_HASH:'a'.repeat(32),LLM_API_KEY:'synthetic-inherited-provider',
 LITELLM_PROXY_KEY:'synthetic-proxy',OPENAI_API_KEY:'synthetic-openai',PYTHONDONTWRITEBYTECODE:'1'});
const recorder=path.join(out,'browser_probe.py');
await writeFile(recorder,'import os,sys\nfrom pathlib import Path\nwith (Path(os.environ["LOCALAPPDATA"])/"opened.txt").open("a") as f:f.write(sys.argv[1]+"\\n")\n');
env.BROWSER='"'+python.replace(/python\.exe$/,'pythonw.exe')+'" "'+recorder+'" %s';
const start=()=>{const c=spawn(executable||python,executable?[]:['-B',path.join(work,'runtime_wrapper.py')],{env,cwd:out,windowsHide:true,stdio:['ignore','pipe','pipe']});processes.push(c);c.output='';c.stdout.on('data',d=>c.output+=d);c.stderr.on('data',d=>c.output+=d);return c;};
const api=async(route,body,headers={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),'X-SBM-Instance':info.token,...headers},body:body===undefined?undefined:JSON.stringify(body)});
const record=label=>{report.checks.push(label);console.log('PASS '+label);};
try{
 assert.equal(await stat(data).catch(()=>null),null);record('public data directory absent before first launch');
 blocker=net.createServer(s=>s.end());await new Promise(r=>blocker.listen(0,'127.0.0.1',r));
 env.SUPER_BOOKMARK_MANAGER_PORT=String(blocker.address().port);
 child=start();
 info=await wait(async()=>JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')));
 base='http://127.0.0.1:'+info.port;
 assert.notEqual(info.port,Number(env.SUPER_BOOKMARK_MANAGER_PORT));
 await wait(async()=>{const r=await api('/api/runtime');return r.ok;});
 record('occupied preferred port safely falls back; existing listener retained');
 if(executable){
   const probe=path.join(out,'console.json');
   await execute(python.replace(/python\.exe$/,'pythonw.exe'),[path.join(work,'console_probe.py'),String(child.pid),probe],{windowsHide:true});
   assert.deepEqual(JSON.parse(await readFile(probe,'utf8')),{probe_initial_console:false,target_console_attached:false,winerror:6});
   record('native console probe confirms running GUI process has no attached console');
   const modules=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${child.pid}).Modules | Where-Object ModuleName -eq 'python312.dll' | Select-Object -ExpandProperty FileName`],{windowsHide:true});
   assert.equal(path.resolve(modules.stdout.trim()).toLowerCase(),path.resolve(path.dirname(executable),'_internal/python312.dll').toLowerCase());record('stripped PATH launch loads Python from its own bundle');
 }
 const listeners=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-NetTCPConnection -State Listen -OwningProcess ${child.pid} | Select-Object -ExpandProperty LocalAddress`],{windowsHide:true});
 assert.deepEqual([...new Set(listeners.stdout.trim().split(/\s+/))],['127.0.0.1']);record('live process listens exclusively on IPv4 loopback');
 const library=await(await api('/api/library')).json();assert.deepEqual(library.posts,[]);assert.deepEqual(library.legacyRows,[]);
 const config=await(await api('/api/telegram/config')).json();assert.equal(config.api_id_configured??config.status?.api_id_configured,false);assert.equal(config.api_hash_configured??config.status?.api_hash_configured,false);
 const auth=await(await api('/api/telegram/auth')).json();
 assert.equal(await stat(path.join(data,'session.session')).catch(()=>null),null);
 assert.equal(await stat(path.join(data,'config.json')).catch(()=>null),null);
 record('fresh library empty; inherited and legacy Telegram credentials/session not adopted');
 assert.equal((await fetch(base+'/api/library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({posts:[],deletedUrls:[]})})).status,403);
 assert.equal((await api('/api/runtime/quit',{confirm:true},{Origin:'https://external.invalid'})).status,403);
 assert.equal((await api('/api/runtime/quit',{})).status,400);
 record('stale-tab writes and cross-origin/unconfirmed Quit rejected');
 await wait(async()=>(await readFile(path.join(profile,'opened.txt'),'utf8')).includes(base));record('automatic browser dispatch reaches synthetic browser handler');
 if(!executable){assert.ok((await readFile(path.join(profile,'provider-boundary.txt'),'utf8')).startsWith('PASS:'));record('runtime provider configuration contains no inherited synthetic credentials');}
 const duplicate=start();await wait(()=>duplicate.exitCode!==null);assert.equal(duplicate.exitCode,0);
 await wait(async()=>(await readFile(path.join(profile,'opened.txt'),'utf8')).trim().split('\n').length===2);
 assert.equal(child.exitCode,null);record('duplicate launch reopens same instance and exits');
 browser=await chromium.launch({channel:process.env.SBM_TEST_BROWSER_CHANNEL || 'msedge',headless:true});
 context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();if(u.pathname==='/api/enrich')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic metadata unavailable"}'});return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());
 const quitDialog=()=>page.getByRole('dialog',{name:'Quit Super Bookmark Manager?'});
 await page.addInitScript(()=>{
   if(!localStorage.getItem('legacy-seeded')){
     localStorage.setItem('library-store-v1',JSON.stringify({state:{posts:[{id:'legacy',url:'https://example.invalid/legacy',source:'manual',platform:'web',domain:'example.invalid',categories:[],tags:[],projectIds:[],status:'inbox',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',metadataStatus:'failed'}],pending:{},views:[{id:'developer-view',name:'Developer view',filter:{kind:'all'}}],demo:false},version:2}));
     localStorage.setItem('prefs-store-v1',JSON.stringify({state:{theme:'light',sidebarCollapsed:true},version:0}));
     localStorage.setItem('lib-view','table');localStorage.setItem('legacy-seeded','yes');
   }
 });
 await page.goto(base+'/library/settings');await page.getByRole('button',{name:'Quit Super Bookmark Manager',exact:true}).waitFor();
 await page.getByRole('region',{name:'Telegram Integration',exact:true}).getByText('Keys saved here belong only to this Super Bookmark Manager profile. Inherited developer credentials are ignored.').waitFor();
 await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('sbm-')&&k.endsWith('library-store-v1')));
 const isolation=await page.evaluate(()=>{
   const key=Object.keys(localStorage).find(k=>k.startsWith('sbm-')&&k.endsWith('library-store-v1'));
   const state=JSON.parse(localStorage.getItem(key)).state;
   return {posts:state.posts.length,views:state.views.length,theme:document.documentElement.dataset.theme,legacyView:JSON.parse(localStorage.getItem('library-store-v1')).state.views[0].name};
 });
 assert.deepEqual(isolation,{posts:0,views:0,theme:'dark',legacyView:'Developer view'});record('populated legacy link cache, Saved Views and preferences ignored/preserved before hydration');
 await page.setViewportSize({width:320,height:750});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1365,height:900});record('Settings Quit control fits at 320px');
 let failWrites=true;await page.route('**/api/library',r=>failWrites&&r.request().method()==='POST'?r.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic write failure"}'}):r.continue());
 await page.getByRole('button',{name:'Add link',exact:true}).click();
 await page.getByRole('dialog',{name:'Add link'}).getByRole('textbox').fill('https://example.invalid/owned');
 await page.getByRole('button',{name:'Save link',exact:true}).click();
 await page.goto(base+'/library/settings');
 await page.getByRole('button',{name:'Quit Super Bookmark Manager',exact:true}).click();
 await quitDialog().getByRole('button',{name:/Save and quit/}).click();
 await quitDialog().getByText('Changes are still pending. Retry SQLite save before quitting.',{exact:true}).waitFor();
 await quitDialog().getByRole('button',{name:'Cancel'}).click();
 assert.equal(child.exitCode,null);assert.equal((await(await api('/api/library')).json()).posts.length,0);record('Quit refuses a pending/failed SQLite write');
 failWrites=false;
 await page.getByRole('button',{name:'Retry SQLite save',exact:true}).click();
 await wait(async()=>{const l=await(await api('/api/library')).json();return l.posts.length===1;});
 const own=await(await api('/api/library')).json();assert.equal(own.posts[0].url,'https://example.invalid/owned');
 await page.goto(base+'/library/settings');
 await page.getByRole('button',{name:'Quit Super Bookmark Manager',exact:true}).click();
 await quitDialog().getByRole('button',{name:'Quit now'}).click();
 await page.getByRole('alertdialog').getByText(/Super Bookmark Manager (is stopping|has stopped)/).waitFor();await wait(()=>child.exitCode!==null);assert.equal(child.exitCode,0);
 record('synthetic manual link saved; visible Settings Quit acknowledges and stops process');
 await assert.rejects(fetch(base+'/api/library'));record('Quit releases server port');
 delete env.SUPER_BOOKMARK_MANAGER_PORT;
 child=start();await wait(async()=>{const r=await api('/api/runtime');return r.status===403;});
 info=JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8'));assert.equal('http://127.0.0.1:'+info.port,base);
 const restored=await(await api('/api/library')).json();assert.deepEqual(restored,own);
 await page.goto(base+'/library');
 await page.waitForFunction(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('sbm-')&&k.endsWith('library-store-v1'));return JSON.parse(localStorage.getItem(k)).state.posts.length===1;});
 record('restart retains exactly synthetic user state and browser identity');
 const fresh=await browser.newContext({serviceWorkers:'block'});await fresh.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());const freshPage=await fresh.newPage();await freshPage.goto(base+'/library');
 await freshPage.waitForFunction(()=>{const k=Object.keys(localStorage).find(k=>k.startsWith('sbm-')&&k.endsWith('library-store-v1'));return k&&JSON.parse(localStorage.getItem(k)).state.posts.length===1;});await fresh.close();record('fresh browser recovers only own SQLite link');
 await page.goto(base+'/library/settings');await page.screenshot({path:path.join(out,'settings.png'),fullPage:true});
 await page.getByRole('button',{name:'Quit Super Bookmark Manager',exact:true}).click();await quitDialog().getByRole('button',{name:'Quit now'}).click();await wait(()=>child.exitCode!==null);assert.equal(child.exitCode,0);
 for(const [name,value]of Object.entries(sentinels))assert.equal(await readFile(path.join(legacy,name),'utf8'),value);record('legacy synthetic DB/config/session/cache/backups byte-identical');
 assert.deepEqual(report.errors,[]);assert.equal(blocker.listening,true);assert.ok(processes.every(p=>p.exitCode===0));
 report.status='PASS';
}catch(e){report.failure=String(e);process.exitCode=1;console.error(report.failure);}
finally{
 if(context)await context.close();if(browser)await browser.close();
 if(child&&child.exitCode===null){try{await api('/api/runtime/quit',{confirm:true});await wait(()=>child.exitCode!==null,4000);}catch{}if(child.exitCode===null)child.kill();}
 if(blocker)await new Promise(r=>blocker.close(r));
 report.cleanup={browserClosed:true,ownedProcessesExited:processes.every(p=>p.exitCode!==null),blockedPortReleased:true};
 await writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log('RESULT '+path.join(out,'results.json'));
}
