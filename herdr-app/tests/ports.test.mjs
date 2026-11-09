import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const base = new URL('../profile/mods/odysseas-ports/', import.meta.url);
const modelSource = await readFile(new URL('model.js', base), 'utf8');
const model = await import(uri(modelSource));
const { parseStatus, rowsFor, rowKey, enabled, togglePath, localUrl, manualPath, metadataBody, request } = model;
const sample = {
  host:'debina', connected:true, last_error:null, last_scan_ms:1,
  tunnels:[
    {remote_port:3000,local_port:3001,label:'Web',group:'Luca',process:'vite',state:'active'},
    {remote_port:8080,local_port:null,label:'',group:'',process:'node',state:'disabled'},
  ],
  reverse_tunnels:[
    {remote_port:5037,local_port:5039,process:'adb',state:'error'},
    {remote_port:9000,local_port:9000,process:'server',state:'available'},
  ],
};
const status = parseStatus(sample);
assert.equal(status.last_error, '');
assert.deepEqual(rowsFor(status,'forward','VITE').map(r=>r.remote_port),[3000]);
assert.deepEqual(rowsFor(status,'forward','3001').map(r=>r.remote_port),[3000]);
assert.equal(rowsFor(status,'reverse').length,2);
assert.equal(rowKey(status.tunnels[0]),'3000:3001');
assert.equal(localUrl(status.tunnels[0]),'http://127.0.0.1:3001');
assert.equal(localUrl(status.tunnels[1]),null);
assert.equal(enabled(status.tunnels[1],'forward'),false);
assert.equal(enabled(status.reverse_tunnels[0],'reverse'),true,'an error reverse mapping is still configured');
assert.equal(enabled(status.reverse_tunnels[1],'reverse'),false);
assert.equal(togglePath(status.reverse_tunnels[0],'reverse'),'/api/reverse/5037/5039/toggle');
assert.equal(manualPath('4500','forward',status),'/api/tunnels/4500/toggle');
assert.equal(manualPath('4500:4501','reverse',status),'/api/reverse/4500/4501/toggle');
assert.equal(manualPath('4500','reverse',status),'/api/reverse/4500/4500/toggle');
assert.equal(manualPath('8080','forward',status),'/api/tunnels/8080/toggle');
assert.throws(()=>manualPath('3000','forward',status),/already/);
assert.throws(()=>manualPath('5037:5040','reverse',status),/already/);
for(const input of ['0','80','65536','1e4','12.5','3000; touch /tmp/oops','-1234','']) assert.throws(()=>manualPath(input,'forward',status));
assert.throws(()=>manualPath('43117','forward',status),/control/);
assert.throws(()=>manualPath('43117:5037','reverse',status),/control/);
assert.throws(()=>manualPath('4500:43117','forward',status));
assert.deepEqual(metadataBody('label','  Web “dev”  '),{label:'Web “dev”'});
assert.deepEqual(metadataBody('group',''),{group:''});
assert.throws(()=>metadataBody('label','🙂'.repeat(49)),/48/);
assert.throws(()=>metadataBody('group','a'.repeat(33)),/32/);
assert.throws(()=>parseStatus({}),/invalid/);
assert.throws(()=>parseStatus({...sample,tunnels:[{...sample.tunnels[0],state:'surprise'}]}),/invalid/);
assert.throws(()=>parseStatus({...sample,tunnels:[{...sample.tunnels[0],local_port:null}]}),/invalid/);
assert.deepEqual(parseStatus({...sample,reverse_tunnels:undefined}).reverse_tunnels,[]);

let commands=[];
const exec = async (cmd,args,options) => { commands.push({cmd,args,options}); return {code:0,stdout:JSON.stringify(sample)+'\n200',stderr:''}; };
assert.deepEqual(await request(exec,{platform:'windows'},'/api/status',undefined,'GET'),status);
assert.equal(commands[0].cmd,'curl.exe');
assert.deepEqual(commands[0].options,{on:null});
assert.ok(commands[0].args.includes('--max-time'));
assert.ok(commands[0].args.includes('--noproxy'));
assert.equal(commands[0].args.at(-1),'http://127.0.0.1:43117/api/status');
const payload={label:'$(touch /tmp/nope); "quoted" 🙂'};
await request(async (...args)=>{await exec(...args);return {code:0,stdout:'\n204',stderr:''};},{on:'debina',platform:'windows'},'/api/tunnels/3000/label',payload);
assert.equal(commands[1].cmd,'curl');
assert.deepEqual(commands[1].options,{on:'debina'});
assert.equal(commands[1].args[commands[1].args.indexOf('--data-binary')+1],JSON.stringify(payload));
await assert.rejects(request(exec,{},'/api/status?url=https://evil',undefined,'GET'),/Invalid/);
await assert.rejects(request(exec,{apiPort:80},'/api/status',undefined,'GET'),/Invalid/);
await assert.rejects(request(async()=>({code:0,stdout:'redirect\n302'}),{},'/api/refresh'),/302/);
await assert.rejects(request(async()=>({code:0,stdout:'already mapped\n409'}),{},'/api/refresh'),/already mapped/);
await assert.rejects(request(async()=>({code:28,stdout:'',stderr:'timed out'}),{},'/api/refresh'),/timed out/);

// The actual view, with GPUI/Herdr mocked. Render every dynamic branch, not
// just the initial loading UI. No real daemon, tunnels, terminals or network.
function element() {
  const el = {items:[],handlers:{}};
  const proxy = new Proxy(el,{get(target,key){
    if(key in target) return target[key];
    if(key==='child') return child=>{target.items.push(child);return proxy;};
    if(key==='children') return children=>{target.items.push(...children);return proxy;};
    if(key==='when') return (cond,body)=>{if(cond)body(proxy);return proxy;};
    if(key==='id') return id=>{target.idValue=id;return proxy;};
    if(String(key).startsWith('on_')) return (...args)=>{target.handlers[key]=args.at(-1);return proxy;};
    return ()=>proxy;
  }});
  return proxy;
}
function inputState(opts={}) {
  let value=opts.value??'';
  return {handlers:{},on(type,fn){this.handlers[type]=fn;},value:()=>value,set_value(v){value=v;},focus(){}};
}
const text = el => typeof el==='string'?el:typeof el==='number'?String(el):(el?.items??[]).map(text).join(' ');
const find = (el,id) => el?.idValue===id?el:(el?.items??[]).map(e=>find(e,id)).find(Boolean);
const state={props:{},calls:[],tasks:[],timers:[],closed:[],urls:[],copies:[],active:true,fail:false,hold:null};
const cx={notify(){},stop_propagation(){},focus_handle:()=>({focus(){}}),open_url:url=>state.urls.push(url),write_to_clipboard:value=>state.copies.push(value),
  spawn(fn){const promise=Promise.resolve(fn(cx));state.tasks.push(promise);return {cancel(){}};},
  timer:{every(ms,fn){const timer={ms,fn,cancelled:false,cancel(){this.cancelled=true;}};state.timers.push(timer);return timer;},after(_ms,fn){fn(cx);return {cancel(){}};}},
};
const drain=async()=>{while(state.tasks.length)await Promise.all(state.tasks.splice(0));};
globalThis.__portsMock={
  View:class{},div:element,h_flex:element,v_flex:element,InputState:{new:inputState},Input:{new:()=>element()},
  theme:()=>({}),props:()=>state.props,closeOverlay:id=>state.closed.push(id),machines:()=>[{name:null,layout:'ready'},{name:'debina',layout:'ready'}],
  window:()=>({platform:'linux',active:state.active}),
  exec:async(cmd,args,options)=>{
    state.calls.push({cmd,args,options});
    if(state.hold)await state.hold;
    if(state.fail)return {code:28,stdout:'',stderr:'timeout'};
    const method=args[args.indexOf('--request')+1];
    return {code:0,stdout:method==='GET'?JSON.stringify(sample)+'\n200':'\n204',stderr:''};
  },
};
const names='View,div,h_flex,v_flex,InputState,Input,theme,props,closeOverlay,exec,machines,window';
const mocks=uri(`export const {${names}} = globalThis.__portsMock;`);
let viewSource=await readFile(new URL('main.js',base),'utf8');
for(const name of ['gpui-kit','gpui-base','herdr'])viewSource=viewSource.replace(`from "${name}"`,`from "${mocks}"`);
viewSource=viewSource.replace('from "./model.js"',`from "${uri(modelSource)}"`);
const {default: Ports}=await import(uri(viewSource));
const checkView=new Ports();checkView.init({},cx);checkView.render();
assert.equal(state.calls.length,0,'mod check must not call portd');
assert.equal(state.timers.length,0,'mod check must not poll');
state.props={overlay:'test'};
const view=new Ports();view.init({},cx);await drain();
assert.equal(view.available,true);
assert.match(text(view.render()),/Development ports.*Web/s);
assert.equal(state.calls.length,1);
const click=id=>{const el=find(view.render(),id);assert.ok(el,`missing ${id}`);el.handlers.on_click({},cx);};
click('open-3000');assert.deepEqual(state.urls,['http://127.0.0.1:3001']);
click('copy-3000');assert.deepEqual(state.copies,['http://127.0.0.1:3001']);
click('edit-label');view.editor.set_value('Native label');view.submitForm(cx);await drain();
assert.equal(view.form,null);
assert.ok(state.calls.some(c=>c.args.includes('/api/tunnels/3000/label')||c.args.at(-1).endsWith('/api/tunnels/3000/label')));
view.changeMode('reverse',cx);assert.match(text(view.render()),/Local service/);
view.beginForm('manual',null,cx);view.editor.set_value('5037:5040');view.submitForm(cx);
assert.match(view.formError,/already/);assert.ok(view.form);
view.editor.set_value('4500:4501');view.submitForm(cx);await drain();
assert.ok(state.calls.at(-2).args.at(-1).endsWith('/api/reverse/4500/4501/toggle'));
// Disabled rows and errors never manufacture a successful status.
state.fail=true;view.refresh(cx);await drain();
assert.equal(view.available,false);assert.match(text(view.render()),/timeout/);
const before=state.calls.length;view.toggle(view.status.reverse_tunnels[0],cx);await drain();assert.equal(state.calls.length,before);
state.fail=false;view.refresh(cx);await drain();
// Duplicate clicks cannot double-toggle. A timeout never automatically retries POST.
let release;state.hold=new Promise(resolve=>{release=resolve;});
view.toggle(view.status.reverse_tunnels[0],cx);view.toggle(view.status.reverse_tunnels[0],cx);
assert.equal(state.calls.length,before+2);release();state.hold=null;await drain();
// Polling is open-only and skips an inactive window.
state.active=false;const calls=state.calls.length;state.timers.at(-1).fn(cx);await drain();assert.equal(state.calls.length,calls);
state.active=true;
view.changeSource('debina',cx);await drain();assert.deepEqual(state.calls.at(-1).options,{on:'debina'});
assert.match(text(view.render()),/different computer/);
view.mode='forward';view.beginForm('group',view.status.tunnels[0],cx);assert.match(text(view.render()),/Group for port/);
view.key({key:'escape'},cx);assert.equal(view.form,null);assert.equal(state.closed.length,0);
view.key({key:'escape'},cx);assert.deepEqual(state.closed,['test']);
view.close();assert.equal(state.timers.at(-1).cancelled,true);
// Late replies from a previous controller cannot replace the new one's status.
const other=new Ports();other.init({},cx);await drain();
state.hold=new Promise(resolve=>{release=resolve;});other.refresh(cx);other.changeSource('debina',cx);
other.close();release();state.hold=null;await drain();assert.equal(other.status,null);
assert.equal(state.calls.some(c=>c.cmd==='sh'),false);
console.log('Ports tests: PASS (model, bounded loopback/SSH transport, native controls, stale/error states, duplicate-toggle guard, lifecycle)');
