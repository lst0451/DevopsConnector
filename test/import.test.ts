import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AzureDevOpsClient } from '../src/azureDevOpsClient';
import { renderWorkItem } from '../src/markdown';
import { saveNewWorkItem } from '../src/storage';
import { parseWorkItemInput } from '../src/validation';

test('imports a mocked Azure work item end-to-end without persisting the token', async (t) => {
  const parent = path.resolve('work');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'import-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('import-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const connection = { organizationUrl: 'https://dev.azure.com/example', project: 'Demo' };
  const id = parseWorkItemInput('https://dev.azure.com/example/Demo/_workitems/edit/21835', connection);
  const client = new AzureDevOpsClient(async () => new Response(JSON.stringify({
    id, rev: 7, fields: {
      'System.TeamProject': 'Demo',
      'System.Title': '测试任务',
      'System.Description': '<p>从远端导入<strong>需求</strong>。</p>',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>本地文件完整</li></ul>',
    },
  }), { headers: { 'content-type': 'application/json' } }));
  const item = await client.getWorkItem(connection, id, 'test-only-token-value');
  const file = await saveNewWorkItem(root, 'requirements', id,
    renderWorkItem(item, connection, new Date('2026-11-11T12:00:00Z')));
  const result = await fs.readFile(file, 'utf8');
  assert.match(result, /测试任务/);
  assert.match(result, /Revision: 7/);
  assert.match(result, /本地文件完整/);
  assert.doesNotMatch(result, /test-only-token-value/);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['workitem.md']);
});
