import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEventThread, resolveReportTopic } from '../src/routing.mjs';

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

// resolveReportTopic — precedence: explicit thread > repo's canonical topic > create > flat
test('report: explicit thread wins over everything', () => {
  assert.deepEqual(resolveReportTopic({ thread: '99', repo: '/workspace/frame-forge', repoTopic: 124 }), { kind: 'thread', threadId: 99 });
});

test('report: no thread -> the repo canonical topic (no duplicate topic)', () => {
  assert.deepEqual(resolveReportTopic({ repo: '/workspace/frame-forge', repoTopic: 124 }), { kind: 'existing', threadId: 124 });
});

test('report: no thread, no canonical topic -> create from basename', () => {
  assert.deepEqual(resolveReportTopic({ repo: '/workspace/frame-forge' }), { kind: 'create', name: 'frame-forge' });
  assert.deepEqual(resolveReportTopic({ repo: '/workspace/frame-forge', repoTopic: 0 }), { kind: 'create', name: 'frame-forge' });
});

test('report: nothing identifiable -> flat', () => {
  assert.deepEqual(resolveReportTopic({}), { kind: 'flat' });
});
