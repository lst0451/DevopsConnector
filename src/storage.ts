import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserError } from './types';
import { validateDirectory, validateId } from './validation';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function importFilePath(root: string, directory: string, id: number): string {
  validateId(String(id));
  return path.join(root, ...validateDirectory(directory), String(id), 'workitem.md');
}

export async function saveNewWorkItem(root: string, directory: string, id: number, markdown: string): Promise<string> {
  validateId(String(id));
  const parts = [...validateDirectory(directory), String(id)];
  // Resolve the workspace once; reject nested symlinks/junctions before each directory creation.
  let current = await fs.realpath(root);
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.mkdir(current); }
    catch (error) { if (!hasCode(error, 'EEXIST')) { throw error; } }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UserError(t('保存路径包含符号链接、目录联接或非目录项，已停止导入。'));
    }
  }
  const target = path.join(current, 'workitem.md');
  const temporary = path.join(current, '.devops-import-' + randomUUID() + '.tmp');
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(markdown, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    // Linking a complete file creates the destination atomically and fails if it already exists.
    // Do not fall back to overwriting or a non-atomic copy.
    await fs.link(temporary, target);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new UserError(t('本地 workitem.md 已存在，未覆盖。更新同步将在下一阶段提供。'));
    }
    if (error instanceof UserError) { throw error; }
    throw new UserError(t('保存失败。请检查目录权限及文件系统是否支持硬链接；已有文件未被覆盖。'));
  } finally {
    if (created) { await fs.unlink(temporary).catch(() => undefined); }
  }
  return target;
}
