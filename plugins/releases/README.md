# Agent 插件发布目录

把准备分发的 VACP 插件包放在本目录。生产环境也可以把 `VACP_AGENT_PLUGIN_DIR` 指向绝对路径。仓库读取文件名中的版本，并为每个包提供大小和 SHA-256。

| 宿主 | 文件名 |
|---|---|
| DeepSeek Harness | `vacp-plugin-dsh-<版本>.tgz` |
| OpenCode | `vacp-plugin-opencode-<版本>.tgz` |

在仓库根目录运行 `npm pack ./plugins/dsh ./plugins/opencode` 生成安装包。先写入临时文件，再重命名为指定文件名。已发布的版本应保持字节不变，升级时添加新版本文件。安装包由部署环境提供。旧版不带版本的文件名仍可用于原有下载入口。

已登录的工作空间成员可从 VACP 侧栏的「插件市场」按版本下载。两个宿主的「安装指南」都提供手动步骤和可复制的安装提示词。提示词固定到指定版本，下载使用浏览器的登录会话。

客户端使用插件账号令牌访问 `GET /api/v1/agent-plugin-auth/account/workspaces/:workspaceId/plugins` 读取 VACP 安装包版本，使用该路径下的 `/:id/versions/:version/download` 下载。客户端的「插件仓库」通过 `/sources` 浏览工作空间的第三方插件来源。打开 DSH 的 VACP 页面时会自动检测自更新，有新版时在「版本更新」中确认。安装前校验更新包，DSH 插件管理器会报告是否需要重启。OpenCode 的安装包包含仓库工具及终端客户端，详见 [OpenCode 插件说明](../opencode/README.md)。

## 插件登录接口

当前 DSH 插件使用 [VACP 账号登录接口](../../README.md#agent-插件账号登录)。已有连接码客户端可继续调用 `POST /api/v1/agent-plugin-auth/redeem` 和 `GET /api/v1/agent-plugin-auth/session`。
