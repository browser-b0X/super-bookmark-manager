import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
// Setting up Telegram in one visit (Settings > Telegram): saving the developer credentials enables
// Connect on the same page, Connect opens the focused phone field without any login request, the
// portal link is right, Clear and a failed save leave Connect off. Runs on the built app with every
// request answered here (no server, no network), at desktop and phone width.
const dist=fileURLToPath(new URL('../dist/',import.meta.url));
const phase='green';
const ev=await mkdtemp(path.join(tmpdir(),'sbm-telegram-handoff-'));
const {chromium}=createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const origin='http://127.0.0.1:58947';
const report={phase,checks:[],denied:[],errors:[],status:'FAIL'};
const browser=await chromium.launch({headless:true});
try{
 for(const width of [1365,320]){
 let configured=false,authPosts=0,configPosts=0,mode='ok';
 const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
 try{
 await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url()),method=req.method();
 if(url.origin!==origin){report.denied.push(url.origin);return route.abort();}
 if(url.pathname==='/api/library')return route.fulfill({json:{posts:[],deletedUrls:[],legacyRows:[]}});
 if(url.pathname==='/api/stats')return route.fulfill({json:{total:0}});
 // Quiet start-up questions, answered "nothing here".
 if(url.pathname==='/api/ai/providers')return route.fulfill({json:{ok:true,providers:[],ready:[],available:false}});
 if(url.pathname==='/api/archive/large-videos')return route.fulfill({json:{ok:true,on:false,limit:2147483648,cap:52428800}});if(url.pathname==='/api/archive')return route.fulfill({json:{ok:true,enabled:false,count:0,bytes:0}});
 if(url.pathname==='/api/extension')return route.fulfill({json:{ok:true,connections:[],code:null}});
 if(url.pathname==='/api/library/pending')return route.fulfill({json:{ok:true,connected:false,change:null,suggestions:0,version:'0'}});
 if(url.pathname==='/api/claude-desktop')return route.fulfill({json:{ok:true,connected:false,createdAt:'',lastUsedAt:'',changes:[],suggestions:[]}});
 if(url.pathname.startsWith('/fonts/'))return route.fulfill({status:404,body:''});
 if(url.pathname==='/api/telegram/config'){
 if(method==='POST'){
 configPosts++;
 if(mode==='fail')return route.fulfill({status:503,json:{ok:false}});
 const body=req.postDataJSON();configured=body.action==='save';
 }
 return route.fulfill({json:{ok:true,api_id_configured:configured,api_hash_configured:configured,config_readable:true}});
 }
 if(url.pathname==='/api/telegram/auth'){
 if(method==='POST')authPosts++;
 return route.fulfill({json:{ok:true,credentials_configured:configured,session_exists:false,authorized:false,login_step:null,expires_in:null}});
 }
 if(method!=='GET'){report.denied.push(url.pathname);return route.abort();}
 const file=url.pathname.startsWith('/assets/')?path.join(dist,'assets',path.basename(url.pathname)):url.pathname.startsWith('/library')?path.join(dist,'index.html'):path.join(dist,path.basename(url.pathname));
 try{return route.fulfill({body:await readFile(file),contentType:({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.ico':'image/x-icon'})[path.extname(file)]||'application/octet-stream'});}catch{report.denied.push(url.pathname);return route.abort();}
 });
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto(origin+'/library/settings');
 const integration=page.getByRole('region',{name:'Telegram Integration',exact:true});
 const account=page.getByRole('region',{name:'Telegram Account',exact:true});
 const connect=account.getByRole('button',{name:'Connect Telegram',exact:true});
 await connect.waitFor();assert.equal(await connect.isDisabled(),true);
 await integration.getByRole('button',{name:'Configure',exact:true}).click();
 await integration.getByLabel('Telegram API ID',{exact:true}).fill('1234567');
 await integration.getByLabel('Telegram API hash',{exact:true}).fill('a'.repeat(32));
 await integration.getByRole('button',{name:'Save',exact:true}).click();
 await integration.getByRole('status',{name:'Telegram configuration result'}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Connect Telegram'&&!b.disabled),{},{timeout:2500});
 assert.equal(configPosts,1);await connect.click();
 const phone=account.getByLabel('Telegram phone number',{exact:true});await phone.waitFor({timeout:1000});
 assert.equal(await phone.evaluate(el=>document.activeElement===el),true);assert.equal(authPosts,0);
 report.checks.push(`${width}: same-page save enables Connect; click opens focused phone field without auth request`);
 const portal=integration.getByRole('link',{name:'Get your Telegram API ID and hash',exact:true});
 assert.equal(await portal.getAttribute('href'),'https://my.telegram.org/auth');assert.equal(await portal.getAttribute('target'),'_blank');
 assert.match(await integration.innerText(),/API development tools/);
 report.checks.push(`${width}: correct developer portal link and instructions`);
 await phone.fill('+15551234567');
 await integration.getByRole('button',{name:'Clear',exact:true}).click();
 await connect.waitFor();assert.equal(await connect.isDisabled(),true);assert.equal(await phone.count(),0);
 assert.equal(authPosts,0);report.checks.push(`${width}: clearing credentials disables Connect and discards unsent phone input without session action`);
 mode='fail';await integration.getByRole('button',{name:'Configure',exact:true}).click();
 await integration.getByLabel('Telegram API ID',{exact:true}).fill('7654321');
 await integration.getByLabel('Telegram API hash',{exact:true}).fill('b'.repeat(32));
 await integration.getByRole('button',{name:'Save',exact:true}).click();
 await integration.getByRole('alert').waitFor();assert.equal(await connect.isDisabled(),true);
 assert.equal(authPosts,0);report.checks.push(`${width}: failed credential save does not enable Connect`);
 await integration.getByLabel('Telegram API ID',{exact:true}).fill('');await integration.getByLabel('Telegram API hash',{exact:true}).fill('');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(await page.evaluate(()=>JSON.stringify(Object.entries(localStorage)).includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),false);
 await integration.screenshot({path:path.join(ev,`${phase}-${width}.png`)});
 }finally{await context.close();}
 }
 assert.deepEqual(report.denied,[]);assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(e){report.failure=String(e);process.exitCode=1;}finally{await browser.close();report.browserClosed=true;await writeFile(path.join(ev,`${phase}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
