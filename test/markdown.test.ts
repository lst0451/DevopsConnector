import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImageUrls, extractImageUrlsFromHtml, htmlToMarkdown, referencedLocalImages, renderWorkItem } from '../src/markdown';

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
  for (const expected of ['修订版本：3', '开发者', '需求内容', '## Description', '## Acceptance Criteria', '## Repro Steps', '（未提供）',
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

test('current template exports Specifications and Design without conflating acceptance criteria', () => {
  const result = renderWorkItem({ id: 42, rev: 73, fields: {
    'Custom.Specifications': '<h3>规格明细</h3><p><strong>金额规则</strong></p>',
    'Custom.Design': '<p>设计实现说明</p>',
    'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>独立验收条件</p>',
  } }, connection, new Date('2026-11-11T12:00:00Z'));
  for (const expected of ['导出模板版本：3', '## Specifications', '规格明细',
    '**金额规则**', '## Design', '设计实现说明', '## Acceptance Criteria', '独立验收条件']) {
    assert.ok(result.includes(expected), expected);
  }
});

test('legacy templates keep the original shape and omit newly supported custom fields', () => {
  for (const version of [1, 2] as const) {
    const result = renderWorkItem({ id: 42, rev: 73, fields: {
      'Custom.Specifications': '<p>新字段内容</p>', 'Custom.Design': '<p>新设计内容</p>',
    } }, connection, new Date('2026-11-11T12:00:00Z'), version);
    assert.doesNotMatch(result, /导出模板版本|Specifications|Design|新字段内容|新设计内容/);
    assert.ok(result.includes('此版本仅支持首次导入') === (version === 1));
  }
});

test('missing custom fields remain explicit and custom HTML receives safety conversion', () => {
  const empty = renderWorkItem({ id: 42, rev: 1, fields: {} }, connection, new Date());
  assert.match(empty, /## Specifications\n\n（未提供）/);
  assert.match(empty, /## Design\n\n（未提供）/);
  const result = renderWorkItem({ id: 42, rev: 1, fields: {
    'Custom.Specifications': '<script>unsafe()</script><a href="command:evil">规则</a>' +
      '<table><tr><td>表格内容</td></tr></table>',
    'Custom.Design': '<img src="https://example.com/design.png" alt="设计图">',
  } }, connection, new Date());
  assert.doesNotMatch(result, /unsafe\(\)|command:|<table|!\[/);
  assert.match(result, /表格内容/);
  assert.match(result, /设计图（远端图片）/);
});

test('extractImageUrls collects unique safe HTTPS images across rendered fields', () => {
  const item = {
    id: 42,
    rev: 5,
    fields: {
      'System.Description': '<p><img src="https://dev.azure.com/example/_apis/wit/attachments/1?fileName=a.png" alt="图A"></p>',
      'Custom.Specifications': '<p><img src="https://dev.azure.com/example/_apis/wit/attachments/1?fileName=a.png"><img src="http://insecure.test/bad.png"></p>',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<script><img src="https://evil.test/in-script.png"></script><form><img src="https://evil.test/in-form.png"></form>',
      'Custom.Design': '<p><img src="https://cdn.example.com/design.jpg" alt="设计[1]"></p>',
      'Microsoft.VSTS.TCM.ReproSteps': '<p><img src="data:image/png;base64,AAAA"></p>',
    },
  };
  assert.deepEqual(extractImageUrls(item, connection), [
    'https://dev.azure.com/example/_apis/wit/attachments/1?fileName=a.png',
    'https://cdn.example.com/design.jpg',
  ]);
  assert.deepEqual(extractImageUrlsFromHtml('<img src="/relative.png">', base), [
    'https://dev.azure.com/relative.png',
  ]);
});

test('renderWorkItem uses local image paths when provided and referencedLocalImages extracts them', () => {
  const img1 = 'https://dev.azure.com/example/_apis/wit/attachments/1?fileName=a.png';
  const img2 = 'https://cdn.example.com/design.jpg';
  const item = {
    id: 42,
    rev: 5,
    fields: {
      'System.Description': `<p><img src="${img1}" alt="图A"></p>`,
      'Custom.Design': `<p><img src="${img2}" alt="设计[1]"></p>`,
    },
  };
  const map = new Map([
    [img1, 'images/a-11111111.png'],
    [img2, 'images/design-22222222.jpg'],
  ]);
  const md = renderWorkItem(item, connection, new Date('2026-11-11T12:00:00Z'), 3, map);
  assert.ok(md.includes('![图A](images/a-11111111.png)'));
  assert.ok(md.includes('![设计\\[1\\]](images/design-22222222.jpg)'));
  assert.ok(md.includes('图片已下载到本地。'));
  assert.doesNotMatch(md, /远端图片/);
  assert.deepEqual(referencedLocalImages(md), [
    'images/a-11111111.png',
    'images/design-22222222.jpg',
  ]);
});

test('preserves raw Markdown in Custom.Design including headings, lists, code and entities', () => {
  const rawDesign = [
    '## 1. Summary of Final Requirement Choices (2026-10-30)',
    '',
    '1. **Header &amp; Removed Elements**:',
    '   - Top-left displays **`INVOICE`** and `Sales Invoice Header.&quot;No.&quot;`.',
    '   - **Remove** `page number 1/1`.',
    '',
    '## 2. Technical Design',
    '',
    '### 2.1 Report Extension (`RepExt51000.al`)',
    '',
    '```al',
    'var x: Code[20];',
    '```',
  ].join('\n');

  const md = renderWorkItem({
    id: 42,
    rev: 81,
    fields: { 'Custom.Design': rawDesign },
  }, connection, new Date('2026-11-11T12:00:00Z'));

  assert.ok(md.includes('## Design\n\n## 1. Summary of Final Requirement Choices (2026-10-30)\n\n1. **Header & Removed Elements**:'));
  assert.ok(md.includes('   - Top-left displays **`INVOICE`** and `Sales Invoice Header."No."`.'));
  assert.ok(md.includes('### 2.1 Report Extension (`RepExt51000.al`)'));
  assert.ok(md.includes('```al\nvar x: Code[20];\n```'));
  assert.doesNotMatch(md, /\\\*\\\*|\\##/);
});

test('unwraps Markdown wrapped in simple p/div/br tags and sanitizes unsafe links and images', () => {
  const wrapped = '<div>## Heading<br>- **Bold** &amp; `code`<br>[safe](https://example.com) [bad](javascript:evil())<br>![图](https://cdn.example.com/a.png)</div>';
  assert.deepEqual(extractImageUrlsFromHtml(wrapped, base), ['https://cdn.example.com/a.png']);

  const withoutLocal = htmlToMarkdown(wrapped, base);
  assert.ok(withoutLocal.includes('## Heading\n- **Bold** & `code`\n[safe](https://example.com/) bad\n[图（远端图片）](https://cdn.example.com/a.png)'));
  assert.doesNotMatch(withoutLocal, /javascript:/);

  const withLocal = htmlToMarkdown(wrapped, base, new Map([['https://cdn.example.com/a.png', 'images/a-11111111.png']]));
  assert.ok(withLocal.includes('![图](images/a-11111111.png)'));
});
