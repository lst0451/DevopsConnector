import { language, t } from './i18n';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readSettings, tokenKey } from './configuration';
import { UserError } from './types';
import { envToken, parseOrganizationInput, configuredProject, validateDirectory } from './validation';

const panels = new Map<string, vscode.WebviewPanel>();

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function openConfiguration(folder: vscode.WorkspaceFolder, secrets: vscode.SecretStorage): Promise<void> {
  const id = folder.uri.toString();
  const existing = panels.get(id);
  if (existing) { existing.reveal(); return; }

  const panel = vscode.window.createWebviewPanel('devopsConnector.configuration',
    'DevOps Connector · ' + folder.name, vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
  panels.set(id, panel);
  panel.onDidDispose(() => panels.delete(id));
  const config = () => vscode.workspace.getConfiguration('devopsConnector', folder.uri);
  let displayedKey: string | undefined;
  let busy = false;

  async function render(message = '', clearDraft = false): Promise<void> {
    const settings = config();
    let stored = false;
    displayedKey = undefined;
    try {
      displayedKey = tokenKey(folder, readSettings(folder));
      stored = Boolean((await secrets.get(displayedKey))?.trim());
    } catch (error) {
      if (!(error instanceof UserError)) { throw error; }
    }
    const source = !displayedKey ? t('请先保存有效的连接配置。') : stored ? t('正在使用此工作区与组织的已存 PAT。') :
      envToken() ? t('正在使用环境变量 AZURE_DEVOPS_PAT。') : t('尚未设置 PAT。');
    const nonce = randomBytes(18).toString('base64');
    panel.webview.html = `<!doctype html><html lang="${language()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'">
<style nonce="${nonce}">
body { max-width: 42rem; padding: 1.5rem; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
h1 { font-size: 1.6rem; } h2 { margin-top: 2rem; font-size: 1.2rem; }
label { display: block; margin: 1rem 0 .3rem; }
input, select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: .5rem; border: 1px solid var(--vscode-input-border, transparent); }
button { margin: .8rem .4rem 0 0; padding: .45rem .85rem; border: 1px solid transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
button:disabled { opacity: .55; cursor: default; } :focus-visible { outline: 1px solid var(--vscode-focusBorder); }
</style></head><body><h1>${t('DevOps Connector 配置')}</h1><p>${t('工作区')} · ${escapeHtml(folder.uri.fsPath)}</p>
<label for="language">${t('语言')}</label>
<select id="language"><option value="zh-CN" ${language() === 'zh-CN' ? 'selected' : ''}>简体中文</option><option value="en" ${language() === 'en' ? 'selected' : ''}>English</option></select>
<form id="connection" novalidate><h2>${t('Azure DevOps 连接')}</h2>
<label for="organization">${t('组织或项目地址')}</label><input id="organization" type="url" required placeholder="https://dev.azure.com/my-org" value="${escapeHtml(settings.get('organizationUrl', 'https://vffice.visualstudio.com'))}">
<label for="project">${t('项目名称（可选）')}</label><input id="project" placeholder="${t('组织地址下留空可按编号跨项目查找')}" value="${escapeHtml(settings.get('project', ''))}">
<label for="directory">${t('工作区内保存目录')}</label><input id="directory" required value="${escapeHtml(settings.get('saveDirectory', '.vscode/docs/workitems'))}">
<button>${t('保存连接')}</button></form>
<h2>Personal Access Token</h2><p id="source">${source}</p>
<button id="set" ${displayedKey ? '' : 'disabled'}>${t('设置或替换 PAT')}</button>
<button id="remove" ${stored ? '' : 'disabled'}>${t('移除已存 PAT')}</button>
<p role="status" id="feedback">${escapeHtml(message)}</p>
<script nonce="${nonce}">
const api = acquireVsCodeApi(), byId = id => document.getElementById(id);
byId('language').onchange = e => api.postMessage({action:'language', value:e.target.value});
const fields = ['organization','project','directory'];
if (${clearDraft}) api.setState(undefined);
const draft = api.getState();
if (draft) for (const field of fields) byId(field).value = draft[field];
byId('connection').oninput = () => {
  api.setState(Object.fromEntries(fields.map(field => [field, byId(field).value])));
  byId('set').disabled = byId('remove').disabled = true;
  byId('source').textContent = ${JSON.stringify(t('请先保存连接，再管理该组织的 PAT。'))};
};
if (draft) byId('connection').oninput();
byId('connection').onsubmit = e => {
  e.preventDefault();
  api.postMessage({action:'save', organization:byId('organization').value, project:byId('project').value, directory:byId('directory').value});
};
for (const action of ['set','remove']) byId(action).onclick = () => api.postMessage({action});
window.addEventListener('message', e => { byId('feedback').textContent = e.data.message; });
</script></body></html>`;
  }

  panel.webview.onDidReceiveMessage(async data => {
    if (busy || !data || !['language', 'save', 'set', 'remove'].includes(data.action)) { return; }
    busy = true;
    try {
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.some(f => f.uri.toString() === id)) {
        throw new UserError(t('请在受信任的工作区文件夹中重新打开配置页。'));
      }
      if (data.action === 'language') {
        if (data.value !== 'en' && data.value !== 'zh-CN') { return; }
        await vscode.workspace.getConfiguration('devopsConnector').update('language', data.value, vscode.ConfigurationTarget.Global);
        return;
      }
      if (data.action === 'save') {
        if (![data.organization, data.project, data.directory].every(v => typeof v === 'string')) { return; }
        const parsed = parseOrganizationInput(data.organization);
        const project = configuredProject(data.project, parsed.project);
        const directory = validateDirectory(data.directory).join('/');
        const settings = config();
        const target = vscode.ConfigurationTarget.WorkspaceFolder;
        await settings.update('organizationUrl', parsed.organizationUrl, target);
        await settings.update('project', project, target);
        await settings.update('saveDirectory', directory, target);
        await render(t('连接已保存。导入 Work Item 时将验证访问权限。'), true);
        return;
      }
      const connection = readSettings(folder);
      const key = tokenKey(folder, connection);
      if (key !== displayedKey) { await render(t('组织配置已更改，请核对后继续。')); return; }
      if (data.action === 'set') {
        const pat = await vscode.window.showInputBox({
          title: t('设置 PAT · ') + connection.organizationUrl, password: true, ignoreFocusOut: true,
          prompt: t('使用具有 Work Items (Read) 权限的 PAT'),
          validateInput: value => value.trim() ? undefined : t('PAT 不能为空。'),
        });
        if (pat === undefined) { return; }
        await secrets.store(key, pat.trim());
        await render(t('PAT 已保存到 VS Code SecretStorage。'));
      } else {
        await secrets.delete(key);
        await render(t('已移除此组织的已存 PAT。'));
      }
    } catch (error) {
      await panel.webview.postMessage({ message: error instanceof UserError ? error.message : t('操作失败，请检查工作区权限后重试。') });
    } finally { busy = false; }
  });
  const listener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('devopsConnector.language')) {
      void render();
    }
  });
  panel.onDidDispose(() => listener.dispose());
  try { await render(); } catch (error) { panel.dispose(); throw error; }
}
