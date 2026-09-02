# NexusLLMapi：Go/EXE → Node.js 无 EXE 版迁移报告

- 迁移日期：2026-08-31
- 迁移目标：将原 Go/Gin 编译版（`nexus-llm-api.exe`）完整迁移为 **Node.js 20 + TypeScript + Fastify** 纯源码运行版，无任何 EXE 依赖，`npm install && npm start` 一键运行。
- 数据策略：**原 SQLite 库直接复用**（`data/store.db`），结构、渠道、模型、日志、设置全部保留；迁移前已备份至 `backup-before-node-20260831-112758/`。

## 一、迁移范围

| 项 | 原版（Go） | 现版（Node） |
|---|---|---|
| 后端 | Go + Gin，编译为 `nexus-llm-api.exe` | Node 20 + TypeScript + Fastify 4，源码运行 |
| 前端 | Vue3 + shadcn-vue + Tailwind | 保留原前端（Vue3 + Pinia + Vite + Tailwind），仅修复构建配置 |
| 数据 | SQLite `data/store.db`（WAL） | 直接复用同一库，访问层改为 better-sqlite3 |
| 进程管理 | 单进程 | Supervisor（父）自愈 + Worker（子）双进程 |
| 存储 | SQLite（迁移前已由原版切换） | 不变 |

## 二、服务架构

```
npm start → dist-server/main.js（Supervisor 父进程）
              ├─ fork 自身为 worker（--worker）
              ├─ IPC heartbeat 1s 心跳
              ├─ HTTP GET /health/live 探活
              └─ 崩溃/心跳超时/探活失败 → 自动重启（指数退避）
Worker：ConfigManager → DatabaseManager → RuntimeContext
        → ProviderService → Gateway → createApp → listen 127.0.0.1:8787
```

Supervisor 退出码约定（`server/worker.ts` EXIT 常量）：
`OK=0, CONFIG=10, PORT_BUSY=11, STARTUP_FAILED=12, WORKER_CRASH=20, WORKER_HANG=21, ORPHAN=22, CRASH_LOOP=23`

自愈机制（均有测试覆盖）：
1. Worker 进程 `exit(1)` → 自动重启，新 Worker 接管并恢复 ready
2. IPC 心跳超时（默认 10s）→ 判定卡死 → SIGTERM 强制重启
3. HTTP 探活连续失败 3 次 → 强制重启
4. 10 分钟内连续崩溃 ≥5 次 → crash-loop 保护：停止重启、进入 5 分钟等待并清空计数
5. 稳定运行 ≥10 分钟 → 重置崩溃计数
6. `SIGINT/SIGTERM/IPC shutdown` → 优雅退出：killWorker（先 IPC shutdown 再 SIGTERM，宽限 8s 后 SIGKILL）→ 释放端口

## 三、API 兼容性

网关层保持与原版一致的对外接口：

| 端点 | 状态 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | ✅ | OpenAI 兼容，支持 stream（SSE）/ 非流式 |
| `POST /v1/messages` | ✅ | Anthropic 协议，自动转换 → OpenAI 格式 → 上游 → 回写 |
| `POST /v1/responses` | ✅ | Responses 协议，同上 |
| `GET /v1/models` | ✅ | 可路由模型列表 |
| `GET /p/:id` / `/p/:name` | ✅ | 按渠道 ID 或名称（大小写不敏感）透传上游，路径去重（`/v1/v1`→`/v1`），未启用渠道 503 |
| `/api/channels` `/api/models` `/api/settings` `/api/logs` `/api/dashboard` `/api/trend` `/api/server-logs` `/api/mcp` `/api/prompts` `/api/config/export` | ✅ | 管理 API 全量保留 |
| `/health/live` `/health/ready` `/health/deep` | ✅ | 存活 / 就绪 / 深度（含 active_requests/active_streams） |
| `/api/health` `/api/health/trigger` `/api/health/channels/:id` | ✅ | 新增：渠道健康检查 |

## 四、路由与容错语义（与原版对齐/增强）

1. **路由顺序**：精确模型 → 别名 → 模型梯队（tier）→ 降级切换；`enabled=false` / `available=false` / 熔断中的渠道与模型不参与路由；无可用模型返回 `NO_MODEL`。
2. **熔断器**：连续 5 次失败 → 冷却（默认 `default_cooldown` 秒），期间不被选中；冷却后恢复。
3. **粘性会话**：30 分钟 TTL；`X-Client-ID` 优先，缺省按 IP+UA 经 FNV-1a 派生 `tmp:` key；被粘渠道失效/禁用/熔断/模型不可路由时自动重路由并刷新。
4. **重试**：非流式 `RETRYABLE`（网络异常 / 429 / 500 / 502 / 503 / 504）重试；**渠道级 `retry_count` 优先**（0–10），未定义时回退 `default_retry`；重试**优先同渠道**（瞬时可恢复），不排除已尝试渠道；尊重 `Retry-After`（秒或 HTTP 日期，上限 10s）；`NO_MODEL` 为确定性结果直接终止不重试。
5. **限流**：全局令牌桶 `global_rpm` + 渠道级 rpm；全部渠道被占满 → `BUSY` → HTTP 503。
6. **流式**：SSE 逐块透传；客户端断开即中止上游并释放并发槽；空闲超时（`idle_timeout_ms`）中断并向已写头客户端补发 error SSE；上游任意字节处断开不崩溃。

## 五、数据与配置

- `data/store.db`：沿用原库（4 渠道、10 模型、1013 条请求日志、settings 含 prompt 配置），迁移全程 `PRAGMA integrity_check = ok`。
- `data/config.json`：自动生成并补齐新字段（`idle_timeout_ms`、`channel_health_interval_sec` 等），损坏时备份为 `.corrupt` 并回退默认。
- 除 `port` 外全部配置可经 `PUT /api/settings` 热更新（`HOT_UPDATABLE_KEYS`）。

## 六、前端

- 前端源码与组件体系（shadcn-vue、Tailwind、Pinia、Vite）沿用原版。
- 修复：根目录 CWD 执行 Vite 构建时 PostCSS 找不到 `web/tailwind.config.js`，导致 `border-border` 等 `@apply` 类缺失。重写 `web/postcss.config.js`，用 `fileURLToPath(new URL(...))` 显式指向 web 配置。此后构建全绿。

## 七、测试（62/62 通过）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/db.test.ts` | 9 | 原库副本完整性、CRUD、事务回滚、alias/enabled 保留、列齐全 |
| `tests/providers.test.ts` | 19 | URL 模板、认证头、模型解析、真实 mock 联调 testChannel/syncChannel/网关聊天 |
| `tests/router.test.ts` | 17 | 精确/别名/梯队/熔断/粘性/降级、HTTP 层 404/503 |
| `tests/retry.test.ts` | 7 | 重试计数、Retry-After、401/404 不重试、网络重置重试、硬超时 |
| `tests/streaming.test.ts` | 6 | SSE 正常流、TCP 半途切断、客户端断开中止、空闲超时补发 error、并发 100 流、释放恰好一次 |
| `tests/supervisor.test.ts` | 4 | 正常运行不误杀、exit(1) 自动重启、心跳超时强制重启、crash-loop 保护 |

运行方式：`npm test`（vitest，单 worker 串行防端口/DB 冲突）。

## 八、验证记录（生产模式 `node dist-server/main.js`）

- 构建：`npm run build` 全绿；`npm run typecheck` 通过。
- 健康与管理 API：`/health/live`、`/health/ready`、`/health/deep`、`/api/*` 全部 200。
- 真实联调（Agnes AI 渠道）：非流式 chat（200 + tokens）、流式 SSE（28 chunks / 104 data-lines / `[DONE]`）、`/v1/messages` 200、`/v1/responses` 200、`/p/4/v1/models` 与 `/p/Agnes AI/v1/models` 200。
- 请求日志写入 `request_logs`。
- 自愈端到端：`Stop-Process` kill worker → Supervisor 自动拉起新 worker → health 恢复 200 → 真实聊天 200 → 停止后端口 8787 释放。
- dev 模式：`npm run dev` → Vite 5173 提供前端、`/api` `/v1` 等经代理转发 8787，经 5173 真实聊天 200。

## 九、清理与归档

- 移除 `nexus-llm-api.exe`（15MB）。
- Go 源码（`api/ channels/ config/ internal/ models/ platform/ proxy/ store/ server/*.go 及 embed.go go.mod go.sum main.go`）归档至 `legacy-go/`，不参与构建、不误删。
- 删除迁移过程的临时验证文件（`.tmp-*.json/.txt/.cjs`）。
- 原始数据备份保留在 `backup-before-node-20260831-112758/`。

## 十、已知差异与说明

1. **客户端断开检测**：改为监听响应流（`reply.raw`）close 事件；请求体已读完后 `req.raw` 的 close 不再被当作断开（避免误杀）。
2. **空闲超时**：为新增能力，原 Go 版无对应配置；默认 5 分钟，可在设置中关闭。
3. **渠道健康检查**：为新增能力（原版仅测速），默认 5 分钟周期，只读不自动改 `enabled`。
4. **Windows 信号**：Windows 上 `Stop-Process`/`kill` 为强制终止，无法触发 Node 信号 handler；优雅退出路径（IPC shutdown / SIGTERM）在 Supervisor 单测与端到端中验证。
5. **重试语义微调**：重试不再排除已尝试渠道（原 Go 版排除 tried，单渠道场景下 500 后重试必 404）；改为优先同渠道重试，熔断由 isAvailable 自动排除。

## 十一、复审与修复（2026-08-31 二次任务）

针对《Node 迁移后完整复审与修复任务书》完成 P0/P1/P2 分级修复，测试 62 → 75（新增 supervisor 故障注入、sticky 跨模型、retry_count=0、流式分类、协议 tools、CORS、settings 热更新、DB 备份/quick_check）。

**P0-1 Supervisor 生命周期**：
- `killWorker` 升级终止阶梯：IPC shutdown(1200ms) → SIGTERM(5000ms) → SIGKILL(8000ms)，`stop()` 等待 Worker 退出后再以 `process.exitCode` 自然退出（不再提前 `process.exit`）。
- 启动宽限 `STARTUP_GRACE_MS=45000`：宽限期内心跳/探活失败仅记录不误杀慢启动 Worker。
- Worker 孤儿退出：`process.on('disconnect')` → 优雅退出（exit 22），防 Supervisor 崩溃后残留占用 8787；Windows 硬杀 Supervisor 冒烟验证通过（端口释放、无孤儿进程）。
- 路径解耦：新增 `server/paths.ts` `resolveProjectRoot()`（NEXUS_BASE_DIR > 入口脚本父目录），worker/main 从任意 CWD 启动不再找不到 data/。

**P0-2 流式管道**：
- 去除 `accum: string[]` 全量累积（长流内存 O(整响应)），改为 `StreamingUsageTracker` 增量解析 usage/[DONE]。
- 背压：`raw.write` 返回 false / `writableNeedDrain` 时 pause 上游、等 drain 再 resume。
- 失败分类：区分 upstream/client/idle/other；客户端断开与空闲超时用 `releaseNeutral` 不计渠道熔断；未写头的非 2xx（401/404 等）不再盲重试，按真实状态码透传上游错误体与 Retry-After。

**P0-3 粘性会话**：
- `selectTier` sticky 命中改为按当前 tier 在 sticky 渠道上重算 realModel（修复"先 A 后 B，把旧模型当 realModel"错配）；`selectExact` 按当前模型在渠道上的真实目标重算。
- 新增 `sweepSticky()` 显式过期清理（60s 周期 + rebuild 时触发），不再仅依赖惰性删除。

**P0-4 Anthropic tools**：request（tool_use→tool_calls、tool_result→tool 消息、tools schema 转换、tool_choice 映射）、response（tool_calls→tool_use block）、流式（content_block_start tool_use / input_json_delta / block_stop）三向转换 + roundtrip 单测。

**P1 重试/冷却**：
- `release` 三态：`releaseNeutral`（限流/客户端中断/空闲不计失败）与普通失败分离。
- 冷却时长 = 基础（`default_cooldown`）+ 失败惩罚 `min(consec_fail,30)` 秒（此前硬编码忽略 default_cooldown）。
- `retry_count=0` 路由层修复：create/update 不再被 `||2` 吞成 2，非法值回退默认，范围钳制 -1..10（-1=继承全局）；网关 `effectiveMaxRetry` 支持渠道级 0 不重试。

**P1 配置/DB/安全**：
- `PUT /api/settings` 补传 `idle_timeout_ms`（此前 HOT_UPDATABLE_KEYS 有但路由没透传）。
- `channel_health_interval_sec` 热更新：ChannelHealthService 订阅 config 变更重新调度定时器。
- DB：启动备份保留上限 5 份（超出删最旧）；启动 `quick_check`（全量 `integrity_check` 保留为手动 `fullIntegrityCheck()`）。
- `syncChannel`：上游不再返回的旧模型标 `available=false`（保留记录与用户设置，仅剔出路由索引）。
- CORS 收敛：仅放行 localhost/127.0.0.1 任意端口与 file://（null），远程站点 Origin 不再反射 ACAO。

**前端**：
- Settings.vue 代理配置移除不存在的 `/v1/moderations`、`/v1/audio/*`，补 `/v1/responses`。
- Guide.vue 步骤 1 改 Node 启动命令（`npm install && npm start`）。
- Channels.vue 重试说明（0=不重试、-1=继承全局）+ 渠道健康状态列与"健康检测"按钮（接入 `/api/health`）。

**未改项与说明**：
- port 保持重启生效（不在 HOT_UPDATABLE_KEYS，前端 Settings.vue 亦注明"修改后需重启"），与现设计一致，不做热绑定。
- Windows 上 SIGTERM/SIGINT 为强制终止、handler 不可捕获：SIGKILL 升级、孤儿退出的单元/冒烟均以"收到优雅指令拒不退出→被强杀/端口释放"语义验证。

## 十二、最终稳定性验收与剩余缺口修复（2026-08-31 第三轮）

本轮目标：不重构、不加功能，只做"最终稳定性验收 + 剩余缺口修复"，确保后端真挂死能自愈、长 SSE / Claude Code 工具调用不泄漏。最终测试 75 → **102**（8 个测试文件全过）。

**§3 SQLite WAL 一致性备份（database.ts）**
- 弃用 `copyFileSync(store.db)`（WAL 下会丢未 checkpoint 数据），改用 better-sqlite3 `db.backup()` 在线备份 API（worker 线程、SQLite backup API），连接存活时可安全备份，未 checkpoint 的 WAL 数据进入快照。
- 校验：备份后切回 `journal_mode=DELETE`（checkpoint 并入主文件）使备份成为自包含单文件，再 `quick_check`，坏快照删除并告警；保留上限 5 份，清理逻辑覆盖 -wal/-shm 侧文件。
- 新增测试：插入仅存在于 WAL 的行 → backup → 打开备份行存在 + quick_check=ok + 无 -wal/-shm 侧文件。

**§1 客户端断开"真正中止上游"（streaming.test.ts）**
- 新增测试：mock 上游持续写 SSE，客户端收到首包后 `destroy()`，断言上游 `res.on("close")` 触发（upstreamClosed=true，证明真实 TCP 连接结束，而非只释放本地变量），且 active_conns=0、active_streams=0、fail_count=0、consec_fail=0。

**§2 retry_count 三态（retry.test.ts，网关真实请求级）**
- 测试A：default_retry=3 + channel.retry_count=0，永远 500 → hits=1（不重试）。
- 测试B：default_retry=3 + channel.retry_count=-1（继承全局），3 次 500 后第 4 次 200 → hits=4、最终 200、x-fallback-attempts=3。
- 测试C：default_retry=5 + channel.retry_count=2（覆盖全局），2 次 500 后第 3 次 200 → hits=3、最终 200。
- 状态码矩阵：401/403/404 不重试（仅 1 次）；429/500/502/503/504 按规则重试（第 2 次成功）。

**§4 Supervisor 真卡死恢复（supervisor.test.ts + worker-hard-hang.mjs）**
- 新 fixture `worker-hard-hang.mjs`：首启占用端口、不发心跳、不响应 HTTP、忽略 IPC shutdown / SIGTERM / disconnect、事件循环保持存活。
- 测试断言（不用 child.killed）：用 PID 是否仍存在（`process.kill(pid,0)`）确认卡死 Worker 真正退出；端口释放后被新 Worker 重新绑定；/health/live 恢复 200；restartCount≥1。
- 永不就绪（超宽限期）与慢启动（宽限内 restartCount=0、就绪后 restartCount=0）两个 fixture 测试通过。

**§7 / §8 SSE 背压与长流内存（streaming.test.ts）**
- Gateway 新增 `backpressure = {pauseCount,resumeCount,maxBufferedBytes}` 观测点；背压等待改用 `drain`/`close`/`error` 竞速 + 结束后清理全部临时监听（此前 `once()` race 会遗留 close 监听）。
- 背压测试：约 22MB SSE + 客户端暂停读 → 断言 pauseCount>0、maxBufferedBytes>0、resumeCount>0、数据以 [DONE] 收尾且顺序完整、结束后 active_streams/active_conns 归零。
- 内存测试：约 25MB SSE 流式消费，heapUsed 增量 <15MB（远小于 body，证明不随完整响应线性累积）；日志不保存整条 body（只存 usage/model/channel/duration/status/error 摘要）。

**§9 / §10 协议 tools 边界（tools.test.ts，12 例，纯协议层）**
- Anthropic：text+多 tool_use、tool_result 字符串/block 数组/is_error、tool_choice auto/any/指定工具、多轮工具循环（tool_use→tool_result→tool_use 往返不丢 id/name/arguments/stop_reason）、流式多 tool_calls + 分片 arguments + 首包空字符串、流式 text+多工具混合。
- Responses：`responsesToOpenAI` 支持 tools/tool_choice/function_call/function_call_output/多 tool call；`openaiToResponses` 输出 function_call 项；`ResponsesSseConverter` 流式 function_call（output_item.added + function_call_arguments.delta）。

**§11 资源释放审计**
- transport.requestStream 建连失败现在清理 timeout 定时器与外部 abort 监听（此前泄漏）。
- 背压 drain 等待清理临时监听（见 §7）。
- ModelPool 新增 `dispose()`（清 sweepTimer），Gateway.dispose() 调用。
- handleChat 的 controller/registry/listeners 各成功、失败、断开、超时、abort 路径均 finally 清理（既有 + 本轮复核）。

**§12 健康检查不误伤（phase2.test.ts）**
- pipeStream 失败归类：`other`（server shutdown）也走 `releaseNeutral`，不再计入渠道连续失败。
- 新增测试：全局限流 429、渠道并发占满排队、Supervisor 优雅关闭中断进行中的流——均 consec_fail=0 / fail_count=0 / active_conns=0；渠道健康检查失败不污染路由池状态（健康检测与熔断统计解耦）。

**§14 / §13 一键运行与交付包**
- package.json 新增 `prestart: node scripts/ensure-build.cjs`：dist-server 或 web/dist 缺失/源码更新时自动 `build:server` + `build:web`，实现真正的 `npm install && npm start` 一键运行。
- 交付包 `NexusLLMapi-final.zip`：不含 node_modules / dist-server / web/dist / data/backups / legacy-go / 迁移前备份，含 package.json + package-lock.json + server/ + web/ + tests/ + data/ + scripts/ + README + MIGRATION_REPORT。

**§15 / §5 最终实机验证（Windows，记录 PID）**
- 命令链路：`npm ci`（364 packages，13s，含 better-sqlite3 原生重建）→ `npm run typecheck`（0 错）→ `npm test`（102/102）→ `npm run build`（成功）→ 删除 dist-server/web/dist → `npm start`（prestart 自动重建后启动，监听 8787）。
- 从交付 ZIP 解压到全新目录 `NexusLLMapi-final-test`：npm ci + npm start 一键成功（Supervisor pid=24012，Worker pid=21968，监听 8787，健康检测 ok）；强杀 Supervisor 24012 后 Worker 21968 自动退出、8787 释放、无残留进程，随后清理测试目录。
- 全端点冒烟（主项目）：/health/live、/health/ready、/health/deep、/api/health、POST /api/health/trigger（手动健康检测）均 200；/v1/models 200（10 模型）；/p/:ch/v1/models 200；/v1/chat/completions 非流式 200、流式 200（含 [DONE]）；/v1/messages 普通与 tool calling 200（max_tokens 足够时 content 正常返回）；/v1/responses 200（output_text 正常）。
- Worker kill 自动恢复：taskkill /F 杀掉 Worker pid=26456 → Supervisor 拉起新 Worker pid=23584，/health/ready 恢复 200。
- Supervisor 强杀孤儿处理：强杀 Supervisor pid=19964 → Worker 23584 检测 IPC disconnect 自动退出、8787 释放、无 node --worker 孤儿进程。
- 数据完整性：data/store.db quick_check=ok，channels=4，models=10；备份为自包含单文件、保留 ≤5。

**架构约束遵守**：未引入 Go 后端 / NexusLLMapi.exe / watchdog / heartbeat / PowerShell 或 BAT 心跳 / PM2 / NSSM / Windows Service；仍为 Node.js 20 + TypeScript + Fastify + Vue 3 + SQLite + Supervisor/Worker 内置自愈 + 127.0.0.1 本地监听 + 本地 API 不增加鉴权。

## 十三、独立审查 P0/P1/P2 边界修复与最终验收（2026-08-31 第四轮）

独立审查在 `NexusLLMapi-final.zip`（102 用例版本）上又发现 2 个确定 P0 + 2 个 P1/P2 边界问题。本轮**不重构、不加功能**，只修问题、补回归测试、重打交付包。最终测试 **102 → 112**（9 个测试文件全过）。

### §1 P0：ensure-build 第二次 `npm start` ENOTDIR（scripts/ensure-build.cjs）

**根因**：`newestMtime()` 无条件对入参执行 `readdirSync`，而 `needs()` 传入的源里混有文件（`tsconfig.build.json`、`web/vite.config.ts`、`web/index.html`）。首次无产物时 `npm start` 能构建；产物存在后第二次 `npm start` 对文件执行 `readdirSync(file)` → `ENOTDIR`。

**修复**：`newestMtime()` 先 `statSync`：文件直接返回 `mtimeMs`（不再 readdir）；目录才递归扫描（跳过 node_modules/dist/dist-server）；路径不存在返回 0。`needs()` 增加可选 `base`（测试注入临时根）。

**新增测试**（tests/ensure-build.test.ts，5 例）：单文件路径不抛 ENOTDIR；不存在路径返回 0；目录递归返回最新（含子目录、跳过 node_modules）；needs 三态（缺失/最新/源更新）；文件源（tsconfig/vite/index.html）不抛 ENOTDIR。

**实机触发矩阵验证**（touch 对应文件 → 跑 ensure-build）：
- 基线（无改动）：server 跳过 ✓ web 跳过 ✓
- 改 `server/*.ts`：server 重建 ✓ web 跳过 ✓
- 改 `tsconfig.build.json`：server 重建 ✓ web 跳过 ✓
- 改 `web/src/*`：server 跳过 ✓ web 重建 ✓
- 改 `web/vite.config.ts`：server 跳过 ✓ web 重建 ✓
- 改 `web/index.html`：server 跳过 ✓ web 重建 ✓

### §2 P0：Supervisor.stop() 与 killWorker() 逻辑冲突（server/supervisor/supervisor.ts）

**根因**：`stop()` 设 `stopping=true` 后调用 `killWorker()`，而 `killWorker()` 开头 `if (this.stopping) return` —— 正常 stop 路径根本不执行 IPC→SIGTERM→SIGKILL 升级终止，Worker 只能靠孤儿断开兜底退出。

**修复**：
- `killWorker` 去掉 `if (this.stopping) return`，改为 per-worker 在途终止 Promise `Map<ChildProcess,Promise<boolean>>` 去重（heartbeat/probe/stop 并发触发不会并发两套 killWorker，复用同一在途流程）；返回 **Worker 是否真实退出**（exit/close 事件），不依赖 `child.killed`。
- 升级阶梯不变：IPC shutdown → SIGTERM → SIGKILL，每级 `waitForExit`（新增 `close` 事件监听）。
- `stop()`：停 watchers 后仍走升级终止；`SIGKILL` 等待结束仍存活 → 记录"未干净退出"而非"干净退出"；确认 Worker 退出后再 `waitPortReleased()`（连接被拒即视为释放）；最后 `process.exitCode=exitCode` 自然结束。
- runner 改为**不 process.exit 帮忙**：`sup.stop()` 完成后上报 `stopped` 并 `process.disconnect()`，让事件循环自然结束。

**新增测试**（tests/supervisor.test.ts，2 例 + 新 fixture `worker-stop-stubborn.mjs`）：
- 生产 stop 路径（正常 Worker）：IPC shutdown → Worker exit → PID 不存在 → 端口不可访问 → Supervisor 自然结束 exit 0。
- 生产 stop 路径（拒绝 IPC shutdown 的顽固 Worker，绑定端口+发心跳+忽略 IPC/SIGTERM/disconnect）：IPC 超时 → SIGTERM（Windows 即强杀）→ PID 消失 → 端口释放 → Supervisor 才结束；断言 Worker 确实收到过 IPC shutdown（标记文件）。

### §3 P1：requestStream 未处理"进入时已 aborted"的 AbortSignal（server/providers/transport.ts）

**根因**：`requestStream` 仅 `signal?.addEventListener('abort', onOuter, {once:true})`；若 signal 在进入前已 aborted（客户端已断开 / server 已 shutdown），监听器收不到过去的事件，仍会创建新上游请求。

**修复**：与 `request()` 一致 —— `if (signal) { if (signal.aborted) controller.abort(new Error('client aborted')); else signal.addEventListener('abort', onOuter, {once:true}); }`。

**新增测试**（tests/retry.test.ts）：预置已 abort 的 AbortController → requestStream → mock 上游 hits=0（建连前立即失败）→ 无 abort listener 泄漏。

### §4 P2：OpenAI SSE usage/[DONE] 跨 TCP chunk 解析（server/gateway/gateway.ts）

**根因**：openai 分支对每个 chunk 单独 `indexOf('\n')` 解析，TCP chunk 不保证与 SSE 行边界一致。`data: {"usage":{...` 或 `data: [DO`+`NE]` 被拆包时漏 usage / `sawDone=false` → 末尾额外补发一个 `[DONE]`。

**修复**：加增量行缓冲 `openaiLineBuf += text`，逐行消费完整 `\n` 行，仅保留未结束尾巴；上限 64KB 防异常上游不发换行导致无限增长（不恢复全量 accum）。

**新增测试**（tests/streaming.test.ts，2 例）：usage JSON 拆 5 段 + [DONE] 拆两段（`data: [DO`+`NE]\n\n`）→ 日志 total_tokens=15 正确、`[DONE]` 只输出一次；一条 24KB data line 拆 7 段 → 内容完整、`[DONE]` 只一次、流/连接归零。**已做判别力验证**：临时还原旧解析逻辑，该测试确实失败（收到 2 个 `[DONE]`），证明覆盖真实跨 chunk 路径。

### §5 ZIP 数据快照规则（scripts/make-delivery-zip.cjs，新增）

**问题**：此前 ZIP 直接含运行中活库的 `store.db` + `store.db-wal` + `store.db-shm` + `.bak` 文件，三个文件在不同时间点被读取，是非原子快照。

**修复**：新增打包脚本 `scripts/make-delivery-zip.cjs`：
- 真实数据包：用 better-sqlite3 只读连接执行 SQLite 在线 backup API 生成自包含 `data/store.db` 快照（含 WAL 未 checkpoint 数据）→ 切 `journal_mode=DELETE` → `quick_check=ok` → 进入交付包；**绝不分别 ZIP 活库三件套**。
- 不打包 node_modules / dist-server / web/dist / data/backups / legacy-go / -wal / -shm / 运行日志；含 package.json、package-lock.json、server/、web/、tests/、scripts/、data/、README、MIGRATION_REPORT、配置文件。
- **真实数据未被删除/修改**（data/ 原样保留，仅复制快照进交付树）。
- 交付包内 store.db 快照验证：quick_check=ok、channels=4、models=10。

### §6 最终重新验收（Windows 实机，真实命令与 PID）

从全新状态执行：

```
删除 node_modules、dist-server、web/dist → npm ci（364 packages，8s）→ npm run typecheck（0 错）→ npm test（112/112，9 文件）
```

连续三次 start/stop 全部正常：
1. **第一次 `npm start`**（无任何构建产物）：prestart 自动 `build:server` + `build:web` → 启动成功，Worker pid=14372，`/health/live` 200。
2. **第二次 `npm start`**（产物最新，直接判跳过）：日志 `[ensure-build] dist-server 已是最新，跳过` + `web/dist 已是最新，跳过`，**无 ENOTDIR**，直接启动，Worker pid=3340，200。
3. **第三次 `npm start`**（源 mtime 更新触发重建）：自动重建后启动，Worker pid=20940，200。

每次停止均验证 8787 释放、无孤儿进程（Supervisor 27628/22864 强杀 → Worker 14372/3340 自动退出）。

**真实冒烟（运行中服务，8787）**：
- `/health/live` 200（pid 20940）、`/health/ready` 200、`/health/deep` 200（uptime/memory/event_loop）
- `/v1/models` 200（10 模型）、`/p/4/v1/models` 200、`POST /api/health/trigger`（渠道手动健康检查）200
- `/v1/chat/completions` 非流式 200（usage 295 tokens）、流式 200（`[DONE]` 恰 1 次）
- `/v1/messages` 普通 200（Anthropic 格式）；tool calling 200（`type:"tool_use"` + `stop_reason:"tool_use"`，完整往返）
- `/v1/responses` 200（Responses 格式，`object:"response"`，usage 302 tokens）
- **Worker kill 自动恢复**：taskkill /F 杀 Worker 20940 → Supervisor 日志 `Worker 退出，准备重启 {"backoffMs":2000,"restart":1}` → 新 Worker 23388 接管，`/health/live` 200（pid 23388）
- **Worker 真卡死自动恢复**：由 supervisor.test.ts 的 `worker-hard-hang` fixture 覆盖（不发心跳/不响应 HTTP/忽略 IPC 与 SIGTERM/占用端口，用 PID 存活检测而非 child.killed，首启硬卡死→升级终止→旧 PID 消失→端口释放→新 Worker ready）
- **Supervisor 强杀孤儿处理**：强杀 Supervisor 27628/22864/23756 → Worker 自动检测 IPC disconnect 退出、PID 消失、8787 释放、无 node 孤儿进程
- **8787 最终正确释放**：最终停止后确认无 Listen、无残留 Nexus node 进程

### 本轮修改文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/ensure-build.cjs` | 修改 | newestMtime 支持文件/目录，修复 ENOTDIR（P0-1） |
| `server/supervisor/supervisor.ts` | 修改 | killWorker 去 stopping 早退 + 去重 + 返回真实退出；stop() 升级终止+端口释放确认（P0-2） |
| `tests/fixtures/supervisor-runner.ts` | 修改 | stop 不再 process.exit，自然结束（P0-2 测试基建） |
| `tests/fixtures/worker-stop-stubborn.mjs` | 新增 | 拒绝 IPC shutdown 的顽固 Worker fixture |
| `server/providers/transport.ts` | 修改 | requestStream 处理已 aborted signal（P1） |
| `server/gateway/gateway.ts` | 修改 | openai 分支增量行缓冲，跨 chunk 解析 usage/[DONE]（P2） |
| `scripts/make-delivery-zip.cjs` | 新增 | 正式打包：SQLite backup API 自包含快照 + 排除运行期产物（§5） |
| `tests/ensure-build.test.ts` | 新增 | 5 例（P0-1 回归） |
| `tests/supervisor.test.ts` | 修改 | +2 例生产 stop 路径（P0-2 回归） |
| `tests/retry.test.ts` | 修改 | +1 例 requestStream 已 abort（P1 回归） |
| `tests/streaming.test.ts` | 修改 | +2 例跨 TCP chunk SSE（P2 回归） |

### 测试总数

**112 个用例 / 9 个文件全部通过**（102 → 112：+5 ensure-build、+2 supervisor、+1 retry、+2 streaming）。命令：`npm ci && npm run typecheck && npm test && npm start` 一键链路全绿。

**架构约束遵守**：未引入 Go / NexusLLMapi.exe / watchdog / heartbeat / PowerShell 或 BAT 心跳 / PM2 / NSSM / Windows Service；仍为 Node 20 + TypeScript + Fastify + Vue 3 + SQLite + Supervisor/Worker 内置自愈 + 127.0.0.1 本地监听 + 本地 API 不增加鉴权。

## 十四、Node 24 兼容修复（better-sqlite3 原生模块 ABI 不匹配）（2026-09-01 第五轮）

### 现象（用户实机复现）

用户终端执行 `npm run dev`：Vite v5.4.21 在 5173 正常 ready，但 API Worker 启动失败——`better_sqlite3.node was compiled against NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 137`，随后 Vite 代理 `/api/channels`、`/api/dashboard` 全部 `ECONNREFUSED 127.0.0.1:8787`，网页数据加载失败（"网页全这样了"）。

### 根因

- 用户系统 PATH 的 Node 为 **v24.19.0**（`E:\environment\node-v24.19.0-win-x64`，NODE_MODULE_VERSION=137）；此前所有构建/测试均在 Node 20.20.2（ABI 115）下进行，`npm ci` 产出的 better-sqlite3 原生二进制为 ABI 115。
- 原生模块 ABI 不匹配：Node 24 加载 ABI 115 的 `.node` → `ERR_DLOPEN_FAILED`（Worker 启动失败 → 8787 无服务 → Vite 代理 ECONNREFUSED）。
- 排查确认：better-sqlite3 **v11.10.0 无 Node 24（node-v137）win32-x64 预编译**（经 GitHub release 资产探测：仅有 node-v108/115/127），且本机无 MSVC 编译链，无法 node-gyp 从源码编译。

### 修复

1. **升级 better-sqlite3 11.10.0 → 12.9.0**（package.json / package-lock.json）：
   - 经逐版本探测，**v12.9.0 同时提供 node-v115（Node 20）与 node-v137（Node 24）** 的 win32-x64 预编译（v12.10+ 起只保留 Node 24 预编译、v13 无预编译，故选 v12.9.0），两个 Node 版本都能 `npm ci` 后直接加载。
   - 本机 `node_modules` 置入 node-v137 预编译（prebuild-install 在 Node 24 下下载 / 手动解包 GitHub release tarball），用户终端立即可用。
2. **npm 11 的 allow-scripts 安全机制**（Node 24 自带 npm 11.17 默认拦截依赖安装脚本）：
   - `npm approve-scripts --all` 在 package.json 写入对象形式 `"allowScripts": { "better-sqlite3@12.9.0": true, ... }`，使全新 `npm ci` 自动执行 better-sqlite3 的 install 脚本（prebuild-install 按运行它的 Node 版本下载对应 ABI 预编译）。
   - 移除误加的数组形式 allowScripts（与 approve-scripts 写入的对象键重复，JSON 后者覆盖前者）。
3. **长流内存测试在 Node 24 下 GC 感知**（tests/streaming.test.ts）：
   - Node 24 V8 年轻代更大，无 GC 时约 25MB 流式传输的瞬时 heapUsed 增量达 ~23MB（>15MB 阈值误报）。
   - 采样前若 `global.gc` 可用则强制 GC：实测保留内存 delta = **-6.1MB**（不随完整响应体线性累积，证明为 GC 时机差异、非泄漏）。
   - `package.json` test 脚本改为 `set "NODE_OPTIONS=--expose-gc" && vitest run`（引号形式避免 cmd 解析尾随空格）。

### Node 24 实机验收（用户终端同款环境，记录真实 PID）

- **全新安装链路**：删除 node_modules/dist-server/web/dist → `npm ci`（Node 24，364 packages，10s，**无 allow-scripts 警告**，better-sqlite3 预编译自动下载）→ Node 24 加载真实库 channels=4/models=10/quick_check=ok。
- `npm run typecheck`：0 错。
- `npm test`：**112/112 通过（9 文件）**（Node 24 + `--expose-gc`）。
- `npm run build`：vite build + tsc 均成功。
- **`npm run dev`（用户原始失败命令）**：Worker pid=29148 就绪（SQLite 初始化完成、channels=4/models=10、health 检测 ok=1）、Vite pid=33296 ready 5173；`/health/ready` 200、`/v1/models` 200、Vite 代理 `/api/channels` 200（1362B）、`/api/dashboard` 200（932B）——网页数据恢复。
- **连续三次 `npm start`**：① 无产物自动构建启动（Worker pid=26848）；② 产物最新直接跳过（Worker pid=14844，日志 `[ensure-build] dist-server 已是最新，跳过` / `web/dist 已是最新，跳过`，**无 ENOTDIR**）；③ 同样跳过构建（Worker pid=21148）；每次均正确终止 supervisor 树 → 8787 释放 → 无孤儿进程。
- 生产端点冒烟（8787）：`/health/live`（pid 26848）、`/health/ready`、`/health/deep`（active_requests=0、active_streams=0）、`/v1/models` 全部 200。

### 本轮修改文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `package.json` | 修改 | better-sqlite3 11.10.0→12.9.0；allowScripts（npm 11 安装脚本白名单，对象形式）；test 脚本加 `--expose-gc` |
| `package-lock.json` | 修改 | 随依赖升级更新（better-sqlite3 12.9.0） |
| `tests/streaming.test.ts` | 修改 | 长流内存测试 GC 感知采样（Node 24 公平测保留内存） |
| `README.md` | 修改 | Node 20/24 兼容说明、npm 11 allowScripts 说明 |

### 架构约束遵守

未引入 Go / NexusLLMapi.exe / watchdog / heartbeat / PowerShell 或 BAT 心跳 / PM2 / NSSM / Windows Service；仍为 Node 20/24 兼容 + TypeScript + Fastify + Vue 3 + SQLite + Supervisor/Worker 内置自愈 + 127.0.0.1 本地监听 + 本地 API 不增加鉴权。

## 十五、SPA 回退修复 + better-sqlite3 升级 N-API（2026-09-01 第六轮，Node 24.19 稳定性）

### P0：前端 history 路由刷新/直接访问 404（"UI 没了/点不动"）

**现象（用户实机）**：前端面板在 `http://127.0.0.1:8787/` 正常渲染，但用户进入子页面（如 `/logs`）后询问"UI/UX 呢"；实测直接访问/刷新 `http://127.0.0.1:8787/logs` 返回 `{"message":"Route GET:/logs not found","error":"Not Found","statusCode":404}`——页面直接变成 404 错误，无任何 UI。

**根因**：`server/app.ts` 生产静态托管使用 `@fastify/static` 只挂根目录，**缺少 SPA 回退**。Vue Router 为 history 模式：从首页点击侧边栏是前端路由（不触发请求）可用；但**刷新或在子路由直接打开**时服务端找不到 `/logs` 等路径对应文件 → 404。同时解释了"点不动"：在内置浏览器中点击子路由触发整页导航到 `/logs` → 404，表现为"界面没了 / 不能点"。

**修复**（`server/app.ts`）：在存在 `web/dist` 时注册 `app.setNotFoundHandler`——对 GET 请求且路径**不是** `/api`、`/v1`、`/p/`、`/health` 前缀、且**不带文件扩展名**（非真实静态资源缺失）时，回退 `sendFile('index.html')` 由前端接管；API/网关/健康检查未匹配路径与缺失的静态资源仍返回 404 JSON。

**验证**：
- `GET /logs` `/channels` `/models` `/settings` `/guide` → 200 text/html（index.html）；带查询串 `/logs?page=2` 同样回退。
- `GET /`、真实静态资源 `/asset.js` → 200 正常。
- `GET /api/nonexistent`、`/v1/nonexistent`、`/p/xx/models`、`/health/nonexistent`、缺失 `/assets/x.js` → 404 JSON，行为不变。
- 浏览器实测：直接打开 `/logs` 渲染日志中心（1045 条记录表格），侧边栏点击正常跳转。
- 生产 `npm start` 复验：`/logs` `/channels` `/models` 均 200 HTML，`/api/channels` `/v1/models` `/health/ready` 均 200。

### P0：Node 24.19 + better-sqlite3 12.x（NAN）退出期崩溃 → `npm test` 偶发失败

**现象**：`npm test`（Node 24.19）在部分测试文件的 worker 退出时报原生崩溃：`Assertion failed: (env) != nullptr`（`node::RemoveEnvironmentCleanupHook`）+ `Statement::scalar deleting destructor`，vitest 报 `Worker exited unexpectedly`，导致 `npm test` 退出码非 0（多次运行 1~3 个 worker 崩溃，波及 phase2/router/spa-fallback 等不同文件，属偶发竞态）。

**根因（已查证）**：**Node 24.19.0（2026-08-03 发布）为 `node::ObjectWrap` 新增了 cleanup hooks（nodejs/node#63642）**。better-sqlite3 ≤12.x 是 NAN 风格原生模块，其 Database/Statement 析构在环境（isolate）拆除后调用 `RemoveEnvironmentCleanupHook` → 断言崩溃。官方与社区确认：**唯一可靠修复是 N-API（better-sqlite3 v13）**；显式 `db.close()` 只能降低概率不能根治（Node 24.19 + 12.x 仍会崩溃）。本机所有 `new Database` 实例均已显式 close（测试与 DatabaseManager 均有 finally close），证明非泄漏，而是 Node 24.19 对 NAN 模块的普遍性退出竞态。

**修复**：**better-sqlite3 12.9.0 → 13.0.3（N-API）**。
- v13 为 N-API（node-addon-api 8），天然免疫该退出竞态；`prebuilds/win32-x64.node` **内置在 npm tarball 中**（已下载 tarball 核实），无需本机编译工具、无 install 脚本、无需 allowScripts。
- `package.json`：`better-sqlite3: "13.0.3"`；engines 由 `>=20.0.0` 调整为 **`>=22.0.0`**（v13 要求 Node ≥22；Node 20 已于 2026-04 EOL，用户实机为 Node 24.19）；`allowScripts` 移除 better-sqlite3 条目（v13 无安装脚本），保留 esbuild / vue-demi。
- 验证 v13 在 Node 24 加载、WAL/exec/prepare/pragma(quick_check)/backup API 全部可用；**不 close 直接进程退出退出码 0**（12.x 在此必崩）、连续开关 20 库无崩溃。

**验收（Node 24.19 用户环境）**：
- `npm install`（+1/删 33 包）→ `npm run typecheck` 0 错。
- `npm test`：**122/122 通过（10 文件），0 崩溃/0 断言**（此前 12.x 每轮 1~3 worker 崩溃）。
- `npm run build`：vite + tsc 成功。
- `npm start`：Supervisor 拉起 Worker pid=24440，SQLite 初始化 ok（channels=4/models=10），SPA 子路由全 200，停止后 8787 释放、无孤儿。

### 本轮修改文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/app.ts` | 修改 | 新增 SPA 回退（`setNotFoundHandler` → `sendFile('index.html')`），修复 history 路由刷新/直接访问 404 |
| `tests/spa-fallback.test.ts` | 新增 | SPA 回退回归测试（10 用例）：子路由回退/静态资源/API 404/非 GET 404/真实路由不受影响 |
| `package.json` | 修改 | better-sqlite3 12.9.0→13.0.3（N-API）；engines node ≥22；allowScripts 移除 better-sqlite3 |
| `package-lock.json` | 修改 | 随依赖升级更新（better-sqlite3 13.0.3） |
| `README.md` | 修改 | Node ≥22 要求、better-sqlite3 13 N-API、SPA 回退说明、测试数 122/10 |

### 测试总数

**122/122 通过，10 个测试文件**（db 9、providers 19、router 17、retry 12、streaming 11、supervisor 11、phase2 16、tools 12、ensure-build 5、spa-fallback 10）。命令：`npm install && npm run typecheck && npm test && npm run build && npm start` 全链路 Node 24.19 实机通过。

### 架构约束遵守

未引入 Go / NexusLLMapi.exe / watchdog / heartbeat / PowerShell 或 BAT 心跳 / PM2 / NSSM / Windows Service；仍为 Node 22+/24 + TypeScript + Fastify + Vue 3 + SQLite + Supervisor/Worker 内置自愈 + 127.0.0.1 本地监听 + 本地 API 不增加鉴权。依赖变更仅为 better-sqlite3 12→13（N-API），未改动总体架构、未新增功能。

## 第十六章 前端 UI/UX 重设计（uupm.cc 风格）（2026-09-02）

### 背景
用户要求按 https://www.uupm.cc/（UI/UX Pro Max · Design Intelligence）的风格重新设计管理面板 UI/UX，并要求：背景加粒子特效、毛玻璃效果、鼠标点击特效；同时对接好路由、逻辑链、服务与 API。

### 修改文件（本轮）
- `web/src/style.css` — 重写全局样式：深色科技风设为默认（:root 深空蓝黑变量，.light 浅色可切换）；新增/强化玻璃拟态（.glass/.glass-strong/.glass-nav/.glass-hover）；粒子画布（.particle-canvas）；鼠标点击特效（.click-burst/.ripple-ring/.spark/.core/.dot-ping）；uupm 终端美学（.term-box/.term-prompt）；霓虹光效（.glow-*/.neon-border）与渐变文字（.gradient-text/.gradient-text-animated）。
- `web/src/components/ParticleBackground.vue` — 新增：全屏 canvas 粒子网络背景（粒子漂移+近距离连线+鼠标推开互动，零依赖，自动适配深/浅色与 DPR，尊重 reduced-motion）。
- `web/src/components/ClickEffect.vue` — 新增：全局鼠标点击特效（点击处扩散波纹环+核心闪光+8 颗粒子爆发，独立容器动画结束自动移除，无 DOM 累积）。
- `web/src/App.vue` — 重构：顶部终端命令行状态栏（nexus@local ~ $ ... + PROXY RUNNING 实时状态点）；玻璃导航（Logo 渐变图标+Design Intelligence Gateway 副标题+横向 pill 导航）；集成粒子背景与点击特效；背景极光 blob + 网格；保留主题切换与移动端菜单。
- `web/src/views/Dashboard.vue` — 重设计：uupm 大数字统计卡（渐变数字+发光图标）、LIVE TELEMETRY 徽章 hero 区、终端副标题、渠道状态+快捷操作+PROXY_ENDPOINT 终端框、7 天请求趋势柱状图。
- `web/src/views/Channels.vue` / `Models.vue` / `Settings.vue` / `Logs.vue` / `Guide.vue` — 标题区统一升级为 uupm hero 条（分类徽章+渐变标题+终端命令副标题），深色兼容颜色修正（600→400 级/品牌色）。
- `web/src/composables/useTheme.js` + `web/index.html` — 主题默认改为深色（localStorage 优先，深色为默认，浅色通过 .light 类覆盖），预渲染脚本防闪烁。
- `web/tailwind.config.js` — 修复 content 路径：改为基于配置文件位置的绝对路径（rootDir + ...），解决从项目根运行构建（CWD 不等于 web/ 目录）时 Tailwind 扫描不到源码、全部工具类被 tree-shake 的 P0 级问题（表现为页面只剩粒子背景、布局/玻璃样式全部丢失）。
- `README.md` — 更新技术栈（Node 22+ / better-sqlite3 13 N-API）、测试数 122/10、前端 UI 说明。

### 验证结果（Node 24.19 实机）
- 根因一：SPA 直访 404（上一轮已修）；本轮额外发现并修复根因二：tailwind.config.js content 相对路径在 CWD 不等于 web/ 时失效 → CSS 仅 7.8KB（工具类全丢）→ 页面只显示粒子、内容被推离视口。修复后 CSS 53.6KB，.z-10/.glass/.particle-canvas/.click-burst 等全部生成。
- `npm run build` 通过（前端 vite + 后端 tsc 0 错）。
- 生产 `npm start`（Supervisor+Worker）后 headless Chrome 实机截图验证：首页（终端栏 PROXY RUNNING、导航、LIVE TELEMETRY hero、4 张统计卡、渠道状态、快捷操作）、/channels（4 渠道卡片+健康状态）、/models（10 模型卡片+筛选）均正常渲染，深色+粒子网络背景+毛玻璃全部生效。
- 路由/API 全通：/ /logs /channels /models /settings /guide 200 HTML（SPA 回退），/api/dashboard /api/channels /v1/models 200 JSON。

### 架构约束
仍为 Node 22+/24 + TypeScript + Fastify + Vue 3 + SQLite + Supervisor/Worker 内置自愈 + 127.0.0.1 本地监听 + 本地 API 不增加鉴权；未引入 Go / EXE / watchdog / heartbeat / PowerShell·BAT 心跳 / PM2 / NSSM / Windows Service；未重构后端总体架构、未增加后端功能。前端仅做 UI/UX 视觉重构，路由/API/逻辑链完全保持对接。


## 第十七章 卡片内容垂直分布修复（贴顶/快溢出）(2026-09-02)

### 背景
用户验收新 UI 后反馈："div 里面的字体有点靠上，能不能居中""很多字体都快溢出了，很多页面都是这样"（浅色模式下模型库页最明显）。经排查确认为**非真实溢出**，而是等高卡片下内容贴顶、底部留白过多造成的视觉"快溢出"：
- 模型卡片处于等高 grid 网格中，内容少（无 tags/单模型测试结果）的卡片内容全部挤在顶部、卡片底部大片空白；
- 各页 hero 区使用 items-end（内容贴底），Dashboard 统计卡、快捷操作卡内容贴顶；
- 渠道卡片操作按钮区不贴底，内容少的渠道卡下方留白。

### 修改文件（本轮）
- `web/src/views/Models.vue` — 模型卡片：Card 增加 `flex h-full flex-col`，CardContent 增加 `flex h-full flex-col`，内容区 `flex flex-1 ... flex flex-col`，底部操作区（上下文+操作图标+开关）由 `mt-3` 改为 `mt-auto pt-3` 贴底；单模型速度测试结果块移到操作区**上方**，使操作区始终贴底、内容区空白自然分布。
- `web/src/views/Dashboard.vue` — 统计卡 CardContent 增加 `flex h-full flex-col justify-center`（内容垂直居中）；hero 区 `items-end` → `items-center`；快捷操作卡增加 `flex flex-col` + 按钮区 `justify-center`（等高拉伸时按钮垂直居中、不贴顶）。
- `web/src/views/Channels.vue` — 渠道卡片底部操作按钮区 `mt-4` → `mt-auto`（贴底）。
- `web/src/views/Guide.vue` — hero 区 `items-end` → `items-center`（与其余页面统一）。
- `web/src/composables/useTheme.js` + `web/index.html` — 支持 `?theme=light|dark` URL 参数临时覆盖主题（与 localStorage 逻辑一致，便于预览/验证浅色模式）。

### 验证结果（Node 24.19 实机）
- `npm run build`（vite + tsc）通过，0 错误。
- headless Chrome 1440×900 浅色模式（?theme=light）实测截图全部 6 页：/（统计卡垂直居中、快捷操作按钮居中分布、hero 居中）、/channels（渠道卡按钮贴底）、/models（4 列模型卡内容分布均匀、测试结果区位于操作区上方）、/logs、/settings、/guide 均正常，无贴顶/溢出回归。
- 真实浏览器 bu.js 实测：模型卡片注入 80px 高内容后，卡片高度随之增长且底部操作区与卡片底部的 gap 恒为 1px（mt-auto 贴底行为确认生效）。
- 深色模式回归：1440 深色截图 / /models /channels 均正常。

### 架构约束
仍为 Node 22+/24 + TypeScript + Fastify + Vue 3 + SQLite + Supervisor/Worker 内置自愈 + 127.0.0.1 本地监听 + 本地 API 不增加鉴权；未引入 Go / EXE / watchdog / heartbeat / PowerShell·BAT 心跳 / PM2 / NSSM / Windows Service；未重构后端总体架构、未增加后端功能，仅前端布局/主题预览能力调整。


## 第十八章 全局卡片内容垂直居中修复（贴顶/底部留白）(2026-09-02)

### 背景
用户以模型卡片为例再次反馈："上面明显没有空间了，而下面还有很多空间"，并要求"很多 div 都有这种情况，全局修改"。经排查确认根因有两层：
1. 模型卡片外层 `flex items-start` 导致内层内容区高度不被拉伸（`flex-1` 仅横向生效），上一轮的 `mt-auto` 操作区贴底因无剩余空间而失效——卡片被同行高卡拉伸后，内容全部挤在顶部、操作区下方出现大片空白。
2. 用户诉求是"内容在卡片内居中/均衡分布"，而非仅仅底部贴底——等高网格中被拉伸的卡片，内容应上下对称留白。

### 修改文件（本轮）
- `web/src/views/Models.vue` — 模型卡片：内层内容区 `min-w-0 flex-1 flex flex-col` 增加 `self-stretch`（修复高度拉伸，使外层 items-start 不再截断高度）+ `justify-center`（内容组垂直居中、上下对称留白）；底部操作区由 `mt-auto pt-3` 改回 `mt-2`（随内容组一起居中，不再强制贴底）。
- `web/src/views/Settings.vue` — 5 张等高网格设置卡（基础/限流/网络代理/重试/代理配置信息）：Card 统一加 `flex flex-col`，CardContent 统一加 `flex flex-1 flex-col justify-center`（表单项内容垂直居中，消除内容少的卡"顶部挤+底部空"）。

（统计卡/快捷操作/hero 区/渠道卡按钮已在上轮第十七章修复，本轮保持。）

### 验证结果（Node 24.19 实机）
- `npm run build`（vite + tsc）通过，0 错误。
- 真实浏览器 bu.js 确定性验证：模型网格强制 2 列等高，向 0 号卡注入 90px 高块后，同行 1 号卡被拉伸至 230px，其内容组距卡片顶部 45px、距底部 45px（**上下完全对称，居中生效**）。
- headless Chrome 1440×900 浅色模式（?theme=light）实测截图：/models（4 列模型卡内容均匀分布，无顶部挤压/底部留白）、/settings（两列表单卡内容垂直居中）、/（统计卡/快捷操作/hero 均正常）无回归。
- 深色模式回归正常。

### 架构约束
仍为 Node 22+/24 + TypeScript + Fastify + Vue 3 + SQLite + Supervisor/Worker 内置自愈 + 127.0.0.1 本地监听 + 本地 API 不增加鉴权；未引入 Go / EXE / watchdog / heartbeat / PowerShell·BAT 心跳 / PM2 / NSSM / Windows Service；未重构后端总体架构、未增加后端功能，仅前端布局统一调整。

## 第十九章：全局内容垂直居中修复（CardContent pt-0 根因）

### 用户反馈
模型库、渠道管理、仪表盘等多个页面出现"卡片内容贴顶、底部大片空白、上下留白不对称"。用户用红色标注单张模型卡：上面几乎没空间，下面很多空间。

### 根因定位（非 flex 布局问题，是组件默认样式 Bug）
1. `CardContent.vue` 组件默认 class 为 `cn('p-6 pt-0', props.className)`，其中 **`pt-0`（padding-top: 0）是所有卡片顶部贴顶的直接原因**。
2. 所有调用处（Models / Dashboard / Channels / Settings / Guide / Logs，共 20+ 处）均写 `<CardContent class="...">`。但该组件只读取 `props.className`（未声明 prop，实为 attrs 继承），**Vue 会把 `class` 作为普通 attribute 直接追加到根元素 class 后面，根本不经过 `cn()`/tailwind-merge 合并**。
3. 因此 `p-6 pt-0` 与调用处追加的 `p-4/p-5` 冲突时，CSS 源顺序中 `pt-0`（padding-top:0）胜出 → 所有卡片 padding-top 被压成 0，padding-bottom 保持 p-6（24px）→ 内容全部贴顶、底部空一大截。实测 6 个页面全部中招。

### 修复内容
1. **`web/src/components/ui/CardContent.vue`**：默认 class 由 `cn('p-6 pt-0', props.className)` 改为 **`cn('p-6', props.className)`**（去掉 pt-0）。全局所有卡片上下 padding 对称（默认 24px，或调用处追加的 p-4/p-5 覆盖，上下一致）。
2. **等高网格卡片统一模式**（确保行内某卡被拉伸时内容垂直居中）：
   - `Dashboard.vue`：4 张统计卡 `Card` 加 `flex flex-col`，`CardContent` 的 `flex h-full` 改为 `flex flex-1`（h-full=height:100% 在 grid 子项上不引用行高，会断链）。
   - `Models.vue`：模型卡 `Card` 的 `h-full` 去掉改为 `flex flex-col`，`CardContent` 的 `flex h-full` 改为 `flex flex-1`。
   - Channels 渠道卡已是正确模式（flex flex-col + flex-1），无需改动。
3. D:\NexusLLMapi\NexusLLMapi（用户解压副本）与 E:\Demo\NexusLLMapi（发布源）两个副本同步修改。

### 实测验证（真实浏览器 bu.js DOM 精确测量，非截图目测）
| 页面 | 内容距卡片顶 | 内容距卡片底 | 对称 |
|---|---|---|---|
| 模型库 Models | 25px | 25px | ✓ |
| 仪表盘 Dashboard（统计卡） | 25px | 25px | ✓ |
| 仪表盘 Dashboard（快捷操作卡） | 13px | 13px | ✓ |
| 渠道管理 Channels（渠道卡） | 25px | 25px | ✓ |
| 快速开始 Guide | 25px | 25px | ✓ |
| 代理设置 Settings（表单内容） | 24px | 24px | ✓ |
| 请求日志 Logs | 25px | 25px | ✓ |

- **等高拉伸测试**：向统计卡注入 80px 高块强制拉伸，4 张卡等高 230px，同行卡内容对称居中（38/38、65/65），证明 `flex-1 + justify-center` 在拉伸场景下正确居中。
- **宽视口测试**：模拟 1594px 视口的 366px 宽卡片，模型卡 25/25 完美对称（diff≈0.00002）。
- **视觉确认**：headless Chrome 1594×1000 截图浅色/深色模型库，模型卡名称距卡顶与操作区距卡底留白一致。

### 本轮修改文件
- `web/src/components/ui/CardContent.vue`（根因修复：去 pt-0）
- `web/src/views/Dashboard.vue`（统计卡等高模式统一）
- `web/src/views/Models.vue`（模型卡等高模式统一，E 盘源同步）
- 副本同步：D:\NexusLLMapi\NexusLLMapi 同三文件

### 验证命令
```
npm run build   # vite 构建 + tsc 编译，0 错误，CSS 53.71kB（工具类完整）
```
