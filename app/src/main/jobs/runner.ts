import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

/**
 * Runs heavy tasks (Pandoc conversions, PDF text extraction, PDF print-HTML
 * preparation) on worker threads so the Electron main event loop stays
 * responsive. One worker per job: cancellation is `worker.terminate()`, and
 * a crashed worker can never take the main process down with it.
 *
 * The runner is Electron-free and unit-tested against a fake worker.
 */

/** The structural slice of node:worker_threads Worker the runner needs. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type WorkerFactory = (scriptPath: string) => WorkerLike;

export interface JobRunOptions {
  onProgress?: (progress: unknown) => void;
  signal?: AbortSignal;
}

export interface JobRunnerLike {
  run<T>(kind: string, payload: unknown, options?: JobRunOptions): Promise<T>;
}

/** Both dev (electron-vite watch) and packaged builds emit the worker next
 * to the main bundle; in an asar pack the script is unpacked so the worker
 * thread can exec it as a real file. Multi-input code splitting can place
 * this module in a shared `chunks/` chunk, so probe both layouts. */
export function workerScriptPath(): string {
  const candidates = [
    path.join(__dirname, 'jobs', 'worker.js'),
    path.join(__dirname, '..', 'jobs', 'worker.js'),
  ];
  for (const candidate of candidates) {
    if (candidate.includes('app.asar')) {
      const unpacked = candidate.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) return unpacked;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function cancellationError(): Error {
  return new Error('cancelled');
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message === 'cancelled';
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

interface WorkerErrorPayload {
  message: string;
  code?: string;
}

function deserializeError(payload: WorkerErrorPayload): Error {
  const error = new Error(payload.message);
  if (typeof payload.code === 'string') {
    (error as { code?: string }).code = payload.code;
  }
  return error;
}

let nextJobId = 1;

export class JobRunner implements JobRunnerLike {
  constructor(
    private readonly factory: WorkerFactory = (script) =>
      new Worker(script) as unknown as WorkerLike,
    private readonly scriptPath: string = workerScriptPath(),
  ) {}

  run<T>(kind: string, payload: unknown, options: JobRunOptions = {}): Promise<T> {
    const { onProgress, signal } = options;
    if (signal?.aborted) return Promise.reject(cancellationError());
    return new Promise<T>((resolve, reject) => {
      const worker = this.factory(this.scriptPath);
      const id = nextJobId++;
      let settled = false;
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        void worker.terminate();
        complete();
      };
      const onAbort = () => settle(() => reject(cancellationError()));
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (raw: unknown) => {
        const message = raw as { id?: number; type?: string; progress?: unknown; result?: unknown; error?: WorkerErrorPayload };
        if (!message || message.id !== id) return;
        if (message.type === 'progress') {
          onProgress?.(message.progress);
        } else if (message.type === 'result') {
          settle(() => resolve(message.result as T));
        } else if (message.type === 'error') {
          settle(() => reject(deserializeError(message.error ?? { message: 'job failed' })));
        }
      });
      worker.on('error', (error: Error) => settle(() => reject(error)));
      worker.on('exit', (code: number) => {
        if (code !== 0) {
          settle(() => reject(new Error(`job worker exited with code ${code}`)));
        }
      });
      worker.postMessage({ id, kind, payload });
    });
  }
}
