import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AzureDevOpsClient, validateWorkItem } from '../src/azureDevOpsClient';

const connection = { organizationUrl: 'https://dev.azure.com/example', project: 'My Project' };
const fixture = { id: 42, rev: 3, fields: { 'System.TeamProject': 'My Project', 'System.Title': 'Test' } };
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('requests the exact historical revision and validates the response revision', async () => {
  const client = new AzureDevOpsClient(async (url) => {
    assert.equal(url, 'https://dev.azure.com/example/My%20Project/_apis/wit/workitems/42/revisions/3?api-version=7.1');
    return jsonResponse(fixture);
  });
  assert.deepEqual(await client.getWorkItemRevision(connection, 42, 3, 'not-real'), fixture);
  const wrong = new AzureDevOpsClient(async () => jsonResponse({ ...fixture, rev: 4 }));
  await assert.rejects(wrong.getWorkItemRevision(connection, 42, 3, 'not-real'), /历史修订号不一致/);
});

test('sends the API request directly to the configured visualstudio hostname', async () => {
  const client = new AzureDevOpsClient(async (url, options) => {
    assert.equal(url, 'https://vffice.visualstudio.com/My%20Project/_apis/wit/workitems/42?api-version=7.1');
    assert.equal(options?.redirect, 'error');
    return jsonResponse(fixture);
  });
  const item = await client.getWorkItem({ ...connection, organizationUrl: 'https://vffice.visualstudio.com/' }, 42, 'not-real');
  assert.deepEqual(item, fixture);
});

test('requests Work Item read API, encodes project and disables redirects', async () => {
  const client = new AzureDevOpsClient(async (url, options) => {
    assert.equal(url, 'https://dev.azure.com/example/My%20Project/_apis/wit/workitems/42?api-version=7.1');
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization,
      'Basic ' + Buffer.from(':test-token-not-real').toString('base64'));
    return jsonResponse(fixture);
  });
  assert.deepEqual(await client.getWorkItem(connection, 42, 'test-token-not-real'), fixture);
});

for (const [status, message] of [[401, '认证失败'], [403, '访问被拒绝'], [404, '找不到'], [429, '过于频繁'], [500, 'HTTP 500']] as const) {
  test('handles HTTP ' + status + ' without exposing server body', async () => {
    const client = new AzureDevOpsClient(async () => new Response('SECRET-server-body', { status }));
    await assert.rejects(client.getWorkItem(connection, 42, 'not-real'),
      (error: Error) => error.message.includes(message) && !error.message.includes('SECRET'));
  });
}

test('does not expose raw transport errors', async () => {
  const client = new AzureDevOpsClient(async () => { throw new Error('secret-token https://bad-host/'); });
  await assert.rejects(client.getWorkItem(connection, 42, 'not-real'),
    (error: Error) => error.message.includes('无法连接') && !error.message.includes('secret-token'));
});

test('rejects login HTML and invalid JSON', async () => {
  const html = new AzureDevOpsClient(async () => new Response('<html>login</html>'));
  await assert.rejects(html.getWorkItem(connection, 42, 'not-real'), /未返回 JSON/);
  const invalid = new AzureDevOpsClient(async () => new Response('{', { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(invalid.getWorkItem(connection, 42, 'not-real'), /无法解析/);
});

test('validates ID, revision and project of response', () => {
  assert.throws(() => validateWorkItem({ ...fixture, id: 43 }, 42, connection.project));
  assert.throws(() => validateWorkItem({ ...fixture, rev: 0 }, 42, connection.project));
  assert.throws(() => validateWorkItem(fixture, 42, 'Other Project'));
  assert.throws(() => validateWorkItem({ id: 42, rev: 1, fields: [] }, 42, connection.project));
});

test('rejects oversized responses', async () => {
  const client = new AzureDevOpsClient(async () => new Response(' '.repeat(5 * 1024 * 1024 + 1),
    { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.getWorkItem(connection, 42, 'not-real'), /超过 5 MB/);
});

test('propagates caller cancellation safely', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new AzureDevOpsClient(async (_url, options) => {
    assert.equal(options?.signal?.aborted, true);
    throw new Error('cancelled');
  });
  await assert.rejects(client.getWorkItem(connection, 42, 'not-real', controller.signal), /已取消/);
});
