# Agent 接入指南

NexusLLMapi 作为模型中转网关，对外暴露 **OpenAI 兼容 / Anthropic / Responses** 三种协议。你的 Agent 工具（function calling、MCP）由 Agent 客户端自身执行，Nexus 负责把 `tools` 参数和 `tool_result` 透明透传给上游模型。

> 核心原则：**Agent 端把 base_url 指到 Nexus 的 8787，tools / MCP 配置照常写在 Agent 客户端里，Nexus 透明中转。**

---

## 目录

- [通用参数](#通用参数)
- [Claude Code（CLI，Anthropic 协议）](#claude-code)
- [Cursor（IDE，OpenAI 兼容）](#cursor)
- [Dify（LLM 应用平台）](#dify)
- [Continue（IDE 插件）](#continue)
- [OpenAI Python SDK](#openai-python-sdk)
- [curl 快速验证](#curl-快速验证)
- [MCP 工具接入](#mcp-工具接入)
- [远程服务器接入（Agent 不在 Nexus 同一台机器）](#远程服务器接入)
- [按渠道透传](#按渠道透传)

---

## 通用参数

| 参数 | 值 |
|---|---|
| OpenAI 兼容 Base URL | `http://127.0.0.1:8787/v1` |
| Anthropic Base URL | `http://127.0.0.1:8787`（不带 `/v1`） |
| API Key | `sk-nexus`（任意非空字符串，本地不加鉴权） |
| 模型 ID | 从前端「模型库」复制，或 `GET /v1/models` |

---

## Claude Code

Claude Code 使用 **Anthropic 协议**，通过环境变量或配置文件指向 Nexus。

### 方式一：环境变量（推荐）

```bash
# Linux / macOS
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=sk-nexus

# Windows PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN="sk-nexus"

claude
```

### 方式二：配置文件（`~/.claude/settings.json`）

```json
{
  "apiBaseUrl": "http://127.0.0.1:8787",
  "authToken": "sk-nexus"
}
```

### 验证

```bash
claude --print "hi"
```

Claude Code 的工具调用（`tool_use` / `tool_result` / `input_json_delta`）、多轮连续工具循环、多 tool_call 均已通过 Nexus 完整往返验证。

---

## Cursor

Cursor 使用 **OpenAI 兼容协议**，在设置里配置自定义 OpenAI 端点。

### 配置步骤

1. 打开 Cursor → `Settings`（`Ctrl+,`）→ `Models`
2. 选择 **OpenAI API Key** 模式（或「自定义 OpenAI 兼容」）
3. 填写：

| 字段 | 值 |
|---|---|
| API Key | `sk-nexus` |
| Base URL / API Base URL | `http://127.0.0.1:8787/v1` |
| 模型 | 从 Nexus 模型库复制（如 `qwen-plus`） |

### 配置文件方式（`~/.cursor/config.json` 或项目 `.cursor/rules`）

Cursor 的模型选择通过 UI 配置，工具调用（Cursor 的 Composer / Agent 模式）自动走 OpenAI function calling，Nexus 透明透传。

### 验证

在 Cursor 里打开 Agent 模式，输入 `hi`，确认有回复；再让它执行一个需要工具调用的任务（如读文件），确认工具调用正常往返。

---

## Dify

Dify 支持 **OpenAI API-Compat** 供应商，把 Nexus 作为自定义 OpenAI 兼容端点接入。

### 配置步骤

1. 登录 Dify → `设置` → `模型供应商` → `OpenAI API-Compat`
2. 点击「添加」，填写：

| 字段 | 值 |
|---|---|
| 供应商名称 | `NexusLLMapi`（自定义） |
| API Key | `sk-nexus` |
| API Base URL | `http://127.0.0.1:8787/v1` |

3. 在「模型」里手动添加模型，模型名填 Nexus 模型库中的 ID（如 `qwen-plus`、`gpt-4o`）
4. 保存后在 Dify 应用里选择该模型即可

### 注意

- Dify 的 Agent 节点 / 工作流工具调用走 OpenAI function calling，Nexus 透明透传
- 如果 Dify 和 Nexus 不在同一台机器，见[远程服务器接入](#远程服务器接入)

---

## Continue

Continue 是 VS Code / JetBrains 的 AI 编码插件，使用 **OpenAI 兼容协议**。

### 配置文件（`~/.continue/config.json`）

```json
{
  "models": [
    {
      "title": "NexusLLMapi",
      "provider": "openai",
      "model": "你的模型ID",
      "apiKey": "sk-nexus",
      "apiBase": "http://127.0.0.1:8787/v1"
    }
  ],
  "tabAutocompleteModel": {
    "title": "NexusLLMapi",
    "provider": "openai",
    "model": "你的模型ID",
    "apiKey": "sk-nexus",
    "apiBase": "http://127.0.0.1:8787/v1"
  }
}
```

Continue 的 Agent 模式工具调用（读文件、执行命令等）自动走 function calling，Nexus 透明透传。

---

## OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-nexus",
)

# 非流式
resp = client.chat.completions.create(
    model="你的模型ID",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="你的模型ID",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content, end="")

# 工具调用（function calling）
resp = client.chat.completions.create(
    model="你的模型ID",
    messages=[{"role": "user", "content": "北京今天天气怎么样？"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "获取指定城市天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }],
)
print(resp.choices[0].message.tool_calls)
```

---

## curl 快速验证

```bash
# 1. 模型列表
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-nexus"

# 2. 非流式对话
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-nexus" \
  -d '{"model":"你的模型ID","messages":[{"role":"user","content":"hi"}]}'

# 3. 流式对话
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-nexus" \
  -d '{"model":"你的模型ID","messages":[{"role":"user","content":"hi"}],"stream":true}'

# 4. 健康检查
curl http://127.0.0.1:8787/health/ready
```

---

## MCP 工具接入

Nexus 的 **MCP 服务器管理页（`/mcp`）是配置中心**，用于集中管理 MCP server 并导出配置给客户端。Nexus 本身不执行 MCP 工具，MCP 工具在你的 Agent 客户端侧执行。

### 操作步骤

1. 打开 Nexus 管理面板 → **MCP 服务器** → 添加 MCP server（stdio 或 http）
2. 启用该 MCP server
3. 点「导出配置」→ 得到 `mcpServers` JSON（也可调用 `GET /api/mcp/export`）

导出格式示例：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"],
      "env": {}
    }
  }
}
```

### 接入 Claude Desktop

把导出的 `mcpServers` 合并到 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows）：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
    }
  }
}
```

同时确保 Claude Desktop 的 API 指向 Nexus（Anthropic 协议）。

### 接入 Claude Code

把 `mcpServers` 加到 `~/.claude/settings.json`：

```json
{
  "apiBaseUrl": "http://127.0.0.1:8787",
  "authToken": "sk-nexus",
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
    }
  }
}
```

### 执行链路

```
Agent 客户端 → Nexus（模型中转）→ 上游模型返回 tool_use
    ↑                                              ↓
    └──── 客户端本地执行 MCP 工具，返回 tool_result ──┘
```

---

## 远程服务器接入

Nexus 硬约束**仅监听 `127.0.0.1`**（本地 API 不加鉴权，设计上不直接暴露公网）。如果你的 Agent 和 Nexus 不在同一台机器，用以下方式接入。

### 方式一：SSH 端口转发（推荐，最安全）

在 Agent 所在机器执行：

```bash
# Linux / macOS
ssh -L 8787:127.0.0.1:8787 user@你的服务器IP

# Windows PowerShell（需 OpenSSH 客户端）
ssh -L 8787:127.0.0.1:8787 user@你的服务器IP
```

保持 SSH 连接，然后 Agent 端 `base_url` 填 `http://127.0.0.1:8787/v1`，流量通过 SSH 隧道加密转发到服务器上的 Nexus。

### 方式二：nginx / Caddy 反向代理（需固定远程访问）

在服务器上用 nginx 反代 `127.0.0.1:8787`，**务必加 basic auth 或 IP 白名单**（Nexus 本身无鉴权）。

nginx 示例：

```nginx
server {
    listen 8788;
    server_name your-domain.com;

    # 基础鉴权（必须）
    auth_basic "NexusLLMapi";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # 可选：IP 白名单
    # allow 你的固定IP;
    # deny all;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        # SSE 流式需要
        proxy_buffering off;
        proxy_cache off;
    }
}
```

> **不要改 Nexus 代码监听 `0.0.0.0`**——本地无鉴权的 API 直接暴露公网有被滥用风险。

---

## 按渠道透传

如果你的 Agent 需要强制走某个特定上游渠道（绕过 Nexus 的智能路由 / 熔断 / 重试），使用按渠道透传端点：

```
http://127.0.0.1:8787/p/:channel_id/*
```

`channel_id` 支持数字 id 或渠道名称。示例：

```bash
# 强制走 NVIDIA 渠道
curl http://127.0.0.1:8787/p/nvidia/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-nexus" \
  -d '{"model":"模型ID","messages":[{"role":"user","content":"hi"}]}'
```

---

## 常见问题

**Q：Agent 调用时报 404 / 模型不存在？**
A：确认模型 ID 与 Nexus 模型库中的完全一致（区分大小写）；可先 `GET /v1/models` 查看可用模型。

**Q：流式响应卡住 / 不输出？**
A：如果经过 nginx 反代，确保 `proxy_buffering off`；SSH 隧道无此问题。

**Q：工具调用不生效？**
A：确认 Agent 客户端的 `tools` 参数已正确传入；Nexus 透明透传，不修改 tools 内容。Anthropic 协议用 `tools`，OpenAI 协议用 `tools`（function calling）。

**Q：MCP 工具没反应？**
A：MCP 工具在 Agent 客户端侧执行，确认客户端配置了 `mcpServers` 且 MCP server 进程能正常启动；Nexus 的 `/mcp` 页只负责配置管理和导出。
