import { describe, it, expect, afterEach } from 'vitest';
import { makeCtx, seedChannel, seedModel, makeApp, startMockUpstream, cleanup, tempBase } from './helpers.js';
import { Gateway } from '../server/gateway/gateway.js';
import { PoolError } from '../server/gateway/model-pool.js';
import type { RuntimeContext } from '../server/context.js';
import type { CtxBundle } from './helpers.js';

const bundles: CtxBundle[] = [];
function freshCtx(): CtxBundle {
  const b = makeCtx(tempBase());
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

async function gwOf(b: CtxBundle): Promise<Gateway> {
  const gw = new Gateway(b.ctx);
  b.ctx.setReloadHandle(() => gw.reload());
  return gw;
}

function twoChannelSetup(ctx: RuntimeContext) {
  const c1 = seedChannel(ctx, { name: 'ch-A', provider_type: 'custom', base_url: 'http://a/v1' });
  const c2 = seedChannel(ctx, { name: 'ch-B', provider_type: 'custom', base_url: 'http://b/v1' });
  seedModel(ctx, c1.id, 'm1');
  seedModel(ctx, c2.id, 'm1');
  return { c1, c2 };
}

describe('路由池：精确选择 / 别名 / 梯队 / 熔断 / 粘性', () => {
  it('精确模型：唯一渠道命中真实模型名', async () => {
    const b = freshCtx();
    seedChannelModel(b.ctx);
    const gw = await gwOf(b);
    const sel = await gw.pool.selectExact('gpt-test', [], true);
    expect(sel.realModel).toBe('gpt-test');
    expect(sel.channel.provider.id).toBe(1);
    gw.pool.release(sel.channel.provider.id, true);
  });

  it('不存在的模型 → NO_MODEL', async () => {
    const b = freshCtx();
    seedChannelModel(b.ctx);
    const gw = await gwOf(b);
    await expect(gw.pool.selectExact('ghost', [], true)).rejects.toMatchObject({ code: 'NO_MODEL' });
  });

  it('enabled=false 的渠道不参与路由', async () => {
    const b = freshCtx();
    seedChannelModel(b.ctx, 'm1', { enabled: false });
    const gw = await gwOf(b);
    await expect(gw.pool.selectExact('m1', [], true)).rejects.toMatchObject({ code: 'NO_MODEL' });
  });

  it('enabled=false 的模型不参与路由', async () => {
    const b = freshCtx();
    const { ch } = seedChannelModel(b.ctx, 'm1');
    seedModel(b.ctx, ch.id, 'm2', { enabled: false });
    const gw = await gwOf(b);
    await expect(gw.pool.selectExact('m2', [], true)).rejects.toMatchObject({ code: 'NO_MODEL' });
    // m1 仍可用
    const sel = await gw.pool.selectExact('m1', [], true);
    expect(sel.realModel).toBe('m1');
    gw.pool.release(sel.channel.provider.id, true);
  });

  it('available=false 的模型不参与路由（测速失败但保留）', async () => {
    const b = freshCtx();
    const { ch } = seedChannelModel(b.ctx, 'm1');
    seedModel(b.ctx, ch.id, 'm-off', { available: false });
    const gw = await gwOf(b);
    await expect(gw.pool.selectExact('m-off', [], true)).rejects.toMatchObject({ code: 'NO_MODEL' });
  });

  it('alias 解析：别名命中真实模型；多渠道同别名去重后可选', async () => {
    const b = freshCtx();
    const { c1, c2 } = twoChannelSetup(b.ctx);
    // c1 的 m1 设别名 alias-x；c2 的 m2 也设 alias-x
    const m1 = b.ctx.repos.models.listByChannel(c1.id).find((m) => m.model_id === 'm1')!;
    b.ctx.repos.models.update(m1.id, { alias: 'alias-x' });
    const m2 = seedModel(b.ctx, c2.id, 'm2', { alias: 'alias-x' });
    void m2;
    const gw = await gwOf(b);
    const sel = await gw.pool.selectExact('alias-x', [], true);
    expect(['m1', 'm2']).toContain(sel.realModel);
    gw.pool.release(sel.channel.provider.id, true);
  });

  it('同模型多渠道：排除已尝试渠道后可切换到另一渠道', async () => {
    const b = freshCtx();
    const { c1, c2 } = twoChannelSetup(b.ctx);
    const gw = await gwOf(b);
    const first = await gw.pool.selectExact('m1', [], true);
    gw.pool.release(first.channel.provider.id, true);
    const second = await gw.pool.selectExact('m1', [first.channel.provider.id], true);
    expect(second.channel.provider.id).not.toBe(first.channel.provider.id);
    expect([c1.id, c2.id]).toContain(second.channel.provider.id);
    gw.pool.release(second.channel.provider.id, true);
  });

  it('熔断：连续 5 次失败进入冷却，不再被选中', async () => {
    const b = freshCtx();
    const { ch: c1 } = seedChannelModel(b.ctx, 'm1');
    const gw = await gwOf(b);
    // 预释放占用：先选 5 次并标记失败
    for (let i = 0; i < 5; i++) {
      const sel = await gw.pool.selectExact('m1', [], true);
      expect(sel.channel.provider.id).toBe(c1.id);
      gw.pool.release(sel.channel.provider.id, false);
    }
    // 冷却期内不应被选中
    await expect(gw.pool.selectExact('m1', [], true)).rejects.toThrow();
  });

  it('熔断后同模型另一渠道仍可服务（降级切换）', async () => {
    const b = freshCtx();
    const { c1 } = twoChannelSetup(b.ctx);
    const gw = await gwOf(b);
    for (let i = 0; i < 5; i++) {
      const sel = await gw.pool.selectExact('m1', [], true);
      if (sel.channel.provider.id === c1.id) gw.pool.release(c1.id, false);
      else gw.pool.release(sel.channel.provider.id, true);
    }
    // 排除 c1 后，另一渠道仍可路由
    const sel = await gw.pool.selectExact('m1', [c1.id], true);
    expect(sel.channel.provider.id).not.toBe(c1.id);
    gw.pool.release(sel.channel.provider.id, true);
  });

  it('梯队选择：按 tier 命中对应模型', async () => {
    const b = freshCtx();
    const { ch } = seedChannelModel(b.ctx, 'claude-sonnet-4'); // smart
    seedModel(b.ctx, ch.id, 'qwen-flash'); // fast
    const gw = await gwOf(b);
    const fast = await gw.pool.selectTier('fast', [], true);
    expect(fast.realModel).toBe('qwen-flash');
    gw.pool.release(fast.channel.provider.id, true);
    const smart = await gw.pool.selectTier('smart', [], true);
    expect(smart.realModel).toBe('claude-sonnet-4');
    gw.pool.release(smart.channel.provider.id, true);
  });

  it('梯队不存在 → NO_MODEL', async () => {
    const b = freshCtx();
    seedChannelModel(b.ctx, 'gpt-4o');
    const gw = await gwOf(b);
    await expect(gw.pool.selectTier('video', [], true)).rejects.toMatchObject({ code: 'NO_MODEL' });
  });

  it('粘性：同一客户端 30 分钟内固定同一渠道', async () => {
    const b = freshCtx();
    const { c1, c2 } = twoChannelSetup(b.ctx);
    const gw = await gwOf(b);
    const s1 = await gw.pool.selectExact('m1', [], true, 'client-sticky-1');
    gw.pool.release(s1.channel.provider.id, true);
    const s2 = await gw.pool.selectExact('m1', [], true, 'client-sticky-1');
    expect(s2.channel.provider.id).toBe(s1.channel.provider.id);
    gw.pool.release(s2.channel.provider.id, true);
    void c1;
    void c2;
  });

  it('粘性：被粘渠道失效后自动重路由到其它渠道并刷新', async () => {
    const b = freshCtx();
    const { c1 } = twoChannelSetup(b.ctx);
    const gw = await gwOf(b);
    const s1 = await gw.pool.selectExact('m1', [], true, 'client-sticky-2');
    gw.pool.release(s1.channel.provider.id, true);
    // 把被粘渠道禁用并重建 → sticky 失效
    b.ctx.repos.channels.toggle(s1.channel.provider.id, false);
    gw.reload();
    const s2 = await gw.pool.selectExact('m1', [], true, 'client-sticky-2');
    expect(s2.channel.provider.id).not.toBe(s1.channel.provider.id);
    expect(s2.channel.provider.enabled).toBe(true);
    gw.pool.release(s2.channel.provider.id, true);
    void c1;
  });

  it('listRoutable：仅暴露 enabled+available 的模型', async () => {
    const b = freshCtx();
    const { ch } = seedChannelModel(b.ctx, 'm1');
    seedModel(b.ctx, ch.id, 'm-off', { available: false });
    seedModel(b.ctx, ch.id, 'm-dis', { enabled: false });
    const gw = await gwOf(b);
    const ids = gw.pool.listRoutable().map((m) => m.id);
    expect(ids).toContain('m1');
    expect(ids).not.toContain('m-off');
    expect(ids).not.toContain('m-dis');
  });
});

describe('路由池：网关 HTTP 层验证', () => {
  it('无可用模型 → /v1/chat/completions 返回 404 NO_MODEL', async () => {
    const b = freshCtx();
    const app = await makeApp(b);
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'ghost-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('no matching model');
    await app.app.close();
  });

  it('同一客户端经 HTTP 路由稳定命中同一渠道（粘性）', async () => {
    const b = freshCtx();
    const mock = await startMockUpstream((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'm1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    try {
      const { c1, c2 } = twoChannelSetup(b.ctx);
      // 指向 mock
      b.ctx.repos.channels.update(c1.id, { base_url: mock.base });
      b.ctx.repos.channels.update(c2.id, { base_url: mock.base });
      const app = await makeApp(b);
      const call = () =>
        app.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
          headers: { 'x-client-id': 'http-sticky' },
        });
      const r1 = await call();
      const r2 = await call();
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r1.headers['x-routed-via']).toBe(r2.headers['x-routed-via']);
      await app.app.close();
    } finally {
      await mock.close();
    }
  });

  it('PoolError BUSY 映射为 503（全部渠道被占满）', async () => {
    const b = freshCtx();
    seedChannelModel(b.ctx, 'm1');
    const gw = await gwOf(b);
    // 手动把并发槽占满：max_channel_conns=1，acquire 一次不释放
    b.ctx.config.update({ max_channel_conns: 1 });
    gw.reload();
    const sel = await gw.pool.selectExact('m1', [], true);
    void sel; // 不释放
    await expect(gw.pool.selectExact('m1', [], true)).rejects.toMatchObject({ code: 'BUSY' });
  });
});

function seedChannelModel(ctx: RuntimeContext, modelId = 'gpt-test', chOpts: Record<string, unknown> = {}) {
  const c = seedChannel(ctx, chOpts as never);
  seedModel(ctx, c.id, modelId);
  return { ch: c, modelId };
}

// 占位：确保 PoolError 类型被引用（供编译期检查）
void (null as unknown as PoolError);
