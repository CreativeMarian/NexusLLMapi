import type { FastifyInstance } from 'fastify';
import type { Gateway } from '../gateway/gateway.js';

export function registerGatewayRoutes(app: FastifyInstance, gw: Gateway) {
  app.post('/v1/chat/completions', (req, reply) => gw.handleChat(req, reply, 'openai'));
  app.post('/v1/embeddings', (req, reply) => gw.handleEmbeddings(req, reply));
  // 媒体生成（图片 / 视频）：OpenAI 风格 /v1/images/generations 与 /v1/video/generations
  app.post('/v1/images/generations', (req, reply) => gw.handleMediaGeneration(req, reply, 'images/generations'));
  app.post('/v1/video/generations', (req, reply) => gw.handleMediaGeneration(req, reply, 'video/generations'));
  app.get('/v1/models', async (_req, reply) => reply.send(gw.listModels()));

  // 临时诊断：路由池内部状态
  app.get('/__nexus/debug/pool', async (_req, reply) =>
    reply.send({ states: gw.pool.allStates(), routable: gw.pool.listRoutable().map((r) => r.id) }));

  // Anthropic Messages（Claude Code）入站
  app.post('/v1/messages', (req, reply) => gw.handleChat(req, reply, 'anthropic'));
  // OpenAI Responses（Codex）入站
  app.post('/v1/responses', (req, reply) => gw.handleChat(req, reply, 'responses'));

  // 透传：/p/:identifier/任意上游路径（identifier 为数字 ID 或渠道名）
  const passthrough = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const params = req.params as { channelId: string; '*'?: string };
    const identifier = String(params.channelId ?? '').trim();
    if (!identifier) {
      return reply.code(400).send({ error: { message: 'invalid channel identifier' } });
    }
    return gw.handlePassthrough(req, reply, identifier, params['*'] ?? '');
  };
  app.get('/p/:channelId/*', passthrough);
  app.post('/p/:channelId/*', passthrough);
  app.put('/p/:channelId/*', passthrough);
  app.delete('/p/:channelId/*', passthrough);
}
