import { JobRunner, type JobRunnerLike } from './runner';

/**
 * The one place services reach for a job runner. The app binds a real
 * worker-backed runner at startup (main/index.ts); unit tests bind an
 * in-process runner (jobs/testSetup.ts) so service tests exercise the same
 * task code without needing the built worker bundle.
 */
let current: JobRunnerLike | null = null;

export function bindJobRunner(runner: JobRunnerLike): void {
  current = runner;
}

export function jobRunner(): JobRunnerLike {
  if (!current) current = new JobRunner();
  return current;
}
