import { createHash } from 'node:crypto';
import { Connection, UserError, WorkItem } from './types';
import { isSameOrganizationUrl, normalizeOrganization, validateId, validateProject } from './validation';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
type Fetcher = typeof fetch;

export interface DownloadedImage {
  data: Uint8Array;
  contentType: string;
}

const IMAGE_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/x-ms-bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

function detectMagicImageExtension(data: Uint8Array): string | undefined {
  if (data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return '.png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return '.jpg';
  }
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return '.gif';
  }
  if (data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return '.webp';
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return '.bmp';
  }
  return undefined;
}

function normalizeImageExtension(rawName: string): string | undefined {
  const match = /\.(png|jpe?g|gif|webp|bmp|ico)$/i.exec(rawName);
  if (!match) { return undefined; }
  const lower = '.' + match[1]!.toLowerCase();
  return lower === '.jpeg' ? '.jpg' : lower;
}

export function buildLocalImagePath(imageUrl: string, contentType: string, data: Uint8Array): string {
  const url = new URL(imageUrl);
  const rawFileName = url.searchParams.get('fileName')?.trim() ?? '';
  const rawPathSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let pathSegment = rawPathSegment;
  try { pathSegment = decodeURIComponent(rawPathSegment); } catch {}
  const normalizedType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = detectMagicImageExtension(data) ??
    IMAGE_CONTENT_TYPE_EXTENSIONS[normalizedType] ??
    normalizeImageExtension(rawFileName) ??
    normalizeImageExtension(pathSegment) ??
    '.png';

  const rawStemSource = rawFileName || pathSegment;
  const withoutExt = rawStemSource.replace(/\.(png|jpe?g|gif|webp|bmp|ico)$/i, '');
  const isPathGuid = !rawFileName && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(withoutExt);
  const cleaned = isPathGuid ? 'image' : withoutExt
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .toLowerCase();
  const stem = !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? 'image' : cleaned;
  const shortHash = createHash('sha256').update(imageUrl, 'utf8').digest('hex').slice(0, 8);
  return 'images/' + stem + '-' + shortHash + ext;
}

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
    return this.request(connection, id, token, signal);
  }

  async getWorkItemRevision(connection: Connection, id: number, revision: number, token: string, signal?: AbortSignal): Promise<WorkItem> {
    validateId(String(revision));
    return this.request(connection, id, token, signal, revision);
  }

  async downloadImage(connection: Connection, imageUrl: string, token: string, signal?: AbortSignal): Promise<DownloadedImage> {
    normalizeOrganization(connection.organizationUrl);
    validateProject(connection.project);
    let url: URL;
    try { url = new URL(imageUrl.trim()); }
    catch { throw new UserError('图片地址无效，仅支持 HTTPS 地址。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new UserError('图片地址必须是无凭据和端口的 HTTPS 地址。');
    }
    const sameOrg = isSameOrganizationUrl(url.href, connection.organizationUrl);
    if (sameOrg && !token.trim()) { throw new UserError('请先设置 Personal Access Token。'); }
    const headers: Record<string, string> = {
      Accept: 'image/*, application/octet-stream;q=0.9, */*;q=0.1',
    };
    if (sameOrg) {
      headers.Authorization = 'Basic ' + Buffer.from(':' + token.trim()).toString('base64');
    }
    const { data, contentType } = await this.fetchBinary(url.href, headers, MAX_IMAGE_BYTES, {
      statusMessages: {
        401: '认证失败：下载图片时 PAT 无效或已过期，请重新设置。',
        403: '访问被拒绝：无权下载图片，请确认账号权限及 PAT 的 Work Items (Read) 权限。',
        404: '找不到远端图片，或当前账号无权访问。',
        429: '图片下载请求过于频繁，请稍后重试。',
      },
      defaultStatus: (status) => '图片下载失败，HTTP ' + status + '。',
      validateContentType: (type) => {
        if (type.includes('text/html') || type.includes('application/xhtml')) {
          return '图片下载未返回二进制内容，可能是登录页或代理响应；请检查连接和凭据。';
        }
        return undefined;
      },
      emptyMessage: '下载的图片内容为空。',
      oversizedMessage: '图片大小超过 20 MB，本次导入已停止。',
      abortedMessage: '已取消下载图片。',
      networkMessage: '无法下载远端图片。请检查网络、HTTPS 证书、代理或登录重定向。',
    }, signal);
    if (data.byteLength === 0) {
      throw new UserError('下载的图片内容为空。');
    }
    return { data, contentType };
  }

  private async request(connection: Connection, id: number, token: string, signal?: AbortSignal, revision?: number): Promise<WorkItem> {
    const organization = normalizeOrganization(connection.organizationUrl);
    const project = validateProject(connection.project);
    validateId(String(id));
    if (!token.trim()) { throw new UserError('请先设置 Personal Access Token。'); }
    const url = organization + '/' + encodeURIComponent(project) +
      '/_apis/wit/workitems/' + id + (revision === undefined ? '' : '/revisions/' + revision) + '?api-version=7.1';
    const { data: rawBytes } = await this.fetchBinary(url, {
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(':' + token.trim()).toString('base64'),
    }, MAX_RESPONSE_BYTES, {
      statusMessages: {
        401: '认证失败：PAT 无效或已过期，请重新设置。',
        403: '访问被拒绝：请确认账号权限及 PAT 的 Work Items (Read) 权限。',
        404: '找不到 Work Item，或当前账号无权访问；请检查组织、项目和 ID。',
        429: 'Azure DevOps 请求过于频繁，请稍后重试。',
      },
      defaultStatus: (status) => 'Azure DevOps 请求失败，HTTP ' + status + '。',
      validateContentType: (_type, rawHeader) => !rawHeader?.includes('application/json') ?
        '服务未返回 JSON，可能是登录页或代理响应；请检查连接和凭据。' : undefined,
      emptyMessage: '服务返回了空响应。',
      oversizedMessage: 'Work Item 响应超过 5 MB，本次导入已停止。',
      abortedMessage: '已取消导入。',
      networkMessage: '无法连接 Azure DevOps。请检查网络、HTTPS 证书、代理或登录重定向。',
    }, signal);
    let data: unknown;
    try { data = JSON.parse(Buffer.from(rawBytes).toString('utf8')); }
    catch { throw new UserError('服务返回的 JSON 无法解析。'); }
    const item = validateWorkItem(data, id, project);
    if (revision !== undefined && item.rev !== revision) { throw new UserError('返回的历史修订号不一致，已停止操作。'); }
    return item;
  }

  private async fetchBinary(
    url: string,
    headers: Record<string, string>,
    maxBytes: number,
    messages: {
      statusMessages: Record<number, string>;
      defaultStatus: (status: number) => string;
      validateContentType: (normalizedType: string, rawHeader: string | null) => string | undefined;
      emptyMessage: string;
      oversizedMessage: string;
      abortedMessage: string;
      networkMessage: string;
    },
    signal?: AbortSignal,
  ): Promise<DownloadedImage> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { controller.abort(); }
    const timeout = setTimeout(abort, 20_000);
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
        // Never send the PAT through an authentication or cross-origin redirect.
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UserError(messages.statusMessages[response.status] ?? messages.defaultStatus(response.status));
      }
      const rawContentType = response.headers.get('content-type');
      const contentType = (rawContentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const typeError = messages.validateContentType(contentType, rawContentType);
      if (typeError) {
        await response.body?.cancel();
        throw new UserError(typeError);
      }
      const reader = response.body?.getReader();
      if (!reader) { throw new UserError(messages.emptyMessage); }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { break; }
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new UserError(messages.oversizedMessage);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return { data: new Uint8Array(Buffer.concat(chunks)), contentType };
    } catch (error) {
      if (signal?.aborted) { throw new UserError(messages.abortedMessage); }
      if (error instanceof UserError) { throw error; }
      if (controller.signal.aborted) { throw new UserError('请求超时（20 秒），请稍后重试。'); }
      // Raw network errors can contain URLs or credentials; do not show or log them.
      throw new UserError(messages.networkMessage);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
