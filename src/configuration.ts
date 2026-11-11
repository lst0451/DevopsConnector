import * as vscode from 'vscode';
import { Connection, UserError } from './types';
import { normalizeOrganization, validateDirectory, validateProject } from './validation';

export async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  if (!vscode.workspace.isTrusted) { throw new UserError('请先信任当前工作区。'); }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { throw new UserError('请先打开需要保存 Work Item 的项目文件夹。'); }
  const folder = folders.length === 1 ? folders[0] :
    await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择保存 Work Item 的项目文件夹' });
  if (folder && folder.uri.scheme !== 'file') {
    throw new UserError('目前仅支持文件系统工作区，不支持虚拟工作区。');
  }
  return folder;
}

export function readSettings(folder: vscode.WorkspaceFolder): Connection & { saveDirectory: string } {
  const config = vscode.workspace.getConfiguration('devopsConnector', folder.uri);
  const organizationUrl = normalizeOrganization(config.get<string>('organizationUrl', ''));
  const project = validateProject(config.get<string>('project', ''));
  const saveDirectory = config.get<string>('saveDirectory', 'docs/workitems');
  validateDirectory(saveDirectory);
  return { organizationUrl, project, saveDirectory };
}

export function tokenKey(folder: vscode.WorkspaceFolder, connection: Connection): string {
  // Separate tokens by workspace folder and organization; never persist them in settings.
  return 'devopsConnector.pat:' + JSON.stringify([folder.uri.toString(), connection.organizationUrl]);
}

function validationMessage(check: (value: string) => unknown): (value: string) => string | undefined {
  return (value) => {
    try { check(value); return undefined; }
    catch (error) { return error instanceof UserError ? error.message : '输入无效。'; }
  };
}

export async function configureConnection(folder: vscode.WorkspaceFolder): Promise<void> {
  const config = vscode.workspace.getConfiguration('devopsConnector', folder.uri);
  const organization = await vscode.window.showInputBox({
    title: 'DevOps Connector · 组织',
    prompt: '组织地址，例如 https://dev.azure.com/my-org',
    value: config.get<string>('organizationUrl', ''),
    ignoreFocusOut: true,
    validateInput: validationMessage(normalizeOrganization),
  });
  if (organization === undefined) { return; }
  const project = await vscode.window.showInputBox({
    title: 'DevOps Connector · 项目',
    prompt: 'Azure DevOps 项目名称（不是项目 GUID）',
    value: config.get<string>('project', ''),
    ignoreFocusOut: true,
    validateInput: validationMessage(validateProject),
  });
  if (project === undefined) { return; }
  const directory = await vscode.window.showInputBox({
    title: 'DevOps Connector · 保存目录',
    prompt: '相对于当前项目根目录，例如 docs/workitems',
    value: config.get<string>('saveDirectory', 'docs/workitems'),
    ignoreFocusOut: true,
    validateInput: validationMessage(validateDirectory),
  });
  if (directory === undefined) { return; }
  const target = vscode.ConfigurationTarget.WorkspaceFolder;
  await config.update('organizationUrl', normalizeOrganization(organization), target);
  await config.update('project', validateProject(project), target);
  await config.update('saveDirectory', validateDirectory(directory).join('/'), target);
  await vscode.window.showInformationMessage('连接配置已保存（尚未联网验证）。请设置 PAT，然后导入 Work Item。');
}
