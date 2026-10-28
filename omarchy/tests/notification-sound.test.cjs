const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const root = join(__dirname, '../.config/omarchy/plugins/odysseas.notifications');
const logic = vm.createContext({});
vm.runInContext(readFileSync(join(root, 'SoundLogic.js'), 'utf8'), logic);
const bb = { appName: 'bb', hints: { 'desktop-entry': 'bb-desktop' } };

test('only BB sender identities chime; body/title cannot opt other apps in', () => {
  assert.equal(logic.shouldChime(bb, false), true);
  assert.equal(logic.shouldChime({ appName: 'BB' }, false), true);
  assert.equal(logic.shouldChime({ hints: { 'desktop-entry': 'bb-desktop.desktop' } }, false), true);
  assert.equal(logic.shouldChime({ appName: 'bb', hints: { 'desktop-entry': 'slack' } }, false), false);
  assert.equal(logic.shouldChime({ appName: 'Slack', summary: 'bb', body: 'bb-desktop' }, false), false);
  assert.equal(logic.shouldChime(null, false), false);
});

test('DND and suppress-sound hints are respected', () => {
  assert.equal(logic.shouldChime(bb, true), false);
  for (const suppressed of [true, 1, 'true', '1']) {
    assert.equal(logic.shouldChime({ ...bb, hints: { ...bb.hints, 'suppress-sound': suppressed } }, false), false);
  }
  for (const suppressed of [false, 0, 'false', '0']) {
    assert.equal(logic.shouldChime({ ...bb, hints: { ...bb.hints, 'suppress-sound': suppressed } }, false), true);
  }
});

test('bursts and overlapping playback do not stack sounds', () => {
  assert.equal(logic.canPlay(bb, false, false, 10000, 0), true);
  assert.equal(logic.canPlay(bb, false, false, 10000, 9000), false);
  assert.equal(logic.canPlay(bb, false, true, 10000, 0), false);
  assert.equal(logic.canPlay(bb, false, false, 10000, 7000), true);
  assert.equal(logic.canPlay(bb, true, false, 10000, 0), false);
});

test('replacement content chimes, image and timeout changes do not', () => {
  const before = { summary: 'Thread', body: 'Finished', image: 'old' };
  assert.equal(logic.contentChanged(before, { ...before, body: 'Needs input' }), true);
  assert.equal(logic.contentChanged(before, { ...before, summary: 'Other thread' }), true);
  assert.equal(logic.contentChanged(before, { ...before, image: 'new', expireTimeout: 5000 }), false);
});

test('sound reuses the exact Herdr done asset', () => {
  const mp3 = readFileSync(join(root, 'sounds/herdr-done.mp3'));
  assert.equal(createHash('sha256').update(mp3).digest('hex'),
    'cb9c93492c808e33946edac2ab5915758267e65914bc4b794a5ca6dc6e655741');
  const generator = readFileSync(join(root, 'sounds/generate-chime.py'), 'utf8');
  assert(generator.includes('herdr-done.mp3'));
  assert(!generator.includes('math.sin'));
});

test('Herdr audio has Bluetooth padding and is non-silent without clipping', () => {
  const wav = readFileSync(join(root, 'sounds/bb-notification.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 48000);
  const samples = [];
  for (let i = 44; i < wav.length; i += 2) samples.push(wav.readInt16LE(i));
  assert(samples.length > 48000 * 2 && samples.length < 48000 * 4);
  assert(samples.slice(0, 24000).every(x => x === 0));
  assert(samples.slice(-38400).every(x => x === 0));
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert(peak > 1000 && peak < 32767);
});

test('service only plays on live arrival or changed live content, never history replay', () => {
  const source = readFileSync(join(root, 'Service.qml'), 'utf8');
  assert(source.includes('playBbChime(notification)\n    persistPopupFile(snapshot)'));
  assert(source.includes('if (SoundLogic.contentChanged(row, updated)) playBbChime(notification)'));
  const replay = source.slice(source.indexOf('function replayHistory('), source.indexOf('// ---------------------------------------------------- settings persistence'));
  assert(!replay.includes('playBbChime'));
  assert(source.includes('"pw-play", "--volume=0.65"'));
});
