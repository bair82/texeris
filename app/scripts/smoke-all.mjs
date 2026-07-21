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
];

let failed = 0;
for (const script of SMOKE) {
  console.log(`\n=== ${script} ===`);
  let result = spawnSync(process.execPath, [script], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    // Back-to-back Electron launches are racy (worse under load); retry once.
    console.log(`=== ${script} failed (exit ${result.status}), retrying once ===`);
    spawnSync('sleep', ['10']);
    result = spawnSync(process.execPath, [script], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: 'inherit',
      env: process.env,
    });
  }
  if (result.status !== 0) {
    failed += 1;
    console.log(`=== ${script} FAILED (exit ${result.status}) ===`);
  }
  // Let Electron instances fully exit before the next smoke attaches.
  spawnSync('sleep', ['5']);
}
console.log(failed ? `\n${failed} smoke(s) FAILED` : '\nall smokes passed');
process.exit(failed ? 1 : 0);
