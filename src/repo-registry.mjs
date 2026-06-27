import path from 'node:path';

// Pure repo-name matching for the forum auto-detect feature. No I/O — the caller
// supplies candidate paths (gathered from the target container) and we map + match.

// Nicknames -> normalized repo name. Extend as projects gain shorthands.
export const ALIASES = { ff: 'frameforge' };

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// paths -> [{ path, base, norm }], deduped, dropping anything whose basename
// normalizes to empty (e.g. '/').
export function buildRegistry(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths || []) {
    const clean = String(p || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const base = path.posix.basename(clean);
    const norm = normalize(base);
    if (!norm) continue;
    out.push({ path: clean, base, norm });
  }
  return out;
}

// Match free text against the registry. Returns:
//   { kind:'match', path }       exactly one repo identified
//   { kind:'ambiguous', paths }  more than one
//   { kind:'none' }              nothing recognized
// Aliases match on a standalone token (so "ff" never fires inside "diff"); repo
// names match as a substring of the alnum-joined text (so "frame forge" ->
// "frameforge"), with names <=3 chars constrained to a standalone token.
export function matchRepo(text, registry, aliases = ALIASES) {
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const tokenSet = new Set(tokens);
  const joined = tokens.join('');
  const hits = new Set();
  for (const [alias, target] of Object.entries(aliases)) {
    if (tokenSet.has(alias)) {
      const r = registry.find((x) => x.norm === target);
      if (r) hits.add(r.path);
    }
  }
  for (const r of registry) {
    if (r.norm.length <= 3) { if (tokenSet.has(r.norm)) hits.add(r.path); }
    else if (joined.includes(r.norm)) hits.add(r.path);
  }
  const paths = [...hits];
  if (paths.length === 1) return { kind: 'match', path: paths[0] };
  if (paths.length > 1) return { kind: 'ambiguous', paths };
  return { kind: 'none' };
}
