import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../profile/mods/', import.meta.url);
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const contextSource = await readFile(new URL('odysseas-t3-agents/context.js', root), 'utf8');
assert.equal(await readFile(new URL('odysseas-t3-focus/context.js', root), 'utf8'), contextSource, 'both views must use the same context rules');
const contextModule = uri(contextSource);
const {parseRepo, agentSource, describeProject, ProjectContext} = await import(contextModule);
assert.deepEqual(parseRepo('/worktrees/δοκιμή\n/repos/Λούκα/.git\n'), {project:'Λούκα', checkout:'δοκιμή', linked:true});
assert.deepEqual(parseRepo('/repo\n/repo/.git\n'), {project:'repo', checkout:'repo', linked:false});
assert.deepEqual(parseRepo('/unrelated/feature-a\n/repos/Luca/.git\n'), {project:'Luca', checkout:'feature-a', linked:true});
assert.deepEqual(parseRepo('C:\\work\\feature\r\nC:\\repos\\Luca\\.git\r\n'), {project:'Luca', checkout:'feature', linked:true});
assert.equal(parseRepo(''), null);
assert.equal(parseRepo('fatal: not a repository'), null);
assert.equal(parseRepo('relative\nrelative/.git'), null);

const a = {address:'t1', pane:'p1', space:'s1', space_name:'Editable label'};
const sp = [{id:'s1', name:'Renamed', folder:'/wrong', machine:null}];
const ps = [{pane:'p1', terminal:'t1', cwd:'/checkouts/ticket/src', branch:'ticket/123'}];
assert.equal(agentSource(a, ps, sp, []).cwd, '/checkouts/ticket/src');
assert.equal(agentSource(a, [], sp, [{address:'t1', cwd:'/live'}]).cwd, '/live');
assert.equal(agentSource(a, [], sp, []).cwd, '/wrong');
assert.equal(agentSource({...a, address:'debina/t1', space:'remote'}, [], [], []).on, 'debina');
const source = agentSource(a, ps, sp, []);
assert.equal(describeProject(source, parseRepo('/checkouts/ticket\n/repos/Luca/.git')).label, 'Luca › ticket/123 · local');
assert.equal(describeProject({...source, branch:null}, parseRepo('/checkouts/ticket\n/repos/Luca/.git')).path, 'Luca › ticket');
assert.equal(describeProject({cwd:'', on:null, branch:null, space:''}, null).project, 'Unknown project');

const tasks = [], calls = [];
const cx = {notify() {}, spawn(fn) { const job = fn(cx); tasks.push(job); return {cancel() {}}; }};
const cache = new ProjectContext(async (...args) => { calls.push(args); return {code:0, stdout:'/checkouts/ticket\n/repos/Luca/.git\n'}; });
const snapshot = () => cache.snapshot([a, {...a, address:'t2', pane:'p2'}], [...ps, {pane:'p2', terminal:'t2', cwd:source.cwd, branch:'ticket/123'}], sp, [], cx);
snapshot(); snapshot();
await Promise.all(tasks.splice(0));
assert.equal(calls.length, 1, 'same machine/cwd must be resolved only once');
assert.equal(snapshot()(a).project, 'Luca');
assert.equal(calls.length, 1, 'renders must not poll Git');
assert.deepEqual(calls[0], ['git', ['--no-optional-locks','rev-parse','--path-format=absolute','--show-toplevel','--git-common-dir'], {cwd:source.cwd, on:null}]);
const remote = {...a, address:'debina/t1', pane:'rp', space:'rs'};
cache.snapshot([a, remote], [...ps, {pane:'rp', cwd:source.cwd, branch:'other'}], [...sp, {id:'rs', machine:'debina'}], [], cx);
await Promise.all(tasks.splice(0));
assert.equal(calls.length, 2, 'identical paths on different machines must not share a result');
assert.equal(calls[1][2].on, 'debina');
const switched = [{...ps[0], cwd:'/new/checkout', branch:'new-branch'}];
cache.snapshot([a], switched, sp, [], cx);
await Promise.all(tasks.splice(0));
assert.equal(calls.length, 3, 'changing the agent cwd must resolve a fresh identity');
assert.equal(cache.cache.size, 1, 'ended/moved agents must not retain an unbounded cwd history');
cache.close();
cache.snapshot([a], [{...ps[0], cwd:'/another'}], sp, [], cx);
assert.equal(calls.length, 3, 'closed views must not launch more work');

let failures = 0;
const offline = new ProjectContext(async () => { failures++; throw new Error('offline'); });
offline.snapshot([a], ps, sp, [], cx);
await Promise.all(tasks.splice(0));
assert.equal(offline.snapshot([a], ps, sp, [], cx)(a).path, 'src › ticket/123');
assert.equal(failures, 1, 'failures must not create a redraw/retry loop');
for (const entry of offline.cache.values()) entry.at -= 61000;
offline.snapshot([a], ps, sp, [], cx);
await Promise.all(tasks.splice(0));
assert.equal(failures, 2, 'a later data render can retry an offline machine');

// Render the actual mods, not just the resolver, to protect all views of an agent.
function element() {
  const node = {nodes:[], handlers:{}, attributes:{}};
  return new Proxy(node, {get(target, key) {
    if (key in target) return target[key];
    if (key === 'child') return child => { if (child != null && child !== false) target.nodes.push(child); return node.proxy; };
    if (key === 'children') return children => { target.nodes.push(...children.filter(x => x != null && x !== false)); return node.proxy; };
    if (key === 'when') return (condition, fn) => { if (condition) fn(node.proxy); return node.proxy; };
    if (key === 'hover') return () => node.proxy;
    if (key.startsWith('on_')) return (...args) => { target.handlers[key] = args.at(-1); return node.proxy; };
    return (...args) => { target.attributes[key] = args; return node.proxy; };
  }, set(target, key, value) { target[key] = value; return true; }});
}
function div() { const el = element(); el.proxy = el; return el; }
const text = el => typeof el === 'string' ? el : (el?.nodes ?? []).map(text).join(' ');
const find = (el, id) => typeof el === 'string' ? null : el?.attributes?.id?.[0] === id ? el : (el?.nodes ?? []).map(child => find(child, id)).find(Boolean);
const state = {shared:{}, commands:[], props:{}, execs:[]};
state.agents = [
  {address:'t1', pane:'p1', space:'s1', tab:'tab1', space_name:'Renamed', status:'done', seq:1},
  {address:'t2', pane:'p2', space:'s2', tab:'tab2', space_name:'feature', status:'done', seq:2},
  {address:'debina/t3', pane:'rp', space:'rs', tab:'rt', space_name:'feature', status:'done', seq:3},
].map(a => ({...a, title:'Same task', program:{name:'Pi', key:'pi', icon:null}, focused:false}));
state.spaces = [
  {id:'s1', name:'Renamed', folder:'/repos/Luca', machine:null, tabs:[{id:'tab1'}]},
  {id:'s2', name:'feature', folder:'/elsewhere/feature', machine:null, tabs:[{id:'tab2'}]},
  {id:'rs', name:'feature', folder:'/elsewhere/feature', machine:'debina', tabs:[{id:'rt'}]},
];
state.panes = [
  {pane:'p1', terminal:'t1', tab:'tab1', cwd:'/repos/Luca', branch:'main'},
  {pane:'p2', terminal:'t2', tab:'tab2', cwd:'/elsewhere/feature', branch:'ticket-1'},
  {pane:'rp', terminal:'debina/t3', tab:'rt', cwd:'/elsewhere/feature', branch:'ticket-2'},
];
state.terminals = state.agents.map(a => ({address:a.address, state:'live', labels:{'pi.session':'Same task'}, turn:1, status_ms:Date.now()}));
const storage = new Map();
globalThis.localStorage = {getItem:key => storage.get(key) ?? null, setItem:(key,value) => storage.set(key,value)};
const control = {new:() => div()};
const InputState = {new:() => ({on() {}, value:() => '', set_value() {}, focus() {}})};
globalThis.__agentContextMock = {
  View:class {}, div, image:div, svg:div, h_flex:div, v_flex:div, Button:control, Popover:control, Input:control, InputState,
  agents:() => state.agents, terminals:() => state.terminals, panes:() => state.panes, spaces:() => state.spaces,
  focused:() => ({agent:'t1'}), props:() => state.props,
  shared:key => state.shared[key], setShared:(key,value) => { state.shared[key] = value; }, setAgentOrder() {},
  run:(...args) => state.commands.push(args), hc:async () => ({code:0}), notify() {},
  nextCommand:() => new Promise(() => {}), settings:() => ({}),
  openOverlay() {}, closeOverlay() {}, theme:() => new Proxy({}, {get:() => '#8899aa'}),
  exec:async (...args) => {
    state.execs.push(args);
    const opts = args[2];
    return {code:0, stdout:`${opts.cwd}\n/repos/${opts.on ? 'luca-ims' : 'Luca'}/.git\n`};
  },
};
const mocks = uri(`export const {${Object.keys(globalThis.__agentContextMock).join(',')}} = globalThis.__agentContextMock;`);
const viewCx = {...cx, focus_handle:() => ({focus() {}}), timer:{every:() => ({cancel() {}})}};
const flush = async () => { for (let i=0;i<25;i++) await Promise.resolve(); };
for (const mod of ['odysseas-t3-agents','odysseas-t3-focus']) {
  storage.clear(); state.shared = {}; state.props = {};
  let source = await readFile(new URL(`${mod}/main.js`, root), 'utf8');
  const name = uri((await readFile(new URL(`${mod}/name.js`, root), 'utf8')).replace('from "herdr"', `from "${mocks}"`));
  for (const module of ['herdr','gpui-kit','gpui-base']) source = source.replace(`from "${module}"`, `from "${mocks}"`);
  source = source.replace('from "./name.js"', `from "${name}"`).replace('from "./context.js"', `from "${contextModule}"`);
  const {default:View} = await import(uri(source));
  const view = new View(); view.init({}, viewCx);
  view.render(viewCx); await flush();
  let tree = view.render(viewCx);
  if (mod.endsWith('agents')) {
    for (const sort of ['priority','grouped']) {
      state.shared['agents.sort'] = sort;
      state.shared['agents.pins'] = ['t2'];
      tree = view.render(viewCx);
      assert.match(text(find(tree,'ag-t2')), /Same task.*Luca › ticket-1/);
      assert.match(text(find(tree,'ag-debina/t3')), /luca-ims › ticket-2/);
      assert.match(find(tree,'ag-debina/t3').attributes.accessibility_label[0], /debina/);
      assert.equal(find(tree,'ag-t2').attributes.h[0], 46);
      find(tree,'ag-t2').handlers.on_click();
      assert.deepEqual(state.commands.at(-1), ['agent.focus',{terminal:'t2'}]);
    }
  } else {
    assert.match(text(find(tree,'card-t2')), /Luca · local.*Same task.*↳ ticket-1/);
    assert.match(text(find(tree,'card-debina/t3')), /luca-ims · debina.*Same task.*↳ ticket-2/);
    state.terminals[1].labels.settled = `${Date.now()}:1`;
    view.open = true;
    tree = view.render(viewCx);
    assert.match(text(find(tree,'slim-t2')), /Same task.*Luca › ticket-1 · local/);
    assert.equal(find(tree,'slim-t2').attributes.h[0], 46);
    find(tree,'slim-t2').handlers.on_click();
    assert.deepEqual(state.commands.at(-1), ['agent.focus',{terminal:'t2'}]);
    delete state.terminals[1].labels.settled;
  }
  view.close();
}
console.log('Agent context tests: PASS (Git identity, arbitrary worktree paths, machines, cache/lifecycle, priority/grouped/pinned, Focus and settled rows)');
