import type { RuntimeContext } from '../context.js';
import type { ChannelTestResult } from '../service-locator.js';
import { getProviderService } from '../service-locator.js';
import { logger } from '../util/logger.js';

export type ChannelHealthStatus = 'ok' | 'fail' | 'pending' | 'disabled';

export interface ChannelHealth {
  channelId: number;
  name: string;
  provider_type: string;
  enabled: boolean;
  status: ChannelHealthStatus;
  last_check_ms: number | null;
  last_success_ms: number | null;
  latency_ms: number | null;
  model_count: number | null;
  consecutive_failures: number;
  message: string;
  error: string;
}

export interface HealthSummary {
  status: 'ok' | 'degraded' | 'pending';
  total: number;
  enabled: number;
  ok: number;
  fail: number;
  pending: number;
  disabled: number;
  checked_at: number;
  checking: boolean;
}

const CONCURRENCY = 5;

/**
 * 渠道健康检查器：后台定时检测所有启用渠道（复用 Provider Adapter + Transport，与转发同一链路），
 * 结果仅用于健康上报/手动触发，不擅自修改渠道 enabled。
 */
export class ChannelHealthService {
  private results = new Map<number, ChannelHealth>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastCheckedAt = 0;

  constructor(private ctx: RuntimeContext) {}

  start(): void {
    this.arm();
    // 热更新：channel_health_interval_sec 变更后重新调度定时器
    this.ctx.config.subscribe((cfg) => this.arm(cfg.channel_health_interval_sec));
    // 启动后先做一次初始检测（不阻塞启动）
    void this.runOnce().catch(() => undefined);
  }

  private arm(intervalSec?: number): void {
    const sec = intervalSec ?? this.ctx.config.get('channel_health_interval_sec');
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!(sec > 0)) return;
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), sec * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isChecking(): boolean {
    return this.running;
  }

  /** 手动触发一次检测（POST /api/health/trigger）；进行中时返回 false */
  trigger(): boolean {
    if (this.running) return false;
    void this.runOnce().catch(() => undefined);
    return true;
  }

  list(): ChannelHealth[] {
    const arr = [...this.results.values()].sort((a, b) => a.channelId - b.channelId);
    // 补全新渠道
    for (const ch of this.ctx.repos.channels.list()) {
      if (!this.results.has(ch.id)) {
        arr.push({
          channelId: ch.id,
          name: ch.name,
          provider_type: ch.provider_type,
          enabled: ch.enabled,
          status: ch.enabled ? 'pending' : 'disabled',
          last_check_ms: null,
          last_success_ms: null,
          latency_ms: null,
          model_count: null,
          consecutive_failures: 0,
          message: ch.enabled ? '未检测' : '渠道未启用',
          error: '',
        });
      }
    }
    arr.sort((a, b) => a.channelId - b.channelId);
    return arr;
  }

  get(id: number): ChannelHealth | null {
    return this.results.get(id) ?? null;
  }

  summary(): HealthSummary {
    const list = this.list();
    const enabled = list.filter((c) => c.enabled);
    const ok = list.filter((c) => c.status === 'ok').length;
    const fail = list.filter((c) => c.status === 'fail').length;
    const pending = list.filter((c) => c.status === 'pending').length;
    const disabled = list.filter((c) => c.status === 'disabled').length;
    const status = this.running ? 'pending' : fail > 0 ? 'degraded' : enabled.length === 0 || pending === enabled.length ? 'pending' : 'ok';
    return {
      status,
      total: list.length,
      enabled: enabled.length,
      ok,
      fail,
      pending,
      disabled,
      checked_at: this.lastCheckedAt,
      checking: this.running,
    };
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const targets = this.ctx.repos.channels.list().filter((c) => c.enabled);
      for (const ch of targets) {
        const cur = this.results.get(ch.id);
        if (!cur) {
          this.results.set(ch.id, {
            channelId: ch.id,
            name: ch.name,
            provider_type: ch.provider_type,
            enabled: ch.enabled,
            status: 'pending',
            last_check_ms: null,
            last_success_ms: null,
            latency_ms: null,
            model_count: null,
            consecutive_failures: 0,
            message: '检测中',
            error: '',
          });
        }
      }

      let cursor = 0;
      const results: Array<{ id: number; r: ChannelTestResult }> = [];
      async function worker(svc: ChannelHealthService) {
        while (true) {
          const idx = cursor++;
          if (idx >= targets.length) return;
          const ch = targets[idx];
          if (!ch) continue;
          const ps = getProviderService();
          if (!ps) return; // Provider 服务未装配（理论不出现）
          const r = await ps.testChannel(ch.id);
          results.push({ id: ch.id, r });
        }
      }
      const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(targets.length, 1)) }, () => worker(this));
      await Promise.all(workers);

      const now = Date.now();
      this.lastCheckedAt = now;
      for (const { id, r } of results) {
        const ch = this.ctx.repos.channels.get(id);
        if (!ch) continue;
        const prev = this.results.get(id);
        const consecutiveFailures = r.success ? 0 : (prev?.consecutive_failures ?? 0) + 1;
        this.results.set(id, {
          channelId: id,
          name: ch.name,
          provider_type: ch.provider_type,
          enabled: ch.enabled,
          status: !ch.enabled ? 'disabled' : r.success ? 'ok' : 'fail',
          last_check_ms: now,
          last_success_ms: r.success ? now : (prev?.last_success_ms ?? null),
          latency_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
          model_count: typeof r.model_count === 'number' ? r.model_count : null,
          consecutive_failures: consecutiveFailures,
          message: r.message ?? (r.success ? '连接成功' : '连接失败'),
          error: r.success ? '' : (r.message ?? ''),
        });
      }
      logger.info('渠道健康检测完成', { checked: results.length, ok: results.filter((x) => x.r.success).length });
    } catch (err) {
      logger.warn('渠道健康检测异常', { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }
}
