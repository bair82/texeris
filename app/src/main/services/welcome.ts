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

Texeris is a local workspace for serious writing: your documents stay ordinary
Markdown files, while revisions, conversations, references, and research
context stay connected around them.

You can edit or delete this note. It is here only to help you begin.

## Start with something real

Open **manuscript.md** in the file list and paste in a paragraph you are
actually working on. Use the **+** button when you need another document.

Texeris saves as you type. Closing the app or changing projects waits for recent
edits to reach the document, so there is no save button to remember.

**Rendered** mode is the comfortable writing view. **Raw** mode shows the same
document as Pandoc-oriented Markdown—not a second copy. Switch modes in the
status bar or with Ctrl+E.

## Work with the assistant

The right-hand panel is an editorial collaborator that understands the current
document and its revision.

Before sending, choose what it should see:

- **Document** for structure, argument, or whole-draft questions.
- **Section** for focused work on one part.
- **Selection** when you want help with a particular passage.

Use **Fast** for routine editing and **Deep** for work that benefits from more
deliberation. If a request should change the manuscript, the assistant proposes
a patch. You review the exact changes and decide what to accept; it never
silently rewrites the document.

Try a concrete first request:

> Read this draft and identify the single most important revision I should make
> next. Explain why before proposing any edits.

If you want to change an earlier instruction, hover over your message and choose
**Edit**. To ask for another answer to the latest turn, choose **Regenerate**.
Both create a new branch; the original conversation and document history remain
available.

## Keep your bearings

Open **History** in the status bar to inspect revisions or restore an earlier
state. Typing is grouped into useful revisions, while accepted patches remain
distinct. Add a named checkpoint before a major restructure or submission.

Your Markdown file is canonical and readable without Texeris. The local history
database supplies the richer undo and audit trail.

## Citations and previous writing

Use **Cite** in the editor toolbar to import a CSL JSON, BibTeX, or RIS library,
or add a reference from a few details. A DOI can fill the rest when metadata is
available. Citation markers stay standard Pandoc Markdown, and bibliography-aware
PDF or word-processor export is available from the project commands.

The **Archive** in the left activity rail is for previous writing you may want
to reuse or consult. Import files or a folder, search locally, preview a result,
then choose **Use in chat** to give a saved passage to the assistant explicitly.

## Useful controls

- Ctrl+K opens the command palette.
- Ctrl+/ shows all keyboard shortcuts.
- The trash keeps deleted documents restorable until you remove them permanently.
- Settings holds model credentials, appearance, and writing-profile controls.

That is enough to begin. Open **manuscript.md**, write a little, and ask one
specific question about the text in front of you.
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
