import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { renderWorkItem } from '../src/markdown';
import { digest, LOCK_FILE, PENDING_FILE, STATE_FILE } from '../src/syncModel';
import { SyncRepository } from '../src/syncRepository';
import { ExistingFileMismatch, SyncService } from '../src/syncService';
import { Connection, UserError, WorkItem } from '../src/types';

const connection: Connection = { organizationUrl: 'https://vffice.visualstudio.com', project: 'Demo' };
const now = () => new Date('2026-11-11T22:00:00Z');
function fixture(rev = 1): WorkItem {
  return { id: 42, rev, fields: {
    'System.TeamProject': 'Demo', 'System.Title': '测试任务',
    'System.Description': '<p>需求版本 ' + rev + '</p>',
  } };
}
class FakeClient {
  latest = fixture();
  error?: Error;
  requestedRevision?: number;
  calls = 0;
  async getWorkItem(): Promise<WorkItem> {
    this.calls++;
    if (this.error) { throw this.error; }
    return this.latest;
  }
  async getWorkItemRevision(_connection: Connection, _id: number, revision: number): Promise<WorkItem> {
    this.requestedRevision = revision;
    if (this.error) { throw this.error; }
    return fixture(revision);
  }
}
async function setup(t: TestContext, hook?: () => Promise<void>) {
  const parent = path.resolve('work');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'sync-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('sync-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const client = new FakeClient();
  const repository = new SyncRepository(root, '.vscode/docs/workitems', hook);
  const service = new SyncService(repository, connection, client, now);
  const directory = path.join(root, '.vscode/docs/workitems/42');
  return { root, directory, file: path.join(directory, 'workitem.md'), client, repository, service };
}
const guard = () => {};
const clean = () => false;

test('new import creates verified tracking state without persisting PAT', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'test-token-secret', guard);
  const { state, local } = await s.service.inspect(42);
  assert.equal(state.revision, 1);
  assert.equal(state.hash, digest(local!));
  assert.equal(state.rendererVersion, 2);
  assert.equal(state.status, 'synced');
  assert.doesNotMatch(await fs.readFile(path.join(s.directory, STATE_FILE), 'utf8'), /test-token-secret/);
  assert.deepEqual((await fs.readdir(s.directory)).sort(), [STATE_FILE, 'workitem.md'].sort());
});

test('unchanged check and apply do not rewrite Markdown or export time', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  const content = await fs.readFile(s.file, 'utf8');
  const stat = await fs.stat(s.file);
  const plan = await s.service.check(42, 'not-real', clean);
  assert.equal(plan.changed, false);
  await s.service.apply(plan, guard);
  assert.equal(await fs.readFile(s.file, 'utf8'), content);
  assert.equal((await fs.stat(s.file)).mtimeMs, stat.mtimeMs);
  assert.equal((await s.service.inspect(42)).state.status, 'unchanged');
});

test('checking remote changes does not overwrite, applying updates only managed Markdown', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  await fs.writeFile(path.join(s.directory, 'notes.md'), 'my notes');
  const original = await fs.readFile(s.file, 'utf8');
  s.client.latest = fixture(2);
  const plan = await s.service.check(42, 'not-real', clean);
  assert.equal(plan.changed, true);
  assert.equal(await fs.readFile(s.file, 'utf8'), original);
  assert.equal((await s.service.inspect(42)).state.revision, 1);
  await s.service.apply(plan, guard);
  assert.equal((await s.service.inspect(42)).state.revision, 2);
  assert.match(await fs.readFile(s.file, 'utf8'), /需求版本 2/);
  assert.equal(await fs.readFile(path.join(s.directory, 'notes.md'), 'utf8'), 'my notes');
});

test('saved local edits block update, including when remote is unchanged', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  await fs.appendFile(s.file, '\nmy local edit');
  for (const revision of [1, 2]) {
    s.client.latest = fixture(revision);
    const plan = await s.service.check(42, 'not-real', clean);
    assert.equal(plan.conflict, true);
    await assert.rejects(s.service.apply(plan, guard), /本地修改/);
  }
  assert.match(await fs.readFile(s.file, 'utf8'), /my local edit/);
  assert.equal((await s.service.inspect(42)).state.revision, 1);
});

test('unsaved edits block sync; edits after preview also block commit', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  s.client.latest = fixture(2);
  assert.equal((await s.service.check(42, 'not-real', () => true)).conflict, true);
  const plan = await s.service.check(42, 'not-real', clean);
  await assert.rejects(s.service.apply(plan, () => { throw new UserError('未保存编辑'); }), /未保存编辑/);
  await fs.appendFile(s.file, '\nchanged after preview');
  await assert.rejects(s.service.apply(plan, guard), /预览后/);
  assert.match(await fs.readFile(s.file, 'utf8'), /changed after preview/);
});

test('missing document is not silently recreated by sync', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  await fs.unlink(s.file);
  s.client.latest = fixture(2);
  const plan = await s.service.check(42, 'not-real', clean);
  assert.equal(plan.conflict, true);
  await assert.rejects(s.service.apply(plan, guard));
  await assert.rejects(fs.stat(s.file), { code: 'ENOENT' });
});

test('network failure retains document/baseline and does not advance last successful check', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  const before = await s.service.inspect(42);
  s.client.error = new UserError('找不到 Work Item 或无权访问');
  await assert.rejects(s.service.check(42, 'not-real', clean), /无权/);
  const after = await s.service.inspect(42);
  assert.equal(after.local, before.local);
  assert.equal(after.state.hash, before.state.hash);
  assert.equal(after.state.checkedAt, before.state.checkedAt);
  assert.equal(after.state.status, 'error');
});

test('cancelled checks do not change state and lower remote revisions are refused', async (t) => {
  const s = await setup(t);
  s.client.latest = fixture(2);
  await s.service.import(42, 'not-real', guard);
  const before = await fs.readFile(path.join(s.directory, STATE_FILE), 'utf8');
  await assert.rejects(s.service.check(42, 'not-real', clean, AbortSignal.abort()), /取消/);
  assert.equal(await fs.readFile(path.join(s.directory, STATE_FILE), 'utf8'), before);
  s.client.latest = fixture(1);
  await assert.rejects(s.service.check(42, 'not-real', clean), /低于/);
  assert.equal((await s.service.inspect(42)).state.revision, 2);
});

test('legacy file is verified against its historical revision, keeps CRLF and is not rewritten', async (t) => {
  const s = await setup(t);
  await fs.mkdir(s.directory, { recursive: true });
  const old = renderWorkItem(fixture(1), connection, now(), 1).replace(/\n/g, '\r\n');
  await fs.writeFile(s.file, old);
  const stat = await fs.stat(s.file);
  s.client.latest = fixture(4);
  await s.service.trackExisting(42, 'not-real', guard);
  assert.equal(s.client.requestedRevision, 1);
  assert.equal(await fs.readFile(s.file, 'utf8'), old);
  assert.equal((await fs.stat(s.file)).mtimeMs, stat.mtimeMs);
  const { state } = await s.service.inspect(42);
  assert.equal(state.revision, 1);
  assert.equal(state.checkedAt, undefined);
  const plan = await s.service.check(42, 'not-real', clean);
  assert.equal(plan.next.revision, 4);
  await s.service.apply(plan, guard);
  assert.equal((await s.service.inspect(42)).state.rendererVersion, 2);
});

test('legacy local modifications cannot become a trusted baseline', async (t) => {
  const s = await setup(t);
  await fs.mkdir(s.directory, { recursive: true });
  const modified = renderWorkItem(fixture(), connection, now(), 1) + '\nlocal design';
  await fs.writeFile(s.file, modified);
  await assert.rejects(s.service.trackExisting(42, 'not-real', guard), ExistingFileMismatch);
  assert.equal(await fs.readFile(s.file, 'utf8'), modified);
  await assert.rejects(fs.stat(path.join(s.directory, STATE_FILE)), { code: 'ENOENT' });
});

test('untracking removes only metadata and the file can safely be reattached', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  const before = await fs.readFile(s.file, 'utf8');
  await s.service.untrack(42);
  assert.equal(await fs.readFile(s.file, 'utf8'), before);
  assert.deepEqual(await s.service.list(), []);
  await s.service.trackExisting(42, 'not-real', guard);
  assert.equal((await s.service.list()).length, 1);
});

test('configuration source changes do not silently retarget tracked IDs', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  const other = new SyncService(s.repository, { ...connection, project: 'Other' }, s.client);
  const calls = s.client.calls;
  await assert.rejects(other.check(42, 'not-real', clean), /配置不同/);
  assert.equal(s.client.calls, calls);
  assert.equal((await other.list())[0]?.status, 'error');
  const moved = new SyncService(new SyncRepository(s.root, 'different-directory'), connection, s.client);
  assert.deepEqual(await moved.list(), []);
  assert.ok(await fs.stat(s.file));
});

test('canonical URL alias retains tracked source identity', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  const alias = new SyncService(s.repository, { ...connection, organizationUrl: 'https://dev.azure.com/vffice' }, s.client);
  assert.equal((await alias.check(42, 'not-real', clean)).changed, false);
});

test('file lock prevents concurrent windows and is released on failure', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  await s.repository.withItem(42, false, async () => {
    await assert.rejects(s.service.check(42, 'not-real', clean), /同步锁/);
  });
  await assert.rejects(s.repository.withItem(42, false, async () => { throw new Error('fault'); }), /fault/);
  await assert.rejects(fs.stat(path.join(s.directory, LOCK_FILE)), { code: 'ENOENT' });
  await s.service.inspect(42);
});

test('a stale preview cannot overwrite a newer completed sync', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  s.client.latest = fixture(2);
  const older = await s.service.check(42, 'not-real', clean);
  s.client.latest = fixture(3);
  const newer = await s.service.check(42, 'not-real', clean);
  await s.service.apply(newer, guard);
  await assert.rejects(s.service.apply(older, guard), /其他窗口/);
  assert.equal((await s.service.inspect(42)).state.revision, 3);
});

test('import interrupted after file publication recovers tracking without rewriting the file', async (t) => {
  const s = await setup(t, async () => { throw new Error('simulated crash'); });
  await assert.rejects(s.service.import(42, 'not-real', guard), /simulated crash/);
  const document = await fs.readFile(s.file, 'utf8');
  assert.ok(await fs.stat(path.join(s.directory, PENDING_FILE)));
  const restored = new SyncService(new SyncRepository(s.root, '.vscode/docs/workitems'), connection, s.client);
  const result = await restored.inspect(42);
  assert.equal(result.state.revision, 1);
  assert.equal(result.local, document);
  await assert.rejects(fs.stat(path.join(s.directory, PENDING_FILE)), { code: 'ENOENT' });
});

test('update interrupted between document and state commits recovers the exact new baseline', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  s.client.latest = fixture(2);
  const plan = await s.service.check(42, 'not-real', clean);
  const failing = new SyncService(new SyncRepository(s.root, '.vscode/docs/workitems',
    async () => { throw new Error('simulated crash'); }), connection, s.client);
  await assert.rejects(failing.apply(plan, guard), /simulated crash/);
  const persisted = JSON.parse(await fs.readFile(path.join(s.directory, STATE_FILE), 'utf8')) as { revision: number };
  assert.equal(persisted.revision, 1);
  const recovered = await s.service.inspect(42);
  assert.equal(recovered.state.revision, 2);
  assert.equal(recovered.state.hash, digest(recovered.local!));
});

test('recovery refuses to discard edits made after an interrupted sync', async (t) => {
  const s = await setup(t, async () => { throw new Error('simulated crash'); });
  await assert.rejects(s.service.import(42, 'not-real', guard));
  await fs.appendFile(s.file, '\npost-crash local edit');
  await assert.rejects(s.service.inspect(42), /中断后文件又被修改/);
  assert.match(await fs.readFile(s.file, 'utf8'), /post-crash local edit/);
  assert.ok(await fs.stat(path.join(s.directory, PENDING_FILE)));
});

test('invalid state is fail-closed, not treated as a new import', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  const before = await fs.readFile(s.file, 'utf8');
  await fs.writeFile(path.join(s.directory, STATE_FILE), '{"schema":999}');
  await assert.rejects(s.service.import(42, 'not-real', guard), /状态文件无效/);
  assert.equal((await s.service.list())[0]?.status, 'error');
  assert.equal(await fs.readFile(s.file, 'utf8'), before);
});

test('nested junctions are rejected and source directories stay untouched', async (t) => {
  const s = await setup(t);
  const outside = path.join(s.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(s.root, '.vscode'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(s.service.import(42, 'not-real', guard), /目录联接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('late editor guard rejection leaves no journal and permits a later retry', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  s.client.latest = fixture(2);
  const plan = await s.service.check(42, 'not-real', clean);
  let calls = 0;
  await assert.rejects(s.service.apply(plan, () => {
    calls++;
    if (calls === 3) { throw new UserError('late unsaved edit'); }
  }), /late unsaved/);
  await assert.rejects(fs.stat(path.join(s.directory, PENDING_FILE)), { code: 'ENOENT' });
  assert.equal((await s.service.inspect(42)).state.revision, 1);
  await s.service.apply(plan, guard);
  assert.equal((await s.service.inspect(42)).state.revision, 2);
});

test('journal written before file commit is abandoned without modifying the original', async (t) => {
  const s = await setup(t);
  await s.service.import(42, 'not-real', guard);
  s.client.latest = fixture(2);
  const plan = await s.service.check(42, 'not-real', clean);
  await fs.writeFile(path.join(s.directory, PENDING_FILE), JSON.stringify({
    schema: 1, beforeHash: plan.expectedHash, after: plan.next,
  }));
  const { state, local } = await s.service.inspect(42);
  assert.equal(state.revision, 1);
  assert.equal(local, plan.previous.baseline);
  await assert.rejects(fs.stat(path.join(s.directory, PENDING_FILE)), { code: 'ENOENT' });
});
