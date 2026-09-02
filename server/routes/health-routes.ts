import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  app.get('/health/live', ctx.selfHealth.live);
  app.get('/health/ready', ctx.selfHealth.readyHandler);
  app.get('/health/deep', ctx.selfHealth.deep);
  app.get('/health', ctx.selfHealth.health);
  app.get('/__nexus/status', ctx.selfHealth.nexusStatus);

  // ================= 渠道健康（Channel Health） =================
  // 汇总状态
  app.get('/api/health', async (_req, reply) => {
    reply.send({ summary: ctx.channelHealth.summary(), channels: ctx.channelHealth.list() });
  });

  // 手动触发一次检测（正在检测时返回 checking=true，不重复排队）
  app.post('/api/health/trigger', async (_req, reply) => {
    const started = ctx.channelHealth.trigger();
    reply.send({ started, checking: ctx.channelHealth.isChecking });
  });

  // 单渠道健康
  app.get('/api/health/channels/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: { message: 'invalid channel id' } });
    const health = ctx.channelHealth.get(id);
    if (!health) return reply.code(404).send({ error: { message: 'no health record yet, trigger a check first' } });
    reply.send(health);
  });
}
