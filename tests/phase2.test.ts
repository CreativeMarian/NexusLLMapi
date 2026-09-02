import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import {
  makeCtx,
  seedChannel,
  seedModel,
  makeApp,
  startMockUpstream,
  cleanup,
  tempBase,
  sleep,
} from './helpers.js';
import type { CtxBundle } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { getProviderService } from '../server/service-locator.js';
import { anthropicToOpenAI, openaiToAnthropic, AnthropicSseConverter } from '../server/gateway/protocol-in.js';

const bundles: CtxBundle[] = [];
function freshCtx(extraCfg?: Record<string, unknown>): CtxBundle {
  const b = makeCtx(tempBase(), extraCfg);
  bundles.push(b);
  return b;
}
afterEach(() => {
  while (bundles.length) {
    const b = bundles.pop()!;
    try {
      b.db.close();
    } catch {
      /* ignore */
    }
    cleanup(b.baseDir);
  }
});

describe('Phase2：sticky 跨模型（P0-3）', () => {
  it('selectTier 粘性：按当前 tier 在 sticky 渠道上重算 realModel，不沿用旧模型', async () => {
    const b = freshCtx();
    const ch1 = seedChannel(b.ctx, { name: 'c1', provider_type: 'custom', base_url: 'http://c1/v1' });
    const ch2 = seedChannel(b.ctx, { name: 'c2', provider_type: 'custom', base_url: 'http://c2/v1' });
    // ch1: smart + fast；ch2: smart + fast
    seedModel(b.ctx, ch1.id, 'claude-sonnet-4'); // smart
    seedModel(b.ctx, ch1.id, 'qwen-flash'); // fast
    seedModel(b.ctx, ch2.id, 'gpt-4o'); // smart
    seedModel(b.ctx, ch2.id, 'gpt-fast'); // fast
    const app = await makeApp(b);
    const gw = app.gateway;
    // 先请求 smart 模型 → sticky 到 ch1 的 claude-sonnet-4
    const s1 = await gw.pool.selectExact('claude-sonnet-4', [], true, 'px-client');
    expect(s1.channel.provider.id).toBe(ch1.id);
    gw.pool.release(ch1.id, true);
    // 再按 fast 梯队请求 → 不应沿用 claude-sonnet-4，而应在 sticky 渠道 ch1 上选 fast 模型
    const s2 = await gw.pool.selectTier('fast', [], true, 'px-client');
    expect(s2.channel.provider.id).toBe(ch1.id);
    expect(s2.realModel).toBe('qwen-flash');
    gw.pool.release(s2.channel.provider.id, true);
    await app.app.close();
  });

  it('sweepSticky 显式清理：过期条目被移除', async () => {
    const b = freshCtx();
    const ch = seedChannel(b.ctx, { name: 'c', provider_type: 'custom', base_url: 'http://c/v1' });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const gw = app.gateway;
    const s = await gw.pool.selectExact('m1', [], true, 'sweep-client');
    gw.pool.release(s.channel.provider.id, true);
    // 手动把 sticky 条目的过期时间改为过去
    const pool = gw.pool as unknown as { sticky: Map<string, { expiresAt: number }> };
    for (const [, e] of pool.sticky) e.expiresAt = Date.now() - 1;
    const removed = gw.pool.sweepSticky();
    expect(removed).toBeGreaterThan(0);
    expect(pool.sticky.size).toBe(0);
    await app.app.close();
  });
});

describe('Phase2：Anthropic tools 三向转换（P0-4）', () => {
  it('anthropicToOpenAI：tool_use → tool_calls，tool_result → tool 消息，tools schema 转换', () => {
    const r = anthropicToOpenAI(
      JSON.stringify({
        model: 'claude-x',
        stream: false,
        tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: '上海天气？' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '让我查一下' },
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Shanghai' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴，25 度' }],
          },
        ],
      }),
    );
    const o = JSON.parse(r.openaiBody) as {
      tools: { type: string; function: { name: string; parameters: unknown } }[];
      messages: { role: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string; content: unknown }[];
    };
    expect(o.tools[0].function.name).toBe('get_weather');
    expect(o.tools[0].function.parameters).toHaveProperty('properties.city');
    // assistant：text + tool_calls
    const asst = o.messages.find((m) => m.role === 'assistant')!;
    expect(asst.tool_calls?.length).toBe(1);
    expect(asst.tool_calls![0].id).toBe('toolu_1');
    expect(asst.tool_calls![0].function.name).toBe('get_weather');
    expect(JSON.parse(asst.tool_calls![0].function.arguments)).toEqual({ city: 'Shanghai' });
    // tool_result → role=tool
    const toolMsg = o.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('toolu_1');
    expect(toolMsg.content).toContain('晴');
  });

  it('openaiToAnthropic：tool_calls → content tool_use block，finish_reason=tool_calls → stop_reason=tool_use', () => {
    const out = openaiToAnthropic(
      JSON.stringify({
        id: 'chatcmpl-1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
      'claude-x',
    );
    const a = JSON.parse(out) as {
      content: { type: string; id?: string; name?: string; input?: unknown; text?: string }[];
      stop_reason: string;
    };
    expect(a.stop_reason).toBe('tool_use');
    const toolBlock = a.content.find((c) => c.type === 'tool_use')!;
    expect(toolBlock.id).toBe('call_9');
    expect(toolBlock.name).toBe('get_weather');
    expect(toolBlock.input).toEqual({ city: 'Beijing' });
  });

  it('AnthropicSseConverter：tool_calls 增量 → tool_use block + input_json_delta + block_stop', () => {
    const conv = new AnthropicSseConverter();
    let out = '';
    out += conv.feed(JSON.stringify({ model: 'claude-x', choices: [{ index: 0, delta: { content: '查' } }] }));
    out += conv.feed(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } },
              ],
            },
          },
        ],
      }),
    );
    out += conv.feed(
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Beijing"' } }] } }],
      }),
    );
    out += conv.end();
    expect(out).toContain('content_block_start');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"get_weather"');
    expect(out).toContain('input_json_delta');
    expect(out).toContain('"partial_json":"{\\"city\\":"');
    // 每个 open block 都有对应的 stop
    const starts = (out.match(/content_block_start/g) ?? []).length;
    const stops = (out.match(/content_block_stop/g) ?? []).length;
    expect(stops).toBeGreaterThanOrEqual(starts);
  });
});

describe('Phase2：流式失败分类（P0-2）', () => {
  it('流式上游 401：不重试、透传上游错误体与状态码、计一次失败', async () => {
    const b = freshCtx();
    let hits = 0;
    const mock = await startMockUpstream((_r, res) => {
      hits++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key', type: 'authentication_error' } }));
    });
    seedChannel(b.ctx, { name: 's401', provider_type: 'custom', base_url: mock.base, retry_count: 2 });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const res = await postAndRead(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      expect(res.status).toBe(401);
      expect(res.body).toContain('bad key');
      expect(hits).toBe(1); // 401 不在可重试集合 → 不重试
      const st = app.gateway.pool.getRuntime(1)!.state;
      expect(st.consec_fail).toBe(1);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('流式客户端断开：中性释放，不计入渠道熔断（consec_fail 不变）', async () => {
    const b = freshCtx();
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
      const iv = setInterval(() => {
        if (!res.destroyed) res.write('data: {"choices":[{"delta":{"content":"B"}}]}\n\n');
        else clearInterval(iv);
      }, 20);
      res.on('close', () => clearInterval(iv));
    });
    seedChannel(b.ctx, { name: 'abort', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      req.end(JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true }));
      await new Promise<void>((r) =>
        req.on('response', (res) => {
          res.once('data', () => r());
        }),
      );
      await sleep(50);
      req.destroy(); // 客户端断开
      await sleep(400);
      const st = app.gateway.pool.getRuntime(1)!.state;
      expect(st.consec_fail).toBe(0); // 客户端断开不累计失败
      expect(st.fail_count).toBe(0);
      expect(st.active_conns).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });
});

describe('Phase2：retry_count=0 与设置热更新（P1）', () => {
  it('创建渠道 retry_count=0 保留（不落成 2），更新 0 也保留', async () => {
    const b = freshCtx();
    const app = await makeApp(b);
    try {
      const created = await app.app.inject({
        method: 'POST',
        url: '/api/channels',
        payload: { name: 'no-retry', provider_type: 'custom', base_url: 'http://x/v1', retry_count: 0 },
      });
      const ch = created.json().data;
      expect(ch.retry_count).toBe(0);
      // 更新为 0
      const upd = await app.app.inject({
        method: 'PUT',
        url: `/api/channels/${ch.id}`,
        payload: { retry_count: 0 },
      });
      expect(upd.json().data.retry_count).toBe(0);
    } finally {
      await app.app.close();
    }
  });

  it('PUT /api/settings 热更新 idle_timeout_ms 与 channel_health_interval_sec 生效', async () => {
    const b = freshCtx();
    const app = await makeApp(b);
    try {
      const res = await app.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { idle_timeout_ms: 12345, channel_health_interval_sec: 300 },
      });
      expect(res.statusCode).toBe(200);
      const got = await app.app.inject({ method: 'GET', url: '/api/settings' });
      const data = got.json().data;
      expect(data.idle_timeout_ms).toBe(12345);
      expect(data.channel_health_interval_sec).toBe(300);
    } finally {
      await app.app.close();
    }
  });
});

describe('Phase2：CORS 收敛', () => {
  it('本地来源放行，远程来源不反射 ACAO', async () => {
    const b = freshCtx();
    const app = await makeApp(b);
    try {
      const local = await app.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost:5173' } });
      expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      const evil = await app.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example.com' } });
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      // OPTIONS 预检：本地来源 204
      const preflight = await app.app.inject({
        method: 'OPTIONS',
        url: '/v1/chat/completions',
        headers: { origin: 'http://127.0.0.1:8787', 'access-control-request-method': 'POST' },
      });
      expect(preflight.statusCode).toBe(204);
    } finally {
      await app.app.close();
    }
  });
});

describe('Phase2：DB 备份保留与 WAL 一致性快照', () => {
  it('启动备份只保留最近 5 份，integrityCheck 用 quick_check', async () => {
    const b = freshCtx();
    // 模拟多次启动备份（错开时间戳避免同名覆盖）
    for (let i = 0; i < 7; i++) {
      await b.db.backup();
      await sleep(5);
    }
    const dir = join(b.baseDir, 'data', 'backups');
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((f) => /^store-.*\.db\.bak$/.test(f));
    expect(files.length).toBe(5);
    expect(b.db.integrityCheck()).toBe('ok');
    expect(b.db.fullIntegrityCheck()).toBe('ok');
  });

  it('WAL 中未 checkpoint 的数据进入备份；备份文件 quick_check = ok', async () => {
    const b = freshCtx();
    // 写入两行：一行在已 checkpoint 的主库，一行仅在 WAL（不 checkpoint）
    b.db.checkpoint();
    b.db.db.prepare('INSERT INTO request_logs (request_id, created_at, created_date) VALUES (?, ?, ?)').run(
      'ckpt-1',
      new Date().toISOString(),
      new Date().toISOString().slice(0, 10),
    );
    b.db.db.prepare('INSERT INTO request_logs (request_id, created_at, created_date) VALUES (?, ?, ?)').run(
      'wal-only-row',
      new Date().toISOString(),
      new Date().toISOString().slice(0, 10),
    );
    // 不 checkpoint：第二行仍只存在于 WAL
    const dest = await b.db.backup();
    expect(dest).toBeTruthy();
    // 备份必须是自包含单文件：无 -wal/-shm 侧文件
    const sidecars = readdirSync(join(b.baseDir, 'data', 'backups')).filter((f) => /\.db\.bak-(wal|shm)$/.test(f));
    expect(sidecars).toHaveLength(0);
    // 打开备份文件验证：新插入的数据必须存在，且 quick_check=ok
    const bak = new Database(String(dest), { readonly: true });
    try {
      const qc = String(bak.pragma('quick_check', { simple: true }));
      expect(qc).toBe('ok');
      const row = bak.prepare("SELECT request_id FROM request_logs WHERE request_id = 'wal-only-row'").get();
      expect(row).toBeTruthy();
      const ckpt = bak.prepare("SELECT request_id FROM request_logs WHERE request_id = 'ckpt-1'").get();
      expect(ckpt).toBeTruthy();
    } finally {
      bak.close();
    }
  });
});

describe('Phase2：健康检查不误伤（仅真正 upstream failure 进入熔断统计）', () => {
  it('全局限流命中（429）：通道并发槽回收，但不计失败/连续失败', async () => {
    const b = freshCtx({ global_rpm: 1 });
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const ch = seedChannel(b.ctx, { name: 'rl-neutral', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    try {
      // 第一个请求消费掉唯一令牌；第二个请求在窗口内命中限流
      const r1 = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-client-id': 'rl-neutral' },
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-client-id': 'rl-neutral' },
      });
      expect(r2.statusCode).toBe(429);
      const st = app.gateway.pool.getRuntime(ch.id)!.state;
      expect(st.active_conns).toBe(0);
      expect(st.fail_count).toBe(0);
      expect(st.consec_fail).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('渠道并发占满：排队等待不误伤（不产生失败计数）', async () => {
    const b = freshCtx({ max_channel_conns: 1 });
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      const t = setTimeout(() => {
        res.write('data: [DONE]\n\n');
        res.end();
      }, 250);
      res.on('close', () => clearTimeout(t));
    });
    const ch = seedChannel(b.ctx, { name: 'busy', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      // 两个并发流：第二个在等待第一个释放槽位
      const p1 = postAndRead(port, { model: 'm1', messages: [{ role: 'user', content: 'a' }], stream: true });
      await sleep(50);
      const p2 = postAndRead(port, { model: 'm1', messages: [{ role: 'user', content: 'b' }], stream: true });
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      await sleep(200);
      const st = app.gateway.pool.getRuntime(ch.id)!.state;
      expect(st.active_conns).toBe(0);
      expect(st.consec_fail).toBe(0);
      expect(st.fail_count).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('Supervisor 优雅关闭中断进行中的流：中性释放，不计入渠道失败', async () => {
    const b = freshCtx();
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"X"}}]}\n\n');
      // 之后挂起不结束
    });
    const ch = seedChannel(b.ctx, { name: 'shut', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const p = postAndRead(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      await sleep(120);
      // 模拟 Supervisor 优雅关闭：中止所有活跃请求（pipeStream 归类为 other → 中性释放）
      b.ctx.activeRegistry.abortAll('server shutting down');
      const r = await p;
      expect(r.body).toContain('server shutdown');
      await sleep(200);
      const st = app.gateway.pool.getRuntime(ch.id)!.state;
      expect(st.active_conns).toBe(0);
      expect(st.consec_fail).toBe(0);
      expect(st.fail_count).toBe(0);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('渠道健康检查失败不污染路由池状态（健康检测与熔断统计解耦）', async () => {
    const b = freshCtx();
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'down' }));
    });
    const ch = seedChannel(b.ctx, { name: 'hcheck', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    try {
      const ps = getProviderService();
      expect(ps).toBeTruthy();
      const r = await ps!.testChannel(ch.id);
      expect(r.success).toBe(false);
      // 路由池熔断状态不受健康检查失败影响
      const st = app.gateway.pool.getRuntime(ch.id)!.state;
      expect(st.consec_fail).toBe(0);
      expect(st.fail_count).toBe(0);
      expect(st.active_conns).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });
});

// ================= 工具 =================
async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

function postAndRead(port: number, body: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}
