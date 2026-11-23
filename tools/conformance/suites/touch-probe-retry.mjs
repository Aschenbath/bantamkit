/** #342: a timed-out git probe must be retried by both runtimes. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'touch-probe-retry';
export const summary = 'a real git probe timeout is not cached; the next call retries and caches its exit status';

export async function run(ctx) {
  if (process.platform === 'win32') {
    return { cases: [], notes: ['the sleeping shebang fixture requires POSIX; portable unit tests cover incomplete spawn results'] };
  }
  const touch = await import(pathToFileURL(join(ctx.runtimeTs, 'dist', 'touch', 'index.js')).href);
  const coldGit = (side) => {
    const bin = join(ctx.scratch, `touch-probe-retry-${side}`);
    mkdirSync(bin);
    const git = join(bin, 'git');
    // Warm platform executable assessment before measuring. `exec sleep` leaves no child
    // behind when the probe kills its timed-out process.
    writeFileSync(git, '#!/bin/sh\n[ "$1" = "--warmup" ] && exit 0\nprintf x >> "$0.calls"\nif [ ! -e "$0.started" ]; then\n  : > "$0.started"\n  exec /bin/sleep 3\nfi\nexit 0\n');
    chmodSync(git, 0o755);
    execFileSync(git, ['--warmup'], { timeout: 30_000 });
    const state = join(bin, 'state');
    return { git, probes: [bin, bin, bin, `${bin}:`].map((p) => [p, state]) };
  };
  const py = coldGit('py');
  const nd = coldGit('node');
  const ref = join(ctx.repoRoot, 'tools', 'conformance', 'ref', 'touch_ref.py');
  const python = ctx.runPython(ref, { suite: 'touch-bound', probe: py.probes }).probe;
  const node = nd.probes.map(([p, state]) => {
    const ok = touch.gitOnPath(p, '', false, state);
    let text = null;
    try { text = readFileSync(join(state, touch.GIT_PROBE_FILE), 'utf8'); } catch { /* no cache */ }
    return [ok, text];
  });
  const observed = (rows, git) => [
    rows.map(([ok, text]) => [ok, text === null ? null : JSON.parse(text).ok]),
    readFileSync(`${git}.calls`, 'utf8').length,
  ];
  const pyObserved = observed(python, py.git);
  const ndObserved = observed(node, nd.git);
  const expected = [[[false, null], [true, true], [true, true], [true, true]], 2];
  return {
    cases: [
      { name: 'Python and Node retry the same way', kind: 'json', expected: pyObserved, actual: ndObserved },
      ...[['Python', pyObserved], ['Node', ndObserved]].map(([side, actual]) => ({
        name: `LITERAL: ${side} retries once and reuses both caches`, kind: 'json', expected, actual,
      })),
    ],
  };
}
