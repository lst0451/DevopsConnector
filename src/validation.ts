import { Connection, UserError } from './types';

export function normalizeOrganization(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new UserError('请输入完整组织地址，例如 https://dev.azure.com/my-org。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new UserError('组织地址必须使用 HTTPS，且不能包含凭据、端口、查询参数或片段。');
  }
  let organization: string | undefined;
  if (url.hostname === 'dev.azure.com') {
    organization = /^\/([a-z0-9-]+)\/?$/i.exec(url.pathname)?.[1];
  } else {
    organization = /^([a-z0-9-]+)\.visualstudio\.com$/i.exec(url.hostname)?.[1];
    if (url.pathname !== '/' && url.pathname !== '') { organization = undefined; }
  }
  if (!organization || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(organization)) {
    throw new UserError('目前仅支持 Azure DevOps Services 组织地址，不支持自建 Server。');
  }
  return 'https://dev.azure.com/' + organization.toLowerCase();
}

export function validateProject(value: string): string {
  const project = value.trim();
  if (!project || /[\\/\u0000-\u001f]/.test(project) || project === '.' || project === '..') {
    throw new UserError('请输入有效的 Azure DevOps 项目名称。');
  }
  return project;
}

export function validateDirectory(value: string): string[] {
  const normalized = value.trim().replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (!normalized || parts.some((part) =>
    !part || part === '.' || part === '..' ||
    /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) ||
    /^(?:\.git|node_modules)$/i.test(part))) {
    throw new UserError('保存目录必须是项目内相对路径，不能包含 ..、绝对路径或保留目录/名称。');
  }
  return parts;
}

export function validateId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
    throw new UserError('Work Item ID 必须是有效的正整数。');
  }
  return Number(value);
}

export function parseWorkItemInput(value: string, connection: Connection): number {
  const text = value.trim();
  if (/^\d+$/.test(text)) { return validateId(text); }
  let url: URL;
  try { url = new URL(text); }
  catch { throw new UserError('请输入 Work Item ID 或完整 Azure DevOps Work Item 链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new UserError('Work Item 链接必须是无凭据的 HTTPS 地址。');
  }
  let parts: string[];
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new UserError('Work Item 链接包含无效编码。'); }
  let organization: string;
  if (url.hostname === 'dev.azure.com') {
    organization = normalizeOrganization(url.origin + '/' + (parts.shift() ?? ''));
  } else {
    organization = normalizeOrganization(url.origin);
  }
  const [project, area, action, id] = parts;
  if (organization !== connection.organizationUrl ||
    project?.toLowerCase() !== connection.project.toLowerCase()) {
    throw new UserError('链接与当前项目配置的组织或项目不一致，请先切换连接配置。');
  }
  if (parts.length !== 4 || area !== '_workitems' || action !== 'edit' || !id) {
    throw new UserError('不支持此链接格式，请使用 /项目/_workitems/edit/ID 或直接输入 ID。');
  }
  return validateId(id);
}

export function workItemUrl(connection: Connection, id: number): string {
  return connection.organizationUrl + '/' + encodeURIComponent(connection.project) + '/_workitems/edit/' + id;
}
