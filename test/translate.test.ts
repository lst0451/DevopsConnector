import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildTranslationPrompt,
  extractWorkItemIdFromPath,
  saveTranslatedWorkItem,
  splitMarkdownChunks,
  stripMarkdownFence,
  translatedFilePath,
} from '../src/translation';
import { UserError } from '../src/types';

async function sandbox(t: TestContext): Promise<string> {
  const parent = path.resolve('work');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'translate-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('translate-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('translatedFilePath builds expected path and validates id/directory', () => {
  const file = translatedFilePath('C:/repo', 'docs/workitems', 123);
  assert.equal(file, path.join('C:/repo', 'docs', 'workitems', '123', 'workitem.zh-CN.md'));
  assert.throws(() => translatedFilePath('C:/repo', '../outside', 123), UserError);
});

test('extractWorkItemIdFromPath detects workitem.md and workitem.zh-CN.md in save directory', () => {
  const root = path.resolve('C:/repo');
  assert.equal(
    extractWorkItemIdFromPath(root, 'docs/workitems', path.join(root, 'docs', 'workitems', '42', 'workitem.md')),
    42,
  );
  assert.equal(
    extractWorkItemIdFromPath(root, 'docs/workitems', path.join(root, 'docs', 'workitems', '42', 'workitem.zh-CN.md')),
    42,
  );
  assert.equal(
    extractWorkItemIdFromPath(root, 'docs/workitems', path.join(root, 'docs', 'workitems', '42', 'notes.md')),
    undefined,
  );
  assert.equal(
    extractWorkItemIdFromPath(root, 'docs/workitems', path.join(root, 'other', '42', 'workitem.md')),
    undefined,
  );
});

test('stripMarkdownFence unwraps outer markdown code fence and preserves inner code blocks', () => {
  const wrapped = '```markdown\n# 标题\n\n```ts\nconst x = 1;\n```\n```';
  assert.equal(stripMarkdownFence(wrapped), '# 标题\n\n```ts\nconst x = 1;\n```\n');

  const plain = '# 标题\n\n正文';
  assert.equal(stripMarkdownFence(plain), '# 标题\n\n正文\n');
});

test('buildTranslationPrompt includes source markdown and instructions', () => {
  const prompt = buildTranslationPrompt('# Sample\n\nHello');
  assert.match(prompt, /Simplified Chinese/);
  assert.match(prompt, /# Sample\n\nHello/);
});

test('saveTranslatedWorkItem writes and updates workitem.zh-CN.md without touching workitem.md', async (t) => {
  const root = await sandbox(t);
  const itemDir = path.join(root, 'docs', 'workitems', '42');
  await fs.mkdir(itemDir, { recursive: true });
  await fs.writeFile(path.join(itemDir, 'workitem.md'), '# Original\n', 'utf8');

  const file = await saveTranslatedWorkItem(root, 'docs/workitems', 42, '# 中文翻译 v1\n');
  assert.equal(file, path.join(itemDir, 'workitem.zh-CN.md'));
  assert.equal(await fs.readFile(file, 'utf8'), '# 中文翻译 v1\n');

  await saveTranslatedWorkItem(root, 'docs/workitems', 42, '# 中文翻译 v2\n');
  assert.equal(await fs.readFile(file, 'utf8'), '# 中文翻译 v2\n');
  assert.equal(await fs.readFile(path.join(itemDir, 'workitem.md'), 'utf8'), '# Original\n');
  assert.deepEqual((await fs.readdir(itemDir)).sort(), ['workitem.md', 'workitem.zh-CN.md']);
});

test('saveTranslatedWorkItem fails when item directory does not exist', async (t) => {
  const root = await sandbox(t);
  await assert.rejects(
    () => saveTranslatedWorkItem(root, 'docs/workitems', 99, '# 中文\n'),
    UserError,
  );
});

test('splitMarkdownChunks keeps short documents whole and splits long documents by section without breaking code fences', () => {
  const shortDoc = '# Work Item #1\n\n## Description\n\nShort text.';
  assert.deepEqual(splitMarkdownChunks(shortDoc, 4000), [shortDoc]);

  const longDoc = [
    '# Work Item #1',
    '',
    '## Description',
    '',
    '```md',
    '## Not a heading inside fence',
    'A'.repeat(120),
    '```',
    '',
    '## Specifications',
    '',
    'B'.repeat(120),
    '',
    '## Comments',
    '',
    '### Comment 1',
    '',
    'C'.repeat(120),
    '',
    '### Comment 2',
    '',
    'D'.repeat(120),
  ].join('\n');

  const chunks = splitMarkdownChunks(longDoc, 200);
  assert.ok(chunks.length >= 3);
  assert.match(chunks[0]!, /## Not a heading inside fence/);
  assert.equal(chunks.join('\n\n'), longDoc);
});
