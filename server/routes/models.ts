import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';
import { parseId } from './helpers.js';
import { ALL_TAGS } from '../providers/templates.js';
import { getProviderService } from '../service-locator.js';

export function registerModelRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  const repo = ctx.repos.models;
  const chRepo = ctx.repos.channels;

  // 静态路径优先注册
  app.get('/api/models/tags', async () => ({ data: ALL_TAGS }));

  app.get('/api/models/stats', async () => {
    const all = repo.listAll();
    const enabled = repo.listEnabled();
    const channels = chRepo.listEnabled();
    const modalStats: Record<string, number> = { text: 0, image: 0, video: 0 };
    for (const m of all) modalStats[m.modal_type] = (modalStats[m.modal_type] ?? 0) + 1;
    return {
      data: {
        total: all.length,
        enabled: enabled.length,
        channels: channels.length,
        modal_stats: modalStats,
      },
    };
  });

  app.post('/api/models/batch-toggle', async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown[]; enabled?: unknown };
    if (!Array.isArray(body.ids)) return reply.code(400).send({ error: 'ids 必须为数组' });
    // 布尔严格解析（避免 "false" 字符串被 Boolean() 误判为 true）
    const enabled = body.enabled === true || body.enabled === 'true';
    repo.batchToggle(body.ids.map(Number), enabled);
    ctx.requestRuntimeReload();
    return { message: 'ok' };
  });

  app.post('/api/models/batch-test', async (req, reply) => {
    const svc = getProviderService();
    if (!svc) return reply.code(503).send({ error: 'Provider 服务尚未就绪' });
    return svc.batchTest(req.body);
  });

  app.post('/api/models/batch-delete', async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: number[] };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.code(400).send({ error: 'ids 不能为空' });
    }
    const deleted = repo.batchDelete(body.ids.map(Number));
    ctx.requestRuntimeReload();
    return { message: 'deleted', deleted, total: body.ids.length };
  });

  app.get('/api/models', async (req) => {
    const q = req.query as Record<string, string>;
    const page = Number(q.page ?? 1) || 1;
    const pageSize = Number(q.page_size ?? 50) || 50;
    const enabled = q.enabled === undefined ? null : q.enabled === 'true';
    const { list, total } = repo.query({
      page,
      pageSize,
      keyword: q.keyword || '',
      modalType: q.modal_type || '',
      tag: q.tag || '',
      channelId: Number(q.channel_id ?? 0) || 0,
      enabled,
    });
    return { data: list, total, page, page_size: pageSize };
  });

  app.get('/api/models/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const m = repo.get(id);
    if (!m) return reply.code(404).send({ error: 'model not found' });
    return { data: m };
  });

  app.put('/api/models/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const u = (req.body ?? {}) as Record<string, unknown>;
    const m = repo.update(id, {
      alias: typeof u.alias === 'string' ? u.alias : undefined,
      remark: typeof u.remark === 'string' ? u.remark : undefined,
      enabled: typeof u.enabled === 'boolean' ? u.enabled : undefined,
      available: typeof u.available === 'boolean' ? u.available : undefined,
      max_context: typeof u.max_context === 'number' ? u.max_context : undefined,
      tags: typeof u.tags === 'string' ? u.tags : undefined,
      modal_type: typeof u.modal_type === 'string' ? u.modal_type : undefined,
      model_id: typeof u.model_id === 'string' ? u.model_id : undefined,
    });
    if (!m) return reply.code(404).send({ error: 'model not found' });
    ctx.requestRuntimeReload();
    return { data: m };
  });

  app.delete('/api/models/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    repo.remove(id);
    ctx.requestRuntimeReload();
    return { message: 'deleted' };
  });

  app.post('/api/models/:id/toggle', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const current = repo.get(id);
    // 布尔严格解析：空 body 翻转当前状态；表单编码的 "true"/"false" 字符串也能正确识别
    const raw = (req.body as { enabled?: unknown } | undefined)?.enabled;
    let enabled: boolean;
    if (typeof raw === 'boolean') enabled = raw;
    else if (raw === 'true' || raw === '1') enabled = true;
    else if (raw === 'false' || raw === '0') enabled = false;
    else enabled = current ? !current.enabled : true; // 无 body 或无法识别：视为翻转
    repo.toggle(id, enabled);
    ctx.requestRuntimeReload();
    return { message: 'ok', enabled };
  });

  app.post('/api/models/:id/test', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = getProviderService();
    if (!svc) return reply.code(503).send({ success: false, error: 'Provider 服务尚未就绪' });
    return svc.testModel(id);
  });
}
