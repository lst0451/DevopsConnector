import assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('devops-connector-local.devops-connector');
  assert.ok(extension, 'Development extension is discoverable');
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.equal(extension.packageJSON.version, '0.2.1');
  const commands = await vscode.commands.getCommands(true);
  const declared = extension.packageJSON.contributes.commands as { command: string }[];
  const menus = extension.packageJSON.contributes.menus;
  const configuration = extension.packageJSON.contributes.commands.find(
    (item: { command: string }) => item.command === 'devopsConnector.configure');
  assert.equal(configuration?.title, 'Configuration');
  assert.equal(configuration.category, 'DevOps Connector');
  assert.ok(!menus.commandPalette?.some((item: { command: string }) => item.command === configuration.command));
  assert.equal(declared.length, 9);
  assert.ok(menus['view/title'].some((item: { command: string }) => item.command === configuration.command));
  await vscode.commands.executeCommand('devopsConnector.configure');
  const pageIsOpen = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('devopsConnector.configuration')));
  for (let i = 0; i < 50 && !pageIsOpen(); i++) { await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(pageIsOpen(), 'Configuration webview is open');
  for (const item of declared) { assert.ok(commands.includes(item.command), item.command); }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.parse('devops-connector-snapshot:/smoke/missing.md'));
  assert.ok(document.getText().includes('请重新执行比较命令'));
  assert.equal(vscode.workspace.getConfiguration('devopsConnector').get('saveDirectory'), 'docs/workitems');
  console.log('HOST SMOKE PASSED: extension activation, configuration page and 8 business commands, snapshot provider, configuration defaults.');
}
