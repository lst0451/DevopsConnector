import { Connection, UserError, WorkItem } from './types';
import { normalizeOrganization, validateId, validateProject } from './validation';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
type Fetcher = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateWorkItem(value: unknown, id: number, project: string): WorkItem {
  if (!isRecord(value) || value.id !== id || !Number.isInteger(value.rev) ||
      (value.rev as number) < 1 || !isRecord(value.fields)) {
    throw new UserError('Azure DevOps 返回的 Work Item 数据格式无效。');
  }
  if (typeof value.fields['System.TeamProject'] !== 'string' ||
      value.fields['System.TeamProject'].toLowerCase() !== project.toLowerCase()) {
    throw new UserError('返回的 Work Item 不属于配置的项目，未保存文件。');
  }
  return { id, rev: value.rev as number, fields: value.fields };
}

export class AzureDevOpsClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async getWorkItem(connection: Connection, id: number, token: string, signal?: AbortSignal): Promise<WorkItem> {
    const organization = normalizeOrganization(connection.organizationUrl);
    const project = validateProject(connection.project);
    validateId(String(id));
    if (!token.trim()) { throw new UserError('请先设置 Personal Access Token。'); }
    const url = organization + '/' + encodeURIComponent(project) +
      '/_apis/wit/workitems/' + id + '?api-version=7.1';
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { controller.abort(); }
    const timeout = setTimeout(abort, 20_000);
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Basic ' + Buffer.from(':' + token.trim()).toString('base64'),
        },
        // Never send the PAT through an authentication or cross-origin redirect.
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const messages: Record<number, string> = {
          401: '认证失败：PAT 无效或已过期，请重新设置。',
          403: '访问被拒绝：请确认账号权限及 PAT 的 Work Items (Read) 权限。',
          404: '找不到 Work Item，或当前账号无权访问；请检查组织、项目和 ID。',
          429: 'Azure DevOps 请求过于频繁，请稍后重试。',
        };
        throw new UserError(messages[response.status] ?? 'Azure DevOps 请求失败，HTTP ' + response.status + '。');
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new UserError('服务未返回 JSON，可能是登录页或代理响应；请检查连接和凭据。');
      }
      const reader = response.body?.getReader();
      if (!reader) { throw new UserError('服务返回了空响应。'); }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { break; }
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new UserError('Work Item 响应超过 5 MB，本次导入已停止。');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new UserError('服务返回的 JSON 无法解析。'); }
      return validateWorkItem(data, id, project);
    } catch (error) {
      if (signal?.aborted) { throw new UserError('已取消导入。'); }
      if (error instanceof UserError) { throw error; }
      if (controller.signal.aborted) { throw new UserError('请求超时（20 秒），请稍后重试。'); }
      // Raw network errors can contain URLs or credentials; do not show or log them.
      throw new UserError('无法连接 Azure DevOps。请检查网络、HTTPS 证书、代理或登录重定向。');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
