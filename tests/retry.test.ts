import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEventListeners } from 'node:events';
import { makeCtx, seedChannel, seedModel, makeApp, startMockUpstream, cleanup, tempBase, chatCompletionJSON } from './helpers.js';
import { Transport } from '../server/providers/transport.js';
import type { CtxBundle } from './helpers.js';

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

function chatRequests(mock: { requests: Array<{ method: string; url: string }> }): number {
  return mock.requests.filter((r) => r.method === 'POST' && /chat\/completions/.test(r.url)).length;
}

function mockJSON(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

describe('重试语义', () => {
  it('retry_count=0：即使上游 500 也只请求一次', async () => {
    const b = freshCtx();
    let calls = 0;
    const mock = await startMockUpstream((_r, res) => {
      calls++;
      mockJSON(res, 500, { error: 'boom' });
    });
    const ch = seedChannel(b.ctx, { name: 'no-retry', provider_type: 'custom', base_url: mock.base, retry_count: 0 });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'retry-0' },
    });
    expect(r.statusCode).toBe(500);
    expect(calls).toBe(1);
    expect(chatRequests(mock)).toBe(1);
    await app.app.close();
    await mock.close();
  });

  it('500 后重试成功（default_retry=2）：先 500 后 200，共 2 次请求', async () => {
    const b = freshCtx();
    let calls = 0;
    const mock = await startMockUpstream((_r, res) => {
      calls++;
      if (calls === 1) return mockJSON(res, 500, { error: 'temp' });
      return mockJSON(res, 200, chatCompletionJSON('m1', 'ok'));
    });
    seedChannel(b.ctx, { name: 'retry2', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'retry-2' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toBe('ok');
    expect(calls).toBe(2);
    expect(r.headers['x-fallback-attempts']).toBe('1');
    await app.app.close();
    await mock.close();
  });

  it('429 触发重试并尊重 Retry-After（此处 0s）', async () => {
    const b = freshCtx();
    let calls = 0;
    const mock = await startMockUpstream((_r, res) => {
      calls++;
      if (calls === 1) return mockJSON(res, 429, { error: 'rate limited' }, { 'retry-after': '0' });
      return mockJSON(res, 200, chatCompletionJSON('m1', 'ok'));
    });
    seedChannel(b.ctx, { name: 'rl', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'retry-429' },
    });
    expect(r.statusCode).toBe(200);
    expect(calls).toBe(2);
    await app.app.close();
    await mock.close();
  });

  it('401 认证失败不重试', async () => {
    const b = freshCtx();
    let calls = 0;
    const mock = await startMockUpstream((_r, res) => {
      calls++;
      mockJSON(res, 401, { error: 'unauthorized' });
    });
    seedChannel(b.ctx, { name: 'auth', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'retry-401' },
    });
    expect(r.statusCode).toBe(401);
    expect(calls).toBe(1);
    await app.app.close();
    await mock.close();
  });

  it('上游 404 模型不存在不重试', async () => {
    const b = freshCtx();
    let calls = 0;
    const mock = await startMockUpstream((_r, res) => {
      calls++;
      mockJSON(res, 404, { error: 'model not found' });
    });
    seedChannel(b.ctx, { name: 'nf', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'retry-404' },
    });
    expect(r.statusCode).toBe(404);
    expect(calls).toBe(1);
    await app.app.close();
    await mock.close();
  });

  it('网络连接被重置触发重试', async () => {
    const b = freshCtx();
    let calls = 0;
    const server = http.createServer((_req, res) => {
      calls++;
      res.destroy(); // 立即断开
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const mock = { base: `http://127.0.0.1:${port}/v1`, requests: [] as unknown[] };
    try {
      seedChannel(b.ctx, { name: 'reset', provider_type: 'custom', base_url: mock.base });
      seedModel(b.ctx, 1, 'm1');
      const app = await makeApp(b);
      const r = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-client-id': 'retry-reset' },
      });
      expect(r.statusCode).toBe(502);
      expect(calls).toBe(3); // retry_count=2 → 3 次尝试
      await app.app.close();
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it('Transport 硬超时：上游不响应 → 抛 upstream timeout 并释放', async () => {
    // 起一个挂起的上游（接受连接但不返回）
    const server = http.createServer(() => {
      /* 永不响应 */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const transport = new Transport();
      const start = Date.now();
      await expect(
        transport.request({
          method: 'POST',
          url: `http://127.0.0.1:${port}/v1/chat/completions`,
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/timeout|abort/i);
      expect(Date.now() - start).toBeLessThan(5000);
      transport.dispose();
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it('P1 requestStream：进入时 signal 已 aborted → 立即中止，不发起上游请求（hits=0）且无 abort listener 泄漏', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"ok":1}\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const transport = new Transport();
      const ctrl = new AbortController();
      ctrl.abort(); // 进入 requestStream 之前 signal 已 abort（客户端已断开 / server 已 shutdown）
      await expect(
        transport.requestStream(
          {
            method: 'POST',
            url: `http://127.0.0.1:${port}/v1/chat/completions`,
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            timeoutMs: 2000,
          },
          ctrl.signal,
        ),
      ).rejects.toThrow(/abort/i);
      // 未发起任何上游请求（建连前立即失败）
      expect(hits).toBe(0);
      // 未在已 abort 的 signal 上遗留 abort listener
      expect(getEventListeners(ctrl.signal, 'abort').length).toBe(0);
      transport.dispose();
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe('retry_count 三态语义（网关真实请求级）', () => {
  it('测试A：default_retry=3 + channel.retry_count=0 → 永远 500 也只请求 1 次', async () => {
    const b = freshCtx({ default_retry: 3 });
    let hits = 0;
    const mock = await startMockUpstream((_r, res) => {
      hits++;
      mockJSON(res, 500, { error: 'boom' });
    });
    const ch = seedChannel(b.ctx, { name: 'A', provider_type: 'custom', base_url: mock.base, retry_count: 0 });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'trio-A' },
    });
    expect(r.statusCode).toBe(500);
    expect(hits).toBe(1);
    await app.app.close();
    await mock.close();
  });

  it('测试B：default_retry=3 + channel.retry_count=-1（继承全局）→ 3次500后第4次200，共4次请求且最终成功', async () => {
    const b = freshCtx({ default_retry: 3 });
    let hits = 0;
    const mock = await startMockUpstream((_r, res) => {
      hits++;
      if (hits <= 3) return mockJSON(res, 500, { error: 'temp' });
      return mockJSON(res, 200, chatCompletionJSON('m1', 'ok-b'));
    });
    const ch = seedChannel(b.ctx, { name: 'B', provider_type: 'custom', base_url: mock.base, retry_count: -1 });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'trio-B' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toBe('ok-b');
    expect(hits).toBe(4);
    expect(r.headers['x-fallback-attempts']).toBe('3');
    await app.app.close();
    await mock.close();
  });

  it('测试C：default_retry=5 + channel.retry_count=2（覆盖全局）→ 2次500后第3次200，共3次请求且最终成功', async () => {
    const b = freshCtx({ default_retry: 5 });
    let hits = 0;
    const mock = await startMockUpstream((_r, res) => {
      hits++;
      if (hits <= 2) return mockJSON(res, 500, { error: 'temp' });
      return mockJSON(res, 200, chatCompletionJSON('m1', 'ok-c'));
    });
    const ch = seedChannel(b.ctx, { name: 'C', provider_type: 'custom', base_url: mock.base, retry_count: 2 });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const r = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-client-id': 'trio-C' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toBe('ok-c');
    expect(hits).toBe(3);
    expect(r.headers['x-fallback-attempts']).toBe('2');
    await app.app.close();
    await mock.close();
  });

  it('状态码矩阵：401/403/404 不重试（仅 1 次），429/500/502/503/504 按规则重试（第 2 次成功）', async () => {
    const noRetry = [401, 403, 404];
    const retry = [429, 500, 502, 503, 504];
    for (const code of noRetry) {
      const b = freshCtx();
      let hits = 0;
      const mock = await startMockUpstream((_r, res) => {
        hits++;
        mockJSON(res, code, { error: 'x' });
      });
      const ch = seedChannel(b.ctx, { name: `nr-${code}`, provider_type: 'custom', base_url: mock.base });
      seedModel(b.ctx, ch.id, 'm1');
      const app = await makeApp(b);
      const r = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-client-id': `nr-${code}` },
      });
      expect(r.statusCode).toBe(code);
      expect(hits).toBe(1);
      await app.app.close();
      await mock.close();
    }
    for (const code of retry) {
      const b = freshCtx();
      let hits = 0;
      const mock = await startMockUpstream((_r, res) => {
        hits++;
        if (hits === 1) return mockJSON(res, code, { error: 'temp' });
        return mockJSON(res, 200, chatCompletionJSON('m1', `ok-${code}`));
      });
      const ch = seedChannel(b.ctx, { name: `rt-${code}`, provider_type: 'custom', base_url: mock.base });
      seedModel(b.ctx, ch.id, 'm1');
      const app = await makeApp(b);
      const r = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
        headers: { 'x-client-id': `rt-${code}` },
      });
      expect(r.statusCode).toBe(200);
      expect(hits).toBe(2);
      await app.app.close();
      await mock.close();
    }
  });
});
