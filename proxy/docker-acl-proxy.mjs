import net from 'node:net';
import http from 'node:http';
import { decide, parseRequestLine, forceConnectionClose } from './acl.mjs';

// A minimal allow-list proxy in front of the Docker API. It parses just the
// request head, decides via the pure ACL, then raw-pipes both directions — so a
// hijacked `exec -i` stream and a `cp` PUT body flow through untouched. Default
// deny. See docs/adr/0001.

const DOCKER_SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const LISTEN_PORT = Number(process.env.PROXY_PORT) || 2375;
const TARGET_NAME = process.env.TARGET_CONTAINER || 'claude-code-rc';
const HEAD_LIMIT = 64 * 1024; // refuse absurd header blocks

const target = { name: TARGET_NAME, id: null };

// Best-effort resolve the target's container id off the real socket, so requests
// that use the resolved id (not the name) in the path are still recognized.
// Name-matching always works; the id is belt-and-suspenders and refreshed in case
// the container is recreated.
function resolveTargetId() {
  const req = http.request({ socketPath: DOCKER_SOCK, path: `/containers/${TARGET_NAME}/json`, method: 'GET' }, (r) => {
    let b = '';
    r.on('data', (c) => { b += c; });
    r.on('end', () => { try { target.id = JSON.parse(b).Id || null; } catch {} });
  });
  req.on('error', () => {});
  req.end();
}
resolveTargetId();
setInterval(resolveTargetId, 30000).unref();

function deny(socket, code = 403, msg = 'Forbidden') {
  socket.end(`HTTP/1.1 ${code} ${msg}\r\nContent-Type: text/plain\r\nContent-Length: ${msg.length}\r\nConnection: close\r\n\r\n${msg}`);
}

const server = net.createServer({ allowHalfOpen: true }, (client) => {
  client.on('error', () => client.destroy());
  let head = Buffer.alloc(0);
  let decided = false;

  function onData(chunk) {
    if (decided) return;
    head = Buffer.concat([head, chunk]);
    const sep = head.indexOf('\r\n\r\n');
    if (sep === -1) {
      if (head.length > HEAD_LIMIT) { decided = true; client.removeListener('data', onData); return deny(client, 431, 'Request Header Fields Too Large'); }
      return; // wait for the rest of the head
    }
    decided = true;
    client.removeListener('data', onData);
    client.pause();

    const headStr = head.toString('latin1');
    const reqLine = parseRequestLine(headStr);
    if (!reqLine || !decide(reqLine.method, reqLine.path, target)) {
      console.log(`DENY ${reqLine ? reqLine.method + ' ' + reqLine.path.split('?')[0] : '(unparseable)'}`);
      return deny(client);
    }

    // Preserve headers verbatim for a hijacked exec stream (it upgrades the
    // connection and carries stdout/stderr back); forcing `Connection: close` there
    // strips the Upgrade and the stream returns empty. A hijacked connection can't
    // carry a second HTTP request anyway, so it needs no pipelining guard. Everything
    // else gets `Connection: close` so a keep-alive client can't pipeline past the filter.
    const barePath = reqLine.path.split('?')[0];
    const isExecStart = /^(\/v\d+(\.\d+)?)?\/exec\/[A-Za-z0-9]+\/start$/.test(barePath);
    const hasUpgrade = /\r\nupgrade:/i.test(headStr);
    const fwd = (isExecStart || hasUpgrade) ? headStr : forceConnectionClose(headStr);

    // allowHalfOpen so a non-interactive `docker exec` (which FIN-closes its stdin
    // right away) doesn't tear the connection down before the daemon streams stdout
    // back — the FIN becomes a half-close, the response side stays open.
    const upstream = net.connect({ path: DOCKER_SOCK, allowHalfOpen: true }, () => {
      upstream.write(Buffer.from(fwd, 'latin1'));
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on('error', () => { client.destroy(); });
    client.on('error', () => { upstream.destroy(); });
  }

  client.on('data', onData);
});

server.on('error', (e) => { console.error('proxy server error:', e.message); process.exit(1); });
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`docker-acl-proxy listening :${LISTEN_PORT} -> ${DOCKER_SOCK}; target=${TARGET_NAME} (default-deny)`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
