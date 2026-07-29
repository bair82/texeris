import { Type, type Static } from '@sinclair/typebox';

export const ContextDescriptorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('generic') }),
  Type.Object({
    kind: Type.Literal('editor'),
    image: Type.Boolean(),
    canUndo: Type.Boolean(),
    canRedo: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal('document'),
    documentId: Type.String(),
    path: Type.String(),
    isMain: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal('conversation'),
    conversationId: Type.String(),
    active: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal('message'),
    seq: Type.Integer(),
    role: Type.Union([
      Type.Literal('user'),
      Type.Literal('assistant'),
      Type.Literal('tool'),
    ]),
    editable: Type.Boolean(),
    regeneratable: Type.Boolean(),
  }),
]);
export type ContextDescriptor = Static<typeof ContextDescriptorSchema>;

export const ContextActionSchema = Type.Union([
  Type.Literal('editor:undo'), Type.Literal('editor:redo'),
  Type.Literal('editor:image-details'), Type.Literal('editor:image-delete'),
  Type.Literal('document:open'), Type.Literal('document:rename'),
  Type.Literal('document:duplicate'), Type.Literal('document:export'), Type.Literal('document:reveal'),
  Type.Literal('document:set-main'), Type.Literal('document:trash'),
  Type.Literal('conversation:open'), Type.Literal('conversation:rename'),
  Type.Literal('conversation:delete'), Type.Literal('message:copy'),
  Type.Literal('message:edit'), Type.Literal('message:regenerate'),
]);
export type ContextAction = Static<typeof ContextActionSchema>;

export const ContextDescribeReplySchema = Type.Object({
  requestId: Type.String(),
  context: ContextDescriptorSchema,
});
export const ContextShowRequestSchema = Type.Object({
  context: ContextDescriptorSchema,
  x: Type.Integer(),
  y: Type.Integer(),
});

export const ContextDescribeRequestSchema = Type.Object({
  requestId: Type.String(),
  x: Type.Integer(),
  y: Type.Integer(),
});
export type ContextDescribeRequest = Static<typeof ContextDescribeRequestSchema>;

export const ContextActionEventSchema = Type.Object({
  action: ContextActionSchema,
  context: ContextDescriptorSchema,
});
export type ContextActionEvent = Static<typeof ContextActionEventSchema>;

export const ContextMenuChannels = {
  describe: 'texeris:context-menu-describe',
  reply: 'texeris:context-menu-reply',
  show: 'texeris:context-menu-show',
  action: 'texeris:context-menu-action',
} as const;
