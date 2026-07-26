import { parentPort } from 'node:worker_threads';
import { runTask } from './tasks';

/**
 * Job worker entry: receives {id, kind, payload}, answers with
 * {id, type: 'progress' | 'result' | 'error'}. Errors cross the boundary as
 * plain {message, code?} objects (e.g. PdfExtractionError codes survive).
 */
interface JobRequest {
  id: number;
  kind: string;
  payload: unknown;
}

function serializeError(error: unknown): { message: string; code?: string } {
  const code = (error as { code?: unknown })?.code;
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

parentPort?.on('message', async (request: JobRequest) => {
  try {
    const result = await runTask(request.kind, request.payload, (progress) => {
      parentPort?.postMessage({ id: request.id, type: 'progress', progress });
    });
    parentPort?.postMessage({ id: request.id, type: 'result', result });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, type: 'error', error: serializeError(error) });
  }
});
