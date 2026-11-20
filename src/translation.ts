import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserError } from './types';
import { validateDirectory, validateId } from './validation';

const MAX_FILE_SIZE = 32 * 1024 * 1024;
export const DEFAULT_MAX_CHUNK_CHARS = 4000;

function hasCode(error: unknown, expected: string): boolean {
  return error instanceof Error && 'code' in error && error.code === expected;
}

export function translatedFilePath(root: string, directory: string, id: number): string {
  validateId(String(id));
  return path.join(root, ...validateDirectory(directory), String(id), 'workitem.zh-CN.md');
}

export function extractWorkItemIdFromPath(root: string, directory: string, filePath: string): number | undefined {
  let parts: string[];
  try { parts = validateDirectory(directory); }
  catch { return undefined; }
  const baseDir = path.resolve(root, ...parts);
  const resolved = path.resolve(filePath);
  const relative = path.relative(baseDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { return undefined; }
  const segments = relative.split(path.sep);
  if (segments.length !== 2) { return undefined; }
  const [idSegment, fileName] = segments;
  if (!idSegment || !/^[1-9]\d*$/.test(idSegment)) { return undefined; }
  if (fileName !== 'workitem.md' && fileName !== 'workitem.zh-CN.md') { return undefined; }
  const id = Number(idSegment);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function buildTranslationPrompt(markdown: string): string {
  return [
    'Translate the following Azure DevOps work item Markdown document into natural, accurate Simplified Chinese (简体中文).',
    'Requirements:',
    '- Preserve all Markdown structure, headings, lists, blockquotes, tables, and formatting.',
    '- Keep all URLs, relative image paths (e.g. images/...), code blocks, inline code, and work item IDs intact.',
    '- Keep standard technical terms, API/symbol names, and field identifiers clear; translate prose, titles, descriptions, specifications, acceptance criteria, repro steps, and comments into Simplified Chinese.',
    '- Output ONLY the translated Markdown content without wrapping the whole response in a ```markdown code fence.',
    '',
    markdown,
  ].join('\n');
}

export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const body = match ? match[1]! : trimmed;
  return body.endsWith('\n') ? body : body + '\n';
}

function splitAtBoundaries(text: string, isBoundary: (line: string) => boolean): string[] {
  const lines = text.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      const len = fenceMatch[1]!.length;
      if (!fence) { fence = marker.repeat(len); }
      else if (fence[0] === marker && len >= fence.length && trimmed.slice(len).trim() === '') { fence = undefined; }
    }

    if (!fence && current.length > 0 && isBoundary(line)) {
      const block = current.join('\n').trim();
      if (block) { parts.push(block); }
      current = [line];
    } else {
      current.push(line);
    }
  }

  const tail = current.join('\n').trim();
  if (tail) { parts.push(tail); }
  return parts;
}

function splitOversizedPart(part: string, maxChars: number): string[] {
  if (part.length <= maxChars) { return [part]; }
  const bySubheading = splitAtBoundaries(part, (line) => /^###\s+/.test(line));
  const refined: string[] = [];
  for (const sub of bySubheading) {
    if (sub.length <= maxChars) {
      refined.push(sub);
      continue;
    }
    const paragraphs = splitAtBoundaries(sub, (line) => line.trim() === '');
    for (const paragraph of paragraphs) {
      const cleaned = paragraph.trim();
      if (cleaned) { refined.push(cleaned); }
    }
  }
  return refined;
}

export function splitMarkdownChunks(markdown: string, maxChars = DEFAULT_MAX_CHUNK_CHARS): string[] {
  const trimmed = markdown.trim();
  if (!trimmed) { return []; }
  if (trimmed.length <= maxChars) { return [trimmed]; }

  const sections = splitAtBoundaries(trimmed, (line) => /^##\s+/.test(line));
  const atomicParts = sections.flatMap((section) => splitOversizedPart(section, maxChars));

  const chunks: string[] = [];
  let buffer = '';
  for (const part of atomicParts) {
    if (!buffer) {
      buffer = part;
    } else if (buffer.length + 2 + part.length <= maxChars) {
      buffer += '\n\n' + part;
    } else {
      chunks.push(buffer);
      buffer = part;
    }
  }
  if (buffer) { chunks.push(buffer); }
  return chunks;
}

export async function saveTranslatedWorkItem(root: string, directory: string, id: number, markdown: string): Promise<string> {
  validateId(String(id));
  const parts = [...validateDirectory(directory), String(id)];
  let current = await fs.realpath(root);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (hasCode(error, 'ENOENT')) {
        throw new UserError(t('本地 Work Item 目录不存在，请先导入或检查保存目录配置。'));
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UserError(t('保存路径包含符号链接、目录联接或非目录项，已停止操作。'));
    }
  }

  const target = path.join(current, 'workitem.zh-CN.md');
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_SIZE) {
      throw new UserError(t('目标翻译文件不是普通文件、包含链接或超过大小限制，已停止操作。'));
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) { throw error; }
  }

  const temporary = path.join(current, '.devops-translate-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(markdown, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return target;
}
