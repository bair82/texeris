import { Type, type Static } from '@sinclair/typebox';

/**
 * Project lifecycle IPC: current project, recents, open/create/switch.
 * The renderer reloads itself on the project:changed broadcast.
 */

export const ProjectInfoSchema = Type.Object({
  root: Type.String(),
  projectId: Type.String(),
  mainDocument: Type.String(),
});
export type ProjectInfo = Static<typeof ProjectInfoSchema>;

export const ProjectCreateRequestSchema = Type.Object({
  parentDir: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
});
export type ProjectCreateRequest = Static<typeof ProjectCreateRequestSchema>;

export const ProjectOpenPathRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});
export type ProjectOpenPathRequest = Static<typeof ProjectOpenPathRequestSchema>;

export const ProjectChannels = {
  current: 'texeris:project-current',
  recents: 'texeris:project-recents',
  pickDirectory: 'texeris:project-pick-directory',
  openDialog: 'texeris:project-open-dialog',
  openPath: 'texeris:project-open-path',
  create: 'texeris:project-create',
  changed: 'texeris:project-changed',
} as const;
