# NexusLLMapi

本地大模型 API 网关：**统一 OpenAI / Anthropic / Responses 三种协议**，多供应商智能路由、自动故障转移、渠道级重试与熔断、SSE 流式、内置 Supervisor 自愈。纯 Node.js + TypeScript 实现，无任何 EXE / 外部守护进程依赖，一条命令即可部署。

![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-4-000000?logo=fastify&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-122%20passed-2ea44f)

---

## 目录

- [界面预览](#界面预览)
- [特性](#特性)
- [快速开始](#快速开始)
- [使用](#使用)
- [API 参考](#api-参考)
- [配置](#配置)
- [项目结构](#项目结构)
- [测试](#测试)
- [常用命令](#常用命令)
- [技术栈](#技术栈)
- [许可](#许可)

---

## 界面预览

> 以下为管理面板实际运行截图（默认深色主题 / 可切换浅色）。

| 仪表盘 | 渠道管理 |
|---|---|
| ![仪表盘](docs/screenshots/dashboard.png) | ![渠道管理](docs/screenshots/channels.png) |

| 模型库 | 请求日志 |
|---|---|
| ![模型库](docs/screenshots/models.png) | ![请求日志](docs/screenshots/logs.png) |

---

## 特性

**协议与接入**

- 统一对外暴露 **OpenAI（`/v1/chat/completions`）、Anthropic（`/v1/messages`）、Responses（`/v1/responses`）** 三种协议，内部自动做协议转换
- 兼容 `Embeddings`、`/v1/models` 模型列表
- 支持 `GET/POST /p/:channel_id/*` 按指定渠道透传
- 原生 SSE 流式输出，支持 Claude Code / 各类工具调用完整往返（`tool_use` / `tool_result` / `input_json_delta` 等）

**路由与稳定性**

- **多供应商智能路由**：精确模型 → 别名 → 模型梯队 → 降级切换；连续失败自动熔断冷却
- **粘性会话**：同一客户端 30 分钟固定同一渠道，渠道失效自动重路由
- **渠道级重试**：`retry_count`（0–10）覆盖全局 `default_retry`；尊重上游 `Retry-After`
- **渠道健康检查**：后台定时 + 手动触发，仅将真实上游故障计入熔断统计（用户取消、限流、并发满不计入）
- **Supervisor 自愈**：Worker 崩溃自动重启、心跳超时 / HTTP 探活失败强制重启、crash-loop 保护退避、慢启动宽限、优雅退出释放端口

**资源管理**

- 客户端断开即 **Abort 上游真实 HTTP 请求**（非仅释放本地槽位）
- 流式空闲超时（`idle_timeout_ms`），上游卡住自动中断并补发 error SSE
- SSE 背压处理：上游高速写入时暂停读取，`drain` 后恢复，防止无限内存增长
- `/health/deep` 实时暴露 `active_requests` / `active_streams`

**运维**

- Web 管理面板：仪表盘、渠道管理、模型库、代理设置、请求日志
- 请求统计、Token 用量、渠道状态、日志检索（日志自动脱敏，不保存流式响应体）
- SOCKS5 代理支持
- 仅监听 `127.0.0.1`，本地 API 不加鉴权

---

## 快速开始

### 前置要求

| 依赖 | 版本 |
|---|---|
| Node.js | **≥ 22**（推荐 22 / 24） |
| npm | ≥ 10 |

> `better-sqlite3@13` 采用 N-API 预编译二进制，随 npm 包内置，**无需本机 C++ 编译工具链**。

### 安装与启动

```bash
git clone https://github.com/CreativeMarian/NexusLLMapi.git
cd NexusLLMapi
npm ci
npm start
```

启动完成后：

- 管理面板：**http://127.0.0.1:8787**
- API 端点：**http://127.0.0.1:8787/v1**

> `npm start` 的 `prestart` 钩子（`scripts/ensure-build.cjs`）会自动编译缺失/过期的 `dist-server` 与 `web/dist`，无需手动先执行 build。
>
> 首次启动会自动生成 `data/config.json`（内置默认值）与空的 `data/store.db`（SQLite），**不需要手动创建任何配置文件**。

### 开发模式

```bash
npm run dev
```

API（8787，tsx watch 热重载）+ Vite 前端（5173，HMR）并行启动。

---

## 使用

### 第一步：添加渠道

打开管理面板 → **渠道管理** → 添加渠道，填写：

- 名称（如 `openai-main`）
- Provider（`openai` / `ollama` / `gemini` / `azure` / `openrouter` / `cloudflare` 等）
- Base URL
- API Key

保存后点击「同步模型」，模型会自动拉取并进入「模型库」。

### 第二步：接入客户端

| 参数 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | `sk-nexus`（任意非空字符串） |
| 模型 ID | 从前端「模型库」复制 |

**OpenAI SDK 示例**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-nexus",
)
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content, end="")
```

**curl 示例**

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-nexus" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

**Anthropic SDK / Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=sk-nexus
claude
```

---

## API 参考

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 兼容对话 / 流式 |
| POST | `/v1/messages` | Anthropic 协议（自动转换） |
| POST | `/v1/responses` | OpenAI Responses 协议（含 tools 支持） |
| POST | `/v1/embeddings` | 向量生成 |
| GET | `/v1/models` | 可用模型列表 |
| GET/POST | `/p/:channelId/*` | 按渠道透传（channelId 支持 id 或名称） |
| GET | `/health/live` | 存活探针 |
| GET | `/health/ready` | 就绪探针 |
| GET | `/health/deep` | 深度自检（active_requests / active_streams 等） |
| GET/POST | `/api/channels` 等 | 管理 API（面板后端） |

---

## 配置

配置保存在 `data/config.json`，**首次启动自动生成**（含以下默认值）。除 `port` 外均可通过前端「代理设置」页或 `PUT /api/settings` 热更新。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `8787` | 服务端口（修改后重启生效） |
| `global_rpm` | `600` | 全局令牌桶速率（次/分钟） |
| `default_retry` | `2` | 全局默认重试次数（渠道级 `retry_count` 优先） |
| `default_cooldown` | `1` | 熔断冷却秒数 |
| `request_timeout` | `120` | 上游请求超时（秒） |
| `max_channel_conns` | `100` | 单渠道并发上限 |
| `socks5_proxy` | 空 | SOCKS5 代理地址 |
| `channel_health_interval_sec` | `300` | 渠道健康检查周期（秒） |
| `idle_timeout_ms` | `300000` | 流式空闲超时（毫秒，`0`=关闭） |
| `auto_open_browser` | `false` | 启动后自动打开浏览器 |

`data/` 目录（数据库、日志、配置）被 `.gitignore` 忽略，本地修改不会污染仓库。

---

## 项目结构

```
NexusLLMapi/
├── server/                 # 后端（TypeScript）
│   ├── main.ts             # Supervisor 入口（fork 自身为 Worker）
│   ├── worker.ts           # Worker：初始化模块、监听端口、心跳 IPC
│   ├── supervisor/         # 自愈监控（心跳/探活/重启/crash-loop 保护）
│   ├── gateway/            # 网关（模型路由池、协议转换、重试、流式、背压）
│   ├── providers/          # 供应商适配与 HTTP Transport
│   ├── health/             # 活跃请求注册、渠道健康检查、自检
│   ├── routes/             # Fastify 路由（网关 / 管理 / 健康）
│   ├── config/             # 配置管理（data/config.json，内置默认值）
│   └── db/                 # SQLite 访问层（better-sqlite3，WAL）
├── web/                    # 前端（Vue 3 + Vite + Tailwind）
├── tests/                  # Vitest 测试套件
├── scripts/                # ensure-build / 打包等脚本
├── data/                   # 运行时数据（不入库）
├── package.json
└── README.md
```

---

## 测试

```bash
npm test          # Vitest 全量测试（122 用例，10 个测试文件）
npm run typecheck # TypeScript 全量类型检查
```

覆盖范围：数据库兼容、Provider 头构造、路由与 SPA 回退、重试三态语义、SSE 流式与背压、Supervisor 自愈（正常退出 / 卡死强杀 / 慢启动 / 孤儿回收）、ensure-build 增量构建等。

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 生产启动（自动构建 + Supervisor + Worker，监听 8787） |
| `npm run dev` | 开发模式（API 8787 + Vite 5173） |
| `npm run build` | 构建前端 `web/dist` + 后端 `dist-server` |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm test` | 运行测试套件 |

---

## 技术栈

- **后端**：Node.js ≥ 22 + TypeScript + Fastify 4 + better-sqlite3 13（N-API，WAL 模式）
- **前端**：Vue 3 + Pinia + Vite 5 + Tailwind CSS + shadcn-vue 风格组件
- **测试**：Vitest 2

---

## 许可

本项目仅供个人本地使用与学习参考。请自行确认使用方式符合各上游 API 提供商的服务条款。
