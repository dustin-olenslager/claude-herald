import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, parseRequestLine, forceConnectionClose } from '../proxy/acl.mjs';

const target = { name: 'claude-code-rc', id: 'abc123def456' };
const ok = (m, p) => assert.equal(decide(m, p, target), true, `expected ALLOW ${m} ${p}`);
const no = (m, p) => assert.equal(decide(m, p, target), false, `expected DENY ${m} ${p}`);

test('allows CLI negotiation', () => {
  ok('GET', '/_ping'); ok('HEAD', '/_ping'); ok('GET', '/version'); ok('GET', '/v1.47/version');
});

test('allows exec/cp/inspect on the TARGET (by name and by id)', () => {
  ok('POST', '/v1.47/containers/claude-code-rc/exec');
  ok('POST', '/v1.47/containers/abc123def456/exec');
  ok('GET', '/v1.47/containers/claude-code-rc/json');
  ok('PUT', '/v1.47/containers/claude-code-rc/archive?path=%2Ftmp');
  ok('GET', '/v1.47/containers/claude-code-rc/archive?path=%2Ftmp');
  ok('HEAD', '/v1.47/containers/claude-code-rc/archive?path=%2Ftmp');
});

test('allows exec lifecycle by opaque id', () => {
  ok('POST', '/v1.47/exec/deadbeef00/start');
  ok('POST', '/exec/deadbeef00/resize');
  ok('GET', '/exec/deadbeef00/json');
});

test('DENIES container lifecycle (the escape)', () => {
  no('POST', '/v1.47/containers/create');
  no('POST', '/v1.47/containers/claude-code-rc/start');
  no('POST', '/v1.47/containers/claude-code-rc/stop');
  no('POST', '/v1.47/containers/claude-code-rc/kill');
  no('POST', '/v1.47/containers/claude-code-rc/restart');
  no('DELETE', '/v1.47/containers/claude-code-rc');
});

test('DENIES exec/cp/inspect on OTHER containers', () => {
  no('POST', '/v1.47/containers/webtop/exec');
  no('GET', '/v1.47/containers/some-other/json');
  no('PUT', '/v1.47/containers/some-other/archive?path=%2F');
});

test('DENIES images/volumes/networks/build/swarm/system', () => {
  no('POST', '/v1.47/images/create');
  no('GET', '/v1.47/images/json');
  no('POST', '/v1.47/build');
  no('POST', '/v1.47/volumes/create');
  no('POST', '/v1.47/networks/create');
  no('GET', '/v1.47/info');
  no('POST', '/v1.47/swarm/init');
  no('GET', '/v1.47/secrets');
});

test('DENIES unparseable / empty target id matching off', () => {
  no('GET', '/v1.47/containers//json');
  assert.equal(decide('POST', '/v1.47/containers/abc123def456/exec', { name: 'x', id: null }), false); // id not set -> only name matches
});

test('parseRequestLine', () => {
  assert.deepEqual(parseRequestLine('GET /version HTTP/1.1\r\nHost: x\r\n\r\n'), { method: 'GET', path: '/version' });
  assert.equal(parseRequestLine('garbage'), null);
});

test('forceConnectionClose strips keep-alive and appends close', () => {
  const head = 'GET /version HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\nBODY';
  const out = forceConnectionClose(head);
  assert.equal(/connection: keep-alive/i.test(out), false);
  assert.equal(/keep-alive: timeout/i.test(out), false);
  assert.equal(out.endsWith('Connection: close\r\n\r\nBODY'), true);
});
