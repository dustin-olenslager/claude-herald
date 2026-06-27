import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepoPath } from '../src/state.mjs';

const roots = ['/workspace'];

test('validateRepoPath: accepts an existing-style path under root', () => {
  assert.deepEqual(validateRepoPath('/workspace/repo', roots), { ok: true, path: '/workspace/repo' });
});

test('validateRepoPath: accepts the root itself', () => {
  assert.deepEqual(validateRepoPath('/workspace', roots), { ok: true, path: '/workspace' });
});

test('validateRepoPath: strips trailing slash', () => {
  assert.deepEqual(validateRepoPath('/workspace/repo/', roots), { ok: true, path: '/workspace/repo' });
});

test('validateRepoPath: rejects ..', () => {
  assert.equal(validateRepoPath('/workspace/../etc', roots).ok, false);
});

test('validateRepoPath: rejects shell metacharacters', () => {
  for (const p of ['/workspace/a;rm', '/workspace/a$(x)', '/workspace/a b', '/workspace/a|b', '/workspace/a`b']) {
    assert.equal(validateRepoPath(p, roots).ok, false, p);
  }
});

test('validateRepoPath: rejects outside allowed root', () => {
  assert.equal(validateRepoPath('/etc/passwd', roots).ok, false);
});

test('validateRepoPath: rejects sibling-prefix bypass', () => {
  assert.equal(validateRepoPath('/workspace-evil/x', roots).ok, false);
});

test('validateRepoPath: rejects relative and empty', () => {
  assert.equal(validateRepoPath('workspace/x', roots).ok, false);
  assert.equal(validateRepoPath('', roots).ok, false);
});
