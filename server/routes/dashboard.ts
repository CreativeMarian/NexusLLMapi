import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';

export function registerDashboardRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  const logs = ctx.repos.logs;
  const channels = ctx.repos.channels;
  const models = ctx.repos.models;

  app.get('/api/dashboard', async () => {
    const stats = logs.stats();
    const allChannels = channels.list();
    const enabledChannels = allChannels.filter((c) => c.enabled);
    const allModels = models.listAll();
    const enabledModels = allModels.filter((m) => m.enabled);
    const modalStats: Record<string, number> = { text: 0, image: 0, video: 0 };
    for (const m of allModels) modalStats[m.modal_type] = (modalStats[m.modal_type] ?? 0) + 1;

    const total = stats.success_count + stats.fail_count;
    const successRate = total === 0 ? 100 : (stats.success_count / total) * 100;

    const weeklyTrend = logs.trend(7).map((t) => ({ date: t.date, requests: t.requests, tokens: t.tokens }));
    const channelStatus = allChannels.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider_type,
      enabled: c.enabled,
      rpm_limit: c.rpm_limit,
    }));

    return {
      data: {
        stats: {
          total_requests: stats.total_requests,
          today_requests: stats.today_requests,
          total_tokens: stats.total_tokens,
          today_tokens: stats.today_tokens,
          channels: allChannels.length,
          enabled_channels: enabledChannels.length,
          models: allModels.length,
          enabled_models: enabledModels.length,
          success_rate: +successRate.toFixed(2),
          avg_duration: Math.round(stats.avg_duration_ms * 100) / 100,
        },
        modal_stats: modalStats,
        weekly_trend: weeklyTrend,
        channel_status: channelStatus,
      },
    };
  });

  app.get('/api/trend', async (req) => {
    const days = String((req.query as { days?: string }).days ?? '7') === '30' ? 30 : 7;
    return { days, trend: logs.trend(days) };
  });

  app.get('/api/trend/channels', async () => ({ channels: logs.channelStats(), total: logs.channelStats().length }));

  app.get('/api/trend/models', async (req) => {
    let limit = Number((req.query as { limit?: string }).limit ?? 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 10;
    if (limit > 100) limit = 100;
    const result = logs.modelStats(limit);
    return { models: result, total: result.length, limit };
  });
}
