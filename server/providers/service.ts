import type { RuntimeContext } from '../context.js';
import { Transport } from './transport.js';
import {
  buildHeaders,
  modelsEndpoint,
  parseExtra,
  parseModelList,
  resolveBaseURL,
  transformRequestBody,
  type FetchedModel,
} from './registry.js';
import { classifyModel, isDefaultEnabled } from './classify.js';
import type { ChannelTestResult } from '../service-locator.js';
import { logger } from '../util/logger.js';
import type { ChannelDTO, ModelDTO } from '../db/types.js';

interface SyncResult {
  total: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  text: number;
  image: number;
  video: number;
}

const SKIP_MODALS = new Set(['embedding', 'rerank', 'asr', 'tts']);
const BATCH_CONCURRENCY = 5;

export class ProviderService {
  private transport = new Transport();

  constructor(private ctx: RuntimeContext) {}

  private timeout(): number {
    // 测试/同步固定 30s，独立于转发超时
    return 30_000;
  }

  private proxy(): string {
    return this.ctx.config.get('socks5_proxy') ?? '';
  }

  /** 拉取某渠道的上游模型列表（原始） */
  private async fetchList(ch: ChannelDTO): Promise<FetchedModel[]> {
    const extra = parseExtra(ch.extra_config);
    const base = resolveBaseURL(ch.base_url, extra);
    if (!base) throw new Error('渠道 BaseURL 为空');
    const headers = buildHeaders(ch.provider_type, ch.api_key, extra);
    const resp = await this.transport.request({
      method: 'GET',
      url: modelsEndpoint(base),
      headers,
      timeoutMs: this.timeout(),
      socksProxy: this.proxy(),
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`上游返回 ${resp.status}: ${resp.text.slice(0, 300)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(resp.text);
    } catch (err) {
      throw new Error('模型列表响应不是合法 JSON: ' + (err as Error).message);
    }
    return parseModelList(ch.provider_type, json);
  }

  async testChannel(channelId: number): Promise<ChannelTestResult> {
    const ch = this.ctx.repos.channels.get(channelId);
    if (!ch) return { success: false, message: '渠道不存在' };
    const start = Date.now();
    try {
      const list = await this.fetchList(ch);
      return {
        success: true,
        message: '连接成功',
        status_code: 200,
        model_count: list.length,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      return { success: false, message: '连接失败: ' + (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  async syncChannel(channelId: number): Promise<SyncResult> {
    const ch = this.ctx.repos.channels.get(channelId);
    if (!ch) throw new Error('渠道不存在');
    const list = await this.fetchList(ch);
    const result: SyncResult = { total: list.length, added: 0, updated: 0, skipped: 0, failed: 0, text: 0, image: 0, video: 0 };

    const existing = new Map<string, ModelDTO>();
    for (const m of this.ctx.repos.models.listByChannel(channelId)) existing.set(m.model_id, m);

    for (const info of list) {
      if (SKIP_MODALS.has(info.modal_type)) {
        result.skipped++;
        continue;
      }
      if (info.modal_type === 'image') result.image++;
      else if (info.modal_type === 'video') result.video++;
      else result.text++;

      const tags = JSON.stringify(classifyModel(info.id, info.modal_type));
      const old = existing.get(info.id);
      try {
        if (!old) {
          this.ctx.repos.models.create({
            model_id: info.id,
            channel_id: channelId,
            tags,
            modal_type: info.modal_type,
            max_context: info.max_context,
            available: true,
            enabled: isDefaultEnabled(info.id, info.modal_type),
          });
          result.added++;
        } else {
          // 已存在：保留用户的 enabled/alias/remark，仅刷新元数据与可用态
          this.ctx.repos.models.update(old.id, {
            tags,
            modal_type: info.modal_type,
            max_context: info.max_context,
            available: true,
            enabled: old.enabled,
            alias: old.alias,
            remark: old.remark,
          });
          result.updated++;
        }
      } catch (err) {
        logger.warn('同步模型入库失败', { model: info.id, error: (err as Error).message });
        result.failed++;
      }
    }
    // 上游不再返回的旧模型标为不可用（保留记录与用户 enabled/alias/remark，仅从路由索引剔除）
    const seen = new Set(list.map((i) => i.id));
    for (const [mid, old] of existing) {
      if (seen.has(mid) || SKIP_MODALS.has(old.modal_type) || !old.available) continue;
      this.ctx.repos.models.update(old.id, { available: false });
      result.updated++;
    }
    this.ctx.requestRuntimeReload();
    return result;
  }

  /** 单模型测速（字段与旧后端一致） */
  async testModel(modelDbId: number): Promise<Record<string, unknown>> {
    const m = this.ctx.repos.models.get(modelDbId);
    if (!m) return { id: modelDbId, success: false, error: 'model not found' };
    const ch = this.ctx.repos.channels.get(m.channel_id);
    if (!ch) return { id: modelDbId, model_id: m.model_id, success: false, error: '渠道不存在', duration_ms: 0 };
    if (!ch.enabled) return { id: modelDbId, model_id: m.model_id, channel: ch.name, success: false, error: 'channel is disabled' };

    const extra = parseExtra(ch.extra_config);
    const base = resolveBaseURL(ch.base_url, extra);
    const headers = buildHeaders(ch.provider_type, ch.api_key, extra);
    const payload = JSON.stringify({
      model: m.model_id,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      max_tokens: 10,
      temperature: 0.7,
    });
    const body = transformRequestBody(ch.provider_type, payload, m.model_id);
    const start = Date.now();
    try {
      const resp = await this.transport.request({
        method: 'POST',
        url: `${base}/chat/completions`,
        headers,
        body,
        timeoutMs: this.timeout(),
        socksProxy: this.proxy(),
      });
      const durationMs = Date.now() - start;
      let respJson: Record<string, unknown> = {};
      try {
        respJson = JSON.parse(resp.text);
      } catch {
        /* 非 JSON 响应 */
      }
      const contentPreview = extractContent(respJson).slice(0, 100);
      const usage = (respJson.usage ?? {}) as Record<string, number>;
      const speedLevel = durationMs > 10000 ? 'slow' : durationMs > 3000 ? 'medium' : 'fast';
      return {
        id: modelDbId,
        model_id: m.model_id,
        channel: ch.name,
        success: resp.status === 200,
        status_code: resp.status,
        duration_ms: durationMs,
        speed_level: speedLevel,
        content_preview: contentPreview,
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        error: resp.status === 200 ? '' : resp.text.slice(0, 500),
      };
    } catch (err) {
      return {
        id: modelDbId,
        model_id: m.model_id,
        channel: ch.name,
        success: false,
        duration_ms: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  /** 批量检测：ids 为数组，或 'all' + channel_id；并发上限 5 */
  async batchTest(body: unknown): Promise<{ results: Record<string, unknown>[]; total: number; success: number; failed: number }> {
    const b = (body ?? {}) as { ids?: unknown; channel_id?: number };
    let targets: ModelDTO[] = [];
    if (Array.isArray(b.ids)) {
      for (const v of b.ids) {
        const id = Number(v);
        if (Number.isInteger(id)) {
          const m = this.ctx.repos.models.get(id);
          if (m) targets.push(m);
        }
      }
    } else {
      // 'all' 或缺省：所有已启用模型（可按渠道过滤）
      targets = this.ctx.repos.models
        .listAll()
        .filter((m) => m.enabled && (!b.channel_id || m.channel_id === Number(b.channel_id)));
    }
    if (targets.length === 0) return { results: [], total: 0, success: 0, failed: 0 };

    const results: Record<string, unknown>[] = [];
    let cursor = 0;
    async function worker(svc: ProviderService) {
      while (true) {
        const idx = cursor++;
        if (idx >= targets.length) return;
        const m = targets[idx];
        try {
          results.push(await svc.testModel(m.id));
        } catch (err) {
          results.push({ id: m.id, model_id: m.model_id, success: false, error: (err as Error).message });
        }
      }
    }
    const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, targets.length) }, () => worker(this));
    await Promise.all(workers);

    // 按原模型顺序排序输出
    const order = new Map(targets.map((m, i) => [m.id, i]));
    results.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
    const success = results.filter((r) => r.success === true).length;
    return { results, total: results.length, success, failed: results.length - success };
  }

  dispose(): void {
    this.transport.dispose();
  }
}

function extractContent(respJson: Record<string, unknown>): string {
  try {
    const choices = respJson.choices as Array<{ message?: { content?: unknown } }> | undefined;
    const first = choices?.[0]?.message?.content;
    if (typeof first === 'string') return first;
    if (Array.isArray(first)) {
      // 部分厂商 content 为分段数组
      return first.map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''))).join('');
    }
  } catch {
    /* ignore */
  }
  return '';
}
