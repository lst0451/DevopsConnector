import { Connection, UserError } from './types';

export function normalizeOrganization(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new UserError('请输入完整组织地址，例如 https://vffice.visualstudio.com/。'); }
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
    throw new UserError('组织根地址应为 https://组织.visualstudio.com/ 或 https://dev.azure.com/组织。');
  }
  return url.hostname === 'dev.azure.com' ?
    'https://dev.azure.com/' + organization.toLowerCase() : url.origin;
}

/** Keep the chosen endpoint, but use one identity for both Azure cloud URL forms. */
export function organizationIdentity(value: string): string {
  const organization = normalizeOrganization(value);
  const url = new URL(organization);
  return url.hostname === 'dev.azure.com' ? organization :
    'https://dev.azure.com/' + url.hostname.slice(0, -'.visualstudio.com'.length);
}

export function parseOrganizationInput(value: string): { organizationUrl: string; project?: string } {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new UserError('请输入组织或项目地址，例如 https://vffice.visualstudio.com/。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new UserError('地址必须使用 HTTPS，且不能包含凭据、端口、查询参数或片段。');
  }
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
  const organizationUrl = normalizeOrganization(url.hostname === 'dev.azure.com' ?
    url.origin + '/' + (parts.shift() ?? '') : url.origin);
  if (parts.length > 1 || parts.some((part) => !part)) {
    throw new UserError('请输入组织根地址或项目首页地址，不要包含 Boards、Repos 等页面路径。');
  }
  if (parts.length === 0) { return { organizationUrl }; }
  let project: string;
  try { project = decodeURIComponent(parts[0]!); }
  catch { throw new UserError('项目地址包含无效编码。'); }
  return { organizationUrl, project: validateProject(project) };
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
  if (organizationIdentity(organization) !== organizationIdentity(connection.organizationUrl) ||
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

export const ENV_PAT_NAME = 'AZURE_DEVOPS_PAT';

export function envToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[ENV_PAT_NAME]?.trim();
  return value ? value : undefined;
}

export function resolveToken(storedToken: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const value = storedToken?.trim() || envToken(env);
  if (!value) {
    throw new UserError('请先运行 DevOps Connector: Set Personal Access Token，或设置环境变量 AZURE_DEVOPS_PAT。');
  }
  return value;
}

export function isSameOrganizationUrl(rawUrl: string, organizationUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl.trim()); }
  catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return false;
  }
  try {
    const candidateOrg = url.hostname === 'dev.azure.com' ?
      url.origin + '/' + (url.pathname.split('/').filter(Boolean)[0] ?? '') :
      url.origin;
    return organizationIdentity(candidateOrg) === organizationIdentity(organizationUrl);
  } catch {
    return false;
  }
}
