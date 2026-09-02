# NexusLLMapi（Node 无 EXE 版）

本地大模型 API 网关：统一 OpenAI / Anthropic / Responses 兼容接口，多供应商智能路由 + 自动故障转移 + Supervisor 自愈。本版为 **Node.js 22+ / 24 + TypeScript + Fastify** 实现（better-sqlite3 13.0.3 采用 N-API，预编译二进制已随 npm 包内置，无需编译工具），纯源码运行，**无任何 EXE 依赖**，原 SQLite 数据直接复用。

## 快速开始

```bash
npm install      # 安装依赖
npm start        # 构建并启动（生产模式，Supervisor 拉起 worker，监听 127.0.0.1:8787）
```

打开 http://127.0.0.1:8787 即可使用前端面板。

> `npm start` 的 `prestart` 会自动检查并构建缺失/过期的 `dist-server` 与 `web/dist`（`node scripts/ensure-build.cjs`），无需手动先执行 `npm run build`。
>
> **Node 版本**：要求 **Node.js ≥ 22**（推荐 22/24；Node 20 已于 2026-04 停止维护，且 Node 24.19 对旧版 NAN 原生模块存在退出期崩溃，故必须使用 better-sqlite3 13.x N-API 版）。better-sqlite3 13.0.3 的 N-API 预编译二进制已内置在 npm 包 tarball 中，`npm ci` / `npm install` 直接可用、无需本机编译工具；npm 11 下 esbuild / vue-demi 的安装脚本已由 `package.json` 的 `allowScripts` 白名单放行，无需手动 approve。
>
> **前端路由刷新**：管理面板为 Vue history 模式，`/logs`、`/channels`、`/models` 等子页面直接访问或刷新由服务端 SPA 回退到 index.html 正常渲染（不再 404）。
>
> **前端 UI（2026-09-02 重设计）**：按 uupm.cc「Design Intelligence」风格重构——深色科技风为默认、毛玻璃（backdrop-filter）卡片与导航、粒子网络背景（canvas 鼠标互动）、鼠标点击粒子爆发特效、顶部终端命令行状态栏、各页 uupm 风格标题区与渐变文字；主题可在深/浅色间切换。前端与后端 API/路由/逻辑链保持完全对接，未改动后端架构与协议。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式：API 8787（tsx watch）+ Vite 前端 5173 |
| `npm run build` | 构建前端 `web/dist` + 后端 `dist-server` |
| `npm run start` | 生产启动：Supervisor 自愈 + Worker，监听 8787 |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm test` | 运行测试套件（122 个用例，10 个文件） |

## 客户端接入

| 参数 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | `sk-nexus`（任意非空值） |
| 模型 ID | 从前端「模型库」复制 |

支持的协议端点：`/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）、`/v1/responses`（Responses）、`/v1/models`（模型列表）、`/p/:channel_id` 或 `/p/:channel_name`（按渠道透传）。

## 核心特性

- **多供应商路由**：精确模型 → 别名 → 模型梯队 → 降级切换；5 次连续失败进入熔断冷却
- **粘性会话**：同一客户端（`X-Client-ID`，缺省按 IP+UA 派生）30 分钟内固定同一渠道；渠道失效自动重路由
- **渠道级重试**：读取 `channels.retry_count` 覆盖全局 `default_retry`（0–10）；重试优先同渠道，尊重上游 `Retry-After`
- **渠道健康检查**：后台定时 + 手动触发检测所有启用渠道（复用真实请求链路），结果可在前端/`/api/health` 查看
- **协议转换**：Anthropic / Responses 请求自动转换并回写 OpenAI 格式
- **活跃请求注册**：`/health/deep` 实时暴露 active_requests / active_streams；客户端断开即取消上游
- **流式空闲超时**：`idle_timeout_ms`（默认 300000ms，0=关闭），上游卡住自动中断并补发 error SSE
- **Supervisor 自愈**：Worker 崩溃自动重启、心跳超时/HTTP 探测失败强制重启、crash-loop 保护退避、优雅退出释放端口
- **SOCKS5 代理**：支持海外 API 代理
- **视觉路由**：图像请求自动路由到视觉模型；Embeddings 按家族路由
- **仪表盘**：请求统计、Token 用量、渠道状态、日志检索

## 配置

配置保存在 `data/config.json`（首次启动自动生成，含默认值）。常用字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 8787 | 服务端口（改后重启生效） |
| `default_retry` | 2 | 全局默认重试次数（渠道级 retry_count 优先） |
| `default_cooldown` | 1 | 熔断冷却秒数 |
| `request_timeout` | 120 | 上游请求超时（秒） |
| `global_rpm` | 600 | 全局令牌桶速率（次/分钟） |
| `max_channel_conns` | 100 | 单渠道并发上限 |
| `socks5_proxy` | 空 | SOCKS5 代理地址 |
| `channel_health_interval_sec` | 300 | 渠道健康检查周期（秒） |
| `idle_timeout_ms` | 300000 | 流式空闲超时（毫秒，0=关闭） |
| `auto_open_browser` | false | 启动后自动打开浏览器 |

除 `port` 外均可通过前端「设置」页或 `PUT /api/settings` 热更新。

## 数据

- SQLite 数据库：`data/store.db`（沿用原版结构，WAL 模式，渠道 / 模型 / 请求日志 / 设置）
- 迁移前的原始数据库备份：`backup-before-node-20260831-112758/data/`
- Go 旧版源码归档：`legacy-go/`（仅作参考，不参与构建）

## 技术栈

- 后端：Node.js 22+ + TypeScript + Fastify 4 + better-sqlite3 13（N-API）
- 前端：Vue 3 + Pinia + Vite + Tailwind CSS + shadcn-vue
- 测试：Vitest（122 用例，10 文件：DB 兼容 / Provider / 路由 / 重试 / 流式 / Supervisor / ensure-build / SPA 回退）

## 目录结构

```
server/           后端（TS）
  main.ts         Supervisor 入口（fork 自身为 worker）
  worker.ts       Worker：初始化各模块、监听 8787、心跳 IPC
  supervisor/     自愈监控（心跳/探活/重启/crash-loop 保护）
  gateway/        网关（路由池、协议转换、透传、重试、流式）
  providers/      渠道适配与 Transport
  health/         活跃请求注册 + 渠道健康检查 + 自检
  routes/         Fastify 路由（管理 API / 网关 / 健康）
  config/         配置管理（data/config.json）
  db/             SQLite 访问层
web/              前端（Vue3）
tests/            Vitest 测试套件
legacy-go/        原 Go 版源码归档（不参与运行）
data/             SQLite 数据（不入库）
```
