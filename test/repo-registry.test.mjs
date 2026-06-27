import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildRegistry, matchRepo } from '../src/repo-registry.mjs';

const reg = buildRegistry([
  '/workspace/frame-forge',
  '/workspace/fonto',
  '/workspace/plexo',
  '/workspace/depona',
]);

test('normalize strips non-alphanumerics + lowercases', () => {
  assert.equal(normalize('Frame-Forge'), 'frameforge');
  assert.equal(normalize('  Plexo_API '), 'plexoapi');
  assert.equal(normalize(''), '');
});

test('buildRegistry dedupes, strips, and drops empty-norm', () => {
  const r = buildRegistry(['/workspace/a', '/workspace/a', ' /workspace/b ', '/', '']);
  assert.deepEqual(r.map((x) => x.path), ['/workspace/a', '/workspace/b']);
});

test('matchRepo: confident single match from plain language', () => {
  assert.deepEqual(matchRepo("let's work on frame forge — run ls", reg), { kind: 'match', path: '/workspace/frame-forge' });
  assert.deepEqual(matchRepo('open fonto please', reg), { kind: 'match', path: '/workspace/fonto' });
});

test('matchRepo: alias ff -> frame-forge', () => {
  assert.deepEqual(matchRepo('ff please', reg), { kind: 'match', path: '/workspace/frame-forge' });
});

test('matchRepo: alias is token-exact, not substring (no false hit inside "diff")', () => {
  assert.deepEqual(matchRepo('show me a diff', reg), { kind: 'none' });
});

test('matchRepo: ambiguous when multiple repos named', () => {
  const res = matchRepo('compare fonto and plexo', reg);
  assert.equal(res.kind, 'ambiguous');
  assert.deepEqual([...res.paths].sort(), ['/workspace/fonto', '/workspace/plexo']);
});

test('matchRepo: none when nothing recognized', () => {
  assert.deepEqual(matchRepo('hello there, fix the bug', reg), { kind: 'none' });
});

test('matchRepo: short repo name (<=3) requires a standalone token', () => {
  const r = buildRegistry(['/workspace/ab', '/workspace/plexo']);
  assert.deepEqual(matchRepo('grab the table', r), { kind: 'none' }); // "ab" inside "grab"/"table" must NOT match
  assert.deepEqual(matchRepo('open ab now', r), { kind: 'match', path: '/workspace/ab' });
});
