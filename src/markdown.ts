import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { Connection, WorkItem } from './types';
import { workItemUrl } from './validation';

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

export function htmlToMarkdown(html: string, base: string): string {
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
      const href = safeLink(node.getAttribute('src') ?? '', base);
      const label = inline(node.getAttribute('alt')) || '图片';
      return href ? '[' + label + '（远端图片）](' + href + ')' : '[图片未导入]';
    },
  });
  return converter.turndown(html).trim();
}

export function renderWorkItem(item: WorkItem, connection: Connection, importedAt: Date): string {
  const fields = item.fields;
  const assigned = fields['System.AssignedTo'];
  const assignedTo = typeof assigned === 'object' && assigned !== null && 'displayName' in assigned ?
    assigned.displayName : assigned;
  const source = workItemUrl(connection, item.id);
  const section = (name: string, field: string): string =>
    '## ' + name + '\n\n' + (htmlToMarkdown(text(fields[field]), source) || '（未提供）');
  return [
    '# ' + item.id + ' — ' + inline(fields['System.Title']),
    '> Azure DevOps 需求副本。请将本地设计与笔记写入独立文件；此版本仅支持首次导入。',
    '- ID：' + item.id,
    '- 修订版本：' + item.rev,
    '- 类型：' + inline(fields['System.WorkItemType']),
    '- 状态：' + inline(fields['System.State']),
    '- 负责人：' + (inline(assignedTo) || '（未分配）'),
    '- 标签：' + (inline(fields['System.Tags']) || '（无）'),
    '- 项目：' + inline(connection.project),
    '- 来源：[' + 'Azure DevOps' + '](' + source + ')',
    '- 远端更新时间：' + inline(fields['System.ChangedDate']),
    '- 本地导入时间：' + importedAt.toISOString(),
    '',
    section('描述', 'System.Description'),
    section('验收标准', 'Microsoft.VSTS.Common.AcceptanceCriteria'),
    section('复现步骤', 'Microsoft.VSTS.TCM.ReproSteps'),
    '> 评论、附件和历史未导入；图片仅保留链接。',
  ].join('\n\n') + '\n';
}
