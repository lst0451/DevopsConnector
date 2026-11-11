import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { saveNewWorkItem } from '../src/storage';

async function sandbox(t: TestContext): Promise<string> {
  const parent = path.resolve('work');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'storage-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('storage-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('creates UTF-8 file in configured item directory without temp leftovers', async (t) => {
  const root = await sandbox(t);
  const file = await saveNewWorkItem(root, 'docs/workitems', 42, '# 中文需求\n');
  assert.equal(await fs.readFile(file, 'utf8'), '# 中文需求\n');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['workitem.md']);
});

test('repeat import preserves work item and developer notes', async (t) => {
  const root = await sandbox(t);
  const file = await saveNewWorkItem(root, 'docs/workitems', 42, 'original');
  const notes = path.join(path.dirname(file), 'notes.md');
  await fs.writeFile(notes, 'developer notes');
  await assert.rejects(saveNewWorkItem(root, 'docs/workitems', 42, 'replacement'), /已存在/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.equal(await fs.readFile(notes, 'utf8'), 'developer notes');
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['notes.md', 'workitem.md']);
});

test('rejects traversal before creating files', async (t) => {
  const root = await sandbox(t);
  await assert.rejects(saveNewWorkItem(root, '../outside', 42, 'no'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('rejects directory junction/symlink without writing through it', async (t) => {
  const root = await sandbox(t);
  const outside = path.join(root, 'outside');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(outside);
  await fs.mkdir(workspace);
  await fs.symlink(outside, path.join(workspace, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveNewWorkItem(workspace, 'docs/workitems', 42, 'no'), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('concurrent imports never overwrite the winner', async (t) => {
  const root = await sandbox(t);
  const results = await Promise.allSettled([
    saveNewWorkItem(root, 'docs/workitems', 42, 'A'),
    saveNewWorkItem(root, 'docs/workitems', 42, 'B'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const file = path.join(root, 'docs', 'workitems', '42', 'workitem.md');
  assert.ok(['A', 'B'].includes(await fs.readFile(file, 'utf8')));
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['workitem.md']);
});
