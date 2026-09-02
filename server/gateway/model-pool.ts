import type { ChannelDTO } from '../db/types.js';
import { inferTier, type CapabilityTier } from '../providers/templates.js';
import type { RuntimeContext } from '../context.js';
import { logger } from '../util/logger.js';

export type CircuitState = 'idle' | 'busy' | 'cooldown' | 'probation' | 'exhausted';

export interface ChannelRuntime {
  provider: ChannelDTO;
  state: ChannelState;
}

export interface ChannelState {
  channel_id: number;
  state: CircuitState;
  active_conns: number;
  consec_fail: number;
  success_count: number;
  fail_count: number;
  last_success_at: number;
  last_fail_at: number;
  cooldown_until: number; // epoch ms，0=无
  total_tokens: number;
}

interface ModelEntry {
  modelId: string;
  alias: string;
  tier: CapabilityTier;
  enabled: boolean;
  available: boolean;
}

export interface Candidate {
  channelId: number;
  realModel: string;
}

export interface Selection {
  channel: ChannelRuntime;
  realModel: string;
}

const ALL_TIERS: CapabilityTier[] = ['fast', 'smart', 'vision', 'code', 'image', 'video'];

/** 粘性会话条目：30 分钟内同一客户端尽量路由到同一渠道 */
interface StickyEntry {
  channelId: number;
  realModel: string;
  expiresAt: number;
}

/** 模型路由池：内存索引，零 DB 热查询；rebuild 全量重建并保留熔断状态 */
export class ModelPool {
  private channels = new Map<number, ChannelRuntime>();
  private allModels = new Map<number, ModelEntry[]>();
  private modelIdx = new Map<string, number[]>();
  private aliasIdx = new Map<string, Candidate[]>();
  private tierIdx = new Map<CapabilityTier, number[]>();
  private sticky = new Map<string, StickyEntry>();
  private readonly stickyTtlMs = 30 * 60 * 1000;

  constructor(private ctx: RuntimeContext) {
    // 显式 sticky 过期清理（惰性删除之外的兜底），周期性扫描
    this.sweepTimer = setInterval(() => this.sweepSticky(), 60_000);
    this.sweepTimer.unref?.();
  }
  private sweepTimer: NodeJS.Timeout;

  private maxConns(): number {
    const v = this.ctx.config.get('max_channel_conns');
    return v > 0 ? v : 100;
  }

  private stickyKey(clientKey: string | undefined): string | null {
    const k = (clientKey ?? '').trim();
    return k ? `sticky:${k}` : null;
  }

  private setSticky(key: string, channelId: number, realModel: string) {
    this.sticky.set(key, { channelId, realModel, expiresAt: Date.now() + this.stickyTtlMs });
  }

  /** sticky 渠道对指定模型仍可路由才使用；失效/被禁用/熔断/模型不可用则返回 false */
  private stickyUsable(entry: StickyEntry, model: string, exclude: Set<number>): boolean {
    if (exclude.has(entry.channelId)) return false;
    if (entry.expiresAt <= Date.now()) return false;
    const rt = this.channels.get(entry.channelId);
    if (!rt || !rt.provider.enabled) return false;
    if (!this.isAvailable(rt, Date.now())) return false;
    const cands = this.exactCandidates(model, new Set());
    return cands.some((c) => c.channelId === entry.channelId);
  }

  /** sticky 渠道对指定梯队可用（有该梯队模型或任意可用模型可兜底）；不校验旧 realModel */
  private stickyChannelUsable(entry: StickyEntry, tier: CapabilityTier, exclude: Set<number>): boolean {
    if (exclude.has(entry.channelId)) return false;
    if (entry.expiresAt <= Date.now()) return false;
    const rt = this.channels.get(entry.channelId);
    if (!rt || !rt.provider.enabled) return false;
    if (!this.isAvailable(rt, Date.now())) return false;
    const ids = this.tierIdx.get(tier) ?? [];
    if (ids.includes(entry.channelId)) return true;
    const entries = this.allModels.get(entry.channelId) ?? [];
    return entries.some((e) => e.enabled && e.available);
  }

  /** 显式清理过期 sticky 条目，返回清理数量 */
  sweepSticky(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, e] of this.sticky) {
      if (e.expiresAt <= now) {
        this.sticky.delete(k);
        removed++;
      }
    }
    if (removed > 0) logger.info('清理过期粘性会话', { removed });
    return removed;
  }

  /** 释放内部定时器等资源（应用关闭时调用） */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      (this.sweepTimer as unknown as undefined) = undefined;
    }
    this.sticky.clear();
  }

  /** 全量重建索引（保留旧渠道熔断状态） */
  rebuild() {
    this.sweepSticky();
    const channelDTOs = this.ctx.repos.channels.list();
    const modelDTOs = this.ctx.repos.models.listAll();
    const oldStates = new Map<number, ChannelState>();
    for (const [id, rt] of this.channels) oldStates.set(id, rt.state);

    this.channels = new Map();
    this.allModels = new Map();
    this.modelIdx = new Map();
    this.aliasIdx = new Map();
    this.tierIdx = new Map();

    const now = Date.now();
    for (const ch of channelDTOs) {
      let state = oldStates.get(ch.id);
      if (!state) {
        state = {
          channel_id: ch.id,
          state: 'idle',
          active_conns: 0,
          consec_fail: 0,
          success_count: 0,
          fail_count: 0,
          last_success_at: 0,
          last_fail_at: 0,
          cooldown_until: 0,
          total_tokens: 0,
        };
      }
      // 恢复持久化熔断（disabled_until）
      if (ch.disabled_until) {
        const until = Date.parse(ch.disabled_until);
        if (Number.isFinite(until) && until > now) {
          state.state = 'cooldown';
          state.cooldown_until = until;
        }
      }
      const rt: ChannelRuntime = { provider: ch, state };
      this.channels.set(ch.id, rt);

      // 元数据（全部模型，含不可用）
      const entries: ModelEntry[] = modelDTOs
        .filter((m) => m.channel_id === ch.id)
        .map((m) => ({
          modelId: m.model_id,
          alias: m.alias ?? '',
          tier: inferTier(m.model_id, m.modal_type),
          enabled: m.enabled,
          available: m.available,
        }));
      this.allModels.set(ch.id, entries);
      this.addToActiveIndex(rt, entries);
    }
    logger.info('模型路由池重建完成', { channels: this.channels.size, models: modelDTOs.length });
  }

  private addToActiveIndex(rt: ChannelRuntime, entries: ModelEntry[]) {
    if (!rt.provider.enabled) return;
    const chId = rt.provider.id;
    for (const e of entries) {
      if (!e.enabled || !e.available || !e.modelId) continue;
      this.appendUnique(this.modelIdx, e.modelId, chId);
      this.appendUnique(this.tierIdx, e.tier, chId);
      if (e.alias && e.alias !== e.modelId) {
        const list = this.aliasIdx.get(e.alias) ?? [];
        list.push({ channelId: chId, realModel: e.modelId });
        this.aliasIdx.set(e.alias, list);
      }
    }
  }

  private appendUnique<K>(map: Map<K, number[]>, key: K, id: number) {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    map.set(key, list);
  }

  /** 精确候选：alias 多目标 + 真实模型 ID，去重，排除指定渠道 */
  private exactCandidates(model: string, exclude: Set<number>): Candidate[] {
    const cands: Candidate[] = [];
    const aliasTargets = this.aliasIdx.get(model);
    if (aliasTargets) {
      for (const t of aliasTargets) {
        if (!exclude.has(t.channelId)) cands.push({ channelId: t.channelId, realModel: t.realModel });
      }
    }
    const ids = this.modelIdx.get(model);
    if (ids) {
      for (const id of ids) {
        if (exclude.has(id)) continue;
        if (!cands.some((c) => c.channelId === id)) cands.push({ channelId: id, realModel: model });
      }
    }
    return cands;
  }

  /** 精确选择（立即模式不等待）；支持粘性会话 */
  async selectExact(model: string, exclude: number[], immediate: boolean, clientKey?: string): Promise<Selection> {
    const excludeSet = new Set(exclude);
    const key = this.stickyKey(clientKey);
    if (key) {
      const entry = this.sticky.get(key);
      if (entry && this.stickyUsable(entry, model, excludeSet)) {
        // 当前请求的 model 在 sticky 渠道上的真实模型（别名目标可能因渠道而异，不能用旧条目 realModel）
        const realOnCh = this.exactCandidates(model, excludeSet).find((c) => c.channelId === entry.channelId)?.realModel ?? model;
        const cand: Candidate = { channelId: entry.channelId, realModel: realOnCh };
        const got = this.acquire([cand]);
        if (got) {
          entry.expiresAt = Date.now() + this.stickyTtlMs;
          return got;
        }
        if (!immediate) {
          try {
            const waited = await this.waitAcquire([cand]);
            entry.expiresAt = Date.now() + this.stickyTtlMs;
            return waited;
          } catch {
            /* 并发占满，落入常规重路由 */
          }
        }
      }
      // 失效 / 不可用 / 被禁用 → 重新路由并刷新 sticky
      if (entry) this.sticky.delete(key);
    }
    const cands = this.exactCandidates(model, excludeSet);
    if (cands.length === 0) throw new PoolError('no matching model found', 'NO_MODEL');
    const got = this.acquire(cands);
    if (got) {
      if (key) this.setSticky(key, got.channel.provider.id, got.realModel);
      return got;
    }
    if (immediate) throw new PoolError('all channels are busy', 'BUSY');
    const waited = await this.waitAcquire(cands);
    if (key) this.setSticky(key, waited.channel.provider.id, waited.realModel);
    return waited;
  }

  /** 梯队选择（降级/熔断切换）；支持粘性会话 */
  async selectTier(tier: CapabilityTier, exclude: number[], immediate: boolean, clientKey?: string): Promise<Selection> {
    const excludeSet = new Set(exclude);
    const key = this.stickyKey(clientKey);
    if (key) {
      const entry = this.sticky.get(key);
      if (entry && this.stickyChannelUsable(entry, tier, excludeSet)) {
        // 仅保持渠道粘性；realModel 按当前 tier 在 sticky 渠道上重算（避免沿用旧模型导致降级错配）
        const cand: Candidate = { channelId: entry.channelId, realModel: '' };
        const got = this.acquire([cand], tier);
        if (got) {
          entry.expiresAt = Date.now() + this.stickyTtlMs;
          return got;
        }
        if (!immediate) {
          try {
            const waited = await this.waitAcquire([cand], tier);
            entry.expiresAt = Date.now() + this.stickyTtlMs;
            return waited;
          } catch {
            /* fall through */
          }
        }
      }
      if (entry) this.sticky.delete(key);
    }
    const cands: Candidate[] = [];
    for (const id of this.tierIdx.get(tier) ?? []) {
      if (!excludeSet.has(id)) cands.push({ channelId: id, realModel: '' });
    }
    if (cands.length === 0) throw new PoolError('no matching model found for tier', 'NO_MODEL');
    const got = this.acquire(cands, tier);
    if (got) {
      if (key) this.setSticky(key, got.channel.provider.id, got.realModel);
      return got;
    }
    if (immediate) throw new PoolError('all channels are busy', 'BUSY');
    const waited = await this.waitAcquire(cands, tier);
    if (key) this.setSticky(key, waited.channel.provider.id, waited.realModel);
    return waited;
  }

  private isAvailable(rt: ChannelRuntime, now: number): boolean {
    if (!rt.provider.enabled) return false;
    const s = rt.state;
    switch (s.state) {
      case 'idle':
        return true;
      case 'busy':
        return s.active_conns < this.maxConns();
      case 'cooldown':
        if (now > s.cooldown_until) {
          s.state = 'probation';
          return true;
        }
        return false;
      case 'probation':
        return s.active_conns === 0;
      case 'exhausted':
        return false;
      default:
        return true;
    }
  }

  private acquire(cands: Candidate[], tier?: CapabilityTier): Selection | null {
    const now = Date.now();
    const avail: ChannelRuntime[] = [];
    const realByCh = new Map<number, string>();
    for (const c of cands) {
      const rt = this.channels.get(c.channelId);
      if (!rt) continue;
      if (this.isAvailable(rt, now)) {
        avail.push(rt);
        realByCh.set(c.channelId, c.realModel);
      }
    }
    if (avail.length === 0) return null;
    avail.sort((a, b) => this.score(a) - this.score(b));
    const best = avail[0];
    best.state.active_conns++;
    if (best.state.state === 'idle' || best.state.state === 'probation') best.state.state = 'busy';
    let realModel = realByCh.get(best.provider.id) ?? '';
    if (!realModel) realModel = this.pickModelForChannel(best, tier);
    return { channel: best, realModel };
  }

  private score(rt: ChannelRuntime): number {
    const s = rt.state;
    let score = s.active_conns * 100 + s.consec_fail * 50;
    if (s.last_success_at) score += ((Date.now() - s.last_success_at) / 1000) * 0.01;
    return score;
  }

  private pickModelForChannel(rt: ChannelRuntime, tier?: CapabilityTier): string {
    const entries = this.allModels.get(rt.provider.id) ?? [];
    let fallback = '';
    for (const e of entries) {
      if (!e.enabled || !e.available || !e.modelId) continue;
      if (!fallback) fallback = e.modelId;
      if (tier && e.tier === tier) return e.modelId;
    }
    return fallback;
  }

  private waitAcquire(cands: Candidate[], tier?: CapabilityTier): Promise<Selection> {
    const deadline = Date.now() + 30_000;
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const got = this.acquire(cands, tier);
        if (got) {
          clearInterval(timer);
          resolve(got);
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new PoolError('all channels are busy (wait timeout)', 'BUSY'));
        }
      }, 100);
      timer.unref?.();
    });
  }

  /** 释放并发槽并更新熔断（每次 acquire 恰好一次）；success=false 视为渠道故障（retryable/fatal 均累计） */
  release(channelId: number, success: boolean, tokens = 0) {
    const rt = this.channels.get(channelId);
    if (!rt) return;
    const s = rt.state;
    if (s.active_conns > 0) s.active_conns--;
    const now = Date.now();
    if (success) {
      s.success_count++;
      s.consec_fail = 0;
      s.last_success_at = now;
      s.total_tokens += tokens;
      if ((s.state === 'busy' || s.state === 'probation') && s.active_conns === 0) s.state = 'idle';
    } else {
      s.fail_count++;
      s.consec_fail++;
      s.last_fail_at = now;
      if (s.consec_fail >= 5) {
        // cooldown = 基础(default_cooldown) + 失败惩罚(min(consec_fail,30) 秒)
        const base = Math.max(0, this.ctx.config.get('default_cooldown'));
        const penalty = Math.min(s.consec_fail, 30);
        const sec = base + penalty;
        s.cooldown_until = now + sec * 1000;
        s.state = 'cooldown';
        logger.warn('渠道进入冷却', { channel_id: channelId, consec_fail: s.consec_fail, cooldown_sec: sec, base, penalty });
        // 持久化冷却截止时间
        try {
          const iso = new Date(s.cooldown_until).toISOString();
          this.ctx.repos.channels.setDisabledUntil(channelId, iso);
        } catch (err) {
          logger.warn('持久化冷却状态失败', { error: (err as Error).message });
        }
      } else if (s.active_conns === 0) {
        s.state = 'idle';
      }
    }
  }

  /** 中性释放：仅回收并发槽，不计失败（本地限流 / 客户端中断 / 流式空闲超时等非渠道故障场景） */
  releaseNeutral(channelId: number) {
    const rt = this.channels.get(channelId);
    if (!rt) return;
    const s = rt.state;
    if (s.active_conns > 0) s.active_conns--;
    if ((s.state === 'busy' || s.state === 'probation') && s.active_conns === 0) s.state = 'idle';
  }

  markExhausted(channelId: number) {
    const rt = this.channels.get(channelId);
    if (!rt) return;
    rt.state.state = 'exhausted';
    rt.state.cooldown_until = Date.now() + 100 * 365 * 24 * 3600 * 1000;
  }

  resetState(channelId: number) {
    const rt = this.channels.get(channelId);
    if (!rt) return;
    rt.state.state = 'idle';
    rt.state.consec_fail = 0;
    rt.state.cooldown_until = 0;
    rt.state.active_conns = 0;
    try {
      this.ctx.repos.channels.setDisabledUntil(channelId, null);
    } catch {
      /* ignore */
    }
  }

  getRuntime(channelId: number): ChannelRuntime | undefined {
    return this.channels.get(channelId);
  }

  allStates(): ChannelState[] {
    return [...this.channels.values()].map((rt) => ({ ...rt.state })).sort((a, b) => a.channel_id - b.channel_id);
  }

  /** 当前可路由模型（真实 ID + 别名），供 /v1/models */
  listRoutable(): Array<{ id: string; aliasOf: string; channelId: number }> {
    const out: Array<{ id: string; aliasOf: string; channelId: number }> = [];
    for (const [mid, ids] of this.modelIdx) if (ids.length > 0) out.push({ id: mid, aliasOf: '', channelId: ids[0] });
    for (const [alias, targets] of this.aliasIdx)
      if (targets.length > 0) out.push({ id: alias, aliasOf: targets[0].realModel, channelId: targets[0].channelId });
    return out;
  }

  /** 梯队级联顺序：fast→[fast,smart]；其余→[smart,fast] */
  static tierChain(tier: CapabilityTier): CapabilityTier[] {
    return tier === 'fast' ? ['fast', 'smart'] : ['smart', 'fast'];
  }

  allTierList(): CapabilityTier[] {
    return ALL_TIERS;
  }
}

export class PoolError extends Error {
  constructor(
    message: string,
    public code: 'NO_MODEL' | 'BUSY',
  ) {
    super(message);
    this.name = 'PoolError';
  }
}
