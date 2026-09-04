import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  makeCtx,
  makeApp,
  tempBase,
  cleanup,
  seedChannel,
  seedModel,
  startMockUpstream,
  sleep,
  type MockUpstream,
} from './helpers.js';
import { Gateway } from '../server/gateway/gateway.js';

const cleanupDirs: string[] = [];
const mocks: MockUpstream[] = [];

afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
  for (const d of cleanupDirs.splice(0)) cleanup(d);
});

describe('回归：waitAcquire 响应客户端断开（abort 感知）', () => {
  it('进入时已 aborted → 立即拒绝；等待中 aborted → 提前拒绝（均远小于 30s 上限）', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = makeCtx(base, { max_channel_conns: 1 });
    const ch = seedChannel(b.ctx, { name: 'abort-wait' });
    seedModel(b.ctx, ch.id, 'm1');
    const gateway = new Gateway(b.ctx);
    try {
      // 占满唯一并发槽，使后续 selectExact 进入等待
      const first = await gateway.pool.selectExact('m1', [], true);
      expect(first.channel.provider.id).toBe(ch.id);
      // 进入时 signal 已 aborted：不得轮询，立即失败
      const ac = new AbortController();
      ac.abort();
      const t0 = Date.now();
      await expect(gateway.pool.selectExact('m1', [], false, undefined, ac.signal)).rejects.toMatchObject({ code: 'BUSY' });
      expect(Date.now() - t0).toBeLessThan(1000);
      // 等待期间 signal 变为 aborted：提前终止，而非空等到 30s
      const ac2 = new AbortController();
      const t1 = Date.now();
      const p = gateway.pool.selectExact('m1', [], false, undefined, ac2.signal);
      setTimeout(() => ac2.abort(), 150);
      await expect(p).rejects.toMatchObject({ code: 'BUSY' });
      expect(Date.now() - t1).toBeLessThan(2000);
    } finally {
      gateway.pool.release(ch.id, true);
      gateway.dispose();
      b.db.close();
    }
  });
});

describe('回归：anthropic 流式行缓冲有上限（防无限增长）', () => {
  it('上游先发超大无换行 blob 再发正常 SSE → 仍正确转换、流归零', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('x'.repeat(2 * 1024 * 1024)); // 2MB 无换行，触发行缓冲 64KB 截断保护
      res.write('\ndata: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    mocks.push(mock);
    const b = makeCtx(base);
    const ch = seedChannel(b.ctx, { name: 'buf', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, ch.id, 'm1');
    const appBundle = await makeApp(b);
    await appBundle.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (appBundle.app.server.address() as AddressInfo).port;
    try {
      const body = JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        });
        req.on('response', (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
          r.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
      });
      expect(res.status).toBe(200);
      // 超大无换行 blob 后，正常 SSE 行仍被解析并转换为 anthropic 事件（截断只丢异常长行，不影响后续）
      expect(res.body).toContain('content_block_delta');
      expect(res.body).toContain('"text":"ok"');
      await sleep(300);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(b.ctx.activeRegistry.count()).toBe(0);
    } finally {
      await appBundle.app.close();
      b.db.close();
    }
  });
});
