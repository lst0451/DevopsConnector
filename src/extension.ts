import { language, setLanguage, t, withLanguage } from './i18n';
import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOpsClient';
import { chooseFolder } from './configuration';
import { registerSyncCommands } from './syncCommands';
import { UserError } from './types';
import { openConfiguration } from './configurationPage';

export function activate(context: vscode.ExtensionContext): void {
  const loadLanguage = () => setLanguage(vscode.workspace.getConfiguration('devopsConnector').get('language') === 'en' ? 'en' : 'zh-CN');
  loadLanguage();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('devopsConnector.language')) { loadLanguage(); }
  }));
  const client = new AzureDevOpsClient();
  const register = (id: string, action: () => Promise<void>) => {
    const execute = async () => {
      try {
        if (id === 'devopsConnector.configure') { await action(); }
        else { await withLanguage(language(), action); }
      }
      catch (error) {
        if (error instanceof vscode.CancellationError) { return; }
        await vscode.window.showErrorMessage('DevOps Connector: ' +
          (error instanceof UserError ? error.message : t('操作失败。请检查工作区权限和配置后重试。')));
      }
    };
    context.subscriptions.push(vscode.commands.registerCommand(id, execute), vscode.commands.registerCommand(id + '.zh', execute));
  };

  register('devopsConnector.configure', async () => {
    const folder = await chooseFolder();
    if (folder) { await openConfiguration(folder, context.secrets); }
  });
  registerSyncCommands(context, client, register);
}

export function deactivate(): void {}
