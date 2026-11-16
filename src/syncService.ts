import { AzureDevOpsClient, buildLocalImagePath } from './azureDevOpsClient';
import { CURRENT_RENDERER_VERSION, extractImageUrls, referencedLocalImages, renderWorkItem } from './markdown';
import { SyncRepository } from './syncRepository';
import { assertSource, digest, readExistingExport, SyncPlan, SyncState, SyncStatus } from './syncModel';
import { Connection, UserError, WorkItem } from './types';

type Client = Pick<AzureDevOpsClient, 'getWorkItem' | 'getWorkItemRevision'> &
  Partial<Pick<AzureDevOpsClient, 'downloadImage'>>;
export interface TrackedItem { id: number; title: string; status: SyncStatus; revision?: number; rendererVersion?: number; checkedAt?: string; detail: string }
export class ExistingFileMismatch extends UserError {
  constructor(readonly local: string, readonly expected: string) {
    super('本地文件与对应的历史修订不一致，可能有本地修改。未建立跟踪；请先保留笔记并核对差异。');
  }
}
function title(item: WorkItem): string {
  const value = item.fields['System.Title'];
  return typeof value === 'string' ? value : '';
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) { throw new UserError('已取消操作。'); }
}
function makeState(item: WorkItem, connection: Connection, now: string, imagePaths?: ReadonlyMap<string, string>): SyncState {
  const baseline = renderWorkItem(item, connection, new Date(now), CURRENT_RENDERER_VERSION, imagePaths);
  return {
    schema: 1, id: item.id, connection, title: title(item), revision: item.rev, rendererVersion: CURRENT_RENDERER_VERSION,
    baseline, hash: digest(baseline), exportedAt: now, checkedAt: now, attemptedAt: now, status: 'synced',
  };
}
export class SyncService {
  constructor(readonly repository: SyncRepository, readonly connection: Connection,
    private readonly client: Client, private readonly now: () => Date = () => new Date()) {}

  private async resolveImages(item: WorkItem, token: string, signal?: AbortSignal):
    Promise<{ paths: Map<string, string>; files: Map<string, Uint8Array> }> {
    const paths = new Map<string, string>();
    const files = new Map<string, Uint8Array>();
    const urls = extractImageUrls(item, this.connection, CURRENT_RENDERER_VERSION);
    if (urls.length === 0 || !this.client.downloadImage) {
      return { paths, files };
    }
    for (const url of urls) {
      cancelled(signal);
      const downloaded = await this.client.downloadImage(this.connection, url, token, signal);
      const localPath = buildLocalImagePath(url, downloaded.contentType, downloaded.data);
      paths.set(url, localPath);
      files.set(localPath, downloaded.data);
    }
    return { paths, files };
  }

  async import(id: number, token: string, guard: () => void, signal?: AbortSignal): Promise<void> {
    await this.repository.withItem(id, true, async (local) => {
      if (await local.state() || await local.readDocument() !== undefined) {
        throw new UserError('本地文件或跟踪记录已存在。旧文件请用 Track Existing Work Item；已跟踪项请用 Sync Work Item。');
      }
      guard(); cancelled(signal);
      const item = await this.client.getWorkItem(this.connection, id, token, signal);
      cancelled(signal);
      const images = await this.resolveImages(item, token, signal);
      cancelled(signal);
      await local.commit(makeState(item, this.connection, this.now().toISOString(), images.paths), null, guard, images.files);
    });
  }

  async trackExisting(id: number, token: string, guard: () => void, signal?: AbortSignal): Promise<void> {
    await this.repository.withItem(id, false, async (local) => {
      if (await local.state()) { throw new UserError('该文件已在跟踪列表中，请使用 Sync Work Item。'); }
      const document = await local.readDocument();
      if (document === undefined) { throw new UserError('本地 workitem.md 不存在，请先导入。'); }
      guard(); cancelled(signal);
      const existing = readExistingExport(document, id, this.connection);
      const revision = await this.client.getWorkItemRevision(this.connection, id, existing.revision, token, signal);
      cancelled(signal);
      const expected = renderWorkItem(revision, existing.connection, existing.importedAt, existing.rendererVersion);
      if (document.replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) {
        throw new ExistingFileMismatch(document, expected);
      }
      if (await local.readDocument() !== document) { throw new UserError('校验期间本地文件发生变化，未建立跟踪。'); }
      guard();
      await local.writeState({
        schema: 1, id, connection: existing.connection, title: title(revision), revision: revision.rev,
        rendererVersion: existing.rendererVersion, baseline: document, hash: digest(document),
        exportedAt: existing.importedAt.toISOString(), status: 'synced',
      }, true);
    });
  }

  async inspect(id: number): Promise<{ state: SyncState; local: string | undefined }> {
    return this.repository.withItem(id, false, async (item) => {
      const state = await item.state();
      if (!state) { throw new UserError('该文件尚未跟踪，请先运行 Track Existing Work Item。'); }
      assertSource(state, this.connection);
      return { state, local: await item.readDocument() };
    });
  }

  async check(id: number, token: string, isDirty: () => boolean, signal?: AbortSignal): Promise<SyncPlan> {
    return this.repository.withItem(id, false, async (local) => {
      const state = await local.state();
      if (!state) { throw new UserError('该任务尚未跟踪，请先接入现有文件。'); }
      assertSource(state, this.connection);
      const attemptedAt = this.now().toISOString();
      let item: WorkItem;
      let revisionChanged = false;
      const templateChanged = state.rendererVersion < CURRENT_RENDERER_VERSION;
      let imagesChanged = false;
      let resolvedImages: { paths: Map<string, string>; files: Map<string, Uint8Array> } | undefined;
      try {
        cancelled(signal);
        item = await this.client.getWorkItem(this.connection, id, token, signal);
        cancelled(signal);
        if (item.rev < state.revision) { throw new UserError('远端修订低于本地基线，已停止更新。'); }
        revisionChanged = item.rev !== state.revision;
        const imageUrls = extractImageUrls(item, this.connection, CURRENT_RENDERER_VERSION);
        const existingRefs = referencedLocalImages(state.baseline);
        const missingLocalImages = imageUrls.length > 0 && Boolean(this.client.downloadImage) &&
          (state.baseline.includes('（远端图片）') || existingRefs.length < imageUrls.length || !(await local.hasFiles(existingRefs)));
        imagesChanged = missingLocalImages;
        if (imageUrls.length > 0 && this.client.downloadImage && (revisionChanged || templateChanged || missingLocalImages)) {
          resolvedImages = await this.resolveImages(item, token, signal);
          cancelled(signal);
        }
      } catch (error) {
        if (!signal?.aborted) {
          await local.writeState({ ...state, attemptedAt, status: 'error',
            error: error instanceof UserError ? error.message : '检查远端失败，请稍后重试。' });
        }
        throw error;
      }
      const checkedAt = this.now().toISOString();
      const document = await local.readDocument();
      const conflict = document === undefined || digest(document) !== state.hash || isDirty();
      const changed = revisionChanged || templateChanged || imagesChanged;
      const next = changed ? makeState(item, this.connection, checkedAt, resolvedImages?.paths) : state;
      await local.writeState({
        ...state, attemptedAt, checkedAt, error: undefined,
        status: conflict ? 'conflict' : changed ? 'updateAvailable' : 'unchanged',
      });
      return {
        id, expectedHash: state.hash, previous: state, next, local: document,
        changed, revisionChanged, templateChanged, imagesChanged, images: resolvedImages?.files, conflict,
      };
    });
  }

  async apply(plan: SyncPlan, guard: () => void): Promise<void> {
    if (plan.conflict) { throw new UserError('存在本地修改，不能覆盖；请先核对差异。'); }
    await this.repository.withItem(plan.id, false, async (local) => {
      const state = await local.state();
      if (!state) { throw new UserError('跟踪记录已被移除，请重新检查。'); }
      assertSource(state, this.connection);
      assertSource(plan.next, this.connection);
      if (state.hash !== plan.expectedHash || state.revision !== plan.previous.revision ||
          state.rendererVersion !== plan.previous.rendererVersion) {
        throw new UserError('其他窗口已更新此任务，请重新检查。');
      }
      const document = await local.readDocument();
      guard();
      if (document === undefined || digest(document) !== plan.expectedHash) {
        throw new UserError('预览后本地文件发生变化，已停止覆盖。');
      }
      if (!plan.changed) { return; }
      await local.commit(plan.next, plan.expectedHash, guard, plan.images);
    });
  }

  async list(): Promise<TrackedItem[]> {
    const result: TrackedItem[] = [];
    for (const id of await this.repository.listIds()) {
      try {
        const { state, local } = await this.inspect(id);
        const conflict = local === undefined || digest(local) !== state.hash;
        const templateChanged = state.rendererVersion < CURRENT_RENDERER_VERSION;
        result.push({
          id, title: state.title, revision: state.revision, rendererVersion: state.rendererVersion, checkedAt: state.checkedAt,
          status: conflict ? 'conflict' : state.status === 'error' ? 'error' : templateChanged ? 'updateAvailable' : state.status,
          detail: conflict ? '本地文件已修改或缺失' : [state.error,
            templateChanged ? '导出模板需升级至 ' + CURRENT_RENDERER_VERSION + '，请执行同步补全内容' : undefined].filter(Boolean).join('；'),
        });
      } catch (error) {
        result.push({ id, title: '', status: 'error',
          detail: error instanceof UserError ? error.message : '无法读取跟踪记录。' });
      }
    }
    return result;
  }
  async untrack(id: number): Promise<void> {
    await this.repository.withItem(id, false, async (item) => {
      const state = await item.state();
      if (!state) { throw new UserError('未找到跟踪记录。'); }
      assertSource(state, this.connection);
      await item.untrack();
    });
  }
}
