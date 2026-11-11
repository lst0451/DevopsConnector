# DevOps Connector

将 Azure DevOps Work Item 导入当前 VS Code 项目，作为本地 Markdown 需求副本。

## 当前状态：第一阶段 / 0.1.0

已实现：项目级连接与目录配置、PAT 安全存储、通过 ID/链接导入单个 Work Item、Markdown 转换、安全保存。

尚未实现：已跟踪列表、重新同步、变更对比、定时检查、侧边栏、评论和附件下载。**重复导入会拒绝覆盖，不等于更新同步。**

## 开发与调试

开发环境：Node.js 22 或更高版本、npm、VS Code 1.95 或更高版本。

~~~powershell
npm ci --ignore-scripts
npm test
npm run compile
~~~

在本项目中按 F5，选择 Run DevOps Connector。在打开的 Extension Development Host 窗口中，打开一个用于测试的项目文件夹。不要误把需求保存到插件源码项目。

更改代码后可以重新 F5，或使用 npm run watch 并在开发宿主中执行 Developer: Reload Window。

## 首次使用

在开发宿主的命令面板中，依次执行：

1. **DevOps Connector: Configure Connection**
   - 组织地址，例如 https://dev.azure.com/my-org。
   - Azure DevOps 项目名称，支持空格和中文；此版本不接受项目 GUID 代替名称。
   - 项目内相对保存目录，默认 docs/workitems。
2. **DevOps Connector: Set Personal Access Token**
   - 在密码输入框中输入 PAT，建议只授予 Work Items (Read)。
   - 不要将 PAT 粘贴进 settings.json、源代码、终端命令或 Git。
3. **DevOps Connector: Import Work Item**
   - 输入 ID，例如 21835，或者完整 Work Item 链接。
   - 导入完成后自动打开本地文件。

配置命令只保存配置，不声称连接已验证。首次成功导入才验证当前凭据对该 Work Item 的读取权限。

PAT 按“工作区文件夹 + 组织”保存在 VS Code SecretStorage。可通过 Remove Personal Access Token 删除当前配置对应的凭据；切换组织不会自动删除旧组织凭据，需要切回旧组织再删除。

多根工作区每次操作都明确选择目标文件夹。配置保存在该文件夹的 VS Code 设置中，凭据不随配置共享。

## 保存结果

~~~text
目标项目/
└── docs/workitems/
    └── 21835/
        ├── workitem.md       插件生成
        ├── design.md         可自行创建，插件不管理
        └── notes.md          可自行创建，插件不管理
~~~

内容包括标题、类型、状态、负责人、标签、描述、验收标准、复现步骤、修订版本、来源链接与时间。未提供的字段明确显示占位。时间以 UTC ISO 格式保存。

图片只保留 HTTPS 链接，不自动加载或下载。HTML 转换保留常见标题、列表、代码和简单表格；复杂富文本不保证与网页完全一致。

## 安全与限制

- 只读 Azure DevOps Services API 7.1。支持 dev.azure.com 地址以及规范化后的组织级 visualstudio.com 旧地址。
- 不支持自建 Azure DevOps Server、双向回写、Web/虚拟工作区。远程开发和企业代理仍待专项验收。
- 只在用户主动执行导入时联网；没有后台轮询、遥测或 AI 上传。
- 仅向经过校验的 Azure DevOps 云端地址发送 PAT，不跟随重定向；网络错误不输出原始响应或凭据。
- 要求可信工作区。保存目录禁止绝对路径、父目录跳转、保留名称和目录中的符号链接/目录联接。
- 完整临时文件写好后以独占硬链接方式发布；文件系统不支持硬链接时失败，不退回覆盖写入。
- 已有 workitem.md、其他本地文件及未保存的目标编辑不被主动覆盖。没有锁定其他进程的文件系统操作，不能防御恶意进程同时替换目录。
- 网络请求超时为 20 秒，响应上限为 5 MB；取消在文件提交前生效，完成文件保存后不回滚。
- 需求可能含内部资料。是否提交 Git 由项目自行决定，插件不会自动提交或推送。

## 验证与打包

~~~powershell
npm run check
npm test
npm run compile
npm run package
~~~

本地安装包生成在 work/devops-connector-0.1.0.vsix。通过 VS Code 扩展面板的“从 VSIX 安装”安装；安装不会发布到 Marketplace。

publisher 当前为本地占位值；未选择分发许可证，也未配置远程仓库。打包跳过许可证检查仅用于本地开发，发布前必须补齐这些信息。

单元测试使用模拟 API，不需要真实 PAT。真实账号权限、F5 交互、SecretStorage 持久化以及实际 Work Item 富文本需按 docs/manual-test.md 验收。

后续开发顺序见 docs/roadmap.md。

## 参考

- [Work Items REST API 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-item?view=azure-devops-rest-7.1)
- [VS Code API / SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage)
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
