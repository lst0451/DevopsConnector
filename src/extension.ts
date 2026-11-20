import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOpsClient';
import { chooseFolder } from './configuration';
import { registerSyncCommands } from './syncCommands';
import { UserError } from './types';
import { openConfiguration } from './configurationPage';

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
    if (folder) { await openConfiguration(folder, context.secrets); }
  });
  registerSyncCommands(context, client, register);
}

export function deactivate(): void {}
