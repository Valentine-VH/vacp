# VACP

Vector Agent Control Plane 工作目录。产品规格见 [VACP_Codex_Kickoff.md](VACP_Codex_Kickoff.md)。

正式工程使用 Node 26.13.1 和 pnpm 11.28.5。Server 启动时初始化 PostgreSQL 身份表，React + Ant Design 控制台支持自助注册、登录、创建工作空间和配置成员角色。首次登录可直接创建账户。Owner 可以添加已注册用户，Admin 可以管理 Member 和 Viewer。uni-app 当前提供 H5 首页。原身份 PoC 独立保存在 `poc/identity`。

本地开发的写请求要求来源为 `http://127.0.0.1:5176`。部署到 HTTPS 同源入口时，通过 `WEB_ORIGIN` 设置实际入口，并设置 `NODE_ENV=production` 启用 Secure 会话 Cookie。

在项目目录使用 Node 26 后运行：

```powershell
$env:POSTGRES_PASSWORD = Read-Host 'PostgreSQL password' -MaskInput
$vacpDatabasePassword = [uri]::EscapeDataString($env:POSTGRES_PASSWORD)
$env:DATABASE_URL = "postgres://vacp:${vacpDatabasePassword}@127.0.0.1:55439/vacp"
npm exec --yes --package=pnpm@11.28.5 -- pnpm install --frozen-lockfile
npm exec --yes --package=pnpm@11.28.5 -- pnpm infra:up
npm exec --yes --package=pnpm@11.28.5 -- pnpm dev
```

首次启动时设置一个新的数据库密码。已有 PostgreSQL 数据卷时，使用初始化该数据卷时的密码。

Web 地址为 http://127.0.0.1:5176，移动端 H5 为 http://127.0.0.1:5177，API 为 http://127.0.0.1:3320。健康检查分别走 `/health/live` 和 `/health/ready`，后者检查 PostgreSQL。将上述最后一条命令的 `dev` 换成 `typecheck` 或 `build` 可执行检查或构建。

## 系统管理

空数据库首次注册的账户是超管，后续账号默认是普通用户。已有且只有一个账户的数据库升级时，该账户会成为超管。超管可访问系统管理的工作空间、用户、角色、菜单和系统页，并从用户页调整平台角色。系统必须保留至少一位超管。平台角色与工作空间角色独立，空间业务接口继续校验成员关系。

## 模型网关

工作空间 Owner / Admin 在「模型网关」添加上游模型，再签发绑定一个模型别名的网关 Key。客户端的 Base URL 使用控制台域名加 `/v1`，模型名填网关别名。网关支持 `GET /v1/models` 和 `POST /v1/chat/completions`，可转发 SSE。每个 Key 按固定分钟窗口限流，撤销 Key 或停用线路从新请求起生效。部署反向代理时将 `/v1` 转发到 Server 并禁用 SSE 缓冲。

公网 HTTP / HTTPS 上游可直接添加。部署者可通过 `VACP_GATEWAY_ALLOWED_ORIGINS` 配置逗号分隔的精确 Origin，以接入内网服务或使用服务器配置的出站代理。Base URL 支持查询参数和 URL Basic 认证，使用 Basic 时 Bearer Key 留空。查询参数和上游凭据以 AES-256-GCM 加密，开发密钥保存在被 Git 忽略的 `.gateway-key`，生产设置 `VACP_GATEWAY_ENCRYPTION_KEY`（32 随机字节的 64 位十六进制）。网关 Key 只显示一次，数据库保存哈希。周期和总 Token 额度留待后续实现。

开发时可通过 `VACP_SERVER_PORT` 指定 API 监听端口，Web 的 `VACP_DEV_API_PORT` 指向对应端口。默认均为 `3320`。

## 插件市场

侧栏「插件市场 → VACP 发布」提供 DeepSeek Harness 和 OpenCode 的版本包、SHA-256 和安装指南。客户端通过工作空间权限访问同一目录。DSH 内的「VACP → 插件仓库」支持校验后下载，OpenCode 安装包内的 `cli.js` 支持终端登录、列出版本和校验下载。发布目录和接口见 [Agent 插件发布说明](plugins/releases/README.md)。

「插件市场 → GitHub 来源」支持按仓库名搜索（例如 `DSH-*`）或按客户端发现热门插件。工作空间所有者和管理员可从搜索结果添加条目，也可以直接提交公开仓库地址。成员可查看仓库和 Releases，按作者说明安装。服务端需要访问 `api.github.com`，可选环境变量 `VACP_GITHUB_TOKEN` 用于提高 API 频率限制。

## Agent 插件账号登录

用户在插件中填写 VACP 服务地址并用现有邮箱和密码登录。Owner / Admin 在「模型网关」「技能管理」「MCP 服务」维护各自资源。「VACP Agent → 已登录设备」在插件登录后即显示有权访问当前工作空间的设备。工作空间管理员可查看成员的设备，普通成员可查看自己的设备。撤销作用于当前工作空间。只读成员的工作空间不会进入插件模型目录。

以下路径以 `/api/v1/agent-plugin-auth` 为前缀。先调用 `POST /account/login`，提交 `email`、`password`、`plugin`、`device`、`version`。以返回的 `accountToken` 作为 Bearer 获取 `GET /account/workspaces`，并调用 `POST /account/workspaces/:id/session` 取得空间级 `accessToken`。资源请求使用空间级 Bearer，退出登录调用 `DELETE /account/session` 并清除本地凭据。

- `GET /config` 返回当前空间启用的模型、仍审核通过的已安装 Skill、启用的 MCP。返回值不含上游认证密钥。
- `GET /account/workspaces/:id/resources` 使用账号令牌读取指定空间的资源目录。Skill 包含该空间自己已审核发布的版本，以及该空间已安装且仍通过审核的版本。MCP 目录只显示已启用服务的名称和认证方式。
- DSH 用空间会话令牌直接访问 `/v1/models` 和 `/v1/chat/completions`，同一用户在同一工作空间内每分钟最多请求 60 次，跨模型和设备共享。网关在请求时校验成员、设备会话和模型启用状态。旧客户端仍可用 `POST /model-key` 签发绑定单模型的 Key。
- Skill 的 `path` 返回版本内容及其 `digest`。空间会话凭据不能读取其他空间的 Skill。
- 无认证 MCP 使用 `endpoint` 直连。带认证的 MCP 使用 `path` 和插件登录 Bearer，通过 VACP 转发 Streamable HTTP，服务端代填认证 Key。部署者设置 `VACP_MCP_ALLOWED_ORIGINS` 为逗号分隔的精确可信来源。未允许的来源返回 `requires_proxy` 状态，开发环境可显式允许回环 HTTP。

DSH 试验版可从 Desktop 工作台左侧「VACP」或「设置 → VACP 账号」登录、同步模型，并按工作空间浏览「Skill 仓库」和「MCP 仓库」。在普通会话的原生模型选择器中，从「VACP · 工作空间名」分组选择模型。每个有模型的工作空间注册一个 Provider，按工作空间 ID 区分。账号令牌由 DSH Host 的凭据服务保存，模型调用所用的空间会话令牌留在 Host 内存里。首版按文本 Chat Completions 接入。资源仓库目前用于只读浏览，Skill 与 MCP 的宿主注册仍待实现。旧版连接码接口继续服务已有客户端。

宿主的独立开发环境、并行运行与清理步骤见 [插件联调与隔离测试](docs/plugin-development-sandbox.md)。

「已登录设备」显示客户端上报的主机名和可复制的实例识别号。DSH 使用独立的运行实例标识，同一账号在多个沙箱或同一主机的多份进程可以分别出现在 Chat 客户端列表。实例号在进程内及重连时保持一致，重启进程会生成新号。旧插件仍可使用，设备名等上报后显示。

## MCP 服务

在工作空间的「MCP 服务」登记 Streamable HTTP 地址。Owner / Admin 可以增删、启停、选择无认证或保存 Bearer Token / API Key Header。接口只返回密钥配置状态。编辑时留空保留原密钥，变更地址或认证字段需要重新填写。切换到无认证会清除密钥。

服务端用 AES-256-GCM 加密密钥，再写入 PostgreSQL。开发默认在项目根目录生成被 Git 忽略的 `.mcp-key`，生产通过密钥存储配置 `VACP_MCP_ENCRYPTION_KEY`（32 随机字节的 64 位十六进制）。使用既有密钥恢复备份，避免直接替换该密钥。当前提供服务目录与认证配置。连接测试、工具发现、OAuth 授权与 Agent 绑定是后续能力。

## 技能仓库与市场

自有技能从「技能仓库」提交固定版本，在「版本审核」查看 Cisco Skill Scanner 的异步结果。只有扫描完成且未阻断的版本可以批准。默认由另一位 Owner/Admin 查看内容、SHA-256 和脱敏扫描结果，再填写理由批准或驳回。撤销后市场隐藏该版本，已有安装记录标记为已撤销。此前未扫描的已发布版本进入复审。开发环境可显式设置 `VACP_ALLOW_SKILL_SELF_REVIEW=1` 用于单账号演示。

Docker Compose 包含断网的 `skill-scanner` 容器，首次启动需构建镜像。Server 与容器通过项目下被 Git 忽略的 `.skill-scanner-exchange` 交换文件，扫描状态写入 PostgreSQL。扫描容器不可用时，管理员可在审核页重试暂时失败的任务。无效元数据需修正后提交新版本。

「技能市场」默认浏览 SkillHub，也可切换 ClawHub。Owner / Admin 可选择「导入到仓库」，先预览固定上游版本的 `SKILL.md`，再确认保存。「技能仓库 → 上传 ZIP」也可预览并导入，接受不超过 512 KiB、根目录或一级子目录仅有一个 `SKILL.md` 的 ZIP。两种导入只保留文档，其余文件会在预览中明确列为未导入。

导入后在技能仓库提交版本。通过 Cisco 扫描和管理员审核后，点击「查看可安装版本」，打开详情并安装到当前工作空间。导入技能只在本空间可见。

从顶部选择工作空间，再进入「技能管理」。Owner 和 Admin 可以在「技能仓库」编辑自有技能的名称、描述和 `SKILL.md`，并发布只读版本。发布后进入「技能市场」查看版本详情。其他工作空间也可以搜索、预览并选择安装。安装和卸载只调整当前空间的技能清单，内容可在「已安装」中查看。草稿留在原工作空间。

## 愿景 PoC

完整演示、阶段顺序和验收条件见 [愿景 PoC 实施计划](docs/spec/vision-poc-plan.md)。

## Web 通用聊天组件

`apps/web/src/components/chat` 导出 `ChatPanel`、`ChatTranscript` 和 `ChatComposer`。完整工作台可用 `ChatPanel`，已有页面也可分别复用消息列表和输入框。页面负责会话权限、流式连接、发送和存储，并通过消息状态与回调驱动组件。

通过消息字段启用执行步骤、运行摘要、来源、文件和操作按钮，通过输入配置启用提示词、输入建议、附件、语音或停止生成。在 **Chat** 先选 Agent 客户端，再从左侧打开该客户端的已授权会话。使用 DSH 插件 `0.4.8` 或支持附件的后续版本时，可以发送文件到原会话。超管可在 **系统管理 → 系统 → 全局设置** 管理附件中转，默认开启，每条最多 3 个、合计不超过 256 KiB，同时最多中转 4 条带附件的消息。

## AgentTeams 会话

选择工作空间后进入「AgentTeams」，创建群聊并选择空间成员和 Mock Agent，或和其中一位成员或 Agent 发起私聊。群聊可发送普通消息，或指定群内的一个 Agent 回复；与 Agent 私聊时自动选择该 Agent。Agent 在线依赖下文的 Mock Connector。只有该空间的会话参与者可以读取消息。普通空间角色规则仍适用，Viewer 只读。

## AgentTeams 开发联调

AgentTeams 的模拟回复仍通过 Mock Connector 执行。联调时，工作空间管理员可调用 `POST /api/v1/workspaces/:id/mock-nodes` 注册节点，请求体包含 `name`。在独立 PowerShell 终端使用返回的节点凭据：

```powershell
$env:VACP_NODE_TOKEN = Read-Host '节点凭据' -MaskInput
try { node connectors/mock/worker.mjs } finally { Remove-Item Env:VACP_NODE_TOKEN }
```

节点在线后，在 AgentTeams 中向它发送消息即可验证任务投递和回显。节点用 HTTP 轮询领取任务，超出租约可再次领取。DSH 续聊采用独立的 WebSocket 连接。

## 目录

- `apps/server`：控制平面，提供认证、节点、Agent、任务、API 与连接协议。
- `apps/web`：浏览器管理界面，通过 API 访问服务端。
- `apps/mobile`：独立移动端，首阶段以 uni-app H5 为目标。
- `plugins/dsh`、`plugins/opencode`：各自独立构建和发布的运行时插件，Server 不依赖插件或运行时内核。DSH 插件位置以此目录为准，替代规格中的 `connectors/dsh`。
- `connectors/mock`：用于验证连接与任务流程的模拟连接器。
- `packages/contracts`、`connector-sdk`、`api-client`：共享协议、运行时无关 SDK 和 API 客户端。
- `packages/config`、`utils`：共享配置与必要的纯工具函数。
- `infra/database`、`compose`：数据库迁移、种子数据和开发部署配置。
- `docs/spec`：产品和技术规格；`docs/decisions`：架构决策；`scripts`：开发辅助脚本。

开发时 Web 和 Server 可分别运行；部署时 Web 静态产物可以由 Server 或反向代理提供。移动端和插件继续使用服务端 API 或连接协议。
