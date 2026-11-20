import { t } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AzureDevOpsClient } from './azureDevOpsClient';
import { chooseFolder, getToken, readSettings } from './configuration';
import { importFilePath } from './storage';
import { SyncRepository } from './syncRepository';
import { ExistingFileMismatch, SyncService, TrackedItem } from './syncService';
import { describeChanges, SyncPlan } from './syncModel';
import { parseWorkItemInput } from './validation';
import { UserError } from './types';

type Register = (id: string, action: () => Promise<void>) => void;
type Session = { folder: vscode.WorkspaceFolder; settings: ReturnType<typeof readSettings>; service: SyncService };
const labels = () => ({ synced: t('已建立基线'), unchanged: t('修订和模板均为最新'), updateAvailable: t('有更新'), conflict: t('本地已修改/缺失'), error: t('错误') });
function pathKey(file: string): string {
  const normalized = path.resolve(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function registerSyncCommands(context: vscode.ExtensionContext, client: AzureDevOpsClient, register: Register): void {
  const snapshots = new Map<string, string>();
  const scheme = 'devops-connector-snapshot';
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: (uri) => snapshots.get(uri.toString()) ?? t('此预览已关闭，请重新执行比较命令。'),
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === scheme) { snapshots.delete(document.uri.toString()); }
    }),
    { dispose: () => snapshots.clear() },
  );
  const snapshot = (text: string, name: string) => {
    if (snapshots.size >= 64) { snapshots.delete(snapshots.keys().next().value!); }
    const uri = vscode.Uri.from({ scheme, path: '/' + randomUUID() + '/' + name });
    snapshots.set(uri.toString(), text);
    return uri;
  };
  const target = (session: Session, id: number) =>
    vscode.Uri.file(importFilePath(session.folder.uri.fsPath, session.settings.saveDirectory, id));
  const isDirty = (session: Session, id: number) => vscode.workspace.textDocuments.some((document) =>
    document.uri.scheme === 'file' && document.isDirty && pathKey(document.uri.fsPath) === pathKey(target(session, id).fsPath));
  const guard = (session: Session, id: number) => {
    if (isDirty(session, id)) { throw new UserError(t('目标文件有未保存的编辑，已停止写入。')); }
  };
  const session = async (): Promise<Session | undefined> => {
    const folder = await chooseFolder();
    if (!folder) { return undefined; }
    const settings = readSettings(folder);
    const service = new SyncService(new SyncRepository(folder.uri.fsPath, settings.saveDirectory), {
      organizationUrl: settings.organizationUrl, project: settings.project,
    }, client);
    return { folder, settings, service };
  };
  const token = (current: Session) => getToken(context.secrets, current.folder, current.settings);
  const inputId = async (current: Session, title: string) => {
    const input = await vscode.window.showInputBox({
      title: 'DevOps Connector · ' + title,
      prompt: current.settings.project + t(' — 输入 ID 或完整 Work Item 链接'),
      ignoreFocusOut: true,
      validateInput: (value) => {
        try { parseWorkItemInput(value, current.settings); return undefined; }
        catch (error) { return error instanceof UserError ? error.message : t('输入无效。'); }
      },
    });
    return input === undefined ? undefined : parseWorkItemInput(input, current.settings);
  };
  const pick = async (current: Session): Promise<TrackedItem | undefined> => {
    const items = await current.service.list();
    if (!items.length) {
      await vscode.window.showInformationMessage(t('当前保存目录没有跟踪项。已导出的旧文件请先运行 Track Existing Work Item。'));
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(items.map((item) => ({
      label: '#' + item.id + ' ' + item.title,
      description: labels()[isDirty(current, item.id) ? 'conflict' : item.status],
      detail: (item.workItemState ? t('状态：') + item.workItemState + ' · ' : '') +
        (item.revision === undefined ? '' : t('本地修订 ') + item.revision + ' · ') +
        (item.rendererVersion === undefined ? '' : t('导出模板 ') + item.rendererVersion + ' · ') +
        (item.checkedAt ? t('上次成功检查 ') + item.checkedAt : t('尚未检查最新版本')) +
        (item.detail ? ' · ' + item.detail : ''),
      item,
    })), { title: t('DevOps Connector · 已跟踪 Work Items'), matchOnDescription: true, matchOnDetail: true });
    return selected?.item;
  };
  const progress = async <T>(title: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_p, cancellation) => {
      const controller = new AbortController();
      const subscription = cancellation.onCancellationRequested(() => controller.abort());
      if (cancellation.isCancellationRequested) { controller.abort(); }
      try { return await action(controller.signal); }
      catch (error) { if (controller.signal.aborted) { throw new vscode.CancellationError(); } throw error; }
      finally { subscription.dispose(); }
    });
  const showPlan = async (current: Session, plan: SyncPlan) => {
    const left = plan.local === undefined ? snapshot(t('（本地文件缺失）\n'), 'missing.md') : target(current, plan.id);
    const right = snapshot(plan.next.baseline, 'remote-' + plan.next.revision + '.md');
    await vscode.commands.executeCommand('vscode.diff', left, right,
      '#' + plan.id + t(' 本地 ↔ 待同步文档（修订 ') + plan.next.revision + t('，模板 ') + plan.next.rendererVersion + t('）'), { preview: true });
  };
  const check = async (current: Session, id: number) => {
    const pat = await token(current);
    return progress(t('正在检查 #') + id, (signal) => current.service.check(id, pat, () => isDirty(current, id), signal));
  };
  const syncOne = async (current: Session, id: number, previewOnly = false) => {
    const plan = await check(current, id);
    if (previewOnly || plan.conflict) {
      await showPlan(current, plan);
      if (plan.conflict) {
        await vscode.window.showWarningMessage(t('检测到本地修改、未保存编辑或文件缺失，未覆盖。可使用 Compare with Last Synced Version 查看基线并手动处理。'));
      }
      return;
    }
    if (!plan.changed) {
      await vscode.window.showInformationMessage('#' + id + t('：远端修订 ') + plan.next.revision +
        t(' 和导出模板 ') + plan.next.rendererVersion + t(' 均无变化，未重写文件。'));
      return;
    }
    let choice = await vscode.window.showInformationMessage(
      '#' + id + t('：') + describeChanges(plan) + t('。是否更新本地需求副本？'),
      { modal: true }, t('查看差异'), t('同步'));
    if (choice === t('查看差异')) {
      await showPlan(current, plan);
      choice = await vscode.window.showInformationMessage(t('差异已打开。确认后更新 #') + id + t('？'), t('同步'));
    }
    if (choice !== t('同步')) { return; }
    await current.service.apply(plan, () => guard(current, id));
    await vscode.window.showInformationMessage('#' + id + t(' 已同步（修订 ') + plan.next.revision + t('，导出模板 ') + plan.next.rendererVersion + t('）。'));
  };

  register('devopsConnector.importWorkItem', async () => {
    const current = await session(); if (!current) { return; }
    const id = await inputId(current, t('导入并跟踪')); if (id === undefined) { return; }
    const pat = await token(current);
    await progress(t('正在导入 #') + id, (signal) => current.service.import(id, pat, () => guard(current, id), signal));
    await vscode.window.showTextDocument(target(current, id), { preview: false });
    await vscode.window.showInformationMessage('#' + id + t(' 已导入并加入跟踪。'));
  });
  register('devopsConnector.trackExistingWorkItem', async () => {
    const current = await session(); if (!current) { return; }
    const id = await inputId(current, t('接入现有导出文件')); if (id === undefined) { return; }
    const pat = await token(current);
    try {
      await progress(t('正在核对 #') + id + t(' 的历史修订'), (signal) =>
        current.service.trackExisting(id, pat, () => guard(current, id), signal));
    } catch (error) {
      if (error instanceof ExistingFileMismatch) {
        await vscode.commands.executeCommand('vscode.diff', target(current, id),
          snapshot(error.expected, 'historical.md'), '#' + id + t(' 本地 ↔ 历史导出基线'), { preview: true });
      }
      throw error;
    }
    await vscode.window.showInformationMessage('#' + id + t(' 已接入跟踪，原文档未改动。请运行 Sync Work Item 检查最新版本。'));
  });
  register('devopsConnector.syncWorkItem', async () => {
    const current = await session(); if (!current) { return; }
    const item = await pick(current); if (item) { await syncOne(current, item.id); }
  });
  register('devopsConnector.previewChanges', async () => {
    const current = await session(); if (!current) { return; }
    const item = await pick(current); if (item) { await syncOne(current, item.id, true); }
  });
  const compareBaseline = async (current: Session, id: number) => {
    const { state, local } = await current.service.inspect(id);
    await vscode.commands.executeCommand('vscode.diff', snapshot(state.baseline, 'baseline-' + state.revision + '.md'),
      local === undefined ? snapshot(t('（本地文件缺失）\n'), 'missing.md') : target(current, id),
      '#' + id + t(' 上次同步基线 ↔ 当前本地'), { preview: true });
  };
  register('devopsConnector.compareBaseline', async () => {
    const current = await session(); if (!current) { return; }
    const item = await pick(current); if (item) { await compareBaseline(current, item.id); }
  });
  const untrack = async (current: Session, id: number) => {
    const choice = await vscode.window.showWarningMessage(
      t('停止跟踪 #') + id + t('？仅移除同步基线记录；保留 workitem.md、设计与笔记。'),
      { modal: true }, t('停止跟踪'));
    if (choice !== t('停止跟踪')) { return; }
    await current.service.untrack(id);
    await vscode.window.showInformationMessage(t('已停止跟踪 #') + id + t('，本地文档保留。'));
  };
  register('devopsConnector.stopTracking', async () => {
    const current = await session(); if (!current) { return; }
    const item = await pick(current); if (item) { await untrack(current, item.id); }
  });
  register('devopsConnector.showTrackedWorkItems', async () => {
    const current = await session(); if (!current) { return; }
    const item = await pick(current); if (!item) { return; }
    const action = await vscode.window.showQuickPick(
      [t('打开本地文件'), t('同步'), t('查看远端差异'), t('与上次同步版本比较'), t('停止跟踪')], { title: '#' + item.id });
    if (action === t('打开本地文件')) { await vscode.window.showTextDocument(target(current, item.id), { preview: false }); }
    else if (action === t('同步')) { await syncOne(current, item.id); }
    else if (action === t('查看远端差异')) { await syncOne(current, item.id, true); }
    else if (action === t('与上次同步版本比较')) { await compareBaseline(current, item.id); }
    else if (action === t('停止跟踪')) { await untrack(current, item.id); }
  });
  register('devopsConnector.syncAllWorkItems', async () => {
    const current = await session(); if (!current) { return; }
    const items = await current.service.list();
    if (!items.length) { await vscode.window.showInformationMessage(t('当前目录没有跟踪项。')); return; }
    const choice = await vscode.window.showWarningMessage(
      t('检查并同步 ') + items.length + t(' 个跟踪项？会更新无本地修改的需求副本；跳过冲突、错误及来源不符项。'),
      { modal: true }, t('开始同步'));
    if (choice !== t('开始同步')) { return; }
    const pat = await token(current);
    const report: string[] = [];
    let wasCancelled = false;
    const counts = { updated: 0, unchanged: 0, conflict: 0, failed: 0 };
    await progress(t('正在同步已跟踪 Work Items'), async (signal) => {
      for (const item of items) {
        if (signal.aborted) { wasCancelled = true; report.push(t('已取消：剩余任务未处理。')); break; }
        try {
          const plan = await current.service.check(item.id, pat, () => isDirty(current, item.id), signal);
          if (signal.aborted) { wasCancelled = true; report.push(t('已取消：剩余任务未处理。')); break; }
          if (plan.conflict) { counts.conflict++; report.push('#' + item.id + t(' 跳过：本地修改或文件缺失')); }
          else if (!plan.changed) { counts.unchanged++; report.push('#' + item.id + t(' 修订和导出模板均无变化')); }
          else {
            await current.service.apply(plan, () => guard(current, item.id));
            counts.updated++; report.push('#' + item.id + t(' 已同步：') + describeChanges(plan));
          }
        } catch (error) {
          if (signal.aborted) { wasCancelled = true; report.push(t('已取消：剩余任务未处理。')); break; }
          counts.failed++;
          report.push('#' + item.id + t(' 失败：') + (error instanceof UserError ? error.message : t('文件或网络操作失败')));
        }
      }
    });
    const summary = (wasCancelled ? t('已取消。') : '') + t('更新 ') + counts.updated + t('，无变化 ') + counts.unchanged + t('，冲突 ') + counts.conflict + t('，失败 ') + counts.failed;
    const selected = await vscode.window.showInformationMessage(summary, t('查看报告'));
    if (selected) {
      await vscode.window.showTextDocument(snapshot(summary + '\n\n' + report.join('\n'), 'sync-report.txt'), { preview: true });
    }
  });
}
