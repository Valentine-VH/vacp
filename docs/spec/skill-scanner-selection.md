# P2 · Skill Scanner 选型与部署

状态：自有文档技能的异步扫描与审核门禁已接入 Cisco Skill Scanner 2.3.2。外部包导入、Vector 完整包校验、节点分发仍按 P2/P3 实施。上位规范见 [技能安全审核与插件分发](skill-review-and-distribution.md)。

## 选型

首版采用 **Vector 结构校验 + Cisco AI Defense Skill Scanner 的本地分析 + VACP 审核策略**。前两层分别判断包是否符合输入和发现内容风险。VACP 保留批准、阻断、撤销和分发的最终决定权。通过扫描后仍进入人工审核。

| 方案 | 优点 | 首版决定 |
|---|---|---|
| Cisco Skill Scanner | Apache-2.0，有本地静态分析及 JSON 报告，内置 YAML、YARA 和 Python 检查。能复用现成的 Agent Skill 风险规则 | 采用。构建固定发行版与规则，使用本地目录扫描。在实施时实测锁定版本的启用分析器、退出码和 JSON 契约。 [官方文档](https://cisco-ai-defense.github.io/docs/skill-scanner) · [静态分析器](https://github.com/cisco-ai-defense/skill-scanner/blob/main/docs/architecture/analyzers/static-analyzer.md) |
| Snyk Agent Scan | 支持扫描已安装 Agent、MCP 和 Skill，也支持直接指定 Skill 路径。文档区分本地发现与分析端点 | 保留为独立对照候选。首版优先使用可在断网环境复现的目录扫描任务。 [扫描文档](https://github.com/snyk/agent-scan/blob/main/docs/scanning.md) · [CLI 参考](https://github.com/snyk/agent-scan/blob/main/docs/cli-reference.md) |
| 全部自建 | 易定义严格的包格式、大小、允许文件、授权及审核规则 | 保留这些确定性规则。内容规则优先复用 Cisco，避免从零维护多类检测规则 |

首版关闭 LLM、云分析、外部信誉查询和远程仓库拉取，仅接收 VACP 已隔离的本地快照。解析 Cisco 结果后统一生成 VACP 报告，包括引擎版本、规则摘要、文件位置、脱敏摘要和内部处置级别。结构非法或命中过确定性强制规则时阻断。Cisco 内容发现交给配置好的处置映射和人工审核，遇到未知规则或级别时保持待确认。空报告、报告缺字段、非预期退出码、解析异常或超时进入扫描失败。有效的零发现报告进入待审核。

## Vector 复用清单

以下来自本机 `vector-platform@f285dcc`。独立 Scanner 引擎仍未在已查的 Vector 分支确认。

- **直接迁入** `packages/infrastructure/src/skill-packages.ts` 的 `contentDigest` 和路径校验等纯函数，保留行为与错误测试。把 `packages/contracts/src/tool-assets.ts` 的 `skillMetadataSchema` 和 5 MiB 包、512 KiB 单文件、4 MiB 展开、80 文件上限作为初始约束。
- **迁入并适配**同文件的 `skillMetadata`、`packSkill` 和 `unpackSkill`，改用 VACP 自己的契约依赖。规范化处理产生唯一待审版本，再加 VACP 文档类型白名单。现有纯文本草稿仍可编辑，进入审核前统一生成满足元数据约束的快照。
- **直接复用测试思路和可移植样例**来自 `tests/tool-assets.test.ts`，至少覆盖打包往返摘要、危险路径、重复名、文件与目录冲突、数量和大小上限。
- **参考边界**为 `apps/api/src/skill-asset-service.ts` 的版本化存储、限量读取和上游错误处理。空间权限、提交审核、节点租约及下载授权由 VACP 自己实现。

## 部署和扫描任务

首版 Docker Compose 增加一个独立的 `skill-scanner` Python 容器。Node Server 负责 PostgreSQL 任务状态和快照，扫描容器通过专用交换卷读输入、写结果。扫描容器使用 `network_mode: none`，运行非 root，限制 CPU、内存、可写临时空间和进程数。容器没有服务端密钥、数据库连接、Docker socket 或工作空间目录挂载。镜像构建时锁定 Cisco 发行版、依赖和规则；运行时不更新。

1. 提审事务同时写入不可变快照与 `scan_job`。幂等键由空间、快照摘要、引擎与规则版本组成。API 提交后立即返回，审核页展示扫描状态。
2. Server 调度器领取待扫描任务并写入有界输入，以原子重命名提交到交换卷。首版单实例、单并发。按当前任务和执行代次隔离路径，并设置领取租约与运行超时。
3. Scanner 先核对输入摘要，再在独立临时目录扫描。输出 JSON 有大小限制，完成后原子提交结果。Server 校验任务、代次、摘要、报告契约，再在事务中写入结果与审核状态。
4. 宕机或超时后回收过期租约。有上限地重试仅由基础设施导致的失败。旧代次或重复结果不会覆盖新状态。扫描服务离线时，待扫快照继续隔离，该流程不会自动批准。
5. 暂存输入、临时目录和原始报告按期限清理。审核页长期使用脱敏后的结果及版本证据。首版直接复用 PostgreSQL 做任务队列，无需 Redis 或外部分析服务。

## 首版验收

| 编号 | 操作与通过条件 |
|---|---|
| SC01 Vector 校验回归 | 用合规文档包及路径、重复、加密、超限等结构测试样本，验证兼容性和早期拒绝。结构失败不进入内容扫描 |
| SC02 本地引擎 | 在隔离网络的固定镜像内，用干净的技能和来自受控测试集的风险文档扫一遍。记录 CLI、引擎与规则版本，确认可解析报告、风险映射和零发现处理 |
| SC03 失败关闭 | 模拟超时、容器退出、空/坏报告及迟到结果，验证受限重试。失败期间不能批准、安装、绑定或下载，旧执行结果无法改状态 |
| SC04 人工审核 | 审核页展示扫描发现与版本差异，执行批准、驳回和撤销。改动新版本重新进入扫描与审核，旧批准不被继承 |
| SC05 节点分发 | 用两个 Mock 节点验证已批准版本按任务授权下载、摘要校验及撤销。未授权和已撤销版本无法启用。P3 再对实际 DSH、OpenCode 验证 |
| SC06 部署隔离 | 验证扫描容器断网、无平台凭据、输入受限及临时数据清理。重启扫描服务后待处理任务可继续，已批准和已撤销版本状态一致 |

验收保留固定版本、镜像摘要、规则版本、测试样本摘要和复现记录。性能用样本实测后固化超时与资源限额。
