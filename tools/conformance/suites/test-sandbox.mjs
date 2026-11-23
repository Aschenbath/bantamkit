/** #339: both runtimes inherit a scratch home and index from the conformance runner. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'test-sandbox';
export const summary = 'the conformance runner isolates the home and index for both runtimes';

export async function run(ctx) {
  const python = ctx.runPython(join(ctx.repoRoot, 'tools', 'conformance', 'ref', 'test_sandbox_ref.py'), {});
  const node = [homedir(), process.env.HOME, process.env.USERPROFILE, process.env.BANTAMKIT_INDEX_DIR];
  const home = join(ctx.scratch, 'home');
  const expected = [home, home, home, join(ctx.scratch, 'hot-index')];
  return {
    cases: [
      { name: 'Python and Node inherit the same sandbox', kind: 'json', expected: python, actual: node },
      ...[['Python', python], ['Node', node]].map(([side, actual]) => ({
        name: `LITERAL: ${side} home and index are inside the run scratch`, kind: 'json', expected, actual,
      })),
    ],
  };
}
