import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point state at a throwaway file BEFORE importing the module (STATE_FILE is read at load).
const tmp = path.join(os.tmpdir(), `herald-ask-state-${process.pid}.json`);
process.env.STATE_FILE = tmp;
const state = await import('../src/state.mjs');

test('ask-state: setAskState persists + getAskState round-trips', () => {
  const queues = { '123:7': { items: [{ q: 'Pick?', opts: ['a', 'b'] }], answers: [], idx: 0 } };
  const pending = { '123:9': 0 };
  state.setAskState(queues, pending);

  const got = state.getAskState();
  assert.deepEqual(got.queues, queues);
  assert.deepEqual(got.pending, pending);

  // it actually hit disk (so a fresh process rehydrates pending ASK buttons)
  const onDisk = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.deepEqual(onDisk.askQueues, queues);
  assert.deepEqual(onDisk.askPendingOther, pending);
  fs.rmSync(tmp, { force: true });
});
