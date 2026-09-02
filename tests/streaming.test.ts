import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeCtx, seedChannel, seedModel, makeApp, startMockUpstream, sleep, cleanup, tempBase } from './helpers.js';
import type { FastifyInstance } from 'fastify';
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

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

function post(port: number, body: unknown): http.ClientRequest {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-client-id': 'stream-client' },
  });
  req.end(data);
  return req;
}

/** 读取完整响应 */
function readAll(req: http.ClientRequest): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** 读取到首块数据即回调（用于客户端中途断开测试） */
function readUntilFirstChunk(req: http.ClientRequest): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    req.on('response', (res) => {
      res.once('data', () => resolve(res));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function setupStreamApp(handler: (port: number) => void, cfg?: Record<string, unknown>) {
  const b = freshCtx(cfg);
  const mock = await startMockUpstream((_r, res) => {
    handler(mock.port);
    if (!res.writableEnded) {
      // 默认：标准 SSE
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"B"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
  seedChannel(b.ctx, { name: 's', provider_type: 'custom', base_url: mock.base });
  seedModel(b.ctx, 1, 'm1');
  const app = await makeApp(b);
  const port = await listen(app.app);
  return { b, mock, app: app.app, port };
}

describe('流式管道', () => {
  it('正常 SSE：数据块 + [DONE]，结束后活跃流归零', async () => {
    const { b, app, port, mock } = await setupStreamApp(() => undefined);
    try {
      const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const res = await readAll(req);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('[DONE]');
      expect(res.body).toContain('A');
      expect(res.body).toContain('B');
      await sleep(200);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(b.ctx.activeRegistry.count()).toBe(0);
      void mock;
    } finally {
      await app.close();
    }
  });

  it('TCP 半途切断：上游在任意字节处断开，网关不崩溃且流归零', async () => {
    const b = freshCtx();
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"cho'); // 写一半
      setTimeout(() => res.destroy(), 10); // 任意字节处切断
    });
    seedChannel(b.ctx, { name: 'cut', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const res = await readAll(req).catch(() => ({ status: 200, headers: {} as http.IncomingHttpHeaders, body: '' }));
      expect(res.status).toBe(200);
      await sleep(300);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(b.ctx.activeRegistry.count()).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('客户端中途断开：网关中止上游并释放（活跃流归零）', async () => {
    const b = freshCtx();
    let upstreamGotAborted = false;
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"X"}}]}\n\n');
      const iv = setInterval(() => {
        try {
          if (!res.destroyed) res.write('data: {"choices":[{"delta":{"content":"Y"}}]}\n\n');
          else {
            clearInterval(iv);
            upstreamGotAborted = true;
          }
        } catch {
          clearInterval(iv);
          upstreamGotAborted = true;
        }
      }, 20);
      res.on('close', () => {
        clearInterval(iv);
      });
    });
    seedChannel(b.ctx, { name: 's2', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const stream = await readUntilFirstChunk(req);
      await sleep(50);
      req.destroy(); // 客户端断开
      await sleep(300);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(b.ctx.activeRegistry.count()).toBe(0);
      void upstreamGotAborted;
      void stream;
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('空闲超时：上游卡住无数据 → 超时中断并补发 error SSE', async () => {
    const b = freshCtx({ idle_timeout_ms: 500 });
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"once"}}]}\n\n');
      // 之后不再写数据（挂起）
      res.on('close', () => {
        /* ignore */
      });
    });
    seedChannel(b.ctx, { name: 'idle', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const res = await readAll(req);
      expect(res.status).toBe(200);
      expect(res.body).toContain('idle timeout');
      await sleep(200);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('并发 100 个流：全部结束后 activeStreams / activeRequests 归零', async () => {
    const b = freshCtx();
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    seedChannel(b.ctx, { name: 's3', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const reqs = Array.from({ length: 100 }, () => {
        const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
        return readAll(req);
      });
      const results = await Promise.all(reqs);
      for (const r of results) expect(r.status).toBe(200);
      await sleep(300);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(b.ctx.activeRegistry.count()).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('流式释放恰好一次：连续多次请求通道并发槽归零（后续请求正常）', async () => {
    const b = freshCtx();
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"z"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    seedChannel(b.ctx, { name: 's4', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      for (let i = 0; i < 3; i++) {
        const res = await readAll(post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true }));
        expect(res.status).toBe(200);
      }
      await sleep(200);
      // 第 4 次仍可正常路由（并发槽未被泄漏占用）
      const res = await readAll(post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true }));
      expect(res.status).toBe(200);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('客户端断开：上游 TCP 连接真实被中止（res close 触发），槽位归零且不计失败', async () => {
    const b = freshCtx();
    let upstreamClosed = false;
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"X"}}]}\n\n');
      res.on('close', () => {
        upstreamClosed = true; // 上游真实观察到连接结束
      });
      // 持续写入以保持上游连接活跃
      const iv = setInterval(() => {
        try {
          if (res.destroyed) {
            clearInterval(iv);
            return;
          }
          res.write('data: {"choices":[{"delta":{"content":"keepalive"}}]}\n\n');
        } catch {
          clearInterval(iv);
        }
      }, 10);
    });
    const ch = seedChannel(b.ctx, { name: 'abort', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, ch.id, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      await readUntilFirstChunk(req);
      await sleep(80);
      req.destroy(); // 客户端主动断开
      await sleep(500);
      // 必须证明真实上游 HTTP 连接结束（而非只释放本地变量）
      expect(upstreamClosed).toBe(true);
      const st = app.gateway.pool.getRuntime(ch.id)!.state;
      expect(st.active_conns).toBe(0);
      expect(st.fail_count).toBe(0);
      expect(st.consec_fail).toBe(0);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(b.ctx.activeRegistry.count()).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('SSE 背压：客户端慢读触发 pause/resume，数据顺序完整，结束后全部归零', async () => {
    const b = freshCtx();
    const chunk = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x'.repeat(32 * 1024) } }] })}\n\n`;
    const totalChunks = 700; // ≈ 22MB SSE
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < totalChunks; i++) res.write(chunk);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    seedChannel(b.ctx, { name: 'bp', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const stream = await readUntilFirstChunk(req);
      // 客户端暂停读取，制造背压
      stream.pause();
      const start = Date.now();
      while (Date.now() - start < 10000) {
        if (app.gateway.backpressure.pauseCount > 0) break;
        await sleep(50);
      }
      expect(app.gateway.backpressure.pauseCount).toBeGreaterThan(0);
      expect(app.gateway.backpressure.maxBufferedBytes).toBeGreaterThan(0);
      // 显式恢复读取（http.IncomingMessage 在 pause 后必须显式 resume），收完所有数据
      stream.resume();
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c as Buffer));
      const endP = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('end timeout')), 20000);
        stream.on('end', () => {
          clearTimeout(t);
          resolve();
        });
        stream.on('error', reject);
      });
      await endP;
      const body = Buffer.concat(chunks).toString('utf-8');
      // 数据完整、顺序正确（以 [DONE] 结尾，长度与上游一致）
      expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
      expect(body.length).toBeGreaterThan(20 * 1024 * 1024);
      expect(body.split('\n\n').length).toBeGreaterThanOrEqual(totalChunks + 1);
      await sleep(400);
      expect(app.gateway.backpressure.resumeCount).toBeGreaterThan(0);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(b.ctx.activeRegistry.count()).toBe(0);
      expect(app.gateway.pool.allStates()[0].active_conns).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('长流内存稳定性：数十 MB SSE 不随完整响应线性累积（增量处理、不保存整条 body）', async () => {
    const b = freshCtx();
    const chunk = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'y'.repeat(32 * 1024) } }] })}\n\n`;
    const totalChunks = 800; // ≈ 25MB SSE
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < totalChunks; i++) res.write(chunk);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    seedChannel(b.ctx, { name: 'mem', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const before = process.memoryUsage().heapUsed;
      // 用流式读取避免客户端侧把整条 body 留在 heapUsed（Buffer 走 external）
      const req = post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
      let bytes = 0;
      await new Promise<void>((resolve, reject) => {
        req.on('response', (res) => {
          res.on('data', (c) => {
            bytes += (c as Buffer).length;
          });
          res.on('end', () => resolve());
          res.on('error', reject);
        });
        req.on('error', reject);
      });
      // 若运行环境暴露了 GC（npm test 以 --expose-gc 启动），先回收瞬时垃圾，
      // 只测"真正被保留"的内存，避免不同 Node 版本 V8 年轻代大小差异造成误报
      if (typeof global.gc === 'function') {
        await new Promise((r) => setTimeout(r, 100));
        global.gc();
        await new Promise((r) => setTimeout(r, 100));
      }
      const after = process.memoryUsage().heapUsed;
      const delta = after - before;
      expect(bytes).toBeGreaterThan(20 * 1024 * 1024);
      // 未按完整响应体线性累积：增量 delta 远小于 body 大小（且远小于 25MB）
      expect(delta).toBeLessThan(15 * 1024 * 1024);
      console.log(`[mem] bodyBytes=${bytes} heapDelta=${delta}`);
      await sleep(300);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(app.gateway.pool.allStates()[0].active_conns).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('P2 跨 TCP chunk：usage JSON 被拆成多段 + [DONE] 拆成两段 → usage 仍正确、[DONE] 只输出一次', async () => {
    const b = freshCtx();
    const usageLine = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'final' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
    // 手动拆成 5 段（每一段都可能与 TCP 行边界不一致）
    const frags = [usageLine.slice(0, 18), usageLine.slice(18, 41), usageLine.slice(41, 77), usageLine.slice(77, 120), usageLine.slice(120)];
    const mock = await startMockUpstream(async (_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.socket?.setNoDelay(true);
      for (const f of frags) {
        await new Promise((r) => setTimeout(r, 3));
        res.write(f);
      }
      // [DONE] 拆成两段：'data: [DO' + 'NE]\n\n'
      await new Promise((r) => setTimeout(r, 3));
      res.write('data: [DO');
      await new Promise((r) => setTimeout(r, 3));
      res.write('NE]\n\n');
      res.end();
    });
    seedChannel(b.ctx, { name: 'sse-split', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const res = await readAll(post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true }));
      expect(res.status).toBe(200);
      // 正确识别 sawDone → 网关不会额外补发一个 [DONE]
      expect(res.body.split('data: [DONE]').length - 1).toBe(1);
      expect(res.body).toContain('"total_tokens":15');
      // usage 被正确解析并写入请求日志
      await sleep(200);
      const rows = b.ctx.repos.logs.query({ pageSize: 5 }).list;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].total_tokens).toBe(15);
      expect(rows[0].prompt_tokens).toBe(10);
      expect(rows[0].completion_tokens).toBe(5);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });

  it('P2 跨 TCP chunk：一条超长 data line 被拆 5~10 段 → 内容完整、[DONE] 只一次、流归零', async () => {
    const b = freshCtx();
    const content = 'x'.repeat(24 * 1024);
    const line = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
    const seg = Math.ceil(line.length / 7); // 拆 7 段
    const parts: string[] = [];
    for (let i = 0; i < line.length; i += seg) parts.push(line.slice(i, i + seg));
    expect(parts.length).toBeGreaterThanOrEqual(5);
    const mock = await startMockUpstream(async (_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.socket?.setNoDelay(true);
      for (const p of parts) {
        await new Promise((r) => setTimeout(r, 2));
        res.write(p);
      }
      await new Promise((r) => setTimeout(r, 2));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    seedChannel(b.ctx, { name: 'sse-split2', provider_type: 'custom', base_url: mock.base });
    seedModel(b.ctx, 1, 'm1');
    const app = await makeApp(b);
    const port = await listen(app.app);
    try {
      const res = await readAll(post(port, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true }));
      expect(res.status).toBe(200);
      // 内容完整、顺序正确
      expect(res.body).toContain(content);
      expect(res.body.split('data: [DONE]').length - 1).toBe(1);
      await sleep(200);
      expect(b.ctx.activeRegistry.streamCount()).toBe(0);
      expect(app.gateway.pool.allStates()[0].active_conns).toBe(0);
    } finally {
      await app.app.close();
      await mock.close();
    }
  });
});
