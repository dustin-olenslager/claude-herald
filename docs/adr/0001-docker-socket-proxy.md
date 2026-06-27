# ADR 0001 — Front the Docker socket with a default-deny per-container proxy

Status: Accepted
Date: 2026-06-27

## Context

Herald drives a target container by shelling out to the `docker` CLI
(`exec`, `cp`) against a bind-mounted `/var/run/docker.sock`. A full socket mount
is root-equivalent on the host: anything that compromises the bot (a prompt
injection reaching an un-gated `Bash`, a dependency CVE) can `docker run` a
privileged container that mounts `/` and own the host. The PreToolUse approval
gate and tmux-target pinning mitigate misuse *via Claude*, but the raw API is
still the single largest blast radius.

## Rejected: Tecnativa docker-socket-proxy

The off-the-shelf `tecnativa/docker-socket-proxy` (haproxy) gates by API *section*
(CONTAINERS/IMAGES/EXEC/…), not by container. To allow `docker cp` (PUT
`/containers/{id}/archive`) it requires `CONTAINERS=1 + POST=1`, which also admits
`POST /containers/create`. Its fine-grained `ALLOW_START`/`ALLOW_STOP` toggles were
**verified non-functional at Docker API v1.47** (2026-06-27 live test): with
`ALLOW_START=0`, create-from-local-image, `start`, and `stop` all still passed.
So it cannot allow `cp`/`exec` while denying the create-and-run-privileged escape —
it does not meet the goal here.

## Decision

A bespoke **default-deny** allow-list proxy (`proxy/docker-acl-proxy.mjs`, run from
the herald image as a sidecar). Herald talks to it over TCP via
`DOCKER_HOST=tcp://docker-acl-proxy:2375` on a dedicated **internal** compose
network (`herald-docker`) that nothing else joins; the proxy mounts the real
socket and forwards only:

- `GET/HEAD /_ping`, `GET /version` — CLI negotiation.
- `POST /containers/<TARGET>/exec` — create an exec **on the target only**.
- `POST /exec/<id>/{start,resize}`, `GET /exec/<id>/json` — the exec id is opaque
  and can only exist because a target-scoped create produced it, so running it is safe.
- `GET /containers/<TARGET>/json` — inspect target.
- `GET|HEAD|PUT /containers/<TARGET>/archive` — `docker cp` in/out + stat.

Everything else is denied: container create/start/stop/kill/rm, exec/cp/inspect on
*any other* container, and all image/volume/network/build/swarm/system/secret access.
The decision (`proxy/acl.mjs#decide`) is a pure function with unit tests.

Container identity is matched by **name** (the CLI passes the name in the path —
observed) and, belt-and-suspenders, by the live-resolved **id** (refreshed every
30s in case the target is recreated).

The proxy parses only the request *head*, then **raw-pipes both directions**, so a
hijacked `exec -i` stream and a `cp` PUT body pass through untouched. Each
connection carries exactly one request (`Connection: close` is forced into the
forwarded head) so a keep-alive client cannot pipeline a second, unfiltered request.

Separately, the privileged `exec -u root chmod` in `copyFileToContainer` is dropped:
chmod the host file to 644 before `docker cp` (cp preserves mode), so the copied
file is world-readable without an in-container root exec.

## Consequences

- Closes the host-escape path: no image pull/build, no volume/network mutation, no
  new/started/stopped containers, no exec into other containers. Herald can do
  exactly what it needs (exec + cp + inspect on `claude-code-rc`) and nothing more.
- Residual (accepted, low): the proxy itself is a small piece of security-critical
  code (covered by `test/acl.test.mjs` + a live smoke of allow/deny + streaming).
  `DELETE`/lifecycle on the target are denied; the bot recreates the target via
  host-side compose, not via this path.
- Herald must remain on the target's network for the *inbound* supervisor `/event`
  POST; only its *outbound* docker access moves behind the proxy.
