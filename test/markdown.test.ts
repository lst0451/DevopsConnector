import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, renderWorkItem } from '../src/markdown';

const connection = { organizationUrl: 'https://dev.azure.com/example', project: 'My Project' };
const base = connection.organizationUrl + '/My%20Project/_workitems/edit/42';

test('preserves the configured visualstudio hostname in the exported source link', () => {
  const result = renderWorkItem({ id: 42, rev: 1, fields: {} },
    { organizationUrl: 'https://vffice.visualstudio.com', project: 'My Project' }, new Date('2026-11-11T12:00:00Z'));
  assert.ok(result.includes('https://vffice.visualstudio.com/My%20Project/_workitems/edit/42'));
  assert.ok(!result.includes('dev.azure.com'));
});

test('converts description formatting and preserves Unicode', () => {
  const result = htmlToMarkdown('<h2>需求</h2><p><strong>金额</strong> &amp; 税</p><ul><li>第一项</li></ul>', base);
  assert.match(result, /## 需求/);
  assert.match(result, /\*\*金额\*\*/);
  assert.match(result, /第一项/);
});

test('exports revision, source, assignment and missing-field placeholders', () => {
  const result = renderWorkItem({ id: 42, rev: 3, fields: {
    'System.Title': '开发需求', 'System.AssignedTo': { displayName: '开发者' },
    'System.Description': '<p>需求内容</p>',
  } }, connection, new Date('2026-11-11T12:00:00Z'));
  for (const expected of ['修订版本：3', '开发者', '需求内容', '验收标准', '（未提供）',
    '2026-11-11T12:00:00.000Z', base]) { assert.ok(result.includes(expected), expected); }
});

test('drops active content, unsafe links and renders images only as links', () => {
  const result = htmlToMarkdown('<script>danger()</script><iframe>bad</iframe>' +
    '<a href="command:evil">label</a><a href="javascript:evil()">unsafe</a>' +
    '<img src="https://example.com/image.png" alt="参考"><a href="https://example.com">safe</a>', base);
  assert.doesNotMatch(result, /danger|iframe|command:|javascript:|!\[/);
  assert.match(result, /远端图片/);
  assert.match(result, /https:\/\/example.com/);
});

test('does not emit raw HTML from headerless tables or escaped text', () => {
  const result = htmlToMarkdown('<table><tr><td><img src="https://example.com/a" onerror="evil()"></td>' +
    '<td><a href="command:evil">text</a></td></tr></table><p>&lt;img src=x onerror=evil()&gt;</p>', base);
  assert.doesNotMatch(result, /<img|<table|command:|!\[/);
  assert.match(result, /text/);
  assert.match(result, /&lt;img/);
});

test('handles empty tables and preserves heading tables', () => {
  assert.equal(htmlToMarkdown('<table></table>', base), '');
  const result = htmlToMarkdown('<table><tr><th>Name</th></tr><tr><td>A | B</td></tr></table>', base);
  assert.match(result, /Name/);
  assert.match(result, /---/);
  assert.ok(result.includes('A \\| B'));
});
