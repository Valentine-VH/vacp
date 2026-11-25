# 插件联调与隔离测试

日常迭代使用独立的 DSH Desktop 开发版或 OpenClaw 开发 Gateway。VACP 插件源码留在仓库里，宿主源码、测试状态和用于安装的产物放在专用测试目录。以下 PowerShell 命令应分别在新开的窗口中运行，环境变量随窗口关闭而失效。示例使用 `C:\dev\vacp-host-lab`，可以换成自己的路径。

## DeepSeek Harness Desktop

从 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness) 单独检出需要验证的版本，记录版本或提交。使用该版本要求的 Node.js 和 pnpm。在源码根目录设置独立的 Harness 数据目录和 Electron 数据目录。全新检出的 `dsh-v0.2.3-alpha.2` 需要先生成工作区产物，再用 `start:desktop` 启动。[DSH Desktop 开发文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#develop)

```powershell
$lab = 'C:\dev\vacp-host-lab\dsh'
Set-Location -LiteralPath (Join-Path $lab 'source') -ErrorAction Stop
$env:DSH_HOME = Join-Path $lab 'home'
$env:DSH_DESKTOP_USER_DATA_DIR = Join-Path $lab 'electron-user-data'
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'DSH 依赖安装失败' }
pnpm run build:artifacts
if ($LASTEXITCODE -ne 0) { throw 'DSH 工作区构建失败' }
pnpm run start:desktop
```

把首次创建的默认工作空间也放在测试目录。对于该版本，在测试 `DSH_HOME` 的 `cordis.patch.yml` 按行 ID `workspace-controller` 配置 `config.documentsDirectory`，指向专用测试目录下的 `documents`。DSH 会在这个位置之下创建其默认工作空间。

首次启动时保持日常 DSH Desktop 打开。核对开发版打开了独立窗口，启动日志指向测试目录，并用测试会话确认日常 DSH 未出现该会话。完成这一步后，在开发版加载测试插件。开发版和 VACP 同机运行时，可使用 [VACP 本地开发地址](http://127.0.0.1:5176/)。

### 开启 DSH 续聊

在开发版安装 VACP DSH 插件，在启动开发版的同一窗口设置 `$env:VACP_DSH_REMOTE_CONVERSATIONS = '1'`。登录 VACP 后，从 **VACP → Chat 授权** 选择工作空间，并授权一个已发送消息、未归档的普通会话。页面显示可复制的实例识别号，可与 Web「已登录设备」核对。在同一 VACP 账号的 Web **Chat** 菜单中，先选 Agent 客户端，再从左侧选择该客户端的已授权会话。支持附件的客户端可接收每条最多 3 个、合计不超过 256 KiB 的普通文件。文件保存在原 DSH 会话的宿主存储，Web 消息显示文件卡片。撤销授权后，Web 中对应会话的访问结束。

工作空间所有者和管理员可在 **VACP → 模型 → 添加网关模型** 配置该空间的上游地址、模型别名和 Key。保存后，DSH 模型选择器会在 `VACP · 工作空间名称` 分组中显示该模型，调用使用 VACP 的工作空间凭据和 `/v1/chat/completions`。VACP 管理员可在 Web 的模型网关停用模型或更换上游 Key。

在 Web 的 **模型网关 → 编辑模型** 保存上下文窗口、最大输出、DSH 压缩预留和上游支持的思考强度。DSH 插件 `0.4.7` 通过 **VACP → 模型 → 同步模型** 更新上下文窗口、最大输出及可选的思考档位。思考强度用于支持 OpenAI Chat Completions `reasoning_effort` 的上游，关闭对应 `none`。复制编辑页的已保存压缩策略，将条目合并到开发版对应 Agent 预设中 `compaction-basic` 插件的 `config.modelPolicies`，随后重新加载开发版会话。保留预设中的其他插件和现有模型策略。

插件通过 `/api/v1/dsh-connector/ws` 主动连接 VACP。部署时反向代理需要对此路径转发 WebSocket Upgrade，并对会话的 SSE 路径关闭代理缓冲。续聊转发用户和助手文本，最近消息和生成中的文本来自原 DSH 会话。浏览器断线后重新加载该会话的快照。服务端持久化消息请求 ID 和投递状态。连接中断且未收到回执时显示投递结果未知，重连不会自动重发。

清理时退出开发版并确认其 Host 已停止，再删除对应的测试目录。`pnpm run clean` 用于清构建产物，完整清理还需处理开发版的 Harness 和 Electron 数据目录。pnpm 和 Electron 的共享下载缓存可以保留。

## OpenClaw

使用独立的开发 profile 和前台 Gateway。为测试实例分配自己的状态目录、配置文件、Agent 工作目录及端口。示例使用 `19001`。已有实例占用该端口时，选一个与现有 Gateway 及其派生端口错开的端口。[OpenClaw 开发模式](https://docs.openclaw.ai/help/debugging#dev-profile--dev-gateway---dev) · [多 Gateway](https://docs.openclaw.ai/gateway/multiple-gateways)

```powershell
$lab = 'C:\dev\vacp-host-lab\openclaw'
$env:OPENCLAW_STATE_DIR = Join-Path $lab 'state'
$env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
$env:OPENCLAW_WORKSPACE_DIR = Join-Path $lab 'workspace'
$env:OPENCLAW_SKIP_CHANNELS = '1'
openclaw --dev gateway --dev --port 19001
```

第一个 `--dev` 选择开发 profile。第二个 `--dev` 初始化开发配置和工作目录。上例使用已安装的 CLI。使用官方源码时，可从源码根目录用 `pnpm openclaw` 运行同样的子命令。保持 Gateway 前台运行，以便观察日志和停止进程。[OpenClaw 环境变量](https://docs.openclaw.ai/help/environment#paths-and-instances)

在另一个测试终端重复设置相同的目录变量，再运行 `openclaw --dev plugins install --link <插件目录>`。该命令记录本地链接，适合反复修改插件。插件依赖由插件源码目录自行安装。首次加载后，用 `openclaw --dev plugins inspect <插件 ID>` 核对实际加载来源。[本地插件安装](https://docs.openclaw.ai/cli/plugins/install) · [插件依赖](https://docs.openclaw.ai/plugins/dependency-resolution)

清理时用 `Ctrl+C` 停止测试 Gateway，再删除测试目录。测试插件的原始源码由自己的仓库管理。若测试期间另行注册了系统服务，应先卸载该测试实例对应的服务。

## 安装包验收

DSH Desktop 插件打包后，可用 Windows Sandbox 做干净安装验收。只映射安装器和待测插件产物，优先使用只读映射。使用独立的 VACP 测试账号和工作空间，依次验证安装、登录、模型调用、Skill 读取、MCP 调用、设备撤销与卸载。Windows Sandbox 内的 `127.0.0.1` 指向沙箱自身，登录时使用该环境可访问的 VACP HTTPS 测试地址。[Windows Sandbox 文档](https://learn.microsoft.com/en-us/windows/security/threat-protection/windows-sandbox/windows-sandbox-overview) · [目录映射配置](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

源码开发版和 OpenClaw profile 隔离的是应用状态。若插件进程需要与宿主文件隔离，长期调试使用可保留状态的独立虚拟机。Sandboxie Plus 默认允许读取未封锁的宿主文件，若用它测试，应额外验证文件访问规则。[Sandboxie Plus 文件隔离](https://sandboxie-plus.com/sandboxie/sandboxhierarchy/)

本地环境清理完成后，在 VACP 单独处理测试设备授权、账号和工作空间。完整验收以宿主内的真实安装和调用记录为准。
