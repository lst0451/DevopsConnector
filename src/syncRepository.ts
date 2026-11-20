import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserError } from './types';
import { validateDirectory, validateId } from './validation';
import { digest, LOCK_FILE, parsePending, parseState, PENDING_FILE, PendingWrite, sameSource, STATE_FILE, SyncState } from './syncModel';

const MAX_FILE_SIZE = 32 * 1024 * 1024;
function code(error: unknown, expected: string): boolean {
  return error instanceof Error && 'code' in error && error.code === expected;
}
async function safeRead(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_SIZE) {
      throw new UserError(t('同步文件不是普通文件、包含链接或超过大小限制，已停止操作。'));
    }
    return await fs.readFile(file, 'utf8');
  } catch (error) { if (code(error, 'ENOENT')) { return undefined; } throw error; }
}
function json(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new UserError(t('同步状态或恢复记录不是有效 JSON，已停止操作。')); }
}
function validateImageRelativePath(relativePath: string): [string, string] {
  const parts = relativePath.split('/');
  const fileName = parts[1];
  if (parts.length !== 2 || parts[0] !== 'images' || !fileName ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.(png|jpg|jpeg|gif|webp|bmp|ico)$/.test(fileName) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(fileName)) {
    throw new UserError(t('本地图片路径无效，已停止操作。'));
  }
  return ['images', fileName];
}
async function safeDirectory(root: string, parts: string[], create: boolean): Promise<string | undefined> {
  let directory = await fs.realpath(root);
  for (const part of parts) {
    directory = path.join(directory, part);
    if (create) {
      try { await fs.mkdir(directory); }
      catch (error) { if (!code(error, 'EEXIST')) { throw error; } }
    }
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) { if (code(error, 'ENOENT')) { return undefined; } throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new UserError(t('同步目录包含符号链接、目录联接或非目录项，已停止操作。'));
    }
  }
  return directory;
}
async function atomicWrite(file: string, content: string, exclusive = false, beforePublish?: () => Promise<void>): Promise<void> {
  await safeRead(file); // Reject symlinks even for replacement.
  const temporary = path.join(path.dirname(file), '.devops-write-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await beforePublish?.();
    if (exclusive) { await fs.link(temporary, file); }
    else { await fs.rename(temporary, file); }
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

export class LockedItem {
  constructor(readonly directory: string, readonly id: number,
    private readonly afterDocumentWrite?: () => Promise<void>) {}
  get file(): string { return path.join(this.directory, 'workitem.md'); }
  readDocument(): Promise<string | undefined> { return safeRead(this.file); }
  async state(): Promise<SyncState | undefined> {
    const value = await safeRead(path.join(this.directory, STATE_FILE));
    return value === undefined ? undefined : parseState(json(value), this.id);
  }
  async writeState(state: SyncState, exclusive = false): Promise<void> {
    parseState(state, this.id);
    await atomicWrite(path.join(this.directory, STATE_FILE), JSON.stringify(state, null, 2) + '\n', exclusive);
  }
  async recover(): Promise<void> {
    const file = path.join(this.directory, PENDING_FILE);
    const text = await safeRead(file);
    if (text === undefined) { return; }
    const pending = parsePending(json(text), this.id);
    const state = await this.state();
    if ((state && !sameSource(state.connection, pending.after.connection)) ||
        (state?.hash ?? null) !== pending.beforeHash && state?.hash !== pending.after.hash) {
      throw new UserError(t('恢复记录与当前跟踪基线不一致，已保留全部文件。'));
    }
    const document = await this.readDocument();
    const hash = document === undefined ? null : digest(document);
    if (hash === pending.after.hash) {
      await this.writeState(pending.after);
    } else if (hash !== (pending.restoreMissing ? null : pending.beforeHash) || (state?.hash ?? null) !== pending.beforeHash) {
      throw new UserError(t('上次同步中断后文件又被修改；请保留 pending 和状态文件，先人工核对。'));
    }
    // No document is ever changed during recovery.
    await fs.unlink(file);
  }
  async hasFiles(relativePaths: Iterable<string>): Promise<boolean> {
    const paths = [...relativePaths];
    if (paths.length === 0) { return true; }
    const imagesDir = path.join(this.directory, 'images');
    let dirStat;
    try { dirStat = await fs.lstat(imagesDir); }
    catch (error) { if (code(error, 'ENOENT')) { return false; } throw error; }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new UserError(t('图片目录包含符号链接、目录联接或非目录项，已停止操作。'));
    }
    for (const relativePath of paths) {
      const [, fileName] = validateImageRelativePath(relativePath);
      const target = path.join(imagesDir, fileName);
      let stat;
      try { stat = await fs.lstat(target); }
      catch (error) { if (code(error, 'ENOENT')) { return false; } throw error; }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new UserError(t('图片文件不是普通文件或包含符号链接，已停止操作。'));
      }
    }
    return true;
  }
  private async writeImages(images?: ReadonlyMap<string, Uint8Array>): Promise<void> {
    if (!images || images.size === 0) { return; }
    const imagesDir = path.join(this.directory, 'images');
    try { await fs.mkdir(imagesDir); }
    catch (error) { if (!code(error, 'EEXIST')) { throw error; } }
    const dirStat = await fs.lstat(imagesDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new UserError(t('图片目录包含符号链接、目录联接或非目录项，已停止操作。'));
    }
    for (const [relativePath, data] of images) {
      const [, fileName] = validateImageRelativePath(relativePath);
      const target = path.join(imagesDir, fileName);
      try {
        const existingStat = await fs.lstat(target);
        if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
          throw new UserError(t('图片文件不是普通文件或包含符号链接，已停止操作。'));
        }
      } catch (error) {
        if (!code(error, 'ENOENT')) { throw error; }
      }
      const temporary = path.join(imagesDir, '.devops-img-' + randomUUID() + '.tmp');
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(data); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, target);
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    }
  }
  async commit(next: SyncState, expectedHash: string | null, guard: () => void, images?: ReadonlyMap<string, Uint8Array>, restoreMissing = false): Promise<void> {
    const expectedDocumentHash = restoreMissing ? null : expectedHash;
    const document = await this.readDocument();
    if ((document === undefined ? null : digest(document)) !== expectedDocumentHash) {
      throw new UserError(t('本地文件已变化，已停止覆盖。请重新检查差异。'));
    }
    const pending: PendingWrite = { schema: 1, beforeHash: expectedHash, restoreMissing: restoreMissing || undefined, after: next };
    const journal = path.join(this.directory, PENDING_FILE);
    await atomicWrite(journal, JSON.stringify(pending, null, 2) + '\n', true);
    const again = await this.readDocument();
    if ((again === undefined ? null : digest(again)) !== expectedDocumentHash) {
      await fs.unlink(journal);
      throw new UserError(t('保存前检测到本地变化，未覆盖。'));
    }
    try { guard(); }
    catch (error) { await fs.unlink(journal); throw error; }
    let rejectedBeforePublish = false;
    try {
      await atomicWrite(this.file, next.baseline, expectedDocumentHash === null, async () => {
        try {
          const latest = await this.readDocument();
          if ((latest === undefined ? null : digest(latest)) !== expectedDocumentHash) {
            throw new UserError(t('文件准备期间出现本地修改，未覆盖。'));
          }
          guard();
          await this.writeImages(images);
        } catch (error) { rejectedBeforePublish = true; throw error; }
      });
    } catch (error) {
      if (rejectedBeforePublish || (expectedDocumentHash === null && code(error, 'EEXIST'))) { await fs.unlink(journal); }
      throw error;
    }
    await this.afterDocumentWrite?.();
    await this.writeState(next, expectedHash === null);
    await fs.unlink(journal);
  }
  async untrack(): Promise<void> {
    await fs.unlink(path.join(this.directory, STATE_FILE));
  }
}

export class SyncRepository {
  constructor(readonly root: string, readonly saveDirectory: string,
    private readonly afterDocumentWrite?: () => Promise<void>) { validateDirectory(saveDirectory); }
  async withItem<T>(id: number, create: boolean, action: (item: LockedItem) => Promise<T>): Promise<T> {
    validateId(String(id));
    const directory = await safeDirectory(this.root, [...validateDirectory(this.saveDirectory), String(id)], create);
    if (!directory) { throw new UserError(t('本地 Work Item 目录不存在，请先导入或检查保存目录配置。')); }
    const lock = path.join(directory, LOCK_FILE);
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (code(error, 'EEXIST')) {
        throw new UserError(t('此任务已有同步锁，可能正在其他窗口操作。若上次异常退出，请关闭相关窗口后按手动验收文档恢复；不要直接删除 pending。'));
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      const item = new LockedItem(directory, id, this.afterDocumentWrite);
      await item.recover();
      return await action(item);
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(lock);
    }
  }
  async listIds(): Promise<number[]> {
    const directory = await safeDirectory(this.root, validateDirectory(this.saveDirectory), false);
    if (!directory) { return []; }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const ids: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name) || Number(entry.name) > 2147483647) { continue; }
      const itemDirectory = await safeDirectory(this.root, [...validateDirectory(this.saveDirectory), entry.name], false);
      if (itemDirectory && (await safeRead(path.join(itemDirectory, STATE_FILE)) !== undefined ||
          await safeRead(path.join(itemDirectory, PENDING_FILE)) !== undefined)) {
        ids.push(Number(entry.name));
      }
    }
    return ids.sort((a, b) => a - b);
  }
}
