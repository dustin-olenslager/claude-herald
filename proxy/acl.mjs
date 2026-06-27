// Pure allow/deny decision for the Docker API. No I/O — the proxy passes the
// request line and the resolved target identity; this decides. Default DENY.
//
// Allowed (and ONLY these):
//   - GET/HEAD /_ping, GET /version            CLI negotiation
//   - POST /containers/<TARGET>/exec           create an exec on the target
//   - POST /exec/<id>/{start,resize}           run an exec (id is opaque; it can
//     GET  /exec/<id>/json                     only exist if created on TARGET)
//   - GET  /containers/<TARGET>/json           inspect target
//   - GET|HEAD|PUT /containers/<TARGET>/archive   docker cp in/out + stat
// Everything else (create, start, stop, kill, rm, images, volumes, networks,
// build, swarm, system, exec/archive/inspect on OTHER containers) -> denied.

// target: { name: string, id: string|null }
export function decide(method, rawPath, target = {}) {
  const path = String(rawPath || '').split('?')[0];
  // strip an optional /v1.47 style API-version prefix
  const p = path.replace(/^\/v\d+(\.\d+)?/, '') || '/';
  const { name, id } = target;
  const isTarget = (seg) => {
    const s = safeDecode(seg);
    return !!s && (s === name || (!!id && s === id));
  };

  if (method === 'GET' && (p === '/_ping' || p === '/version')) return true;
  if (method === 'HEAD' && p === '/_ping') return true;

  // exec lifecycle — the exec id is opaque and could only have been created on the
  // target (the create call below is target-scoped), so starting it is safe.
  if (method === 'POST' && /^\/exec\/[A-Za-z0-9]+\/(start|resize)$/.test(p)) return true;
  if (method === 'GET' && /^\/exec\/[A-Za-z0-9]+\/json$/.test(p)) return true;

  let m;
  if (method === 'POST' && (m = p.match(/^\/containers\/([^/]+)\/exec$/))) return isTarget(m[1]);
  if (method === 'GET' && (m = p.match(/^\/containers\/([^/]+)\/json$/))) return isTarget(m[1]);
  if ((method === 'GET' || method === 'HEAD' || method === 'PUT') &&
      (m = p.match(/^\/containers\/([^/]+)\/archive$/))) return isTarget(m[1]);

  return false;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Parse the first request line of a buffered HTTP request head. Returns
// { method, path } or null if not yet a complete/valid request line.
export function parseRequestLine(headText) {
  const nl = headText.indexOf('\r\n');
  const line = nl === -1 ? headText : headText.slice(0, nl);
  const m = line.match(/^([A-Z]+) (\S+) HTTP\/1\.[01]$/);
  return m ? { method: m[1], path: m[2] } : null;
}

// Force a single request per connection: drop any Connection/Keep-Alive header in
// the request head and append `Connection: close`, so upstream closes after one
// response and a keep-alive client can't pipeline a second (unfiltered) request
// through the raw pipe. `head` is the bytes up to and including the blank line.
export function forceConnectionClose(head) {
  const idx = head.indexOf('\r\n\r\n');
  if (idx === -1) return head;
  const headerBlock = head.slice(0, idx);
  const rest = head.slice(idx); // starts with \r\n\r\n (+ any body bytes already read)
  const lines = headerBlock.split('\r\n')
    .filter((l) => !/^(connection|keep-alive):/i.test(l));
  lines.push('Connection: close');
  return lines.join('\r\n') + rest;
}
