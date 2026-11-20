import { t } from './i18n';
import * as vscode from 'vscode';
import { Connection, UserError } from './types';
import { organizationIdentity, parseOrganizationInput, resolveToken, validateDirectory, validateProject } from './validation';

export async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  if (!vscode.workspace.isTrusted) { throw new UserError(t('请先信任当前工作区。')); }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { throw new UserError(t('请先打开需要保存 Work Item 的项目文件夹。')); }
  const folder = folders.length === 1 ? folders[0] :
    await vscode.window.showWorkspaceFolderPick({ placeHolder: t('选择保存 Work Item 的项目文件夹') });
  if (folder && folder.uri.scheme !== 'file') {
    throw new UserError(t('目前仅支持文件系统工作区，不支持虚拟工作区。'));
  }
  return folder;
}

export function readSettings(folder: vscode.WorkspaceFolder): Connection & { saveDirectory: string } {
  const config = vscode.workspace.getConfiguration('devopsConnector', folder.uri);
  const organization = config.get<string>('organizationUrl', '');
  if (!organization.trim()) { throw new UserError(t('请先运行 DevOps Connector: Configuration，填写组织地址和项目。')); }
  const parsed = parseOrganizationInput(organization);
  const organizationUrl = parsed.organizationUrl;
  const project = validateProject(config.get<string>('project', '').trim() || parsed.project || '');
  if (parsed.project && parsed.project.toLowerCase() !== project.toLowerCase()) {
    throw new UserError(t('地址中的项目与 project 配置不一致，请运行 DevOps Connector: Configuration。'));
  }
  const saveDirectory = config.get<string>('saveDirectory', 'docs/workitems');
  validateDirectory(saveDirectory);
  return { organizationUrl, project, saveDirectory };
}

export function tokenKey(folder: vscode.WorkspaceFolder, connection: Connection): string {
  // Separate tokens by workspace folder and organization; never persist them in settings.
  return 'devopsConnector.pat:' + JSON.stringify([folder.uri.toString(), organizationIdentity(connection.organizationUrl)]);
}

export async function getToken(secrets: vscode.SecretStorage, folder: vscode.WorkspaceFolder, connection: Connection): Promise<string> {
  return resolveToken(await secrets.get(tokenKey(folder, connection)));
}
