import { createHash } from 'node:crypto';
import { Connection, UserError } from './types';
import { RendererVersion } from './markdown';
import { normalizeOrganization, organizationIdentity, parseOrganizationInput, parseWorkItemInput, validateId, validateProject } from './validation';

export const STATE_FILE = '.devops-sync.json';
export const PENDING_FILE = '.devops-sync.pending.json';
export const LOCK_FILE = '.devops-sync.lock';
export type SyncStatus = 'synced' | 'unchanged' | 'updateAvailable' | 'conflict' | 'error';
export interface SyncState {
  schema: 1;
  id: number;
  connection: Connection;
  title: string;
  revision: number;
  rendererVersion: RendererVersion;
  baseline: string;
  hash: string;
  exportedAt: string;
  checkedAt?: string;
  attemptedAt?: string;
  status: SyncStatus;
  error?: string;
}
export interface PendingWrite { schema: 1; beforeHash: string | null; after: SyncState }
export interface SyncPlan {
  id: number;
  expectedHash: string;
  previous: SyncState;
  next: SyncState;
  local: string | undefined;
  changed: boolean;
  revisionChanged: boolean;
  templateChanged: boolean;
  conflict: boolean;
}
export function describeChanges(plan: SyncPlan): string {
  const changes: string[] = [];
  if (plan.revisionChanged) { changes.push('远端修订 ' + plan.previous.revision + ' → ' + plan.next.revision); }
  if (plan.templateChanged) {
    changes.push('导出模板 ' + plan.previous.rendererVersion + ' → ' + plan.next.rendererVersion + '（补全文档内容）');
  }
  return changes.join('；');
}
export function digest(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function sameSource(a: Connection, b: Connection): boolean {
  return organizationIdentity(a.organizationUrl) === organizationIdentity(b.organizationUrl) &&
    a.project.toLowerCase() === b.project.toLowerCase();
}
export function assertSource(state: SyncState, connection: Connection): void {
  if (!sameSource(state.connection, connection)) {
    throw new UserError('跟踪项的组织或项目与当前配置不同；请切回原配置。没有移动或覆盖文件。');
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
export function parseState(value: unknown, id: number): SyncState {
  if (!isObject(value) || value.schema !== 1 || value.id !== id || !isObject(value.connection) ||
    typeof value.connection.organizationUrl !== 'string' || typeof value.connection.project !== 'string' ||
    typeof value.title !== 'string' || !Number.isInteger(value.revision) || (value.revision as number) < 1 ||
    ![1, 2, 3].includes(value.rendererVersion as number) || typeof value.baseline !== 'string' ||
    value.hash !== digest(value.baseline) || !isTime(value.exportedAt) ||
    (value.checkedAt !== undefined && !isTime(value.checkedAt)) ||
    (value.attemptedAt !== undefined && !isTime(value.attemptedAt)) ||
    !['synced', 'unchanged', 'updateAvailable', 'conflict', 'error'].includes(value.status as string) ||
    (value.error !== undefined && typeof value.error !== 'string')) {
    throw new UserError('同步状态文件无效或已损坏。已保留需求文件，请勿直接删除恢复记录。');
  }
  normalizeOrganization(value.connection.organizationUrl);
  validateProject(value.connection.project);
  validateId(String(value.revision));
  return value as unknown as SyncState;
}
export function parsePending(value: unknown, id: number): PendingWrite {
  if (!isObject(value) || value.schema !== 1 ||
    (value.beforeHash !== null && (typeof value.beforeHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.beforeHash)))) {
    throw new UserError('同步恢复记录无效，已停止写入。');
  }
  return { schema: 1, beforeHash: value.beforeHash as string | null, after: parseState(value.after, id) };
}

export interface ExistingExport { revision: number; importedAt: Date; connection: Connection; rendererVersion: RendererVersion }
export function readExistingExport(markdown: string, id: number, connection: Connection): ExistingExport {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const header = normalized.split('\n## 描述')[0] ?? '';
  const number = /^- ID：([1-9]\d*)$/m.exec(header)?.[1];
  const revision = /^- 修订版本：([1-9]\d*)$/m.exec(header)?.[1];
  const source = /^- 来源：\[Azure DevOps\]\((https:\/\/[^\s]+)\)$/m.exec(header)?.[1];
  const importedAt = /^- 本地导入时间：(.+)$/m.exec(header)?.[1];
  const legacy = header.includes('> Azure DevOps 需求副本。请将本地设计与笔记写入独立文件；此版本仅支持首次导入。');
  const modern = header.includes('> Azure DevOps 需求副本，由 DevOps Connector 管理。请将本地设计与笔记写入独立文件。');
  const declaredTemplate = /^- 导出模板版本：(.*)$/m.exec(header)?.[1];
  if (declaredTemplate !== undefined && (declaredTemplate !== '3' || !modern || legacy)) {
    throw new UserError('导出模板版本无法识别，不能安全接入跟踪。请保留原文件。');
  }
  if (Number(number) !== id || !revision || !source || !importedAt || !isTime(importedAt) || (!legacy && !modern)) {
    throw new UserError('无法识别原始导出文件的来源、修订和导入时间，不能安全建立跟踪基线。');
  }
  parseWorkItemInput(source, connection);
  const parsed = parseOrganizationInput(source.slice(0, source.lastIndexOf('/_workitems/edit/')));
  if (!parsed.project) { throw new UserError('原始导出文件缺少项目。'); }
  return {
    revision: validateId(revision), importedAt: new Date(importedAt),
    connection: { organizationUrl: parsed.organizationUrl, project: parsed.project },
    rendererVersion: declaredTemplate === '3' ? 3 : legacy ? 1 : 2,
  };
}
