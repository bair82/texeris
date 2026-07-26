import { bindJobRunner } from './current';
import { createInProcessRunner } from './tasks';

// Vitest setup: service tests exercise the real task code in-process instead
// of spawning the built worker bundle (out/main/jobs/worker.js).
bindJobRunner(createInProcessRunner());
