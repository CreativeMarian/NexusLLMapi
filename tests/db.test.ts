import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { makeCtx, openDbCopy, ORIGINAL_DB, tempBase, cleanup } from './helpers.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('DB 兼容性与事务', () => {
  let baseDir: string;
  beforeAll(() => {
    baseDir = tempBase();
  });
  afterAll(() => cleanup(baseDir));

  it('打开原 store.db 副本：旧数据可读、完整性 ok', () => {
    expect(existsSync(ORIGINAL_DB)).toBe(true);
    const { db, baseDir: bd } = openDbCopy(ORIGINAL_DB);
    try {
      expect(db.integrityCheck()).toBe('ok');
      // 旧渠道/模型/日志/settings 表可读
      const ch = db.db.prepare('SELECT COUNT(*) c FROM channels').get() as { c: number };
      const m = db.db.prepare('SELECT COUNT(*) c FROM models').get() as { c: number };
      const logs = db.db.prepare('SELECT COUNT(*) c FROM request_logs').get() as { c: number };
      const settings = db.db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number };
      expect(ch.c).toBeGreaterThan(0);
      expect(m.c).toBeGreaterThan(0);
      expect(logs.c).toBeGreaterThanOrEqual(0);
      expect(settings.c).toBeGreaterThanOrEqual(0);
      // 旧 settings 可读（如旧保存的 prompt）
      const prompt = db.db.prepare("SELECT value FROM settings WHERE key='prompt_80916'").get() as { value: string } | undefined;
      expect(prompt).toBeTruthy();
      expect(prompt!.value).toContain('"name"');
    } finally {
      db.close();
      cleanup(bd);
    }
  });

  it('Channel CRUD', () => {
    const b = makeCtx(tempBase());
    const { ctx } = b;
    try {
      const c = ctx.repos.channels.create({ name: 'c1', provider_type: 'openai', base_url: 'http://x/v1', api_key: 'k', enabled: true, rpm_limit: 60, retry_count: 2 });
      expect(c.id).toBeGreaterThan(0);
      expect(ctx.repos.channels.get(c.id)?.name).toBe('c1');
      const upd = ctx.repos.channels.update(c.id, { name: 'c2', enabled: false });
      expect(upd?.name).toBe('c2');
      expect(upd?.enabled).toBe(false);
      ctx.repos.channels.remove(c.id);
      expect(ctx.repos.channels.get(c.id)).toBeNull();
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('Model CRUD + 删除渠道级联删除模型', () => {
    const b = makeCtx(tempBase());
    const { ctx } = b;
    try {
      const c = ctx.repos.channels.create({ name: 'mc', base_url: 'http://x/v1' });
      const m = ctx.repos.models.create({ model_id: 'm1', channel_id: c.id, tags: '["对话"]', modal_type: 'text', max_context: 4096, enabled: true, available: true, alias: 'a1', remark: '' });
      expect(m.id).toBeGreaterThan(0);
      expect(ctx.repos.models.get(m.id)?.model_id).toBe('m1');
      ctx.repos.models.update(m.id, { enabled: false });
      expect(ctx.repos.models.get(m.id)?.enabled).toBe(false);
      // 级联删除
      ctx.repos.channels.remove(c.id);
      expect(ctx.repos.models.get(m.id)).toBeNull();
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('事务回滚：约束冲突时不落任何部分写入', () => {
    const b = makeCtx(tempBase());
    const { ctx, db } = b;
    try {
      const c = ctx.repos.channels.create({ name: 'tx', base_url: 'http://x/v1' });
      ctx.repos.models.create({ model_id: 'dup', channel_id: c.id, tags: '[]', modal_type: 'text', max_context: 1, enabled: true, available: true });
      const beforeModels = ctx.repos.models.listAll().length;
      const beforeChannels = ctx.repos.channels.count();
      expect(() => {
        const tx = db.db.transaction(() => {
          ctx.repos.channels.create({ name: 'should-rollback', base_url: 'http://y/v1' });
          // 唯一索引 (channel_id, model_id) 冲突 → 抛错
          ctx.repos.models.create({ model_id: 'dup', channel_id: c.id, tags: '[]', modal_type: 'text', max_context: 1, enabled: true, available: true });
        });
        tx();
      }).toThrow();
      expect(ctx.repos.channels.count()).toBe(beforeChannels);
      expect(ctx.repos.models.listAll().length).toBe(beforeModels);
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('配置导入失败自动回滚（事务）', async () => {
    const b = makeCtx(tempBase());
    const { ctx } = b;
    try {
      // 用真实路由验证导入事务回滚
      const { createApp } = await import('../server/app.js');
      const { Gateway } = await import('../server/gateway/gateway.js');
      const gw = new Gateway(ctx);
      ctx.setReloadHandle(() => gw.reload());
      const app = await createApp(ctx, gw);
      const beforeCh = ctx.repos.channels.count();
      const beforeM = ctx.repos.models.listAll().length;

      const bad = {
        version: '1.0',
        export_at: new Date().toISOString(),
        channels: [{ id: 1, name: 'newch', provider_type: 'custom', base_url: 'http://n/v1', api_key: '', extra_config: '{}', enabled: true, rpm_limit: 60, retry_count: 2 }],
        models: [],
        // settings 传对象值 → better-sqlite3 绑定报错 → 事务整体回滚
        settings: { boom: { nested: 1 } },
      };
      const res = await app.inject({ method: 'POST', url: '/api/config/import', payload: { data: JSON.stringify(bad), mode: 'merge' } });
      expect(res.statusCode).toBe(500);
      expect(ctx.repos.channels.count()).toBe(beforeCh);
      expect(ctx.repos.models.listAll().length).toBe(beforeM);
      await app.close();
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('alias 数据不丢失（同步刷新时保留用户 alias/enabled/remark）', () => {
    const b = makeCtx(tempBase());
    const { ctx } = b;
    try {
      const c = ctx.repos.channels.create({ name: 'al', base_url: 'http://x/v1' });
      const m = ctx.repos.models.create({ model_id: 'm1', alias: 'my-alias', channel_id: c.id, tags: '["对话"]', modal_type: 'text', max_context: 4096, enabled: true, available: true, remark: 'my note' });
      // 模拟 syncChannel 的“已存在则保留 enabled/alias/remark，仅刷新元数据”逻辑
      ctx.repos.models.update(m.id, { tags: '["对话","代码"]', modal_type: 'text', max_context: 8192, available: true, enabled: m.enabled, alias: m.alias, remark: m.remark });
      const after = ctx.repos.models.get(m.id)!;
      expect(after.alias).toBe('my-alias');
      expect(after.remark).toBe('my note');
      expect(after.max_context).toBe(8192);
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('settings 读写 + 旧值保留', () => {
    const b = makeCtx(tempBase());
    const { ctx } = b;
    try {
      ctx.repos.settings.set('test_key', 'v1');
      expect(ctx.repos.settings.get('test_key')).toBe('v1');
      ctx.repos.settings.set('test_key', 'v2');
      expect(ctx.repos.settings.get('test_key')).toBe('v2');
      const all = ctx.repos.settings.all();
      expect(all.test_key).toBe('v2');
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('原始库文件在只读打开时结构完整（列齐全）', () => {
    const db = new Database(ORIGINAL_DB, { readonly: true });
    try {
      const cols = (db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const required of ['id', 'name', 'provider_type', 'base_url', 'api_key', 'extra_config', 'enabled', 'rpm_limit', 'retry_count', 'disabled_until', 'created_at', 'updated_at']) {
        expect(cols).toContain(required);
      }
      const modelCols = (db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const required of ['id', 'model_id', 'alias', 'channel_id', 'tags', 'modal_type', 'max_context', 'enabled', 'available', 'remark']) {
        expect(modelCols).toContain(required);
      }
    } finally {
      db.close();
    }
  });

  it('join 路径拼接正确', () => {
    expect(join('a', 'b')).toBe('a\\b');
  });
});
