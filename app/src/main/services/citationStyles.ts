import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUILTIN_CITATION_STYLES,
  type BuiltinCitationStyleId,
  type CitationStyleId,
  type CitationStyleSettings,
} from '../../shared/citation-style-types';
import { atomicWriteText } from './document';
import { writeProjectJson, type ProjectContext } from './project';

const DEFAULT_STYLE: BuiltinCitationStyleId = 'chicago-author-date';
const CUSTOM_STYLE_FILE = 'citation-style.csl';
const MAX_CUSTOM_STYLE_BYTES = 2 * 1024 * 1024;

const builtins = new Map<BuiltinCitationStyleId, string>(
  BUILTIN_CITATION_STYLES.map((style) => [style.id, style.label]),
);

function customStylePath(ctx: ProjectContext): string {
  return path.join(ctx.root, '.texeris', CUSTOM_STYLE_FILE);
}

function isBuiltin(id: CitationStyleId): id is BuiltinCitationStyleId {
  return builtins.has(id as BuiltinCitationStyleId);
}

export function citationStyleSettings(ctx: ProjectContext): CitationStyleSettings {
  const configured = ctx.project.citationStyle;
  const customAvailable = fs.existsSync(customStylePath(ctx));
  const id =
    configured === 'custom' && customAvailable
      ? configured
      : configured && isBuiltin(configured)
        ? configured
        : DEFAULT_STYLE;
  return {
    id,
    label:
      id === 'custom'
        ? (ctx.project.customCitationStyleName ?? 'Custom CSL style')
        : builtins.get(id)!,
    customAvailable,
    ...(customAvailable && ctx.project.customCitationStyleName
      ? { customLabel: ctx.project.customCitationStyleName }
      : {}),
  };
}

export function setCitationStyle(ctx: ProjectContext, id: CitationStyleId): CitationStyleSettings {
  if (id === 'custom' && !fs.existsSync(customStylePath(ctx))) {
    throw new Error('Choose a custom CSL file before selecting the custom style.');
  }
  if (id !== 'custom' && !isBuiltin(id)) {
    throw new Error(`unknown citation style: ${id}`);
  }
  ctx.project.citationStyle = id;
  writeProjectJson(ctx.root, ctx.project);
  return citationStyleSettings(ctx);
}

export function importCustomCitationStyle(
  ctx: ProjectContext,
  sourcePath: string,
): CitationStyleSettings {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CUSTOM_STYLE_BYTES) {
    throw new Error('Choose a CSL style file smaller than 2 MB.');
  }
  const xml = fs.readFileSync(sourcePath, 'utf8');
  if (
    !/<style\b[^>]*\bxmlns=["']http:\/\/purl\.org\/net\/xbiblio\/csl["'][^>]*>/i.test(xml) ||
    !/<\/style>\s*$/i.test(xml)
  ) {
    throw new Error('The selected file is not a complete CSL style.');
  }
  if (!/<citation\b/i.test(xml)) {
    throw new Error(
      'Choose an independent CSL style that contains its citation formatting rules.',
    );
  }
  const title = xml.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
  atomicWriteText(customStylePath(ctx), xml);
  ctx.project.citationStyle = 'custom';
  ctx.project.customCitationStyleName = title || path.basename(sourcePath, path.extname(sourcePath));
  writeProjectJson(ctx.root, ctx.project);
  return citationStyleSettings(ctx);
}

export function resolveCitationStylePath(
  ctx: ProjectContext,
  resourcesDir: string,
  id: CitationStyleId,
): string {
  if (id === 'custom') {
    const custom = customStylePath(ctx);
    if (!fs.existsSync(custom)) throw new Error('The project custom CSL style is missing.');
    return custom;
  }
  if (!isBuiltin(id)) throw new Error(`unknown citation style: ${id}`);
  const bundled = path.join(resourcesDir, `${id}.csl`);
  if (!fs.existsSync(bundled)) {
    throw new Error(`The bundled ${builtins.get(id)} citation style is unavailable. Reinstall Texeris.`);
  }
  return bundled;
}
