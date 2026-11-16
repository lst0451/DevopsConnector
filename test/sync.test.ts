import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DownloadedImage } from '../src/azureDevOpsClient';
import { referencedLocalImages, renderWorkItem } from '../src/markdown';
import { describeChanges, digest, LOCK_FILE, PENDING_FILE, readExistingExport, STATE_FILE } from '../src/syncModel';
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
  assert.equal(state.rendererVersion, 3);
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
  assert.equal((await s.service.inspect(42)).state.rendererVersion, 3);
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

for (const version of [1, 2] as const) {
  test('template ' + version + ' upgrades at unchanged revision 73 exactly once', async (t) => {
    const s = await setup(t);
    const remote = fixture(73);
    remote.fields['Custom.Specifications'] = '<p>完整的需求规格</p>';
    remote.fields['Custom.Design'] = '<p>对应的设计说明</p>';
    s.client.latest = remote;
    s.client.getWorkItemRevision = async () => remote;
    await fs.mkdir(s.directory, { recursive: true });
    const old = renderWorkItem(remote, connection, now(), version);
    await fs.writeFile(s.file, old);
    await fs.writeFile(path.join(s.directory, 'design.md'), 'local design notes');
    await s.service.trackExisting(42, 'not-real', guard);
    const listed = (await s.service.list())[0];
    assert.equal(listed?.status, 'updateAvailable');
    assert.match(listed?.detail ?? '', /导出模板需升级/);
    const plan = await s.service.check(42, 'not-real', clean);
    assert.equal(plan.changed, true);
    assert.equal(plan.revisionChanged, false);
    assert.equal(plan.templateChanged, true);
    assert.equal(plan.next.revision, 73);
    assert.equal(plan.next.rendererVersion, 3);
    assert.match(describeChanges(plan), /导出模板/);
    assert.doesNotMatch(describeChanges(plan), /73 → 73/);
    assert.match(plan.next.baseline, /完整的需求规格/);
    assert.match(plan.next.baseline, /对应的设计说明/);
    assert.equal(await fs.readFile(s.file, 'utf8'), old, 'checking must not rewrite the old file');
    assert.equal((await s.service.inspect(42)).state.rendererVersion, version);
    await s.service.apply(plan, guard);
    assert.equal((await s.service.inspect(42)).state.rendererVersion, 3);
    assert.equal(await fs.readFile(path.join(s.directory, 'design.md'), 'utf8'), 'local design notes');
    const upgraded = await fs.readFile(s.file, 'utf8');
    const stat = await fs.stat(s.file);
    const again = await s.service.check(42, 'not-real', clean);
    assert.equal(again.changed, false);
    assert.equal(again.templateChanged, false);
    await s.service.apply(again, guard);
    assert.equal(await fs.readFile(s.file, 'utf8'), upgraded);
    assert.equal((await fs.stat(s.file)).mtimeMs, stat.mtimeMs);
  });
}

test('template-only upgrade still refuses saved and unsaved local edits', async (t) => {
  const s = await setup(t);
  await fs.mkdir(s.directory, { recursive: true });
  await fs.writeFile(s.file, renderWorkItem(fixture(), connection, now(), 1));
  await s.service.trackExisting(42, 'not-real', guard);
  const dirtyPlan = await s.service.check(42, 'not-real', () => true);
  assert.equal(dirtyPlan.templateChanged, true);
  assert.equal(dirtyPlan.conflict, true);
  await assert.rejects(s.service.apply(dirtyPlan, guard), /本地修改/);
  await fs.appendFile(s.file, '\n保留我的本地笔记');
  const editedPlan = await s.service.check(42, 'not-real', clean);
  assert.equal(editedPlan.conflict, true);
  await assert.rejects(s.service.apply(editedPlan, guard), /本地修改/);
  assert.match(await fs.readFile(s.file, 'utf8'), /保留我的本地笔记/);
  assert.equal((await s.service.inspect(42)).state.rendererVersion, 1);
});

test('a second window cannot apply a stale template-only upgrade', async (t) => {
  const s = await setup(t);
  await fs.mkdir(s.directory, { recursive: true });
  await fs.writeFile(s.file, renderWorkItem(fixture(), connection, now(), 2));
  await s.service.trackExisting(42, 'not-real', guard);
  const first = await s.service.check(42, 'not-real', clean);
  const second = await s.service.check(42, 'not-real', clean);
  await s.service.apply(first, guard);
  await assert.rejects(s.service.apply(second, guard), /其他窗口/);
});

test('remote and template upgrades report both reasons', async (t) => {
  const s = await setup(t);
  await fs.mkdir(s.directory, { recursive: true });
  await fs.writeFile(s.file, renderWorkItem(fixture(), connection, now(), 1));
  await s.service.trackExisting(42, 'not-real', guard);
  s.client.latest = fixture(2);
  const plan = await s.service.check(42, 'not-real', clean);
  assert.equal(plan.revisionChanged, true);
  assert.equal(plan.templateChanged, true);
  assert.match(describeChanges(plan), /远端修订 1 → 2/);
  assert.match(describeChanges(plan), /导出模板 1 → 3/);
});

test('explicit renderer version allows reattachment and rejects unsupported versions', () => {
  const exported = renderWorkItem(fixture(), connection, now());
  assert.equal(readExistingExport(exported, 42, connection).rendererVersion, 3);
  assert.throws(() => readExistingExport(exported.replace('Template Version: 3', 'Template Version: 999'),
    42, connection), /导出模板版本无法识别/);
});

const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20, 30]);
const sampleJpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 40, 50]);

class FakeImageClient extends FakeClient {
  imageCalls = 0;
  readonly responses = new Map<string, DownloadedImage>();
  async downloadImage(_connection: Connection, imageUrl: string): Promise<DownloadedImage> {
    this.imageCalls++;
    const found = this.responses.get(imageUrl);
    if (!found) { throw new UserError('找不到远端图片'); }
    return found;
  }
}

test('import downloads remote images into images/ and writes relative local links', async (t) => {
  const s = await setup(t);
  const imgUrl = 'https://vffice.visualstudio.com/Demo/_apis/wit/attachments/11111111-1111-1111-1111-111111111111?fileName=flow.png';
  const extUrl = 'https://cdn.example.com/diagram.jpg';
  const imageClient = new FakeImageClient();
  imageClient.latest = {
    id: 42,
    rev: 5,
    fields: {
      'System.TeamProject': 'Demo',
      'System.Title': '带图片需求',
      'System.Description': `<p>见下图：</p><p><img src="${imgUrl}" alt="流程图"></p>`,
      'Custom.Design': `<p><img src="${extUrl}" alt="架构"></p>`,
    },
  };
  imageClient.responses.set(imgUrl, { data: samplePng, contentType: 'image/png' });
  imageClient.responses.set(extUrl, { data: sampleJpg, contentType: 'image/jpeg' });

  const service = new SyncService(s.repository, connection, imageClient, now);
  await service.import(42, 'not-real', guard);

  const markdown = await fs.readFile(s.file, 'utf8');
  const refs = referencedLocalImages(markdown);
  assert.equal(refs.length, 2);
  assert.match(refs[0]!, /^images\/flow-[a-f0-9]{8}\.png$/);
  assert.match(refs[1]!, /^images\/diagram-[a-f0-9]{8}\.jpg$/);
  assert.ok(markdown.includes(`![流程图](${refs[0]})`));
  assert.ok(markdown.includes(`![架构](${refs[1]})`));
  assert.ok(markdown.includes('图片已下载到本地。'));
  assert.doesNotMatch(markdown, /远端图片/);

  const savedImages = await fs.readdir(path.join(s.directory, 'images'));
  assert.equal(savedImages.length, 2);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(s.directory, refs[0]!))), samplePng);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(s.directory, refs[1]!))), sampleJpg);

  const recheck = await service.check(42, 'not-real', clean);
  assert.equal(recheck.changed, false);
  assert.equal(recheck.imagesChanged, false);
  assert.equal(imageClient.imageCalls, 2);
});

test('check and apply localize remote image links and restore missing local image files', async (t) => {
  const s = await setup(t);
  const imgUrl = 'https://vffice.visualstudio.com/Demo/_apis/wit/attachments/22222222-2222-2222-2222-222222222222?fileName=spec.png';
  const itemWithImage: WorkItem = {
    id: 42,
    rev: 10,
    fields: {
      'System.TeamProject': 'Demo',
      'System.Title': '旧导出图片升级',
      'System.Description': `<p><img src="${imgUrl}" alt="规格图"></p>`,
    },
  };
  await fs.mkdir(s.directory, { recursive: true });
  await fs.writeFile(s.file, renderWorkItem(itemWithImage, connection, now(), 3));

  const imageClient = new FakeImageClient();
  imageClient.latest = itemWithImage;
  imageClient.getWorkItemRevision = async () => itemWithImage;
  imageClient.responses.set(imgUrl, { data: samplePng, contentType: 'image/png' });

  const service = new SyncService(s.repository, connection, imageClient, now);
  await service.trackExisting(42, 'not-real', guard);

  const upgradePlan = await service.check(42, 'not-real', clean);
  assert.equal(upgradePlan.changed, true);
  assert.equal(upgradePlan.revisionChanged, false);
  assert.equal(upgradePlan.templateChanged, false);
  assert.equal(upgradePlan.imagesChanged, true);
  assert.equal(describeChanges(upgradePlan), '下载远端图片到本地');
  await service.apply(upgradePlan, guard);

  const localized = await fs.readFile(s.file, 'utf8');
  const refs = referencedLocalImages(localized);
  assert.equal(refs.length, 1);
  assert.doesNotMatch(localized, /远端图片/);

  await fs.unlink(path.join(s.directory, refs[0]!));
  const restorePlan = await service.check(42, 'not-real', clean);
  assert.equal(restorePlan.changed, true);
  assert.equal(restorePlan.imagesChanged, true);
  await service.apply(restorePlan, guard);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(s.directory, refs[0]!))), samplePng);
});

test('symlinked images directory is rejected without writing through it', async (t) => {
  const s = await setup(t);
  const imgUrl = 'https://cdn.example.com/test.png';
  const imageClient = new FakeImageClient();
  imageClient.latest = {
    id: 42,
    rev: 1,
    fields: {
      'System.TeamProject': 'Demo',
      'System.Title': '符号链接防护',
      'System.Description': `<p><img src="${imgUrl}" alt="图"></p>`,
    },
  };
  imageClient.responses.set(imgUrl, { data: samplePng, contentType: 'image/png' });
  const service = new SyncService(s.repository, connection, imageClient, now);

  const outside = path.join(s.root, 'outside-images');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(s.directory, { recursive: true });
  await fs.symlink(outside, path.join(s.directory, 'images'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(service.import(42, 'not-real', guard), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('check and apply upgrade legacy Chinese section titles and escaped Design Markdown at unchanged revision', async (t) => {
  const s = await setup(t);
  const itemWithMarkdownDesign: WorkItem = {
    id: 42,
    rev: 81,
    fields: {
      'System.TeamProject': 'Demo',
      'System.Title': '章节标题与设计格式升级',
      'System.State': 'Ready for Functional test',
      'System.Reason': 'Moved out of state Development',
      'System.Description': '<p>描述正文</p>',
      'Custom.Design': '## 1. Summary\n\n- **Item**: `Code[20]` &amp; &quot;Quote&quot;',
    },
  };
  s.client.latest = itemWithMarkdownDesign;
  const legacyBaseline = [
    '# 42 — 章节标题与设计格式升级',
    '> Azure DevOps 需求副本，由 DevOps Connector 管理。请将本地设计与笔记写入独立文件。',
    '- ID：42',
    '- 修订版本：81',
    '- 导出模板版本：3',
    '- 类型：',
    '- 状态：Pending Approval',
    '- 负责人：（未分配）',
    '- 标签：（无）',
    '- 项目：Demo',
    '- 来源：[Azure DevOps](https://vffice.visualstudio.com/Demo/_workitems/edit/42)',
    '- 远端更新时间：',
    '- 本地导入时间：2026-11-11T22:00:00.000Z',
    '',
    '## 描述',
    '描述正文',
    '## 需求规格（Specifications）',
    '（未提供）',
    '## 验收标准',
    '（未提供）',
    '## 设计说明（Design）',
    '\\#\\# 1. Summary \\- \\*\\*Item\\*\\*: \\`Code\\[20\\]\\` & "Quote"',
    '## 复现步骤',
    '（未提供）',
    '> 评论、附件和历史未导入；图片仅保留链接。',
  ].join('\n\n') + '\n';

  await fs.mkdir(s.directory, { recursive: true });
  await fs.writeFile(s.file, legacyBaseline);
  await fs.writeFile(path.join(s.directory, STATE_FILE), JSON.stringify({
    schema: 1,
    id: 42,
    connection,
    title: '章节标题与设计格式升级',
    revision: 81,
    rendererVersion: 3,
    baseline: legacyBaseline,
    hash: digest(legacyBaseline),
    exportedAt: '2026-11-11T22:00:00.000Z',
    status: 'synced',
  }, null, 2) + '\n');

  const plan = await s.service.check(42, 'not-real', clean);
  assert.equal(plan.changed, true);
  assert.equal(plan.revisionChanged, false);
  assert.equal(plan.templateChanged, false);
  assert.equal(describeChanges(plan), '更新文档内容格式');
  await s.service.apply(plan, guard);

  const updated = await fs.readFile(s.file, 'utf8');
  assert.ok(updated.includes('- State: Ready for Functional test'));
  assert.ok(updated.includes('- Reason: Moved out of state Development'));
  assert.ok(updated.includes('## Description\n\n描述正文'));
  assert.ok(updated.includes('## Specifications\n\n（未提供）'));
  assert.ok(updated.includes('## Acceptance Criteria\n\n（未提供）'));
  assert.ok(updated.includes('## Design\n\n## 1. Summary\n\n- **Item**: `Code[20]` & "Quote"'));
  assert.ok(updated.includes('## Repro Steps\n\n（未提供）'));
  assert.equal((await s.service.list())[0]?.workItemState, 'Ready for Functional test');

  const recheck = await s.service.check(42, 'not-real', clean);
  assert.equal(recheck.changed, false);

  s.client.latest = {
    ...itemWithMarkdownDesign,
    rev: 82,
    fields: {
      ...itemWithMarkdownDesign.fields,
      'System.State': 'Closed',
    },
  };
  const nextPlan = await s.service.check(42, 'not-real', clean);
  assert.equal(nextPlan.changed, true);
  await s.service.apply(nextPlan, guard);
  const afterStateChange = await fs.readFile(s.file, 'utf8');
  assert.ok(afterStateChange.includes('- State: Closed'));
  assert.equal((await s.service.list())[0]?.workItemState, 'Closed');
});
