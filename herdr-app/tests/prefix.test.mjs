import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const base = new URL('../profile/', import.meta.url);
const keys = JSON.parse(await readFile(new URL('keys.json', base), 'utf8'));
assert.equal(keys['layout:odysseas']['ctrl-space'], 'odysseas-nav.prefix');
assert.equal(keys['layout:odysseas-t3']['ctrl-space'], 'odysseas-nav.prefix');
assert.equal(keys['layout:odysseas-city']['ctrl-space'], 'odysseas-nav.prefix');
const native = Object.entries(keys.global).filter(([key]) => key.startsWith('ctrl-space '));
assert.deepEqual(keys['mod:odysseas-nav'], Object.fromEntries(native.map(([key, action]) =>
  [key.slice('ctrl-space '.length), `odysseas-nav.key:${action === 'send:\u0000' ? 'literal-prefix' : action}`])));
// Other layouts still get their original native sequences; direct keys remain intact.
assert.equal(keys.global['ctrl-space c'], 'tab.new');
assert.equal(keys.global['ctrl-space a'], 'odysseas-t3-chrome.sidebar');
assert.equal(keys.global['ctrl-space shift-a'], 'odysseas-t3-tabs.view');
assert.equal(keys.global['ctrl-space b'], 'layout.toggle:sidebar');
assert.equal(keys.global['alt-1'], 'space.select:1');

function element() {
  const el = {children: [], handlers: {}};
  return new Proxy(el, {get(target, key) {
    if (key in target) return target[key];
    if (key === 'child') return child => { target.children.push(child); return el.proxy; };
    if (key === 'when') return (condition, callback) => { if (condition) callback(el.proxy); return el.proxy; };
    if (key === 'on_action') return (action, callback) => { target.handlers[action] = callback; return el.proxy; };
    if (key.startsWith('on_')) return callback => { target.handlers[key] = callback; return el.proxy; };
    return () => el.proxy;
  }, set(target, key, value) { target[key] = value; return true; }});
}
function div() { const el = element(); el.proxy = el; return el; }
const text = el => typeof el === 'string' ? el : (el.children ?? []).map(text).join(' ');
const state = {
  focus: {pane:'p1', terminal:'debina/t1', space:'s1', tab:'t1', cwd:'/repo'},
  spaces: [{id:'s1', active:true, machine:'debina', tabs:[{id:'t1'}]}],
  panes: [{pane:'p1', tab:'t1'}, {pane:'p2', tab:'t1'}],
  props: {}, active: true, ownsFocus: false, calls: [], sends: [], notifications: [], timers: [], tasks: [],
};
const handle = {focus: () => { state.ownsFocus = true; }, is_focused: () => state.ownsFocus};
const cx = {
  focus_handle: () => handle,
  notify: () => {},
  sleep: async () => {},
  spawn(body) { const promise = Promise.resolve(body(cx)); state.tasks.push(promise); return {cancel() {}}; },
  timer: {every(ms, callback) {
    const timer = {ms, callback, cancelled:false, cancel() { this.cancelled = true; }};
    state.timers.push(timer);
    return timer;
  }},
};
globalThis.__navigationMock = {
  View: class {}, div, h_flex: div, props: () => state.props,
  spaces: () => state.spaces, panes: () => state.panes, agents: () => [],
  focused: () => state.focus, machines: () => [],
  run: (name, args) => { state.calls.push([name, args]); if (name === 'pane.focus') state.ownsFocus = false; },
  theme: () => ({}), nextCommand: () => new Promise(() => {}),
  window: () => ({platform:'linux', active:state.active}), exec: async () => ({code:0}),
  home: () => '/home/test', notify: value => state.notifications.push(value),
  keys: () => Object.entries(keys).flatMap(([section, bindings]) =>
    Object.entries(bindings).map(([keys, action]) => ({section, keys, action}))),
};
const names = 'View,div,h_flex,spaces,panes,agents,focused,machines,run,theme,nextCommand,window,exec,home,notify,keys,props';
const mocks = uri(`export const {${names}} = globalThis.__navigationMock;`);
globalThis.window = {dispatch_action: action => {
  if (action.startsWith('pane.focus:')) {
    state.calls.push(['pane.focus',{pane:action.slice('pane.focus:'.length)}]);
    state.ownsFocus = false;
  } else state.sends.push(action);
}};
const actions = uri(await readFile(new URL('mods/odysseas-nav/actions.js', base), 'utf8'));
let source = await readFile(new URL('mods/odysseas-nav/main.js', base), 'utf8');
for (const name of ['gpui-kit', 'gpui-base', 'herdr']) source = source.replace(`from "${name}"`, `from "${mocks}"`);
source = source.replace('from "./actions.js"', `from "${actions}"`);
const {default: Navigation} = await import(uri(source));
const nav = new Navigation();
nav.init({}, cx);
assert.equal(state.timers.length, 0, 'idle footer must not poll');
assert.doesNotMatch(text(nav.render()), /PREFIX/);

nav.command('prefix', cx);
assert.equal(state.ownsFocus, true);
assert.match(text(nav.render()), /PREFIX · Esc cancels/);
const firstTimer = state.timers.at(-1);
firstTimer.callback(cx);
assert.equal(firstTimer.cancelled, false, 'prefix has no expiry');
nav.render().handlers['odysseas-nav.key:tab.new']({}, {...cx, stop_propagation() {}});
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}], ['tab.new',undefined]]);
assert.equal(firstTimer.cancelled, true);
assert.equal(nav.prefix, null);
assert.doesNotMatch(text(nav.render()), /PREFIX/);

// T3 toggles use the existing mod commands and leave prefix mode cleanly.
for (const stroke of ['a', 'shift-a']) {
  const action = keys['mod:odysseas-nav'][stroke];
  nav.command('prefix', cx);
  nav.render().handlers[action]({}, {...cx, stop_propagation() {}});
  assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}], [keys.global[`ctrl-space ${stroke}`],undefined]]);
  assert.equal(nav.prefix, null);
  assert.equal(state.ownsFocus, false);
}

// City reuses prefix → a for overview/work without changing T3's behavior.
state.props = {prefixActions:{'odysseas-t3-chrome.sidebar':'odysseas-city.mode'}};
nav.command('prefix', cx);
nav.command('key:odysseas-t3-chrome.sidebar', cx);
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}], ['odysseas-city.mode',undefined]]);
assert.equal(nav.prefix, null);
assert.equal(state.ownsFocus, false);
state.props = {};

nav.command('prefix', cx);
nav.command('key:odysseas-nav.cycle-next', cx);
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}], ['pane.focus',{pane:'p2'}]]);

nav.command('prefix', cx);
let stopped = false;
nav.render().handlers.on_key_down({key:'unbound'}, {...cx, stop_propagation: () => { stopped = true; }});
assert.equal(stopped, true);
assert.equal(nav.prefix, null);
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}]]);

nav.command('prefix', cx);
nav.command('key:overlay.close', cx);
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}], ['overlay.close',undefined]]);

nav.command('prefix', cx);
nav.command('key:literal-prefix', cx);
await Promise.resolve();
assert.deepEqual(state.sends, ['send:\u0000']);
assert.equal(nav.prefix, null);
state.calls.length = 0;

// Clicking an input cancels without taking its newly acquired focus away.
nav.command('prefix', cx);
nav.outsidePrefix(cx);
state.ownsFocus = false;
await Promise.resolve();
assert.equal(nav.prefix, null);
assert.deepEqual(state.calls, []);
// A bare chrome click restores the terminal if nothing else took focus.
nav.command('prefix', cx);
nav.outsidePrefix(cx);
await Promise.resolve();
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}]]);

nav.command('prefix', cx);
state.ownsFocus = false;
state.timers.at(-1).callback(cx);
assert.equal(nav.prefix, null);
assert.deepEqual(state.calls, [], 'focus loss must not steal focus back');
nav.command('key:tab.new', cx);
assert.deepEqual(state.calls, [], 'late second strokes must be ignored');

// A direct app shortcut ends prefix mode but keeps its normal native action.
nav.command('prefix', cx);
let propagated = false;
nav.render().handlers['pane.zoom']({}, {...cx, propagate() { propagated = true; }});
await Promise.resolve();
assert.equal(propagated, true);
assert.equal(nav.prefix, null);
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}]]);

nav.command('prefix', cx);
state.active = false;
state.timers.at(-1).callback(cx);
assert.notEqual(nav.prefix, null, 'window activation is not keyboard-focus ownership (notably under Xvfb)');
nav.endPrefix(cx);
assert.deepEqual(state.calls.splice(0), [['pane.focus',{pane:'p1'}]]);
state.active = true;

state.focus = {...state.focus, pane:null};
nav.command('prefix', cx);
nav.endPrefix(cx);
assert.deepEqual(state.calls.splice(0), [['pane.focus',{terminal:'debina/t1'}]]);
nav.command('prefix', cx);
nav.close();
assert.equal(state.timers.at(-1).cancelled, true);
assert.deepEqual(state.notifications, []);
console.log(`Prefix tests: PASS (${native.length} shortcut bridges, indicator, dispatch, cancellation, literal Ctrl+Space, focus restoration)`);
