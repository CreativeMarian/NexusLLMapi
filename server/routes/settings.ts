import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';

export function registerSettingRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  app.get('/api/settings', async () => ({ data: ctx.config.getSnapshot() }));

  app.put('/api/settings', async (req) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    // ConfigManager.update 内部只接受白名单热更新字段并做校验
    const next = ctx.config.update({
      global_rpm: num(patch.global_rpm),
      default_retry: num(patch.default_retry),
      default_cooldown: num(patch.default_cooldown),
      request_timeout: num(patch.request_timeout),
      max_channel_conns: num(patch.max_channel_conns),
      max_cost_pct: num(patch.max_cost_pct),
      channel_health_interval_sec: num(patch.channel_health_interval_sec),
      idle_timeout_ms: num(patch.idle_timeout_ms),
      enable_log: bool(patch.enable_log),
      auto_open_browser: bool(patch.auto_open_browser),
      socks5_proxy: str(patch.socks5_proxy),
    });
    // 订阅者（限流器/传输工厂/健康检查）由各自模块 subscribe config 变更
    return { data: next };
  });

  // KV 设置
  app.get('/api/settings/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    return { data: ctx.repos.settings.get(key) ?? '' };
  });

  app.put('/api/settings/kv/:key', async (req) => {
    const key = (req.params as { key: string }).key;
    const value = String((req.body as { value?: string })?.value ?? '');
    ctx.repos.settings.set(key, value);
    return { message: 'ok' };
  });
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
