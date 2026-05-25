import { spawn } from 'node:child_process';

const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'claude-code-rc';
const TARGET_USER = process.env.TARGET_USER || 'cc';

// Run `gh` CLI inside the target container so it picks up the user's auth there.
function ghIn(cwd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const dockerArgs = [
      'exec', '-i',
      '-u', TARGET_USER,
      '-w', cwd,
      TARGET_CONTAINER,
      'gh', ...args,
    ];
    const child = spawn('docker', dockerArgs);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: '', err: e.message, code: -1 });
    });
  });
}

export async function viewPr(cwd, num) {
  const r = await ghIn(cwd, [
    'pr', 'view', String(num),
    '--json', 'number,title,state,url,author,headRefName,baseRefName,additions,deletions,changedFiles,mergeable,reviewDecision,statusCheckRollup,body',
  ]);
  if (!r.ok) return { error: r.err || `gh failed (exit ${r.code})` };
  try {
    return { pr: JSON.parse(r.out) };
  } catch (e) {
    return { error: `parse failed: ${e.message}` };
  }
}

export async function listPrs(cwd) {
  const r = await ghIn(cwd, [
    'pr', 'list',
    '--assignee', '@me',
    '--state', 'open',
    '--json', 'number,title,headRefName,url,statusCheckRollup',
    '--limit', '20',
  ]);
  if (!r.ok) return { error: r.err || 'gh failed' };
  try {
    return { prs: JSON.parse(r.out) };
  } catch (e) {
    return { error: `parse failed: ${e.message}` };
  }
}

export async function approvePr(cwd, num, body = 'LGTM') {
  const r = await ghIn(cwd, ['pr', 'review', String(num), '--approve', '-b', body]);
  return { ok: r.ok, err: r.err };
}

export async function mergePr(cwd, num, method = 'squash') {
  const r = await ghIn(cwd, ['pr', 'merge', String(num), `--${method}`, '--delete-branch']);
  return { ok: r.ok, err: r.err };
}

export function summarizePr(pr) {
  const checks = (pr.statusCheckRollup || []).reduce((acc, c) => {
    const s = c.state || c.conclusion || 'PENDING';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const checkStr = Object.entries(checks).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'no checks';
  const lines = [
    `#${pr.number} ${pr.title}`,
    `${pr.author?.login || '?'} · ${pr.headRefName} → ${pr.baseRefName}`,
    `+${pr.additions} −${pr.deletions} · ${pr.changedFiles} files`,
    `State: ${pr.state} · Mergeable: ${pr.mergeable || '?'} · Review: ${pr.reviewDecision || 'none'}`,
    `Checks: ${checkStr}`,
  ];
  return lines.join('\n');
}

export function prKeyboard(num, url) {
  return {
    inline_keyboard: [
      [
        { text: '👀 Review', callback_data: `pr:review:${num}` },
        { text: '✅ Approve', callback_data: `pr:approve:${num}` },
      ],
      [
        { text: '🔀 Merge (squash)', callback_data: `pr:merge:${num}` },
        { text: '🌐 Open', url },
      ],
    ],
  };
}
