# Vector Agent Control Plane（VACP）开发启动规格

> **状态**：v0.1 / 开发启动基线  
> **技术路线**：TypeScript Server + TypeScript Connector / Monorepo / Web + uni-app  
> **面向对象**：Codex（实施者）、项目维护者  
> **更新时间**：2026-11-19  
> **重要约束**：此文档是待实现的产品规格，不代表相关接口已经存在。以文末“Codex 执行指令”和验收条件为准。

## 0. 给 Codex 的任务（先读）

你将从一个可能为空的仓库启动 **VACP** 项目。目标不是完成一份漂亮的架构图，而是建立**可运行、可测试、可逐步交付的代码**。

1. 先检查工作区已有文件、仓库约束及 Git 状态；有现有代码时不得覆盖无关内容。
2. 实施 **M0 基础工程**，接着完成 **M1 最小端到端闭环**。后续里程碑按本文顺序继续，但不得在尚未验证 DSH Runtime API 时杜撰其调用方式。
3. 必须保持 `apps/server` 和 `connectors/dsh` **运行与发布独立**；Server 不依赖 DSH、也不嵌入 LLM 推理循环。
4. 每个里程碑完成时执行检查与测试，修复失败，更新 README、环境变量模板、开发日志与后续 TODO。
5. 优先实现可运行的纵向切片：**用户登录 → Web 创建任务 → Server 调度 → Mock Connector / DSH Connector 接收 → 返回事件 → Web 显示结果**。
6. 工具链、SDK 的最新接口以实际安装版本和官方文档为准。出现不兼容时保持协议与架构边界，调整实现而不是伪造接口。
7. 如果无法运行真实 DSH，使用明确标记为 `mock` 的 Connector 完成集成测试；记录阻塞原因，**不得把 mock 测试描述为真实 DSH 已验证**。
8. 不要一次性引入微服务、Kubernetes、完整工作流引擎、复杂知识图谱、模型网关或自动安装插件等无关能力。

**阶段交付的最低标准**：仓库可安装、可启动、可迁移数据库、可运行自动化测试，Web 能看到在线节点和任务流，文档中的命令真实可执行。

---

## 1. 产品定义

### 1.1 核心定位

**VACP = Agent Control Plane**：面向异构 Agent Runtime 的统一注册、治理、资源共享与任务协作控制平面。

VACP **不是**一个新的 Agent Runtime，也**不是** DSH Desktop 的服务端版本。

- **Control Plane（VACP Server）**：组织/租户、身份认证、Agent Registry、节点连接、Capability Registry、任务调度、事件审计。
- **Data/Execution Plane（外部 Agent）**：DSH、OpenCode、Hermes、DeepAgents 等继续负责推理、对话、工具执行和本地工作区。
- **Connector**：将各 Runtime 的能力与生命周期适配到 VACP 自定义连接协议；每一种 Runtime 可以有独立的包或进程。
- **Shared Services（可选）**：RAG / OpenViking / MCP Server / 对象存储等独立服务，通过 Server 做授权目录和访问代理，不强制改造为 TypeScript。

### 1.2 目标用户与典型场景

1. 运维/开发者在 Web 端查看各主机上的 Agent 是否在线、支持什么能力、当前执行什么任务。
2. 一个 DSH Agent 可以经 VACP 将任务委派给另一个 Agent（DSH 或其他 Runtime），并读取结果。
3. 多个 Agent 使用同一组获授权的 MCP 工具及外部知识检索服务。
4. Web、uni-app 使用同一套后端 API，移动端可以查看任务状态、审批高风险操作、发起简单任务。
5. 将来可扩展团队协作、Skills 目录、任务工作流和多租户配额，且不要求修改 Server 核心运行时。

### 1.3 设计原则

- **Runtime 无关**：Server 不 import `@deepseek-ai/*`，只维护通用 Agent/Node/Task/Capability 模型。
- **协议优先**：Connector 和 Server 通过版本化的网络协议通信；TS 类型共享可以提高效率，但发布包之间不能依赖未公开的内部模块。
- **默认安全**：注册需授权；任务执行需能力许可；写入代码、执行 Shell、访问网络等能力不可被未授权的远程请求直接触发。
- **状态有归属**：任务与审计持久化在 PostgreSQL；WebSocket 只承担实时传输，Redis 不是任务事实来源。
- **至少一次投递**：所有任务要求幂等和可追踪，不承诺外部副作用的 Exactly Once。
- **轻量启动**：第一版一个 NestJS 进程 + PostgreSQL；任务队列逐步引入 Redis/BullMQ（M1 可先用持久化 DB outbox + 单实例 Dispatcher）。
- **移动端独立体验**：uni-app 与 Web 共享 DTO/API 客户端和业务逻辑，不强行共享 Vue UI 组件。

## 2. MVP 范围与非目标

### 2.1 M1 必须完成（P0）

- 管理员登录；最小 `tenant` / `user` / `membership` 权限边界（可预置一个默认租户）。
- 手动创建一次性 Connector 注册凭据；Connector 主动连接 Server。
- 注册 Node 和 Agent，维护在线/离线状态、心跳、能力清单和最近在线时间。
- Admin Web：登录页、节点/Agent 列表、任务列表、任务详情与实时事件。
- Mock Connector：可执行简单任务、返回分片事件，用于自动化测试。
- DSH Connector：独立 TS/Cordis 项目，至少实现身份注册、在线心跳、能力上报、接收任务并回报状态；真实 Agent 运行的适配在接口验证通过后接入。
- 能创建 `Task` 并指定目标 Agent；派发、ACK、运行、成功/失败/取消、事件持久化与实时查看。
- 最小 Demo：Node A 发起委派（REST 或 DSH Tool）→ Node B 执行 → Node A / Web 查看结果。
- `apps/mobile` uni-app 可运行基础壳、登录及 Node/Task 列表；首版不要求完整聊天 UI。
- Docker Compose 开发部署、数据库迁移、健康检查、基本单元/集成/E2E 测试。

### 2.2 第一版明确不做（P2+）

- 自研 LLM 推理、模型路由/计费；接入现有 New API 等外部服务即可。
- 跨节点迁移完整对话上下文、共享本地工作空间、自动恢复任意未完成的工具调用。
- 任意第三方 JS 插件的远程热加载、远程自动安装 npm 包。
- 完整 A2A Gateway、Agent Team DAG/循环编排、复杂审批流、K8s 调度。
- 自研 RAG 索引、文档解析、Embedding；使用外部 RAG/OpenViking/MCP 连接。
- 移动端原生推送、后台持续任务、扫码安装、完整实时聊天。

---

## 3. 固定技术栈（默认基线）

| 层 | 选择 | 说明 |
|---|---|---|
| 主语言 | TypeScript（strict） | Server/Web/Mobile/SDK/DSH Connector |
| 运行时 | Node.js 当前受支持的 LTS（仓库锁定具体版本） | `engines` 和 CI 保持一致 |
| Monorepo | pnpm workspace + Turborepo | 所有 TS 包使用独立 `package.json` |
| Server | NestJS + Fastify Adapter | 业务模块划分清晰，统一依赖注入 |
| REST API | NestJS Controllers + OpenAPI | `/api/v1/`，产出可访问的 OpenAPI 文档 |
| WS | `ws` / NestJS WS Adapter | Connector 双向长连接，单独协议 |
| 数据库 | PostgreSQL + Drizzle ORM | 数据库迁移和索引显式管理 |
| Redis | 按阶段接入 | M2 引入 BullMQ；M1 不依赖它保证任务正确性 |
| Web | Vue 3 + Vite + TS + Pinia + Vue Router | 管理后台；优先保证功能与可访问性 |
| Mobile | uni-app + Vue 3 + TS | 首版 H5 验证，再验证 App/小程序差异 |
| 共享 Schema | Zod | WS 消息、业务模型输入输出校验 |
| HTTP Client | 从 OpenAPI 生成 TS Client | Web/Mobile/Connector 使用稳定契约 |
| 测试 | Vitest / Nest Test / Playwright | 单元、集成、核心场景 E2E |
| 日志/追踪 | Pino + Request ID | JSON 结构化日志，后续接 OpenTelemetry |
| MCP | 官方 TS SDK（按当前版本验证） | 初期只封装外部 MCP 调用，不造协议 |
| A2A | 官方 `@a2a-js/sdk`（M3 可选） | 外部 Agent 互操作，不作为内部节点心跳协议 |

**约束**：首次锁定依赖版本前执行安装与编译验证，不填写未经检查的版本号；禁止大量使用 `any`、`@ts-ignore` 或以伪类型掩盖编译错误。

## 4. Monorepo 目录

```text
vacp/
├── apps/
│   ├── server/                     # NestJS API + WebSocket Control Plane
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── tenants/
│   │   │   │   ├── enrollment/
│   │   │   │   ├── nodes/
│   │   │   │   ├── agents/
│   │   │   │   ├── capabilities/
│   │   │   │   ├── tasks/
│   │   │   │   ├── connector-gateway/
│   │   │   │   └── audit/
│   │   │   ├── common/
│   │   │   └── main.ts
│   │   └── test/
│   ├── web/                        # Vue 管理后台
│   └── mobile/                     # uni-app 移动端
├── connectors/
│   ├── dsh/                        # 独立 DSH Cordis Plugin，独立构建和发布
│   └── mock/                       # 最小 Node Connector，可用于集成测试
├── packages/
│   ├── contracts/                  # Zod schema / WS envelope / 事件定义
│   ├── connector-sdk/              # 与 Runtime 无关的 TS Connector SDK
│   ├── api-client/                 # 生成的 REST API Client
│   ├── config/                     # eslint/tsconfig/prettier 通用配置
│   └── utils/                      # 少量纯函数；避免无意义公共包
├── infra/
│   ├── database/                   # Drizzle schema + migrations + seeds
│   └── compose/                    # compose.yaml 等
├── docs/
│   ├── architecture.md
│   ├── protocol.md
│   ├── development.md
│   ├── security.md
│   └── decisions/                   # ADR，记录关键取舍
├── scripts/
├── .env.example
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── AGENTS.md                         # 从本文提炼 Codex 工作规则
└── README.md
```

**可调整点**：如果 Drizzle 的包管理在仓库内更适合 `packages/database`，允许移动 `infra/database`，但必须统一路径和文档。MVP 不必新建独立 Worker 进程：业务拆模块，进程先保持一个。

## 5. 核心概念与所有权

| 实体 | 含义 | 关键边界 |
|---|---|---|
| Tenant | 租户/组织 | 每次读写都受服务端租户授权检查约束 |
| User | 平台用户 | 管理 Web、Mobile API 身份 |
| Membership | 用户在租户中的角色 | P0：owner/admin/member/viewer；权限由 Server 判定 |
| Node | 已安装 Connector 的执行节点 | 稳定 ID、runtimeType、版本、心跳、连接状态 |
| Agent | Node 对外暴露的可执行单元 | 一个 Node 可承载多个 Agent；Task 目标指向 Agent ID |
| Capability | Agent/Node 暴露的能力元数据 | 工具、任务类型、权限边界；不能仅靠自报权限 |
| Enrollment | 一次性注册邀请/凭据 | 有效期、使用次数、租户归属，验证后颁发节点凭据 |
| Task | 持久化任务 | authoritative state 在 PostgreSQL |
| TaskAttempt | 某次执行尝试 | attemptNo、lease、超时、执行 Node / Agent |
| TaskEvent | 流式进度和终态事件 | 追加式记录，按 taskId + seq 唯一排序 |
| AuditLog | 安全/管理操作审计 | 权限变更、注册、撤销、任务派发等事件 |
| CapabilityBinding | 租户到共享服务的授权 | P1 后接 MCP / RAG 服务，不共享明文密钥 |

**必须区分 Node、Agent、TaskAttempt**：在线的 Node 不意味着 Agent 可执行任务；一次 Task 可以多次尝试，但外部副作用任务不能默认自动重试。

## 6. PostgreSQL 数据模型（第一版）

建议使用 UUID / ULID 做 ID（确定一种并保持统一）。下面是逻辑模型，不是可直接运行的 DDL：

```text
tenants(id, name, status, created_at)
users(id, email, password_hash, status, created_at)
memberships(id, tenant_id, user_id, role, created_at)
enrollment_tokens(id, tenant_id, token_hash, expires_at, max_uses, used_count, revoked_at)
nodes(id, tenant_id, name, runtime_type, runtime_version, connector_version,
      status, last_seen_at, credential_hash, created_at, revoked_at)
agents(id, tenant_id, node_id, external_agent_id, display_name,
       status, capabilities_json, updated_at)
tasks(id, tenant_id, creator_user_id, source_agent_id, target_agent_id,
      title, input_json, status, risk_level, idempotency_key, created_at, updated_at)
task_attempts(id, tenant_id, task_id, attempt_no, node_id, agent_id,
              status, lease_token_hash, lease_expires_at, started_at, finished_at, error_json)
task_events(id, tenant_id, task_id, attempt_id, seq, event_type,
            payload_json, occurred_at, received_at)
audit_logs(id, tenant_id, actor_type, actor_id, action, target_type, target_id,
           metadata_json, created_at)
outbox_events(id, tenant_id, aggregate_id, event_type, payload_json,
              created_at, published_at)
```

数据库最少应有：

- `tenant_id` + 必要业务键的复合唯一约束；跨租户查询不允许以猜测 ID 的方式绕过。
- `task_attempts(task_id, attempt_no)` 唯一；`task_events(task_id, seq)` 唯一。
- `agents(node_id, external_agent_id)` 唯一；Node 断线重连时应复用原身份。
- `tasks(tenant_id, idempotency_key)` 在 key 存在时唯一。
- migration、seed、dev reset、回滚原则和测试数据库隔离。

初期可在服务层做租户过滤与资源权限验证；若未来引入 PostgreSQL RLS，应单独设计而非假设 ORM 自动隔离。

---
## 7. 接口与认证设计

### 7.1 身份类型

**平台用户**与**运行时节点**必须使用不同的身份体系：

- **User Token / Session**：Web 使用安全的 HttpOnly Cookie（开发环境可简化），uni-app 使用短期访问凭据 + 合理的续期流程；仅走平台 REST/SSE。
- **Node Credential**：Node 安装后通过一次性 Enrollment Code 换取专用凭据，只能代表它所属的 `tenant_id`、`node_id`；支持撤销、轮换。
- **Service Credential**（P1）：用于外部 MCP/RAG 集成，不与用户/Node 凭据混用。
- 数据库中仅保存令牌哈希；明文只在颁发时返回一次。日志、异常、任务事件不得记录凭据。

**首次启动**：通过 CLI/环境变量创建首个管理员；生产环境不得使用固定默认账号密码。注册 Connector 采取先授权、后连接，禁止任意 Agent 自助加入未授权的租户。

### 7.2 REST API v1 草案

路径与字段可随实现细化，但必须提供 OpenAPI，并保持同一版本的兼容性。HTTP Controller 每次从认证上下文获得 tenant，**禁止相信客户端传入的 tenantId**。

| 方法 | 路径 | 用途 | MVP |
|---|---|---|---|
| `GET` | `/health/live` | 进程存活 | M0 |
| `GET` | `/health/ready` | 数据库等依赖就绪 | M0 |
| `POST` | `/api/v1/auth/login` | 用户登录 | M1 |
| `POST` | `/api/v1/auth/logout` | 登出 | M1 |
| `GET` | `/api/v1/auth/me` | 当前用户/租户/角色 | M1 |
| `POST` | `/api/v1/enrollments` | 管理员签发一次性注册凭据 | M1 |
| `POST` | `/api/v1/connector/enroll` | Connector 用注册凭据获取 Node 身份 | M1 |
| `POST` | `/api/v1/nodes/:id/rotate-credential` | 凭据轮换 | M2 |
| `POST` | `/api/v1/nodes/:id/revoke` | 管理员撤销节点 | M1 |
| `GET` | `/api/v1/nodes` | 节点列表与在线状态 | M1 |
| `GET` | `/api/v1/agents` | Agent 列表、运行时和能力 | M1 |
| `GET` | `/api/v1/agents/:id` | Agent 详情 | M1 |
| `POST` | `/api/v1/tasks` | 创建任务、指定目标 Agent | M1 |
| `GET` | `/api/v1/tasks` | 任务列表/筛选/分页 | M1 |
| `GET` | `/api/v1/tasks/:id` | 任务详情/最新状态 | M1 |
| `GET` | `/api/v1/tasks/:id/events` | 按 `afterSeq` 获取历史增量 | M1 |
| `GET` | `/api/v1/tasks/:id/stream` | SSE 实时进度、支持 Last-Event-ID | M1 |
| `POST` | `/api/v1/tasks/:id/cancel` | 取消请求、记录取消状态 | M1 |
| `POST` | `/api/v1/tasks/:id/retry` | 授权重试；副作用任务受限制 | M2 |
| `GET` | `/api/v1/capabilities` | 能力目录 | M2 |
| `GET` | `/api/v1/audit-logs` | 审计查询 | M2 |

约定：列表分页、错误码、时间戳（ISO 8601）、Idempotency-Key、统一错误结构都应写入 `packages/contracts`。敏感 API 启用请求体限制与速率限制。CORS 采用白名单，Web Cookie 模式做好 CSRF 保护。

### 7.3 用户 API 返回例子（建议）

```json
{
  "data": {
    "id": "task_01...",
    "status": "queued",
    "targetAgentId": "agent_01...",
    "createdAt": "2026-11-19T00:00:00.000Z"
  },
  "requestId": "req_01..."
}
```

错误建议：

```json
{
  "error": {
    "code": "TASK_TARGET_OFFLINE",
    "message": "Target agent is currently offline",
    "details": {}
  },
  "requestId": "req_01..."
}
```

注：离线是否允许排队是任务策略字段，不一定必须返回错误；错误结构仅为演示。

---

## 8. Connector 控制协议 v1

### 8.1 传输选择

- Connector 由客户端**主动发起** `wss://server/connect/v1` 长连接，以适配 NAT 和本地工作站。
- `Node Credential` 由 Node 环境配置或安全存储加载，Node.js Connector 通过 HTTPS/WS 鉴权头发送；必须经 TLS，不放在普通 URL Query 中。
- UI 用户端不直接连接 Node；用户端 REST/SSE 接收已授权的任务数据。
- 单实例首版可将 Connection Registry 维护在内存；重启后靠 Node 重连恢复。多实例部署时必须新增共享路由/消息总线，禁止假装单实例内存适用于集群。
- 同一 Node 的新连接成功鉴权后替换旧连接（connection epoch），旧连接的迟到消息不能覆盖新状态。
- 在 Server/Connector 两端校验 JSON Schema、包大小、协议版本、消息序号/消息 ID，避免无界缓冲。

### 8.2 消息 Envelope

所有消息统一包裹：

```json
{
  "v": 1,
  "id": "msg_01J...",
  "type": "task.assign",
  "ts": "2026-11-19T00:00:00.000Z",
  "traceId": "trace_01J...",
  "payload": {}
}
```

- `v` 为协议主版本；不兼容变更升级主版本，扩展字段默认可忽略。
- `id` 用于去重/追踪；`traceId` 贯穿跨 Agent 委派。
- 不在消息体信任 `tenantId` / `nodeId` 等自声明身份，权限应由已验证连接上下文确定。
- 统一最大帧尺寸、每连接每秒消息配额、心跳超时及背压策略。实际阈值由配置决定并记录为默认值。

### 8.3 最小事件列表

| 方向 | 事件 | 内容 |
|---|---|---|
| Client → Server | `node.hello` | Connector/Runtime 版本、能力、协议版本 |
| Server → Client | `node.welcome` | Node ID、连接 epoch、心跳配置 |
| Client ↔ Server | `node.ping` / `node.pong` | 心跳、延迟测量 |
| Client → Server | `agents.sync` | 节点内 Agent 列表和能力快照 |
| Server → Client | `task.assign` | Task ID、Attempt、目标 Agent、输入、租约 |
| Client → Server | `task.ack` | 是否接受、拒绝原因，含 task/attempt ID |
| Client → Server | `task.started` | 真正开始执行 |
| Client → Server | `task.output` | 追加文本/结构化结果分片 |
| Client → Server | `task.completed` | 成功终态与输出摘要/产物引用 |
| Client → Server | `task.failed` | 失败终态、可重试标记 |
| Server → Client | `task.cancel` | 取消请求 |
| Client → Server | `task.cancelled` | Agent 已确认停止 |
| Client → Server | `task.cancel_rejected` | 无法安全停止及原因 |
| 双向 | `protocol.error` | 错误码、原消息 ID，不包含秘密 |

**最小 task.assign 示例：**

```json
{
  "v": 1,
  "id": "msg_assign_001",
  "type": "task.assign",
  "ts": "2026-11-19T00:00:00.000Z",
  "traceId": "trace_001",
  "payload": {
    "taskId": "task_001",
    "attemptId": "attempt_001",
    "targetAgentId": "agent_001",
    "leaseId": "opaque_lease_token",
    "deadlineAt": "2026-11-19T00:10:00.000Z",
    "input": {
      "kind": "prompt",
      "text": "请总结这段演示文本"
    }
  }
}
```

**注意**：以上是 VACP 自定义内部控制协议，**不是 MCP/A2A 官方消息格式**。MCP 处理工具/资源访问；A2A 处理标准化对外 Agent 互操作；二者与内部 WS 协议通过 Adapter 连接，不要命名混淆。

### 8.4 Connector SDK 接口（建议而非强制代码）

```ts
export interface AgentRuntimeAdapter {
  readonly runtimeType: string;
  listAgents(): Promise<AgentDescriptor[]>;
  executeTask(
    request: ExecuteTaskRequest,
    context: { signal: AbortSignal; traceId: string },
  ): AsyncIterable<RuntimeTaskEvent>;
  cancelTask?(attemptId: string): Promise<void>;
}

export interface ConnectorClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: 'disconnected' | 'connecting' | 'online';
}
```

`packages/connector-sdk` 负责鉴权、握手、重连、心跳、消息校验、去重、错误上报、任务回传和有限缓冲；`connectors/dsh` 只实现 DSH Runtime Adapter 与 Cordis 生命周期。避免每开发一个 Connector 都重写网络层。

---

## 9. 任务状态机与可靠性

### 9.1 Task 状态

```text
queued → assigned → accepted → running → succeeded
   │         │          │         ├──→ failed
   │         │          └─────────┤
   │         └────────────────────┤
   └──────────────────────────────┤
                                  ├──→ cancelled
                                  └──→ timed_out / unknown
```

为避免图示含义不清，状态迁移以代码中显式的 Transition 表为准：

- `queued`：任务持久化，等待目标可用；离线任务可保留队列或按策略拒绝。
- `assigned`：Server 创建 Attempt/Lease 并发出派发消息，等待 ACK。
- `accepted`：Connector ACK 接受，但未执行；ACK 拒绝可回队列或失败，取决于策略。
- `running`：Connector 报告执行开始并刷新租约。
- `succeeded` / `failed` / `cancelled`：终态；只允许合法终态写入。
- `timed_out`：达到 deadline；`unknown`：节点掉线且执行副作用未知，需要人工核查。可以实现为 TaskAttempt 子状态，Task 聚合状态保持可解释。

### 9.2 必须满足的不变量

1. `Task` 创建和待派发 `outbox_event` 在同一个数据库事务提交。
2. `TaskAttempt` 每次执行有唯一 ID 和 attemptNo；重复 `task.assign` 必须由 Connector 去重。
3. 任务状态由 Server 原子检查并更新；晚到的事件（旧 Lease / Attempt）不允许覆盖新的终态。
4. 断线不自动等同于任务失败；可能仍在执行。非幂等副作用任务不能自动重试。
5. 每个 Task 的流式 `seq` 由 Server 分配并持久化，客户端断线后以 `afterSeq` 补读。
6. Server 重启应能从数据库恢复未完成任务和 Outbox；不得靠 WS 内存数据恢复历史。
7. 请求取消不等于取消成功；需等待 Connector 确认或明确展示 `cancel_requested`。
8. 任何最终结果的授权检查必须基于 task、tenant 与 actor，而不是仅凭知道 `taskId`。

### 9.3 M1 实现复杂度控制

- **M1**：单 Server 实例 + PostgreSQL 持久化任务/Outbox + 定时 Dispatcher；Connector mock 支持可中断任务；连接丢失按状态机安全处理。
- **M2**：独立 Worker 进程、Redis/BullMQ、更多并行与负载策略；保持 PostgreSQL 权威状态和幂等不变。
- **M3+**：多 Server 实例、Connection Ownership、跨实例路由、租约 fencing/切换策略，必要时增加事件总线。

这样初期不会因为队列组件过多而阻碍验证，但关键可靠性路径从一开始就建立。

---

## 10. DSH Connector 独立子项目

### 10.1 定位与禁止事项

`connectors/dsh` 是一个**可独立安装/升级的 TypeScript Cordis 插件**，不是 Electron Desktop 插件，也不是 Server 进程插件。

- 适配 Web/CLI/Headless 等 DSH Host，具体兼容范围必须按测试过的 DSH 版本声明。
- 引入 `packages/connector-sdk` 和 `packages/contracts` 的已发布稳定接口，不 import `apps/server/src/*`。
- 不 Fork DSH 内核，不修改其 Agent Loop；通过官方插件与 service API 接入。
- 网络连接、定时器、事件监听必须绑定 Cordis `ctx.effect()` 生命周期，在卸载时释放。
- 禁止通过插件隐式向其他节点暴露本地任意工具、文件和 Shell；先上报能力元数据，再由授权策略决定任务是否可调用。

### 10.2 官方 API 验证与实现步骤

1. 先编写最小 Cordis Plugin：`apply(ctx, config)`，能正确安装/卸载，配置 Server URL 和 Credential。
2. 以官方开发文档为准验证 `ctx.effect`、`inject`、`ctx.tools.register`、`defineTool` 等可用 API。
3. 接入通用 `ConnectorClient`：建立连接、心跳、重连，显示在线状态。
4. 将可识别的 DSH Agent / Runtime 能力映射为 VACP `AgentDescriptor`；无法从公开 API 可靠枚举时，先配置一个显式默认 Agent，不伪造动态发现功能。
5. 调研 DSH **真实执行任务 API**（本地 Agent SDK、SubagentProvider、事件/Session 入口等），必须能被测试用例证明可触发、可监控、可取消或明确记录无法取消。
6. 实现 `vacp_delegate_task`（或同等命名）模型可调用 Tool：向 Server 请求委派任务；由 Server 检查执行权限，不直接在插件内信任模型生成的目标 ID。
7. 在 DSH 真实执行适配未完成时，保持 DSH Connector 的连接/上报功能与 Mock Runtime 明确分离，不对用户虚假承诺远程 DSH 执行已经可用。
8. 最后制作可独立安装的插件包，记录兼容版本、安装步骤和最小配置，支持在仓库外安装验证。

**已核对的 DSH 扩展入口**：官方 Cordis 使用 `apply(ctx)`；`ctx.effect` 管理生命周期；`ctx.tools.register(defineTool(...))` 是支持的 Tool 注册方式。**本规格没有假定某个未经核实的 DSH `executeAgent()` API。**

### 10.3 DSH 插件配置字段（示例）

```yaml
vacp:
  serverUrl: "https://vacp.example.com"
  nodeName: "workstation-dsh"
  credentialEnv: "VACP_NODE_TOKEN"
  enabled: true
  allowRemoteExecution: false   # 默认关闭，由用户显式开启
```

这只是**目标配置结构**，不是声称 DSH 已支持此 YAML 形式；实际插件配置遵循 DSH Manifest / Cordis Schema 规范。

### 10.4 安全边界

- `allowRemoteExecution` 默认 `false`；本地用户明确启用后才接收执行任务。
- 任务声明 `riskLevel` 和所需 capability，Service 侧授权与 Node 侧本地策略**双重校验**。
- 不把环境变量、模型 API Key、私有工作区文件写入任务事件。
- 不默认允许远程 Shell/任意路径读写；需要单独授权、可见审计及未来审批策略。
- 插件包由客户端主动安装，Server 不下发任意 JS 代码执行。

---

## 11. Web / uni-app 规划

### 11.1 Web（M1 必须可用）

核心页面：

1. 登录 / 当前租户信息。
2. Dashboard：在线节点数、Agent 数、近 24h 任务数量、失败任务数。
3. Nodes：名称、Runtime、Connector 版本、在线状态、上次心跳、撤销操作。
4. Agents：所属 Node、能力、是否可调度、最近任务。
5. Tasks：创建任务、指定目标 Agent、状态筛选、分页、取消。
6. Task Detail：按 seq 展示任务事件与输出片段、失败原因、追踪 ID。
7. Enrollments：管理员生成一次性接入凭据，显示一次后隐藏。

要求：合理的 loading/error/empty 状态；列表分页；用户只能访问已授权租户的数据；历史事件由 REST 加载，实时事件由 SSE 接续，不能仅靠前端内存。

### 11.2 uni-app（M1 骨架，M2 完善）

- 与 Web 共用 `api-client`、数据 DTO、权限判断辅助函数。
- 独立适配 uni-app 的网络、储存与路由接口；不能把浏览器 `window`、`localStorage` 等直接封装进共享库。
- 首版页面：登录、节点/Agent 列表、任务列表、任务详情、简单任务创建。
- M1 可以采用定时拉取任务增量，避免假设所有小程序平台原生支持标准 SSE；M2 再接平台兼容的实时通道。
- API Token 优先保存在合适的平台安全存储；必须避免将长效管理员凭据硬编码在客户端。

### 11.3 UI 风格

优先简洁的开发者工具风格：信息密度高、操作明确、支持深浅色主题，移动端自适应。首版不要为复杂可视化/3D 关系图拖慢任务闭环。

---

## 12. 可选共享能力（后续阶段）

### 12.1 Capability Registry（M2）

统一注册目录可包含：

```text
Capability
├── tool             # MCP 工具或代理工具
├── knowledge        # 外部 RAG / OpenViking 知识空间
├── skill            # 元数据、版本、安装指引
├── agent            # 可委派的 Agent 能力
└── workflow         # 预定义任务模板，暂不实现复杂 DAG
```

记录 `tenant_id`、owner、能力 Schema、源地址/服务 ID、版本、可见性、访问策略与健康状态。远程 MCP 调用应在**身份映射、授权和审计**后代理，而不是将服务端主密钥给所有 Agent。

### 12.2 RAG / OpenViking（M2/M3）

通过 HTTP 或 MCP 连接现有知识库，不在 VACP 中重建向量索引。支持：知识空间列表、租户/用户/Agent 授权、检索请求、引用来源回传。已有 Milvus、Embedding、Reranker、MinerU 等外部设施可以独立运行。

### 12.3 A2A（M3）

将 VACP Agent Registry/Task Adapter 与官方 A2A SDK 对接，目标是与非 VACP 的 Agent 做标准互操作。**不要把私有 WS `node.hello` 等控制消息错误地当成 A2A 实现。**

---

## 13. 安全、运行与可观测性

### 13.1 P0 安全清单

- [ ] 首次管理员凭据可安全初始化，数据库存哈希，生产禁止预设万能账号。
- [ ] REST/WS 均鉴权；Tenant 所有权从凭据解析；禁止跨租户读取 Task/Node/Agent。
- [ ] Enrollment Token 一次性或限次、可撤销、有效期短；Node Credential 可撤销。
- [ ] WebSocket 校验消息大小、版本、类型、频率；断连释放资源；敏感字段日志脱敏。
- [ ] 输入 Zod 校验；输出不泄露堆栈、数据库错误、秘密。
- [ ] 工具执行有显式授权；远程执行默认关闭；未知/高风险任务拒绝或留待审批。
- [ ] 任务事件不包含原始环境变量或大体积敏感文件；大产物未来使用对象存储引用。
- [ ] 取消与重试有审计；不能跨节点伪造 Attempt/Lease。
- [ ] 仅 TLS 连接用于生产；开发 HTTP/WS 仅用于本地环境。

### 13.2 监控指标（M1 最少日志，M2 指标）

- 当前已认证 Node/Agent 数及在线率。
- 心跳延迟、连接断开次数、失败握手次数。
- 任务创建/派发/接收/完成/失败数量；各阶段耗时。
- 任务等待时长、Lease 过期次数、重复消息去重数。
- API P95 延迟、数据库连接池和 Outbox 待处理数。

日志含 `requestId`、`traceId`、`tenantId`（不包含秘密）、`nodeId`、`taskId`、`attemptId`，并设置合理的日志等级与保留策略。

### 13.3 部署形态

M1 开发 Compose：

```text
vacp-server   # NestJS API + Connector WS + Outbox Dispatcher
postgres      # 任务/用户/节点/审计持久化
vacp-web      # 静态 Web（也可用 Vite 开发服务）
mock-node-a   # 演示/自动化测试可选
mock-node-b   # 演示/自动化测试可选
```

M2 增加 Redis/BullMQ、独立 worker 进程。生产建议反向代理统一 HTTPS/WSS，配合受控 CORS、连接上限、健康检查、自动重启和数据备份。

---
## 14. 里程碑与实施顺序

### M0 — 工程初始化（必须先交付）

**目标**：空仓库也可以稳定启动并执行检查。

- [ ] 初始化 Git、pnpm workspace、Turborepo、ESLint、Prettier、strict TSConfig 和统一脚本。
- [ ] 建立 `apps/server`：NestJS + Fastify、健康检查、配置验证、结构化日志、Swagger/OpenAPI。
- [ ] 建立 `apps/web`：Vue 3 + Router + Pinia，基础布局、路由与 API 请求层。
- [ ] 建立 `apps/mobile`：uni-app + Vue 3 + TS，至少有可构建的首页；确保 H5 运行。
- [ ] 建立 `packages/contracts`、`packages/connector-sdk`、`packages/api-client` 的边界与构建脚本。
- [ ] 建立 `connectors/dsh`、`connectors/mock` 两个独立包；DSH 暂为可编译的插件壳。
- [ ] 建立 PostgreSQL Compose、Drizzle schema、迁移、seed 工具。
- [ ] 配置 `.env.example`、`.gitignore`、README、`AGENTS.md`、CI 检查。
- [ ] 执行 `pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`；修复失败。

**验收**：一条仓库脚本启动 Server、Web、Mobile H5；健康检查有响应；数据库迁移可重复运行；在不安装 DSH 的情况下其余项目可构建。

### M1-A — 身份、节点、Agent 的最小闭环

- [ ] Tenant/User/Membership/Enrollment/Node/Agent 基础表、迁移与 seed。
- [ ] 用户登录与鉴权；默认租户、管理员角色和跨租户拒绝测试。
- [ ] 管理员生成一次性 Node Enrollment Token。
- [ ] Mock Connector 从环境变量读取凭据，主动注册、建立 WSS/WS、握手、心跳、能力同步。
- [ ] 支持 Node 凭据撤销、离线状态、重连使用原 Node ID、旧连接失效。
- [ ] Web 展示 Node/Agent 列表和最近在线时间。
- [ ] DSH Connector 以 Cordis 方式安装和卸载，验证连接生命周期（尚不要求 DSH 真正执行任务）。

**验收**：两台 Mock Node 在线，Web 可见，断开后状态更新，重连不产生重复 Node，撤销节点立即失去控制权限。

### M1-B — 任务委派与事件流（第一版核心价值）

- [ ] Task / Attempt / Event / Outbox 数据表、迁移、索引。
- [ ] `POST /tasks` 创建任务并写出站事件；单实例 Dispatcher 派发给目标在线 Node。
- [ ] Mock Runtime 支持分片输出、正常成功、失败、取消、延迟、重复消息、模拟断线。
- [ ] 实现 ACK、任务状态迁移、Attempt/Lease 校验、超时、幂等。
- [ ] Server 按 seq 持久化 TaskEvent，提供 REST 增量与 SSE。
- [ ] Web 创建任务、查看事件、取消任务、失败原因。
- [ ] uni-app 可以登录、看到 Agent 与 Task 列表并创建简单任务。
- [ ] 模拟 Agent A → Agent B 委派任务的演示（通过 Connector SDK API 或已验证的 DSH Tool）。

**验收**：两个 Mock Node 完成一条跨节点任务。断开 Web 后重连能从数据库补读不丢日志；Server 重启后任务记录存在；重复 ACK/终态事件不会破坏状态。

### M1-C — DSH 真实 Adapter 可行性验证

- [ ] 在指定且记录版本的 DSH Web/CLI/Headless Host 安装插件包。
- [ ] 注册 `vacp_delegate_task` 工具，并通过 DSH 模型调用此工具向 Server 创建任务。
- [ ] 验证 DSH 是否提供可受控启动 Agent 任务的稳定 API，确认会话隔离、消息事件和取消语义。
- [ ] 如果能实现，完成 `AgentRuntimeAdapter.executeTask()` 与结果回传。
- [ ] 如果暂时没有合适 API，则提交 `docs/dsh-integration-findings.md`：支持/不支持的接口、最小可行替代、阻塞点、下一步实现，不编造虚拟完成状态。

**验收**：至少真实 DSH 可以作为**任务发起方**。是否能成为真正的**被调度执行方**，由此阶段的源码验证和集成测试决定，不把尚未验证能力列为 M1-B 的阻塞。

### M2 — 能力中心与可靠性增强

- [ ] Capability Registry、工具/知识库授权策略。
- [ ] MCP 工具注册、搜索、授权调用链，至少一个测试用 MCP Server。
- [ ] 外部 RAG/OpenViking 作为独立服务接入（选一条验证）。
- [ ] Redis/BullMQ（确有需要时）与 Outbox 可靠投递、独立 Worker。
- [ ] 节点凭据轮换、审批或限制高风险任务、审计检索。
- [ ] Web 与 uni-app 细化，Mobile 的实时兼容方案验证。
- [ ] 简单的并发限额、重试策略、工具超时、任务取消语义。

### M3 — 多 Runtime / 多实例与标准化协议

- [ ] OpenCode、Hermes、DeepAgents Connector：逐一验证各自的 Agent Runtime 入口。
- [ ] A2A Adapter：对外提供 Agent Card / Tasks，兼容官方 SDK。
- [ ] 多 Server 实例连接归属及跨实例消息路由；有负载测试再决定是否独立 Gateway。
- [ ] Skills Registry、版本化同步和可信分发。
- [ ] 可选任务 DAG、Agent Team 与共享任务经验。

---

## 15. 测试与验收矩阵

| 类别 | 必须覆盖 |
|---|---|
| 构建 | 每个 workspace 包独立构建；Server 不依赖 DSH 包 |
| 单元 | Schema 校验、状态迁移、权限判定、消息去重、任务序号 |
| API | 成功/失败登录、跨租户资源拒绝、Enrollment 一次性使用、Task CRUD |
| 协议 | 版本不兼容、无效消息、Token 过期、心跳超时、重连覆盖旧连接 |
| 集成 | Postgres 迁移、持久化 Task/Outbox、Mock Connector 派发和结果回传 |
| 幂等 | 重复创建请求、重复 assign、重复 ack、重复 completed |
| 恢复 | Server 重启、Connector 断线重连、Web SSE 重连并补历史 |
| 安全 | 非授权执行拒绝、越权 Agent/Task 查询拒绝、撤销节点不可继续接任务 |
| Web E2E | 管理员登录、注册 Node、创建任务、查看实时结果 |
| Mobile | uni-app H5 构建和基本 API；各平台 API 差异留在适配层 |
| DSH | 独立安装/卸载、没有悬挂 WS/定时器、真实 Tool 调用验证 |

**M1 最终演示（必须录入 README 的人工验证步骤）：**

1. 启动 `postgres`、`vacp-server`、`vacp-web`。
2. 初始化管理员并登录 Web。
3. 生成两个不同的一次性 Node Enrollment Token，运行 Mock Node A/B。
4. Web 出现两个在线 Node 和对应 Agent。
5. 在 A 发起 `delegate`（或 Web 手动创建任务）交给 B。
6. B ACK、执行、分片回传；Web 可观察任务状态变化和连续输出。
7. 刷新 Web、重启 Server，历史任务仍可追踪。
8. 撤销 B 的凭据并尝试重连，必须失败；对已撤销的 B 不再派发任务。
9. 使用两个租户的用户交叉请求 Node/Task，必须返回授权失败。
10. 完成一次真实 DSH 插件加载/卸载测试，并注明实际 DSH 版本和已验证的功能。

### 15.1 质量门槛

- CI 无类型错误、Lint 错误、单元/集成测试失败。
- 禁止因缺环境/服务而静默跳过核心测试；集成测试依赖需通过 Compose/Testcontainers 启动或明确失败。
- 不出现未受控的明文密钥、默认管理员密码或跨租户数据暴露。
- 所有外部可用 API/WS 消息要有文档、Schema、错误语义和基本测试。
- 如果某项验证做不到，列出 `BLOCKED` 项以及代码位置，而不是宣称完工。

---

## 16. 开发命令（约定的目标脚本）

> 这些是 Codex **需要在仓库中实现并验证**的命令，不是当前已经存在的脚本。允许用同等简洁的命名替换，但 README 必须保持一致。

```bash
# 安装依赖
pnpm install

# 本地基础设施
pnpm infra:up
pnpm db:migrate
pnpm db:seed

# 全栈开发；初期至少 server + web + mobile:h5
pnpm dev

# 单独项目
pnpm --filter @vacp/server dev
pnpm --filter @vacp/web dev
pnpm --filter @vacp/mobile dev:h5
pnpm --filter @vacp/connector-mock dev

# 质量检查
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build

# 完整演示测试
pnpm demo:e2e
```

建议的 `.env.example`（仅字段名示例，具体服务应分别校验）：

```dotenv
NODE_ENV=development
SERVER_HOST=127.0.0.1
SERVER_PORT=3000
DATABASE_URL=postgres://vacp:change_me@127.0.0.1:5432/vacp
PUBLIC_BASE_URL=http://127.0.0.1:3000
WEB_ORIGIN=http://127.0.0.1:5173
SESSION_SECRET=replace_with_long_random_value
LOG_LEVEL=info
# 仅当引入 Redis/BullMQ 时启用
# REDIS_URL=redis://127.0.0.1:6379
# 仅在 Mock/DSH Connector 的本地环境中配置，不提交到 Git
# VACP_NODE_TOKEN=...
```

开发默认只绑定本机；Docker Compose/反向代理部署按环境显式配置监听地址和 TLS。演示种子数据不得使用可预测生产密钥。

---

## 17. Codex 的工程规范

创建仓库根目录 `AGENTS.md`，至少包括如下规则：

1. **遵循本文件**，优先保证 M0/M1 完整闭环；不要自作主张引入大型框架或改造成微服务。
2. 开始修改前检查现有项目、包管理配置、Git 状态及已实现功能。
3. 每次实现一个可验证的纵向功能切片；修改前后运行相关测试。
4. TypeScript 使用 `strict: true`；输入数据统一通过 Zod 运行时校验，避免 `any`、不安全断言和滥用非空断言。
5. 按 API/Domain/Infrastructure/Connector 分离依赖，禁止 Server 引入 DSH Runtime。
6. 新增接口必须有 Schema、类型、权限检查、错误码和测试；跨租户测试不可省略。
7. 任务状态只通过统一 State Machine 转换，所有事件可追溯；禁止多个模块直接随意改 `tasks.status`。
8. 真实 DSH 调用 API 先从官方文档和已安装版本验证；不确定则用 Mock 标注替代并提交技术记录。
9. 客户端凭据不得输出到日志、任务事件或 README；不得远程执行未经批准的 Shell 命令。
10. 依赖通过 lockfile 固定；每个发布包有独立可运行测试；不要将 Workspace 内部路径写入插件发布产物。
11. 始终更新 README（启动/测试/配置）、`docs/decisions/`（重大架构选择）及 `docs/progress.md`（完成/阻塞/下一步）。
12. Codex 应尽可能直接编写并执行代码，不只给出实施建议；无法执行时说明具体环境限制。

## 18. 最终决策与开放问题

### 已决定（不要重复争论）

- **Server：TypeScript / NestJS + Fastify**。
- **DSH Connector：独立 TypeScript Cordis 插件子项目**。
- **Web：Vue 3 / Vite / TypeScript**。
- **Mobile：uni-app / Vue 3 / TypeScript**。
- **Monorepo：pnpm workspace + Turborepo**。
- **数据库：PostgreSQL + Drizzle**，Server 是权威数据源。
- **内部连接：主动 WebSocket + 私有 v1 控制协议**。
- **外部生态：MCP / A2A Adapter（分阶段接入）**。
- **Agent 推理：由各 Runtime 自己运行，VACP 不承接通用 LLM Agent Loop**。

### 需要在源码验证后确定（允许 Codex 给出 ADR）

- DSH 当前版本是否提供稳定的被动远程任务启动与取消接口。
- DSH 插件打包/安装机制、兼容版本和 Desktop/Headless 运行区别。
- uni-app 要覆盖的目标平台（首版 H5；App/小程序在后续扩展）。
- M2 是否需要 BullMQ、Redis，及其是否优于继续使用 DB Outbox。
- 未来是否提供独立 A2A 服务地址、是否接 OpenViking/已有 RAG API。

### 不必阻塞 M0/M1 的产品问题

自定义域名、完整 RBAC 权限点、审计保留时长、公开插件市场、自动部署 Agent、模型接入计费、任务 DAG 编辑器等应按优先级进入后续计划，不要影响首个闭环。

---

## 19. 可直接交给 Codex 的开工指令

将本 Markdown 放到仓库根目录，向 Codex 发送下面这段话即可：

```text
请阅读仓库根目录的 VACP_Codex_Kickoff.md，并将其作为 Vector Agent Control Plane 项目的开发基线。

本次先直接实施 M0 和 M1-A，再尽可能完成 M1-B：
1. 检查当前仓库，不覆盖已有内容；初始化 pnpm + Turborepo TypeScript Monorepo。
2. 创建 NestJS/Fastify Server、Vue 3 Web、uni-app H5、共享 contracts、Connector SDK、DSH Connector 壳和 Mock Connector。
3. 创建 PostgreSQL/Drizzle 迁移、基础登录与 Enrollment/Node/Agent 模型。
4. 打通 Mock Connector 的注册、WebSocket 心跳、能力同步和 Web 节点列表。
5. 在可用环境中继续实现 Task、Attempt、Outbox、WS 派发、流式事件和 Web Task 页面。
6. 对 DSH 只使用当前实际版本确认存在的 Cordis API；真实执行入口未验证时不伪造，记录到 docs/dsh-integration-findings.md。
7. 运行安装、lint、typecheck、test、build 和适用的 E2E；修复错误。
8. 产出 README、AGENTS.md、.env.example、docs/progress.md，并总结已完成、验证结果与剩余阻塞项。

坚持 Server 不依赖 DSH、凭据隔离、租户权限校验、任务持久化与幂等。不必先做 MCP Gateway、RAG、A2A、复杂调度和 Kubernetes。
直接执行代码实现，不要只输出建议或先设计数十个空模块。
```

---

## 20. 参考项目与官方文档（实施时核查现行版本）

- DeepSeek Harness：[主仓库](https://github.com/deepseek-ai/deepseek-harness) · [Cordis 第一个插件](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/01-first-plugin) · [插件生命周期](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/) · [Tool 扩展](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool) · [插件打包](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)
- MCP：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- A2A：[官方 JavaScript SDK](https://github.com/a2aproject/a2a-js)
- NestJS：[官方文档](https://docs.nestjs.com/)
- Drizzle：[官方文档](https://orm.drizzle.team/)
- Turborepo：[官方文档](https://turborepo.com/docs)
- uni-app：[官方文档](https://uniapp.dcloud.net.cn/)
- OpenViking（可选共享上下文服务）：[GitHub](https://github.com/volcengine/OpenViking)

---

**一句话验收标准**：一个不依赖任何 DSH 内核的 VACP Server，能够认证、发现和管理两个主动连接的 Agent 节点，可靠地派发并记录跨节点任务；Web 与 uni-app 能访问同一份受授权保护的任务状态；DSH 通过独立 TS 插件接入，并逐步替换 Mock Runtime。
