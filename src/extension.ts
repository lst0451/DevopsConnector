import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOpsClient';
import { chooseFolder, configureConnection, readSettings, tokenKey } from './configuration';
import { renderWorkItem } from './markdown';
import { importFilePath, saveNewWorkItem } from './storage';
import { parseWorkItemInput } from './validation';
import { UserError } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const client = new AzureDevOpsClient();
  const activeImports = new Set<string>();
  const register = (id: string, action: () => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await action(); }
      catch (error) {
        await vscode.window.showErrorMessage('DevOps Connector: ' +
          (error instanceof UserError ? error.message : '操作失败。请检查工作区权限和配置后重试。'));
      }
    }));
  };

  register('devopsConnector.configure', async () => {
    const folder = await chooseFolder();
    if (folder) { await configureConnection(folder); }
  });
  register('devopsConnector.setToken', async () => {
    const folder = await chooseFolder();
    if (!folder) { return; }
    const settings = readSettings(folder);
    const token = await vscode.window.showInputBox({
      title: 'DevOps Connector · Personal Access Token',
      prompt: settings.organizationUrl + ' — 请使用仅含 Work Items (Read) 权限的 PAT',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'PAT 不能为空。',
    });
    if (token === undefined) { return; }
    await context.secrets.store(tokenKey(folder, settings), token.trim());
    await vscode.window.showInformationMessage('PAT 已保存到 VS Code SecretStorage，未写入项目文件。');
  });
  register('devopsConnector.clearToken', async () => {
    const folder = await chooseFolder();
    if (!folder) { return; }
    const settings = readSettings(folder);
    await context.secrets.delete(tokenKey(folder, settings));
    await vscode.window.showInformationMessage('当前文件夹与组织对应的 PAT 已移除。');
  });
  register('devopsConnector.importWorkItem', async () => {
    const folder = await chooseFolder();
    if (!folder) { return; }
    const settings = readSettings(folder);
    const token = await context.secrets.get(tokenKey(folder, settings));
    if (!token) { throw new UserError('请先运行 DevOps Connector: Set Personal Access Token。'); }
    const input = await vscode.window.showInputBox({
      title: 'DevOps Connector · 导入 Work Item',
      prompt: settings.project + ' — 输入 ID 或完整 Work Item 链接',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try { parseWorkItemInput(value, settings); return undefined; }
        catch (error) { return error instanceof UserError ? error.message : '输入无效。'; }
      },
    });
    if (input === undefined) { return; }
    const id = parseWorkItemInput(input, settings);
    const target = vscode.Uri.file(importFilePath(folder.uri.fsPath, settings.saveDirectory, id));
    const key = target.toString();
    if (activeImports.has(key)) { throw new UserError('该 Work Item 正在导入，请等待完成。'); }
    const checkDirty = () => {
      if (vscode.workspace.textDocuments.some((document) =>
        document.isDirty && document.uri.toString() === key)) {
        throw new UserError('目标文件有未保存的编辑，已停止导入。请先处理本地修改。');
      }
    };
    checkDirty();
    activeImports.add(key);
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'DevOps Connector: 正在导入 #' + id,
        cancellable: true,
      }, async (_progress, cancellation) => {
        const controller = new AbortController();
        const subscription = cancellation.onCancellationRequested(() => controller.abort());
        if (cancellation.isCancellationRequested) { controller.abort(); }
        try {
          const item = await client.getWorkItem(settings, id, token, controller.signal);
          if (controller.signal.aborted) { return; }
          checkDirty();
          const file = await saveNewWorkItem(folder.uri.fsPath, settings.saveDirectory, id,
            renderWorkItem(item, settings, new Date()));
          await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
          await vscode.window.showInformationMessage('Work Item #' + id + ' 已导入（修订 ' + item.rev + '）。');
        } catch (error) {
          if (!controller.signal.aborted) { throw error; }
        } finally { subscription.dispose(); }
      });
    } finally { activeImports.delete(key); }
  });
}

export function deactivate(): void {}
