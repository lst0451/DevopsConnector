import { t } from './i18n';
import { createHash } from 'node:crypto';
import { Connection, UserError, WorkItem, WorkItemComment } from './types';
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

function extractIdentity(value: unknown, identities?: Map<string, string>): string {
  if (typeof value === 'string') { return value; }
  if (isRecord(value)) {
    const name = typeof value.displayName === 'string' ? value.displayName.trim() : '';
    const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
    if (id && name && identities) {
      identities.set(id, name);
    }
    return name;
  }
  return '';
}

export function collectWorkItemIdentities(fields: Record<string, unknown>, identities = new Map<string, string>()): Map<string, string> {
  for (const value of Object.values(fields)) {
    extractIdentity(value, identities);
  }
  return identities;
}

export function resolveCommentMentions(text: string, identities: ReadonlyMap<string, string>): string {
  const withHtmlMentions = text.replace(
    /<a\b[^>]*data-vss-mention="[^"]*?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, guid: string, inner: string) => {
      const cleaned = inner.replace(/<[^>]*>/g, '').trim();
      if (cleaned) { return cleaned.startsWith('@') ? cleaned : '@' + cleaned; }
      const name = identities.get(guid.toLowerCase());
      return name ? '@' + name : '`@<' + guid + '>`';
    },
  );
  return withHtmlMentions.replace(
    /@<([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g,
    (_match, guid: string) => {
      const name = identities.get(guid.toLowerCase());
      return name ? '@' + name : '`@<' + guid + '>`';
    },
  );
}

export function validateWorkItem(value: unknown, id: number, project: string): WorkItem {
  if (!isRecord(value) || value.id !== id || !Number.isInteger(value.rev) ||
      (value.rev as number) < 1 || !isRecord(value.fields)) {
    throw new UserError(t('Azure DevOps 返回的 Work Item 数据格式无效。'));
  }
  if (typeof value.fields['System.TeamProject'] !== 'string' ||
      (project !== '' && value.fields['System.TeamProject'].toLowerCase() !== project.toLowerCase())) {
    throw new UserError(t('返回的 Work Item 不属于配置的项目，未保存文件。'));
  }
  validateProject(value.fields['System.TeamProject']);
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

  async getWorkItemComments(
    connection: Connection,
    id: number,
    token: string,
    signal?: AbortSignal,
    fieldIdentities?: ReadonlyMap<string, string>,
  ): Promise<WorkItemComment[]> {
    const organization = normalizeOrganization(connection.organizationUrl);
    const project = validateProject(connection.project);
    validateId(String(id));
    if (!token.trim()) { throw new UserError(t('请先设置 Personal Access Token。')); }
    const identities = new Map<string, string>(fieldIdentities);
    const rawComments: WorkItemComment[] = [];
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = organization + '/' + encodeURIComponent(project) +
        '/_apis/wit/workItems/' + id + '/comments?$top=200&order=asc' +
        (continuationToken ? '&continuationToken=' + encodeURIComponent(continuationToken) : '') +
        '&api-version=7.1-preview.4';
      const data = await this.fetchJson(url, token, signal);
      if (!isRecord(data) || !Array.isArray(data.comments)) {
        throw new UserError(t('Azure DevOps 返回的评论数据格式无效。'));
      }
      for (const entry of data.comments) {
        if (!isRecord(entry) || entry.isDeleted === true) { continue; }
        const commentId = typeof entry.id === 'number' && Number.isInteger(entry.id) ? entry.id :
          typeof entry.commentId === 'number' && Number.isInteger(entry.commentId) ? entry.commentId :
          rawComments.length + 1;
        const createdBy = extractIdentity(entry.createdBy, identities) || 'Unknown';
        extractIdentity(entry.modifiedBy, identities);
        const rawText = typeof entry.text === 'string' ? entry.text :
          typeof entry.renderedText === 'string' ? entry.renderedText : '';
        rawComments.push({
          id: commentId,
          version: typeof entry.version === 'number' ? entry.version : undefined,
          text: rawText,
          createdBy,
          createdDate: typeof entry.createdDate === 'string' ? entry.createdDate : '',
          modifiedDate: typeof entry.modifiedDate === 'string' ? entry.modifiedDate : undefined,
          format: typeof entry.format === 'string' ? entry.format : undefined,
        });
      }
      const nextToken = typeof data.continuationToken === 'string' && data.continuationToken.trim() ?
        data.continuationToken.trim() : undefined;
      if (!nextToken || seenTokens.has(nextToken)) { break; }
      seenTokens.add(nextToken);
      continuationToken = nextToken;
    }
    return rawComments.map((comment) => ({
      ...comment,
      text: resolveCommentMentions(comment.text, identities),
    }));
  }

  async downloadImage(connection: Connection, imageUrl: string, token: string, signal?: AbortSignal): Promise<DownloadedImage> {
    normalizeOrganization(connection.organizationUrl);
    validateProject(connection.project);
    let url: URL;
    try { url = new URL(imageUrl.trim()); }
    catch { throw new UserError(t('图片地址无效，仅支持 HTTPS 地址。')); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new UserError(t('图片地址必须是无凭据和端口的 HTTPS 地址。'));
    }
    const sameOrg = isSameOrganizationUrl(url.href, connection.organizationUrl);
    if (sameOrg && !token.trim()) { throw new UserError(t('请先设置 Personal Access Token。')); }
    const headers: Record<string, string> = {
      Accept: 'image/*, application/octet-stream;q=0.9, */*;q=0.1',
    };
    if (sameOrg) {
      headers.Authorization = 'Basic ' + Buffer.from(':' + token.trim()).toString('base64');
    }
    const { data, contentType } = await this.fetchBinary(url.href, headers, MAX_IMAGE_BYTES, {
      statusMessages: {
        401: t('认证失败：下载图片时 PAT 无效或已过期，请重新设置。'),
        403: t('访问被拒绝：无权下载图片，请确认账号权限及 PAT 的 Work Items (Read) 权限。'),
        404: t('找不到远端图片，或当前账号无权访问。'),
        429: t('图片下载请求过于频繁，请稍后重试。'),
      },
      defaultStatus: (status) => t('图片下载失败，HTTP ') + status + t('。'),
      validateContentType: (type) => {
        if (type.includes('text/html') || type.includes('application/xhtml')) {
          return t('图片下载未返回二进制内容，可能是登录页或代理响应；请检查连接和凭据。');
        }
        return undefined;
      },
      emptyMessage: t('下载的图片内容为空。'),
      oversizedMessage: t('图片大小超过 20 MB，本次导入已停止。'),
      abortedMessage: t('已取消下载图片。'),
      networkMessage: t('无法下载远端图片。请检查网络、HTTPS 证书、代理或登录重定向。'),
    }, signal);
    if (data.byteLength === 0) {
      throw new UserError(t('下载的图片内容为空。'));
    }
    return { data, contentType };
  }

  private async fetchJson(url: string, token: string, signal?: AbortSignal): Promise<unknown> {
    const { data: rawBytes } = await this.fetchBinary(url, {
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(':' + token.trim()).toString('base64'),
    }, MAX_RESPONSE_BYTES, {
      statusMessages: {
        401: t('认证失败：PAT 无效或已过期，请重新设置。'),
        403: t('访问被拒绝：请确认账号权限及 PAT 的 Work Items (Read) 权限。'),
        404: t('找不到 Work Item，或当前账号无权访问；请检查组织、项目和 ID。'),
        429: t('Azure DevOps 请求过于频繁，请稍后重试。'),
      },
      defaultStatus: (status) => t('Azure DevOps 请求失败，HTTP ') + status + t('。'),
      validateContentType: (_type, rawHeader) => !rawHeader?.includes('application/json') ?
        t('服务未返回 JSON，可能是登录页或代理响应；请检查连接和凭据。') : undefined,
      emptyMessage: t('服务返回了空响应。'),
      oversizedMessage: t('Work Item 响应超过 5 MB，本次导入已停止。'),
      abortedMessage: t('已取消导入。'),
      networkMessage: t('无法连接 Azure DevOps。请检查网络、HTTPS 证书、代理或登录重定向。'),
    }, signal);
    try { return JSON.parse(Buffer.from(rawBytes).toString('utf8')); }
    catch { throw new UserError(t('服务返回的 JSON 无法解析。')); }
  }

  private async request(connection: Connection, id: number, token: string, signal?: AbortSignal, revision?: number): Promise<WorkItem> {
    const organization = normalizeOrganization(connection.organizationUrl);
    const project = connection.project ? validateProject(connection.project) : '';
    validateId(String(id));
    if (!token.trim()) { throw new UserError(t('请先设置 Personal Access Token。')); }
    const url = organization + (project ? '/' + encodeURIComponent(project) : '') +
      '/_apis/wit/workitems/' + id + (revision === undefined ? '' : '/revisions/' + revision) + '?api-version=7.1';
    const data = await this.fetchJson(url, token, signal);
    const item = validateWorkItem(data, id, project);
    if (revision !== undefined && item.rev !== revision) { throw new UserError(t('返回的历史修订号不一致，已停止操作。')); }
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
      if (controller.signal.aborted) { throw new UserError(t('请求超时（20 秒），请稍后重试。')); }
      // Raw network errors can contain URLs or credentials; do not show or log them.
      throw new UserError(messages.networkMessage);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
