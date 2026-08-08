/**
 * E2E smoke suite (WP5): runs every offline smoke in sequence. Live-provider
 * smoke (smoke-live.mjs) is excluded — it needs API keys and is run manually.
 *
 * Usage: pnpm build first, then: node scripts/smoke-all.mjs
 */
import { spawnSync } from 'node:child_process';

const SMOKE = [
  'scripts/smoke.mjs',
  'scripts/smoke-editor.mjs',
  'scripts/smoke-patch.mjs',
  'scripts/smoke-recovery.mjs',
  'scripts/smoke-error.mjs',
  'scripts/smoke-project.mjs',
  'scripts/smoke-ui.mjs',
  'scripts/smoke-find.mjs',
  'scripts/smoke-eu3.mjs',
  'scripts/smoke-eu4.mjs',
  'scripts/smoke-eu5.mjs',
  'scripts/smoke-eu6.mjs',
  'scripts/smoke-eu7.mjs',
  'scripts/smoke-citations.mjs',
  'scripts/smoke-archive.mjs',
  'scripts/smoke-pdf.mjs',
  'scripts/smoke-checkpoint.mjs',
];

const results = [];
for (const script of SMOKE) {
  console.log(`\n=== ${script} ===`);
  const attempts = [];
  const run = () => {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [script], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: process.env,
    });
    const attempt = {
      status: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
    attempts.push(attempt);
    process.stdout.write(attempt.stdout);
    process.stderr.write(attempt.stderr);
    return attempt;
  };
  let result = run();
  if (result.status !== 0) {
    console.log(`=== ${script} attempt 1 failed (exit ${result.status ?? result.signal}), retrying once after launch cooldown ===`);
    spawnSync('sleep', ['10']);
    result = run();
  }
  const passed = result.status === 0;
  results.push({ script, passed, attempts: attempts.map(({ stdout, stderr, ...summary }) => summary) });
  console.log(`=== ${script} ${passed ? 'PASSED' : `FAILED (exit ${result.status ?? result.signal})`} after ${attempts.length} attempt(s) ===`);
  // Let Electron instances fully exit before the next smoke attaches.
  spawnSync('sleep', ['5']);
}
const failed = results.filter((result) => !result.passed);
console.log(`\nSMOKE_SUMMARY ${JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results })}`);
process.exit(failed.length ? 1 : 0);
