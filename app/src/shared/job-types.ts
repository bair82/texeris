import { Type, type Static } from '@sinclair/typebox';

/**
 * Background job reporting (development-plan G1 item 7): heavy import /
 * export / corpus-grant work runs in worker threads; the main process pushes
 * lifecycle events to the invoking window so the renderer can show progress
 * and offer cancellation.
 */
export const JobChannels = {
  event: 'texeris:job-event',
  cancel: 'texeris:job-cancel',
} as const;

export const JobEventSchema = Type.Object({
  jobId: Type.String(),
  op: Type.Union([
    Type.Literal('import'),
    Type.Literal('export'),
    Type.Literal('corpus-grant'),
    Type.Literal('archive-import'),
    Type.Literal('archive-reindex'),
  ]),
  status: Type.Union([
    Type.Literal('started'),
    Type.Literal('progress'),
    Type.Literal('finished'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  detail: Type.Optional(Type.String()),
  progress: Type.Optional(
    Type.Object({
      done: Type.Number(),
      total: Type.Number(),
    }),
  ),
});
export type JobEvent = Static<typeof JobEventSchema>;

export const JobCancelRequestSchema = Type.Object({
  jobId: Type.String(),
});
export type JobCancelRequest = Static<typeof JobCancelRequestSchema>;
