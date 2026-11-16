# DevOps Connector

将 Azure DevOps Work Item 导入当前 VS Code 项目，作为本地 Markdown 需求副本。

## 当前状态：第二阶段 / 0.2.1

已实现：项目级连接与目录配置、PAT 安全存储、导入与跟踪、手动同步、只读差异预览、本地修改保护和中断恢复。

尚未实现：定时检查、侧边栏、评论和附件下载。跟踪列表目前通过命令面板访问；没有后台自动更新。

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
   - 组织地址，例如 https://vffice.visualstudio.com/ 或 https://dev.azure.com/my-org。
   - 也可粘贴项目地址，例如 https://vffice.visualstudio.com/VFF070.Pro-Demnity；下一步会预填项目名称供确认。
   - Azure DevOps 项目名称，支持空格和中文；此版本不接受项目 GUID 代替名称。
   - 项目内相对保存目录，默认 docs/workitems。
2. **DevOps Connector: Set Personal Access Token**
   - 如果环境变量 `AZURE_DEVOPS_PAT` 已设置（非空），插件会默认使用该 token，可跳过此步（如需为当前工作区和组织单独覆盖，仍可通过此命令设置）。
   - 在密码输入框中输入 PAT，建议只授予 Work Items (Read)。
   - 不要将 PAT 粘贴进 settings.json、源代码、终端命令或 Git。
3. **DevOps Connector: Import Work Item**
   - 输入 ID，例如 21835，或者完整 Work Item 链接。
   - 导入完成后自动打开本地文件，并建立同步跟踪。已有文件不会被重复导入覆盖。

配置命令只保存配置，不声称连接已验证。首次成功导入才验证当前凭据对该 Work Item 的读取权限。

PAT 按“工作区文件夹 + 组织”保存在 VS Code SecretStorage。可通过 Remove Personal Access Token 删除当前配置对应的凭据；切换组织不会自动删除旧组织凭据，需要切回旧组织再删除。

多根工作区每次操作都明确选择目标文件夹。配置保存在该文件夹的 VS Code 设置中，凭据不随配置共享。

## 已导出文件的升级与同步

原 0.1.0 导出文件不能直接当作可信同步基线。保持原项目配置和保存目录不变，执行：

1. **DevOps Connector: Track Existing Work Item**，输入原 Work Item ID，例如 21835。
2. 插件读取文档记录的历史修订，使用当时的导出格式和时间重建内容并逐字核对（允许 CRLF/LF 差异）。匹配后只新增跟踪记录，不改动原 Markdown。
3. 执行 **DevOps Connector: Sync Work Item**，选择任务，查看差异并确认同步。仅当远端修订和导出模板版本均无变化时，才不重写 Markdown。

若文件有本地修改或无法获取历史修订，接入会停止；先备份设计/笔记并核对差异，不会把自定义内容静默纳入可覆盖基线。

0.2.1 使用导出模板 3，新增 Custom.Specifications（需求规格）和 Custom.Design（设计说明）。已跟踪的旧模板文件无需再次 Track Existing Work Item，直接 Sync Work Item 即可；即使远端仍为修订 73，也会提示“导出模板 1/2 → 3（补全文档内容）”。确认后补全内容和模板版本，之后再次同步不会重复重写。

旧模板 1/2 仍保留用于核对历史导出和中断恢复，不会用新模板直接比较旧文件。模板升级同样受本地修改、未保存编辑和并发保护约束。

| 命令 | 行为 |
|---|---|
| Show Tracked Work Items | 查看当前保存目录的任务、修订、检查时间与状态；选择任务后可打开或同步 |
| Sync Work Item | 检查单项，确认后更新；可先看差异 |
| Sync All Work Items | 批量确认后更新无本地修改的任务；跳过冲突与错误，提供汇总 |
| View Remote Changes | 仅检查并预览本地与远端差异，不修改需求文件 |
| Compare with Last Synced Version | 离线比较上次成功同步基线与当前本地文件 |
| Stop Tracking Work Item | 确认后仅删除跟踪基线；保留需求、设计与笔记 |

发现本地修改、未保存编辑或目标文件缺失时，不自动覆盖或重建。可先用 Compare with Last Synced Version 将笔记移到独立文件，再手动恢复基线文本并保存，重新检查同步；插件没有“强制覆盖”按钮。

“已建立基线”不代表已检查最新版本；“有更新”不代表已写入本地。只有文档和跟踪记录提交成功后才报告同步成功。

## 保存结果

~~~text
目标项目/
└── docs/workitems/
    └── 21835/
        ├── workitem.md       插件管理的需求副本
        ├── .devops-sync.json 同步来源、完整基线、哈希及检查状态
        ├── images/           随 Work Item 自动下载到本地的图片
        ├── design.md         可自行创建，插件不管理
        └── notes.md          可自行创建，插件不管理
~~~

内容包括标题、ID、Revision、Template Version、Work Item Type、State、Reason、Assigned To、Area、Iteration、Tags、Project、Source、Changed Date、Exported At 等英文元数据字段，以及 Description、Specifications（`Custom.Specifications`）、Acceptance Criteria、Design（`Custom.Design`）、Repro Steps 正文章节。所有元数据标签与正文章节标题均按 Azure DevOps 原文显示；自定义规格/设计与标准验收字段分别展示，不互相替代。未提供的字段明确显示占位。时间以 UTC ISO 格式保存。

Work Item 正文中的 HTTPS 图片会在导入或同步时自动下载到本地 `images/` 目录，并在 `workitem.md` 中使用相对路径引用（`![...](images/...)`）。若字段本身为 Markdown 格式（例如 `Design`），将保留其原始 Markdown 结构而非转义折叠。HTML 转换保留常见标题、列表、代码和简单表格；复杂富文本不保证与网页完全一致。

## 安全与限制

- 只读 Azure DevOps Services API 7.1。支持 dev.azure.com 和 visualstudio.com 地址；保留配置的域名用于请求与导出链接，不强制改写域名。同一组织的两种地址共享凭据身份。
- 不支持自建 Azure DevOps Server、双向回写、Web/虚拟工作区。远程开发和企业代理仍待专项验收。
- 只在用户主动导入、接入跟踪或检查/同步时联网；没有后台轮询、遥测或 AI 上传。
- 仅向经过校验的 Azure DevOps 云端地址发送 PAT，不跟随重定向；网络错误不输出原始响应或凭据。
- 要求可信工作区。保存目录禁止绝对路径、父目录跳转、保留名称和目录中的符号链接/目录联接。
- 首次创建以独占硬链接发布；更新采用同目录临时文件与原子替换。文件系统不支持所需能力时失败，不退回直接截断写入。
- 同步仅更新基线哈希仍匹配的 workitem.md；保存前再次检查哈希与编辑器未保存状态。每项文件锁协调插件的多个窗口；不能保证阻止外部编辑器/进程在最后检查与替换之间写入或恶意替换目录。
- .devops-sync.pending.json 用于处理文档与状态之间的中断。恢复只核对文件并完成状态提交，不覆盖用户文件；检测到额外修改则停止。异常退出后遗留的锁须按 docs/manual-test.md 中步骤处理。
- 组织、项目与 ID 共同确定来源。切换来源会拒绝同步旧来源条目；切换保存目录不会搬动旧文档，也不会扫描旧目录。
- 网络请求超时为 20 秒，响应上限为 5 MB；取消在文件提交前生效，完成文件保存后不回滚。
- 需求与 .devops-sync.json 中的完整基线都可能含内部资料。是否提交 Git 由项目自行决定；建议在变更提交前检查这些文件。插件不会自动提交或推送。

## 验证与打包

~~~powershell
npm run check
npm test
npm run compile
npm run package
~~~

本地安装包生成在 work/devops-connector-0.2.1.vsix。通过 VS Code 扩展面板的“从 VSIX 安装”安装；安装不会发布到 Marketplace。F5 开发方式请停止旧调试后重新 F5。

publisher 当前为本地占位值；未选择分发许可证，也未配置远程仓库。打包跳过许可证检查仅用于本地开发，发布前必须补齐这些信息。

单元测试使用模拟 API，不需要真实 PAT。用户已确认真实项目首次导入成功；新增的旧文件接入、手动同步与差异 UI 仍需按 docs/manual-test.md 联调。可在编译后运行 node scripts/smoke.mjs 加已安装的 Code.exe 路径进行隔离宿主启动检查；它使用 work 下的独立配置，不读取真实项目或 PAT。

后续开发顺序见 docs/roadmap.md。

## 参考

- [Work Items REST API 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-item?view=azure-devops-rest-7.1)
- [Work Item 历史修订 API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/get?view=azure-devops-rest-7.1)
- [VS Code API / SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage)
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
