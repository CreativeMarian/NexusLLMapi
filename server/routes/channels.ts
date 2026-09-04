import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';
import { parseId } from './helpers.js';
import { PROVIDER_TEMPLATES, getTemplate } from '../providers/templates.js';
import { getProviderService } from '../service-locator.js';

export function registerChannelRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  const repo = ctx.repos.channels;

  app.get('/api/channels/templates', async () => ({ data: PROVIDER_TEMPLATES }));

  app.get('/api/channels', async () => ({ data: repo.list() }));

  app.get('/api/channels/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const ch = repo.get(id);
    if (!ch) return reply.code(404).send({ error: 'channel not found' });
    return { data: ch };
  });

  app.post('/api/channels', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const providerType = String(body.provider_type ?? 'custom');
    let rpmLimit = Number(body.rpm_limit ?? 0);
    let baseURL = String(body.base_url ?? '');
    if (providerType !== 'custom') {
      const tpl = getTemplate(providerType);
      if (tpl) {
        if (!baseURL) baseURL = tpl.base_url;
        if (!rpmLimit) rpmLimit = tpl.default_rpm;
      }
    }
    if (!rpmLimit) rpmLimit = 60;
    // retry_count：未传默认 2；显式 0 表示不重试（0||2 会错误吞掉 0）
    const retryCount = retryInput(body.retry_count) ?? 2;
    const ch = repo.create({
      name: String(body.name ?? ''),
      provider_type: providerType,
      base_url: baseURL,
      api_key: String(body.api_key ?? ''),
      extra_config: typeof body.extra_config === 'string' ? body.extra_config : JSON.stringify(body.extra_config ?? {}),
      enabled: body.enabled === false ? false : true,
      rpm_limit: rpmLimit,
      retry_count: retryCount,
    });
    ctx.requestRuntimeReload();
    return reply.code(200).send({ data: ch });
  });

  app.put('/api/channels/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // rpm_limit 必须是有限数（NaN/Infinity 直传 SQLite 会绑定失败或写入非法值）
    const rpmNum = Number(body.rpm_limit);
    const ch = repo.update(id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      provider_type: body.provider_type !== undefined ? String(body.provider_type) : undefined,
      base_url: body.base_url !== undefined ? String(body.base_url) : undefined,
      api_key: body.api_key !== undefined ? String(body.api_key) : undefined,
      extra_config: body.extra_config !== undefined ? String(body.extra_config) : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      rpm_limit: body.rpm_limit !== undefined ? (Number.isFinite(rpmNum) ? Math.max(0, rpmNum) : undefined) : undefined,
      retry_count: retryInput(body.retry_count),
    });
    if (!ch) return reply.code(404).send({ error: 'channel not found' });
    ctx.requestRuntimeReload();
    return { data: ch };
  });

  app.delete('/api/channels/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    repo.remove(id);
    ctx.requestRuntimeReload();
    return { message: 'deleted' };
  });

  app.post('/api/channels/:id/toggle', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const current = repo.get(id);
    if (!current) return { message: 'ok', incremental: true };
    // 布尔严格解析：空 body 翻转当前状态；表单编码的 "true"/"false" 字符串也能正确识别
    const raw = (req.body as { enabled?: unknown } | undefined)?.enabled;
    let enabled: boolean;
    if (typeof raw === 'boolean') enabled = raw;
    else if (raw === 'true' || raw === '1') enabled = true;
    else if (raw === 'false' || raw === '0') enabled = false;
    else enabled = !current.enabled; // 无 body 或无法识别：视为翻转
    repo.toggle(id, enabled);
    ctx.requestRuntimeReload();
    return { message: 'ok', incremental: true, enabled };
  });

  app.post('/api/channels/:id/test', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = getProviderService();
    if (!svc) return reply.code(503).send({ success: false, message: 'Provider 服务尚未就绪' });
    const result = await svc.testChannel(id);
    return result;
  });

  app.post('/api/channels/:id/sync', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const svc = getProviderService();
    if (!svc) return reply.code(503).send({ error: 'Provider 服务尚未就绪' });
    const result = await svc.syncChannel(id);
    ctx.requestRuntimeReload();
    return { data: result };
  });
}

/** retry_count 入参归一化：未传/非法 → undefined（调用方回退默认）；范围限制 -1..10（-1=继承全局） */
function retryInput(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(-1, Math.min(n, 10));
}
