import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAsk, stripAsk, detectYesNo, nextAfterAnswer, hardStopAsk, runHardStopAsk, hasContinue, stripContinue } from '../src/ask-flow.mjs';

test('parseAsk: single valid block', () => {
  const r = parseAsk('summary\n<<ASK>>\n[{"q":"Drop or rename?","opts":["drop","rename"]}]\n<<END>>');
  assert.deepEqual(r, [{ q: 'Drop or rename?', opts: ['drop', 'rename'] }]);
});

test('parseAsk: multiple decisions in one block', () => {
  const r = parseAsk('<<ASK>>[{"q":"A","opts":["1","2"]},{"q":"B","opts":["x","y","z"]}]<<END>>');
  assert.equal(r.length, 2);
  assert.equal(r[1].q, 'B');
  assert.deepEqual(r[1].opts, ['x', 'y', 'z']);
});

test('parseAsk: caps opts at 4', () => {
  const r = parseAsk('<<ASK>>[{"q":"Q","opts":["a","b","c","d","e","f"]}]<<END>>');
  assert.deepEqual(r[0].opts, ['a', 'b', 'c', 'd']);
});

test('parseAsk: no block → null', () => {
  assert.equal(parseAsk('just a normal reply'), null);
});

test('parseAsk: malformed JSON → null', () => {
  assert.equal(parseAsk('<<ASK>>[{not json}]<<END>>'), null);
});

test('parseAsk: non-array JSON → null', () => {
  assert.equal(parseAsk('<<ASK>>{"q":"x","opts":["a"]}<<END>>'), null);
});

test('parseAsk: drops items missing q or opts', () => {
  const r = parseAsk('<<ASK>>[{"q":"keep","opts":["a"]},{"q":"noopts"},{"opts":["a"]}]<<END>>');
  assert.deepEqual(r, [{ q: 'keep', opts: ['a'] }]);
});

test('parseAsk: coerces non-string q/opts to strings', () => {
  const r = parseAsk('<<ASK>>[{"q":123,"opts":[1,2]}]<<END>>');
  assert.deepEqual(r, [{ q: '123', opts: ['1', '2'] }]);
});

test('parseAsk: coerces {label,description} option objects to their label (no [object Object])', () => {
  const r = parseAsk('<<ASK>>[{"q":"Fonto storage?","opts":[{"label":"Plan A wins","description":"Fonto owns bytes"},{"label":"D7 vendored wins"}]}]<<END>>');
  assert.deepEqual(r, [{ q: 'Fonto storage?', opts: ['Plan A wins', 'D7 vendored wins'] }]);
});

test('stripAsk: removes the block and trims', () => {
  assert.equal(stripAsk('hello\n<<ASK>>[{"q":"x","opts":["a"]}]<<END>>'), 'hello');
});

test('stripAsk: removes multiple blocks', () => {
  assert.equal(stripAsk('a<<ASK>>x<<END>>b<<ASK>>y<<END>>c'), 'abc');
});

test('stripAsk: no block leaves text intact', () => {
  assert.equal(stripAsk('  plain  '), 'plain');
});

test('detectYesNo: yes/no question → true', () => {
  assert.equal(detectYesNo('Should I proceed?'), true);
});

test('detectYesNo: wh- question → false', () => {
  assert.equal(detectYesNo('Which option do you want?'), false);
});

test('detectYesNo: statement (no ?) → false', () => {
  assert.equal(detectYesNo('Done. All tests pass.'), false);
});

test('detectYesNo: trailing bracket footer still detected', () => {
  assert.equal(detectYesNo('Ready to merge? [PR #5]'), true);
});

test('nextAfterAnswer: more questions → present next idx', () => {
  const q = { items: [{ q: 'A', opts: [] }, { q: 'B', opts: [] }], answers: ['x'], idx: 0 };
  assert.deepEqual(nextAfterAnswer(q), { kind: 'present', idx: 1 });
});

test('nextAfterAnswer: last question → finish with compiled answers', () => {
  const q = { items: [{ q: 'A?', opts: [] }, { q: 'B?', opts: [] }], answers: ['yes', 'no'], idx: 1 };
  const r = nextAfterAnswer(q);
  assert.equal(r.kind, 'finish');
  assert.equal(r.compiled, '1. A? → yes\n2. B? → no');
});

test('nextAfterAnswer: single-question queue finishes immediately', () => {
  const q = { items: [{ q: 'Only?', opts: [] }], answers: ['ok'], idx: 0 };
  assert.deepEqual(nextAfterAnswer(q), { kind: 'finish', compiled: '1. Only? → ok' });
});

test('hardStopAsk: BLOCKED line → selectable item with reason', () => {
  const r = hardStopAsk('did some work\nBLOCKED: migration 0021 needs operator apply');
  assert.equal(r.length, 1);
  assert.match(r[0].q, /Blocked: migration 0021/);
  assert.ok(r[0].opts.includes('Unblock & continue') && r[0].opts.includes('Stop'));
});

test('hardStopAsk: gate/sign-off prose → selectable item', () => {
  assert.ok(hardStopAsk('merge into main blocked -- needs operator sign-off'));
  assert.ok(hardStopAsk('gate (item 5d): blocked'));
});

test('hardStopAsk: normal reply → null', () => {
  assert.equal(hardStopAsk('All tests pass. Deployed.'), null);
});

test('runHardStopAsk: timeout vs error option sets', () => {
  assert.match(runHardStopAsk('timeout')[0].q, /timed out/i);
  assert.ok(runHardStopAsk('timeout')[0].opts.includes('Resume / continue'));
  assert.ok(runHardStopAsk('error')[0].opts.includes('Retry'));
});

test('hasContinue: marker present → true, absent → false', () => {
  assert.equal(hasContinue('Phase 3 shipped.\n<<CONTINUE>>'), true);
  assert.equal(hasContinue('Phase 3 shipped. Next?'), false);
});

test('stripContinue: removes marker and trims', () => {
  assert.equal(stripContinue('Phase 3 shipped.\n<<CONTINUE>>'), 'Phase 3 shipped.');
});

test('hardStopAsk wins over continue is caller-ordered (BLOCKED still detected with marker)', () => {
  // A reply can carry both; runner checks hardStopAsk BEFORE hasContinue.
  assert.ok(hardStopAsk('BLOCKED: needs sign-off\n<<CONTINUE>>'));
});
