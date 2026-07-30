import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';
import { Value } from '@sinclair/typebox/value';
import {
  LifecycleChannels,
  RendererFlushResultSchema,
} from '../shared/lifecycle-types';

interface PendingFlush {
  senderId: number;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingFlush>();
let registered = false;

export function registerRendererFlushHandler(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle(LifecycleChannels.flushResult, (event, raw: unknown) => {
    const result = Value.Decode(RendererFlushResultSchema, raw);
    const request = pending.get(result.requestId);
    if (!request || request.senderId !== event.sender.id) {
      throw new Error('unknown renderer flush request');
    }
    pending.delete(result.requestId);
    clearTimeout(request.timer);
    if (result.error) request.reject(new Error(result.error));
    else request.resolve();
    return { received: true };
  });
}

export function requestRendererFlush(
  contents: WebContents,
  reason: 'close' | 'project-switch',
  timeoutMs = 15_000,
): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve();
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timed out while saving pending document changes'));
    }, timeoutMs);
    pending.set(requestId, {
      senderId: contents.id,
      resolve,
      reject,
      timer,
    });
    try {
      contents.send(LifecycleChannels.flushRequest, { requestId, reason });
    } catch (error) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
