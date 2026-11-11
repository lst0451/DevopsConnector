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
  assert.equal(declared.length, 11);
  for (const item of declared) { assert.ok(commands.includes(item.command), item.command); }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.parse('devops-connector-snapshot:/smoke/missing.md'));
  assert.ok(document.getText().includes('请重新执行比较命令'));
  assert.equal(vscode.workspace.getConfiguration('devopsConnector').get('saveDirectory'), 'docs/workitems');
  console.log('HOST SMOKE PASSED: extension activation, 11 commands, snapshot provider, configuration defaults.');
}
