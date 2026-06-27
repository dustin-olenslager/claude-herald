import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEventThread } from '../src/routing.mjs';

test('explicit numeric thread routes straight to that topic (no new topic)', () => {
  assert.deepEqual(resolveEventThread({ thread: '123', repo: '/workspace/frame-forge' }), { kind: 'thread', threadId: 123 });
  assert.deepEqual(resolveEventThread({ thread: 123 }), { kind: 'thread', threadId: 123 });
});

test('no thread + repo -> name-create from basename (cron/cold-start)', () => {
  assert.deepEqual(resolveEventThread({ repo: '/workspace/frame-forge' }), { kind: 'name', name: 'frame-forge' });
});

test('thread=0 / non-numeric is ignored, falls back to repo name', () => {
  assert.deepEqual(resolveEventThread({ thread: '0', repo: '/x/foo' }), { kind: 'name', name: 'foo' });
  assert.deepEqual(resolveEventThread({ thread: 'abc', repo: '/x/foo' }), { kind: 'name', name: 'foo' });
});

test('neither thread nor repo -> flat', () => {
  assert.deepEqual(resolveEventThread({}), { kind: 'flat' });
  assert.deepEqual(resolveEventThread({ thread: '', repo: '' }), { kind: 'flat' });
});
