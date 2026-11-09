import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../profile/mods/odysseas-nav/actions.js', import.meta.url), 'utf8');
const {plan} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const state = {
  spaces: [{id:'s1', tabs:[{id:'t1'},{id:'t2'}]}, {id:'s2', tabs:[]}],
  panes: [{pane:'p1',tab:'t1'},{pane:'p2',tab:'t1'},{pane:'p3',tab:'t2'}],
  agents: [{address:'debina/t7'}],
  focus: {space:'s1',tab:'t1',pane:'p1',terminal:'debina/t7',cwd:'/srv/repo'}
};
assert.deepEqual(plan('last',state,'p3'), [['pane.focus',{pane:'p3'}]]);
assert.deepEqual(plan('last',state,'closed'), []);
assert.deepEqual(plan('cycle-next',state), [['pane.focus',{pane:'p2'}]]);
assert.deepEqual(plan('cycle-prev',state), [['pane.focus',{pane:'p2'}]]);
assert.deepEqual(plan('tab-left',state), []);
assert.deepEqual(plan('tab-right',state), [['tab.move',{id:'t1',index:2}]]);
assert.deepEqual(plan('space-down',state), [['space.move',{id:'s1',index:2}]]);
assert.deepEqual(plan('agent-1',state), [['agent.focus',{terminal:'debina/t7'}]]);
assert.deepEqual(plan('agent-9',state), []);
assert.deepEqual(plan('files',state), [['layout.select',{stack:'panel-body',child:'files'}],['layout.show',{id:'panel'}]]);
assert.deepEqual(plan('editor-split',state), [['terminal.open',{name:'Editor',argv:['nvim'],folder:'/srv/repo',place:'right'}]]);
assert.deepEqual(plan('git',state), [['terminal.open',{name:'Git repositories',argv:['workspace-git'],folder:'/srv/repo',place:'tab'}]]);
assert.deepEqual(plan('editor',{...state,focus:null}), []);
assert.deepEqual(plan('ports',state), [['mod.open',{name:'odysseas-ports'}]]);
assert.deepEqual(plan('ports',{...state,focus:null}), [['mod.open',{name:'odysseas-ports'}]]);
console.log('Navigation action tests: PASS (15 assertions)');
