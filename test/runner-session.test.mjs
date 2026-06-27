import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStaleSessionError } from '../src/runner.mjs';

test('matches the claude stale --resume failure', () => {
  assert.equal(isStaleSessionError('claude exit 1\nstderr: No conversation found with session ID: a1a2bc72-6d14-4ca4-9cee-daf85b039d09\nstdout:'), true);
  assert.equal(isStaleSessionError('No conversation found with session ID: x'), true);
});

test('does not match unrelated errors', () => {
  assert.equal(isStaleSessionError('claude timed out after 600000ms'), false);
  assert.equal(isStaleSessionError('container claude-code-rc is not running'), false);
  assert.equal(isStaleSessionError(''), false);
  assert.equal(isStaleSessionError(undefined), false);
});
