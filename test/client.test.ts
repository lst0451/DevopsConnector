import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AzureDevOpsClient, buildLocalImagePath, collectWorkItemIdentities, resolveCommentMentions, validateWorkItem } from '../src/azureDevOpsClient';

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

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('downloadImage sends PAT only for same organization and disables redirects', async () => {
  let seenAuth: string | undefined;
  const orgClient = new AzureDevOpsClient(async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    seenAuth = (options?.headers as Record<string, string>).Authorization;
    return new Response(pngBytes, { headers: { 'content-type': 'image/png' } });
  });
  const orgResult = await orgClient.downloadImage(connection,
    'https://example.visualstudio.com/My%20Project/_apis/wit/attachments/11111111-1111-1111-1111-111111111111?fileName=screen.png',
    'pat-secret');
  assert.equal(seenAuth, 'Basic ' + Buffer.from(':pat-secret').toString('base64'));
  assert.deepEqual(orgResult.data, pngBytes);
  assert.equal(orgResult.contentType, 'image/png');

  let externalAuth: string | undefined;
  const externalClient = new AzureDevOpsClient(async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    externalAuth = (options?.headers as Record<string, string>).Authorization;
    return new Response(pngBytes, { headers: { 'content-type': 'image/png' } });
  });
  const externalResult = await externalClient.downloadImage(connection, 'https://cdn.example.com/assets/diagram.png', '');
  assert.equal(externalAuth, undefined);
  assert.deepEqual(externalResult.data, pngBytes);
});

test('downloadImage rejects HTML responses, HTTP errors, oversized files and unsafe URLs', async () => {
  const html = new AzureDevOpsClient(async () => new Response('<html>login</html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  await assert.rejects(html.downloadImage(connection, 'https://cdn.example.com/a.png', ''), /未返回二进制内容/);

  const notFound = new AzureDevOpsClient(async () => new Response('nope', { status: 404 }));
  await assert.rejects(notFound.downloadImage(connection, 'https://cdn.example.com/a.png', ''), /找不到远端图片/);

  const empty = new AzureDevOpsClient(async () => new Response(new Uint8Array(0), {
    headers: { 'content-type': 'image/png' },
  }));
  await assert.rejects(empty.downloadImage(connection, 'https://cdn.example.com/a.png', ''), /内容为空/);

  const oversized = new AzureDevOpsClient(async () => new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
    headers: { 'content-type': 'image/png' },
  }));
  await assert.rejects(oversized.downloadImage(connection, 'https://cdn.example.com/a.png', ''), /超过 20 MB/);

  await assert.rejects(html.downloadImage(connection, 'http://cdn.example.com/a.png', ''), /HTTPS/);
  await assert.rejects(html.downloadImage(connection, 'https://user:pass@cdn.example.com/a.png', ''), /HTTPS/);
});

test('buildLocalImagePath detects magic bytes, falls back to contentType/URL, and sanitizes filenames', () => {
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const bmpBytes = new Uint8Array([0x42, 0x4d, 0, 0]);

  const p1 = buildLocalImagePath(
    'https://dev.azure.com/example/Proj/_apis/wit/attachments/11111111-2222-3333-4444-555555555555?fileName=Screenshot%20(1).png',
    'application/octet-stream', jpegBytes);
  assert.match(p1, /^images\/screenshot-1-[a-f0-9]{8}\.jpg$/);

  const p2 = buildLocalImagePath(
    'https://dev.azure.com/example/Proj/_apis/wit/attachments/11111111-2222-3333-4444-555555555555',
    'image/gif', gifBytes);
  assert.match(p2, /^images\/image-[a-f0-9]{8}\.gif$/);

  const p3 = buildLocalImagePath('https://cdn.example.com/con.png', 'application/octet-stream', webpBytes);
  assert.match(p3, /^images\/image-[a-f0-9]{8}\.webp$/);

  const p4 = buildLocalImagePath('https://cdn.example.com/%E6%88%AA%E5%9B%BE.bmp', 'image/bmp', bmpBytes);
  assert.match(p4, /^images\/image-[a-f0-9]{8}\.bmp$/);

  const p5 = buildLocalImagePath('https://cdn.example.com/favicon.ico', 'image/x-icon', new Uint8Array([1, 2, 3]));
  assert.match(p5, /^images\/favicon-[a-f0-9]{8}\.ico$/);
});

test('getWorkItemComments paginates, filters deleted entries, and resolves user mentions', async () => {
  const urls: string[] = [];
  const client = new AzureDevOpsClient(async (url) => {
    urls.push(String(url));
    if (!String(url).includes('continuationToken=')) {
      return jsonResponse({
        totalCount: 3,
        count: 2,
        continuationToken: 'page-2',
        comments: [
          {
            id: 101,
            version: 1,
            text: 'Hello @<11111111-1111-1111-1111-111111111111> and @<33333333-3333-3333-3333-333333333333>',
            createdBy: { id: '22222222-2222-2222-2222-222222222222', displayName: 'Alice' },
            createdDate: '2026-11-10T10:00:00Z',
            modifiedDate: '2026-11-10T10:00:00Z',
            format: 'markdown',
          },
          {
            id: 102,
            isDeleted: true,
            text: 'deleted',
            createdBy: { displayName: 'Ghost' },
            createdDate: '2026-11-10T10:05:00Z',
          },
        ],
      });
    }
    return jsonResponse({
      totalCount: 3,
      count: 1,
      comments: [
        {
          id: 103,
          version: 2,
          text: '<a href="#" data-vss-mention="version:2.0,22222222-2222-2222-2222-222222222222"></a><div><p>Done</p></div>',
          createdBy: { id: '11111111-1111-1111-1111-111111111111', displayName: 'Bob' },
          createdDate: '2026-11-10T11:00:00Z',
          modifiedDate: '2026-11-10T11:30:00Z',
          format: 'html',
        },
      ],
    });
  });

  const fieldIdentities = collectWorkItemIdentities({
    'System.AssignedTo': { id: '11111111-1111-1111-1111-111111111111', displayName: 'Bob' },
  });
  const comments = await client.getWorkItemComments(connection, 42, 'not-real', undefined, fieldIdentities);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://dev.azure.com/example/My%20Project/_apis/wit/workItems/42/comments?$top=200&order=desc&api-version=7.1-preview.4');
  assert.equal(urls[1], 'https://dev.azure.com/example/My%20Project/_apis/wit/workItems/42/comments?$top=200&order=desc&continuationToken=page-2&api-version=7.1-preview.4');
  assert.equal(comments.length, 2);
  assert.equal(comments[0]?.text, 'Hello @Bob and `@<33333333-3333-3333-3333-333333333333>`');
  assert.equal(comments[0]?.createdBy, 'Alice');
  assert.equal(comments[1]?.text, '@Alice<div><p>Done</p></div>');
  assert.equal(comments[1]?.modifiedDate, '2026-11-10T11:30:00Z');
  assert.equal(resolveCommentMentions('<a data-vss-mention="version:2.0,11111111-1111-1111-1111-111111111111">Bob</a>', new Map()), '@Bob');
});

test('getWorkItemComments rejects malformed comment payloads', async () => {
  const client = new AzureDevOpsClient(async () => jsonResponse({ comments: 'not-an-array' }));
  await assert.rejects(client.getWorkItemComments(connection, 42, 'not-real'), /评论数据格式无效/);
});
