import { Type } from '@sinclair/typebox';

export const RendererFlushRequestSchema = Type.Object({
  requestId: Type.String(),
  reason: Type.Union([
    Type.Literal('close'),
    Type.Literal('project-switch'),
  ]),
});

export const RendererFlushResultSchema = Type.Object({
  requestId: Type.String(),
  error: Type.Optional(Type.String()),
});

export const LifecycleChannels = {
  flushRequest: 'texeris:lifecycle-flush-request',
  flushResult: 'texeris:lifecycle-flush-result',
} as const;
