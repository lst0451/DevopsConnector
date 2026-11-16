import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { Connection, WorkItem } from './types';
import { workItemUrl } from './validation';

export const CURRENT_RENDERER_VERSION = 3;
export type RendererVersion = 1 | 2 | 3;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function inline(value: unknown): string {
  return text(value).replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\*_{}\[\]()#+.!|~])/g, '\\$1');
}

function safeLink(raw: string, base: string): string | undefined {
  if (!raw.trim()) { return undefined; }
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || url.username || url.password) { return undefined; }
    return url.href.replace(/[()<>]/g, (character) => '%' + character.charCodeAt(0).toString(16));
  } catch { return undefined; }
}

const HTML_TAG_PATTERN = /<\/?(?:p|div|span|br|hr|strong|b|em|i|u|s|del|ins|mark|sub|sup|small|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col|h[1-6]|pre|code|blockquote|figure|figcaption|a|img|script|style|iframe|object|embed|form|input|button|select|textarea|svg|details|summary|section|article|header|footer|nav|main|aside|font|center)\b[^>]*>/i;

const RICH_HTML_TAG_PATTERN = /<\/?(?:hr|strong|b|em|i|u|s|del|ins|mark|sub|sup|small|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col|h[1-6]|pre|code|blockquote|figure|figcaption|a|img|script|style|iframe|object|embed|form|input|button|select|textarea|svg|details|summary|section|article|header|footer|nav|main|aside|font|center)\b[^>]*>/i;

const MARKDOWN_SYNTAX_PATTERN = /(?:^|\n)\s*#{1,6}\s+\S|\*\*[^*\n]+\*\*|`[^`\n]+`|(?:^|\n)\s*```|(?:^|\n)\s*(?:[-*+]|\d+\.)\s+\S|!?\[[^\]]+\]\([^)]+\)/m;

const BASIC_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&amp;': '&',
};

function stripCodeSpans(input: string): string {
  return input.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function decodeBasicEntities(input: string): string {
  return input.replace(/&(?:nbsp|quot|#39|apos|amp);/gi, (entity) => BASIC_ENTITIES[entity.toLowerCase()] ?? entity);
}

function tryExtractMarkdown(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) { return undefined; }
  const withoutCode = stripCodeSpans(trimmed);
  if (!HTML_TAG_PATTERN.test(withoutCode)) {
    return decodeBasicEntities(trimmed.replace(/\r\n/g, '\n'));
  }
  if (!RICH_HTML_TAG_PATTERN.test(withoutCode)) {
    const unwrapped = decodeBasicEntities(
      trimmed
        .replace(/\r\n/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/?(?:p|div|span)\b[^>]*>/gi, '')
    ).trim();
    if (!HTML_TAG_PATTERN.test(stripCodeSpans(unwrapped)) && MARKDOWN_SYNTAX_PATTERN.test(unwrapped)) {
      return unwrapped.replace(/\n{3,}/g, '\n\n');
    }
  }
  return undefined;
}

function sanitizeMarkdown(
  markdown: string,
  base: string,
  imagePaths?: ReadonlyMap<string, string>,
  collectedUrls?: string[],
): string {
  const withImages = markdown.replace(/!\[((?:\\.|[^\]\\])*)\]\(((?:\([^()\s]*\)|[^()\s])+)\)/g, (_match, rawAlt: string, rawUrl: string) => {
    const href = safeLink(rawUrl, base);
    const label = rawAlt.trim() || '图片';
    if (href && collectedUrls && !collectedUrls.includes(href)) {
      collectedUrls.push(href);
    }
    const localPath = href ? imagePaths?.get(href) : undefined;
    if (localPath) {
      return '![' + label + '](' + localPath + ')';
    }
    return href ? '[' + label + '（远端图片）](' + href + ')' : '[图片未导入]';
  });
  return withImages.replace(/(?<!!)\[((?:\\.|[^\]\\])+)\]\(((?:\([^()\s]*\)|[^()\s])+)\)/g, (_match, label: string, rawUrl: string) => {
    const href = safeLink(rawUrl, base);
    return href ? '[' + label + '](' + href + ')' : label;
  }).trim();
}

export function htmlToMarkdown(html: string, base: string, imagePaths?: ReadonlyMap<string, string>, collectedUrls?: string[]): string {
  const extractedMarkdown = tryExtractMarkdown(html);
  if (extractedMarkdown !== undefined) {
    return sanitizeMarkdown(extractedMarkdown, base, imagePaths, collectedUrls);
  }
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  converter.use(gfm);
  const escape = converter.escape.bind(converter);
  converter.escape = (value) => escape(value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  // GFM's default fallback preserves raw HTML for headerless tables. Always use processed children.
  converter.addRule('tablesWithoutRawHtml', {
    filter: 'table',
    replacement: (content, node) => {
      const columns = node.querySelector('tr')?.children.length ?? 0;
      if (!columns) { return ''; }
      const rows = content.trim().replace(/\n{2,}/g, '\n');
      const header = '| ' + Array(columns).fill(' ').join(' | ') + ' |\n' +
        '| ' + Array(columns).fill('---').join(' | ') + ' |\n';
      return '\n\n' + (/^\|(?:\s*:?-+:?\s*\|)+$/m.test(rows) ? '' : header) + rows + '\n\n';
    },
  });
  converter.addRule('escapedTableCells', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const prefix = node.previousElementSibling ? ' ' : '| ';
      return prefix + content.trim().replace(/\|/g, '\\|').replace(/\n/g, ' ') + ' |';
    },
  });
  converter.addRule('dropActiveContent', {
    filter: (node) => ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG'].includes(node.nodeName.toUpperCase()),
    replacement: () => '',
  });
  converter.addRule('safeLinks', {
    filter: 'a',
    replacement: (content, node) => {
      const href = safeLink(node.getAttribute('href') ?? '', base);
      return href ? '[' + content + '](' + href + ')' : content;
    },
  });
  converter.addRule('imageLinksOnly', {
    filter: 'img',
    replacement: (_content, node) => {
      let ancestor = node.parentNode;
      while (ancestor) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG'].includes(ancestor.nodeName.toUpperCase())) {
          return '';
        }
        ancestor = ancestor.parentNode;
      }
      const href = safeLink(node.getAttribute('src') ?? '', base);
      const label = inline(node.getAttribute('alt')) || '图片';
      if (href && collectedUrls && !collectedUrls.includes(href)) {
        collectedUrls.push(href);
      }
      const localPath = href ? imagePaths?.get(href) : undefined;
      if (localPath) {
        return '![' + label + '](' + localPath + ')';
      }
      return href ? '[' + label + '（远端图片）](' + href + ')' : '[图片未导入]';
    },
  });
  return converter.turndown(html).trim();
}

export function extractImageUrlsFromHtml(html: string, base: string): string[] {
  const urls: string[] = [];
  htmlToMarkdown(html, base, undefined, urls);
  return urls;
}

export function extractImageUrls(item: WorkItem, connection: Connection, rendererVersion: RendererVersion = CURRENT_RENDERER_VERSION): string[] {
  const fields = item.fields;
  const source = workItemUrl(connection, item.id);
  const urls: string[] = [];
  const fieldNames = [
    'System.Description',
    ...(rendererVersion >= 3 ? ['Custom.Specifications'] : []),
    'Microsoft.VSTS.Common.AcceptanceCriteria',
    ...(rendererVersion >= 3 ? ['Custom.Design'] : []),
    'Microsoft.VSTS.TCM.ReproSteps',
  ];
  for (const field of fieldNames) {
    htmlToMarkdown(text(fields[field]), source, undefined, urls);
  }
  if (rendererVersion >= 3 && item.comments) {
    for (const comment of item.comments) {
      htmlToMarkdown(text(comment.text), source, undefined, urls);
    }
  }
  return urls;
}

export function referencedLocalImages(markdown: string): string[] {
  const matches = new Set<string>();
  const pattern = /!\[(?:\\.|[^\]\\])*\]\((images\/[a-zA-Z0-9._-]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    matches.add(match[1]!);
  }
  return [...matches];
}

export function renderWorkItem(item: WorkItem, connection: Connection, importedAt: Date, rendererVersion: RendererVersion = CURRENT_RENDERER_VERSION, imagePaths?: ReadonlyMap<string, string>): string {
  const fields = item.fields;
  const assigned = fields['System.AssignedTo'];
  const assignedTo = typeof assigned === 'object' && assigned !== null && 'displayName' in assigned ?
    assigned.displayName : assigned;
  const source = workItemUrl(connection, item.id);
  const section = (name: string, field: string): string =>
    '## ' + name + '\n\n' + (htmlToMarkdown(text(fields[field]), source, imagePaths) || '（未提供）');
  const commentsSection = (): string[] => {
    if (rendererVersion < 3 || item.comments === undefined) { return []; }
    if (item.comments.length === 0) {
      return ['## Comments\n\n（未提供）'];
    }
    const rendered = item.comments.map((comment, idx) => {
      const author = inline(comment.createdBy) || 'Unknown';
      const created = inline(comment.createdDate);
      const edited = comment.modifiedDate && comment.modifiedDate !== comment.createdDate ?
        ', edited ' + inline(comment.modifiedDate) : '';
      const timePart = created ? ' (' + created + edited + ')' : '';
      const body = htmlToMarkdown(text(comment.text), source, imagePaths) || '（未提供）';
      return '### Comment ' + (idx + 1) + ' — ' + author + timePart + '\n\n' + body;
    });
    return ['## Comments\n\n' + rendered.join('\n\n')];
  };
  return [
    '# ' + item.id + ' — ' + inline(fields['System.Title']),
    rendererVersion === 1 ?
      '> Azure DevOps 需求副本。请将本地设计与笔记写入独立文件；此版本仅支持首次导入。' :
      '> Azure DevOps 需求副本，由 DevOps Connector 管理。请将本地设计与笔记写入独立文件。',
    '- ID: ' + item.id,
    '- Revision: ' + item.rev,
    ...(rendererVersion >= 3 ? ['- Template Version: ' + rendererVersion] : []),
    '- Work Item Type: ' + inline(fields['System.WorkItemType']),
    '- State: ' + inline(fields['System.State']),
    ...(rendererVersion >= 3 && text(fields['System.Reason']).trim() ? ['- Reason: ' + inline(fields['System.Reason'])] : []),
    '- Assigned To: ' + (inline(assignedTo) || 'Unassigned'),
    ...(rendererVersion >= 3 && text(fields['System.AreaPath']).trim() ? ['- Area: ' + inline(fields['System.AreaPath'])] : []),
    ...(rendererVersion >= 3 && text(fields['System.IterationPath']).trim() ? ['- Iteration: ' + inline(fields['System.IterationPath'])] : []),
    '- Tags: ' + (inline(fields['System.Tags']) || 'None'),
    '- Project: ' + inline(connection.project),
    '- Source: [' + 'Azure DevOps' + '](' + source + ')',
    '- Changed Date: ' + inline(fields['System.ChangedDate']),
    '- Exported At: ' + importedAt.toISOString(),
    '',
    section('Description', 'System.Description'),
    ...(rendererVersion >= 3 ? [section('Specifications', 'Custom.Specifications')] : []),
    section('Acceptance Criteria', 'Microsoft.VSTS.Common.AcceptanceCriteria'),
    ...(rendererVersion >= 3 ? [section('Design', 'Custom.Design')] : []),
    section('Repro Steps', 'Microsoft.VSTS.TCM.ReproSteps'),
    ...commentsSection(),
    item.comments !== undefined ?
      (imagePaths && imagePaths.size > 0 ?
        '> 评论与图片已同步到本地；附件和修订历史未导入。' :
        '> 评论已同步到本地；附件和修订历史未导入；图片仅保留链接。') :
      (imagePaths && imagePaths.size > 0 ?
        '> 评论、附件和历史未导入；图片已下载到本地。' :
        '> 评论、附件和历史未导入；图片仅保留链接。'),
  ].join('\n\n') + '\n';
}
