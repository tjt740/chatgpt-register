const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/adobe.js'), 'utf8');
const failed = { id: 1, email: 'failed@example.com', status: 'register_failed', can_retry: true, has_auth: false, note: 'form failed' };
const registered = { id: 2, email: 'done@example.com', status: 'registered', has_auth: true, can_retry: false, alive: 'alive' };
async function harness(records = [failed, registered]) {
 const nodes = new Map(), requests = [], messages = [];
 const state = { records, respond: null, headless: true };
 const context = vm.createContext({
  document: { body: { style: {} }, getElementById(id) {
   if (!nodes.has(id)) nodes.set(id,{ value:'', textContent:'', innerHTML:'', style:{}, dataset:{}, addEventListener(){} });
   return nodes.get(id);
  }, querySelectorAll(){return [];} },
  URLSearchParams, setInterval(){return 1;}, clearInterval(){}, setTimeout(){}, renderPager(){}, closeModal(){}, confirm(){return true;},
  esc: s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  fmtTime: x=> x || '', toast:(...args)=>messages.push(args),
  async api(url,opts) {
   requests.push({url,opts});
   const custom = state.respond && await state.respond(url,opts);
   if(custom) return {ok:custom.status<400,status:custom.status,json:async()=>custom.body};
   let data = {};
   if(url==='/api/adobe/browser-settings'){if(opts?.method==='PUT') state.headless=JSON.parse(opts.body).headless;data={headless:state.headless};}
   if(url.includes('/registrations?')) data={data:state.records,total:state.records.length};
   if(url==='/api/browser/status') data={ready:true};
   if(url.endsWith('/logs')) data={email:'test@example.com',log:'test log'};
   return {ok:true,status:200,json:async()=>data};
  }
 });
 vm.runInContext(source,context);
 await new Promise(setImmediate);
 requests.length=0;messages.length=0;
 return {run: code=>vm.runInContext(code,context),nodes,requests,messages,state};
}
test('失败记录提供重试，禁止测活/导出；运行中提供停止和验证码入口',async()=>{
 const h=await harness();
 const html=h.run('rowHtml(adobeCache[1])');
 assert.match(html,/onclick="retryOne\(1\)"/);
 assert.match(html,/data-adobe-action="session"[^>]*disabled[^>]*onclick="liveCheckOne/);
 assert.doesNotMatch(h.run('rowHtml(adobeCache[2])'),/retryOne/);
 assert.match(h.run('rowHtml({id:3,status:"waiting_code"})'),/stopOne\(3\)/);
 assert.match(h.run('rowHtml({id:3,status:"waiting_code"})'),/openCodeModal\(3\)/);
});
test('选择失败记录时测活不会退化成全部测活',async()=>{
 const h=await harness();h.run('adobeSelected.add(1)');await h.run('liveCheckSelected()');
 assert.equal(h.requests.length,0);assert.match(h.messages[0][0],/注册成功/);
});
test('混合批量重试只处理失败项，准确显示失败和跳过',async()=>{
 const h=await harness([failed,registered,{...failed,id:3}]);
 h.run('[1,2,3].forEach(id=>adobeSelected.add(id))');
 h.state.respond=(url)=>url.endsWith('/3/retry')?{status:409,body:{error:'任务已在运行'}}:null;
 await h.run('retrySelected()');
 assert.deepEqual(h.requests.filter(x=>x.opts?.method==='POST').map(x=>x.url),['/api/adobe/registrations/1/retry','/api/adobe/registrations/3/retry']);
 assert.match(h.nodes.get('adobe-action-result').textContent,/启动重试 1 项，失败 1 项，跳过 1 项/);
 assert.match(h.nodes.get('adobe-action-result').textContent,/#3: 任务已在运行/);
});
test('删除接口失败不再报告全部成功，保留失败项选择',async()=>{
 const h=await harness();h.run('[1,2].forEach(id=>adobeSelected.add(id))');
 h.state.respond=url=>url.endsWith('/2')?{status:500,body:{error:'数据库忙'}}:null;
 await h.run('delSelected()');
 assert.equal(h.run('adobeSelected.has(1)'),false);assert.equal(h.run('adobeSelected.has(2)'),true);
 assert.match(h.nodes.get('adobe-action-result').textContent,/删除 1 项，失败 1 项/);
});
test('单条重试连点只发一次请求，错误会显示',async()=>{
 const h=await harness();let release;
 h.state.respond=async url=>{
  if(url.endsWith('/retry')){await new Promise(resolve=>release=resolve);return {status:409,body:{error:'已在运行'}};}
 };
 const first=h.run('retryOne(1)');await h.run('retryOne(1)');release();await first;
 assert.equal(h.requests.filter(x=>x.url.endsWith('/retry')).length,1);
 assert.ok(h.messages.some(([message])=>message==='已在运行'));
});
test('验证码校验和停止错误反馈',async()=>{
 const h=await harness([{...failed,status:'waiting_code',can_retry:false}]);
 h.run('openCodeModal(1)');h.nodes.get('adobe-code').value='abc';await h.run('submitAdobeCode()');
 assert.equal(h.requests.length,0);
 h.nodes.get('adobe-code').value='123456';await h.run('submitAdobeCode()');
 assert.deepEqual(JSON.parse(h.requests.find(x=>x.url.endsWith('/code')).opts.body),{code:'123456'});
 h.state.respond=url=>url.endsWith('/stop')?{status:409,body:{error:'任务已结束'}}:null;
 await h.run('stopOne(1)');assert.ok(h.messages.some(([m])=>m==='任务已结束'));
});
test('列表请求失败保留已有数据并显示原因',async()=>{
 const h=await harness();h.state.respond=url=>url.includes('/registrations?')?{status:500,body:{error:'数据库不可用'}}:null;
 await h.run('load()');assert.equal(h.run('adobeCache[1].id'),1);
 assert.match(h.messages.at(-1)[0],/数据库不可用/);
});
test('HTML 中全部按钮处理函数都存在',async()=>{
 const h=await harness();
 const html=fs.readFileSync(require('node:path').join(__dirname,'../static/adobe.html'),'utf8');
 for(const [,fn] of html.matchAll(/onclick="([A-Za-z]+)\(/g)){
  if(fn==='toggleExportUnshipped') continue; // 共用布局提供
  assert.equal(h.run('typeof '+fn),'function',fn);
 }
});
test('数据未变化时轮询不替换表格，避免打断按钮点击',async()=>{
 const h=await harness();
 // 初次读取浏览器状态会改变重试按钮，先完成这一轮更新。
 await h.run('load()');
 const rows=h.nodes.get('rows');let writes=0,value=rows.innerHTML;
 Object.defineProperty(rows,'innerHTML',{get(){return value},set(v){writes++;value=v}});
 await h.run('load()');await h.run('load()');
 assert.equal(writes,0);
});

test('无头默认开启，保存后重新加载保留，失败时还原',async()=>{
 const h=await harness(),toggle=h.nodes.get('adobe-headless');
 assert.equal(toggle.checked,true);
 toggle.checked=false;await h.run('saveAdobeBrowserMode()');await h.run('loadAdobeBrowserMode()');
 assert.equal(toggle.checked,false);assert.equal(h.state.headless,false);
 h.state.respond=(url,opts)=>opts?.method==='PUT'?{status:500,body:{error:'写入失败'}}:null;
 toggle.checked=true;await h.run('saveAdobeBrowserMode()');
 assert.equal(toggle.checked,false);assert.equal(toggle.disabled,false);
 assert.ok(h.messages.some(([m])=>m.includes('写入失败')));
});
test('操作列使用可见文字按钮',async()=>{
 const h=await harness(),html=h.run('rowHtml(adobeCache[1])');
 const actions=html.slice(html.indexOf('adobe-row-actions'));
 for(const label of ['查看日志','重新注册','检测存活','导出 Cookie','导出 JSON','删除记录']) assert.ok(actions.includes('>'+label+'</button>'),label);
 assert.doesNotMatch(actions,/<svg/);
});

test('已存在账号显示已注册，不提供重试或可用会话操作',async()=>{
 const h=await harness([{id:7,email:'exists@example.com',status:'skipped',can_retry:false,has_auth:false}]);
 const html=h.run('rowHtml(adobeCache[7])');
 assert.match(html,/<span class="badge registered">已注册<\/span>/);assert.doesNotMatch(html,/retryOne|stopOne|openCodeModal/);
 h.run('adobeSelected.add(7)');await h.run('retrySelected()');
 assert.equal(h.requests.filter(r=>r.opts?.method==='POST').length,0);
});
