import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { isCancellation, JobRunner, type WorkerLike } from './runner';

/** EventEmitter-based fake worker: tests script the protocol by hand. */
class FakeWorker extends EventEmitter implements WorkerLike {
  messages: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  /** The job id the runner assigned to this run. */
  jobId(): number {
    return (this.messages[0] as { id: number }).id;
  }
}

function makeRunner(): { runner: JobRunner; worker: FakeWorker } {
  const worker = new FakeWorker();
  const runner = new JobRunner(() => worker, '/fake/worker.js');
  return { runner, worker };
}

describe('JobRunner', () => {
  it('resolves with the task result', async () => {
    const { runner, worker } = makeRunner();
    const promise = runner.run<string>('pandoc-html', { markdown: '# Hi' });
    expect(worker.messages[0]).toMatchObject({ kind: 'pandoc-html', payload: { markdown: '# Hi' } });
    worker.emit('message', { id: worker.jobId(), type: 'result', result: '<h1>Hi</h1>' });
    await expect(promise).resolves.toBe('<h1>Hi</h1>');
    expect(worker.terminated).toBe(true);
  });

  it('routes progress messages to onProgress', async () => {
    const { runner, worker } = makeRunner();
    const progress: unknown[] = [];
    const promise = runner.run('pdf-extract', {}, { onProgress: (p) => progress.push(p) });
    worker.emit('message', { id: worker.jobId(), type: 'progress', progress: { done: 1, total: 3 } });
    worker.emit('message', { id: 999, type: 'progress', progress: { done: 9, total: 9 } }); // other job: ignored
    worker.emit('message', { id: worker.jobId(), type: 'result', result: null });
    await promise;
    expect(progress).toEqual([{ done: 1, total: 3 }]);
  });

  it('terminates the worker and rejects with a cancellation on abort', async () => {
    const { runner, worker } = makeRunner();
    const controller = new AbortController();
    const promise = runner.run('pdf-extract', {}, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow('cancelled');
    expect(worker.terminated).toBe(true);
    await promise.catch((error) => expect(isCancellation(error)).toBe(true));
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { runner, worker } = makeRunner();
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run('pdf-extract', {}, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(worker.messages).toHaveLength(0);
  });

  it('propagates task errors with their code intact', async () => {
    const { runner, worker } = makeRunner();
    const promise = runner.run('pdf-extract', {});
    worker.emit('message', {
      id: worker.jobId(),
      type: 'error',
      error: { message: 'This PDF is password-protected.', code: 'password' },
    });
    await expect(promise).rejects.toMatchObject({ message: 'This PDF is password-protected.', code: 'password' });
  });

  it('rejects when the worker crashes (exit ≠ 0)', async () => {
    const { runner, worker } = makeRunner();
    const promise = runner.run('pdf-extract', {});
    worker.emit('exit', 1);
    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it('rejects on a worker error event', async () => {
    const { runner, worker } = makeRunner();
    const promise = runner.run('pdf-extract', {});
    worker.emit('error', new Error('spawn failure'));
    await expect(promise).rejects.toThrow('spawn failure');
  });
});
