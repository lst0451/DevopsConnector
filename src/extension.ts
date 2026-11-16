import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOpsClient';
import { chooseFolder, configureConnection, readSettings, tokenKey } from './configuration';
import { registerSyncCommands } from './syncCommands';
import { UserError } from './types';
import { envToken } from './validation';

export function activate(context: vscode.ExtensionContext): void {
  const client = new AzureDevOpsClient();
  const register = (id: string, action: () => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await action(); }
      catch (error) {
        if (error instanceof vscode.CancellationError) { return; }
        await vscode.window.showErrorMessage('DevOps Connector: ' +
          (error instanceof UserError ? error.message : '操作失败。请检查工作区权限和配置后重试。'));
      }
    }));
  };

  register('devopsConnector.configure', async () => {
    const folder = await chooseFolder();
    if (folder) { await configureConnection(folder, context.secrets); }
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
    await vscode.window.showInformationMessage(envToken() ?
      '当前文件夹与组织对应的 SecretStorage PAT 已移除；将继续默认使用环境变量 AZURE_DEVOPS_PAT。' :
      '当前文件夹与组织对应的 PAT 已移除。');
  });
  registerSyncCommands(context, client, register);
}

export function deactivate(): void {}
