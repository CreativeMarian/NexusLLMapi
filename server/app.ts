import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { RuntimeContext } from './context.js';
import { registerHealthRoutes } from './routes/health-routes.js';
import { registerAllRoutes } from './routes/index.js';
import { registerGatewayRoutes } from './routes/gateway-routes.js';
import type { Gateway } from './gateway/gateway.js';
import { logger } from './util/logger.js';

export async function createApp(ctx: RuntimeContext, gateway: Gateway): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: false,
    connectionTimeout: 30_000,
    keepAliveTimeout: 65_000,
  });

  // 兼容无 body / 表单类型的 POST（如 toggle/activate 空请求），避免 Unsupported Media Type
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch {
      done(null, {});
    }
  });
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body ?? '').trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(null, {});
    }
  });

  // CORS：收敛策略——仅放行本地来源（localhost/127.0.0.1 任意端口）与 file://（null origin），
  // 远程站点 Origin 一律不反射，防止任意网页跨站调用本地网关。
  app.addHook('onRequest', async (req, reply) => {
    const origin = corsAllowedOrigin(req.headers.origin);
    if (origin) reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With,anthropic-version,x-api-key');
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  // 统一错误处理
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) logger.error('请求处理异常', { error: err.message, stack: err.stack });
    reply.code(status).send({
      error: err.name ?? 'InternalServerError',
      message: err.message ?? 'internal error',
    });
  });

  // 健康检查路由
  registerHealthRoutes(app, ctx);
  // 管理 API 路由
  await registerAllRoutes(app, ctx);
  // 网关转发路由（/v1/*、/p/*）
  registerGatewayRoutes(app, gateway);

  // 生产模式静态托管前端（web/dist）
  const distDir = join(ctx.config.baseDir, 'web', 'dist');
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir, prefix: '/' });

    // SPA 回退：Vue Router 为 history 模式，直接访问/刷新 /guide /channels /models
    // /settings /logs 等子路由时，若路径不匹配任何文件，统一回退到 index.html 由前端接管。
    // API（/api）、网关（/v1、/p）、健康检查（/health）路径与缺失的真实静态资源仍返回 404。
    app.setNotFoundHandler((request, reply) => {
      const url = (request.url ?? '').split('?')[0];
      const method = request.method;
      const isBackend =
        url.startsWith('/api') ||
        url.startsWith('/v1') ||
        url.startsWith('/p/') ||
        url.startsWith('/health');
      const hasExtension = /\.[A-Za-z0-9]+$/.test(url);
      if (method === 'GET' && !isBackend && !hasExtension) {
        return reply.type('text/html; charset=utf-8').sendFile('index.html');
      }
      return reply.code(404).send({
        message: `Route ${method}:${url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
    });
  }

  return app;
}

/** CORS 放行判定：仅本地来源（localhost/127.0.0.1 任意端口）与 file://（null）返回 Origin，其余返回 null（不加 ACAO） */
function corsAllowedOrigin(reqOrigin: string | string[] | undefined): string | null {
  if (reqOrigin === undefined || reqOrigin === null) return null;
  const origin = Array.isArray(reqOrigin) ? reqOrigin[0] : reqOrigin;
  if (origin === 'null') return 'null'; // file:// 本地工具
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return origin;
  } catch {
    /* 非法 Origin 不反射 */
  }
  return null;
}
