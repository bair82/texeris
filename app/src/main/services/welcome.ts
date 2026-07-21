import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerImported } from './documents';
import type { ProjectContext } from './project';

/**
 * The welcome document (M1.5 EU7): seeded into every newly created project
 * and opened on first launch. Keep it short and honest — it describes the
 * app as it ships, so update it when the workflows it names change.
 */
export const WELCOME_DOCUMENT = 'welcome.md';

export const WELCOME_CONTENT = `# Welcome to Texeris

Texeris is a writing workspace with a revision-aware editorial assistant.
This short note tours the essentials. When you are done with it, move it to
the trash — it can be restored from there if you ever want it back.

## Writing

Everything saves automatically as you type. There is no save button and no
unsaved state: every change lands on disk and in the project's revision
history on its own.

Two modes show the *same* document, never two copies. **Rendered** (the
default) is a typeset view you edit directly, much like a word processor.
**Raw** is the underlying Markdown. Switch with the buttons in the status
bar or Ctrl+E — the toolbar's formatting commands work in both.

## The assistant

The panel on the right is your editorial collaborator. It can read the
document you are working on and answer questions about it, but it never
edits the text itself. Instead it *proposes patches* — structured edits
that appear above the chat for your review. Accept the parts you like and
reject the rest; nothing changes without your say.

## Revisions and checkpoints

The **History** button in the status bar lists every revision of the open
document. Typing is grouped automatically, and each accepted patch is its
own revision, so you can always see what happened and restore an earlier
state.

A **checkpoint** is a named bookmark — "before restructuring", "submitted
draft". Create one from the History panel before anything drastic, and you
can return to it in one click.

## Housekeeping

- Ctrl+K opens the command palette; Ctrl+/ lists every shortcut.
- Deleted documents move to the trash (the icon at the top of the file
  list), where they can be restored with their history intact.
- Settings (the gear at the bottom left) holds the assistant's model
  credentials, spellcheck, and appearance.

Happy writing.
`;

/**
 * Seed the welcome document as revision 1 and return its id. An existing
 * welcome.md on disk (the user pointed "new project" at a non-empty folder)
 * is registered with its own content — never overwritten.
 */
export function seedWelcomeDocument(ctx: ProjectContext): string {
  const existing = ctx.db
    .prepare('SELECT id FROM documents WHERE path = ?')
    .get(WELCOME_DOCUMENT) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }
  const filePath = path.join(ctx.root, WELCOME_DOCUMENT);
  const content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : WELCOME_CONTENT;
  return registerImported(ctx, WELCOME_DOCUMENT, content, 'welcome document');
}
