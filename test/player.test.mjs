// Run with: node --test
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const P = require('../player.js');

const b64sha = (text) => createHash('sha256').update(text).digest('base64');

test('sha256 matches node:crypto', () => {
  const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)];
  for (let i = 0; i < 20; i++) samples.push(randomBytes(i * 13).toString('hex'));
  samples.push('pässwörd ✓ 密码');
  for (const text of samples) {
    const ours = Buffer.from(P.sha256(new TextEncoder().encode(text)));
    assert.equal(ours.toString('hex'), createHash('sha256').update(text).digest('hex'), text);
  }
});

test('obs auth string follows the obs-websocket v5 recipe', () => {
  const password = 'supersecretpassword';
  const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
  const challenge = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';
  const expected = b64sha(b64sha(password + salt) + challenge);
  assert.equal(P.obsAuthString(password, salt, challenge), expected);
});

test('the mouth stays shut below the noise gate and opens on speech', () => {
  assert.equal(P.levelTarget(0.01, 2), 0);
  assert.ok(P.levelTarget(0.05, 2) > 0.3);
  assert.equal(P.levelTarget(1, 2), 1);
});

test('the level opens at once and closes over time', () => {
  const open = P.nextLevel(0, 0.08, 2, 16);
  assert.ok(open > 0.3);
  const after = P.nextLevel(open, 0, 2, 50);
  assert.ok(after < open && after > 0);
});

test('talking holds through a short dip', () => {
  let state = P.nextTalking(P.QUIET, 0.5, 1000, 100);
  assert.equal(state.talking, true);
  state = P.nextTalking(state, 0.1, 1050, 100);
  assert.equal(state.talking, true, 'inside the hold');
  state = P.nextTalking(state, 0.1, 1150, 100);
  assert.equal(state.talking, false, 'after the hold');
});

test('meters read the faded magnitude, never the raw peak', () => {
  const inputs = [
    { inputName: 'Mic/Aux', inputLevelsMul: [[0, 0, 0.9], [0, 0, 0.8]] },
    { inputName: 'Desktop', inputLevelsMul: [[0.5, 0.6, 0.6]] },
  ];
  assert.equal(P.micLevelFromMeters(inputs, 'Mic/Aux'), 0);
  assert.equal(P.micLevelFromMeters(inputs, 'Desktop'), 0.5);
  assert.equal(P.micLevelFromMeters(inputs, 'Missing'), null);
});

test('the mic input is Mic/Aux, else the first microphone source', () => {
  assert.equal(P.pickMicInput({ mic1: 'Mic/Aux' }, []), 'Mic/Aux');
  const inputs = [
    { inputName: 'Game', unversionedInputKind: 'wasapi_output_capture' },
    { inputName: 'Headset', unversionedInputKind: 'coreaudio_input_capture' },
  ];
  assert.equal(P.pickMicInput({ mic1: null }, inputs), 'Headset');
  assert.equal(P.pickMicInput(null, [inputs[0]]), null);
});

test('close codes', () => {
  assert.deepEqual(P.closeCodeToStatus(4009), { status: 'auth_failed', retry: false });
  assert.deepEqual(P.closeCodeToStatus(4010), { status: 'unsupported', retry: false });
  assert.deepEqual(P.closeCodeToStatus(1006), { status: 'unreachable', retry: true });
});

test('frames fall back to the nearest one that exists', () => {
  const all = { idle: 'i', talking: 't', blink: 'b', blinkTalking: 'bt' };
  assert.equal(P.roleFor(all, true, true), 'blinkTalking');
  assert.equal(P.roleFor({ idle: 'i', talking: 't' }, true, true), 'talking');
  assert.equal(P.roleFor({ idle: 'i', blink: 'b' }, false, true), 'blink');
  assert.equal(P.roleFor({ idle: 'i' }, true, false), 'idle');
  assert.equal(P.roleFor({}, false, false), null);
});
