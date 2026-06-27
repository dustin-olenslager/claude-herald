import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate STATE_FILE before importing (state.mjs reads it at load + saves there).
process.env.STATE_FILE = path.join(os.tmpdir(), `herald-state-${process.pid}.json`);
const state = await import('../src/state.mjs');
test.after(() => { try { fs.unlinkSync(process.env.STATE_FILE); } catch {} });

const CHAT = -1004236277254;

test('bindRepoTopic records repo->topic AND topic->repo', () => {
  state.bindRepoTopic(CHAT, 7, '/workspace/_eval/nexalog');
  assert.equal(state.getRepoTopic(CHAT, '/workspace/_eval/nexalog'), 7);
  // forward map so a human entering the topic inherits the repo
  assert.equal(state.getRepo(`${CHAT}:7`), '/workspace/_eval/nexalog');
});

test('bindRepoTopic is a no-op for a flat session (no threadId)', () => {
  state.bindRepoTopic(CHAT, undefined, '/workspace/x');
  assert.equal(state.getRepoTopic(CHAT, '/workspace/x'), undefined);
});

test('getRepoTopic is undefined for an unbound repo', () => {
  assert.equal(state.getRepoTopic(CHAT, '/workspace/never-bound'), undefined);
});
