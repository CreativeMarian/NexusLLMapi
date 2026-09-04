import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RuntimeContext } from '../context.js';
import { ModelPool, PoolError, type Selection } from './model-pool.js';
import { RateLimiter } from './token-bucket.js';
import { Transport } from '../providers/transport.js';
import { buildHeaders, getSpec, resolveBaseURL, parseExtra, upstreamEndpoint } from '../providers/registry.js';
import { inferTier } from '../providers/templates.js';
import {
  buildUpstreamBody,
  extractTokens,
  peekStream,
  StreamingUsageTracker,
  type Usage,
} from './request-transform.js';
import {
  AnthropicSseConverter,
  ResponsesSseConverter,
  anthropicToOpenAI,
  openaiErrorToAnthropic,
  openaiToAnthropic,
  openaiToResponses,
  responsesToOpenAI,
  type InboundConvertResult,
} from './protocol-in.js';
import { logger } from '../util/logger.js';
export type InboundProtocol = 'openai' | 'anthropic' | 'responses';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** 流式管道返回：区分成功 / 未写头失败（可重试，带真实状态码与错误体）/ 已写头失败（客户端/空闲/上游中断） */
interface StreamResult {
  ok: boolean;
  usage: Usage;
  /** 未写头时的上游状态码；0=建连/网络失败 */
  status?: number;
  /** 未写头时的上游原始错误体 */
  errorBody?: string;
  /** 未写头时的 Retry-After（ms，解析后） */
  retryAfter?: number | null;
  /** 失败原因：upstream=上游/网络；client=客户端断开；idle=流式空闲超时；other=服务关闭等 */
  reason?: 'upstream' | 'client' | 'idle' | 'other';
}

export class Gateway {
  readonly pool: ModelPool;
  readonly limiter = new RateLimiter();
  private transport = new Transport();
  /** SSE 背压观测（测试/诊断用）：pause/resume 次数与客户端写入缓冲峰值 */
  backpressure = { pauseCount: 0, resumeCount: 0, maxBufferedBytes: 0 };

  constructor(private ctx: RuntimeContext) {
    this.pool = new ModelPool(ctx);
    this.pool.rebuild();
    // 全局 RPM 热更新
    this.ctx.config.subscribe((cfg) => this.limiter.reloadGlobal(cfg.global_rpm));
    this.limiter.reloadGlobal(this.ctx.config.get('global_rpm'));
  }

  /** 数据/配置变更后重建索引（保留熔断状态） */
  reload() {
    this.pool.rebuild();
  }

  private requestId(prefix: string): string {
    return `${prefix}-${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  }

  private proxy(): string {
    return this.ctx.config.get('socks5_proxy') ?? '';
  }
  private timeoutMs(): number {
    return Math.max(5, this.ctx.config.get('request_timeout')) * 1000;
  }
  private maxRetry(): number {
    return Math.max(0, this.ctx.config.get('default_retry'));
  }

  /** 渠道级有效重试次数：-1/null/undefined=继承全局；0=不重试；>0=覆盖（上限 10） */
  private effectiveMaxRetry(ch: { retry_count?: number | null }): number {
    const r = ch.retry_count;
    if (r === null || r === undefined || r === -1) return this.maxRetry();
    return Math.min(Math.max(0, r), 10);
  }

  /** 粘性会话 clientKey：优先显示 X-Client-ID；否则用安全的本地请求特征（IP+UA）派生临时 ID */
  private clientKey(req: FastifyRequest): string | undefined {
    const explicit = String(req.headers['x-client-id'] ?? '').trim();
    if (explicit) return explicit;
    const ip = (req.ip ?? '').trim();
    const ua = String(req.headers['user-agent'] ?? '').trim();
    if (!ip && !ua) return undefined;
    return `tmp:${fnv1a(`${ip}|${ua}`).toString(36)}`;
  }
  private logEnabled(): boolean {
    return this.ctx.config.get('enable_log');
  }
  private idleTimeoutMs(): number {
    return Math.max(0, this.ctx.config.get('idle_timeout_ms'));
  }

  // ================= /v1/models =================
  listModels() {
    const routable = this.pool.listRoutable();
    const seen = new Set<string>();
    const data: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
    for (const r of routable) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const ch = this.ctx.repos.channels.get(r.channelId);
      data.push({ id: r.id, object: 'model', created: 0, owned_by: ch?.name ?? '' });
    }
    return { object: 'list', data };
  }

  // ================= 入站归一：把 anthropic/responses 请求转成 OpenAI chat =================
  private normalizeInbound(protocol: InboundProtocol, rawBody: string): InboundConvertResult {
    if (protocol === 'anthropic') return anthropicToOpenAI(rawBody);
    if (protocol === 'responses') return responsesToOpenAI(rawBody);
    return { openaiBody: rawBody, model: '', stream: peekStream(rawBody) };
  }

  // ================= 主入口：chat =================
  async handleChat(req: FastifyRequest, reply: FastifyReply, protocol: InboundProtocol) {
    const rawBody = JSON.stringify(req.body ?? {});
    const conv = this.normalizeInbound(protocol, rawBody);
    const modelName = protocol === 'openai' ? requireModel(rawBody) : conv.model;
    if (!modelName) return writeJson(reply, 400, { error: { message: 'model is required', type: 'proxy_error' } });
    const isStream = protocol === 'openai' ? peekStream(rawBody) : conv.stream;
    const requestId = this.requestId('req');
    const startedAt = Date.now();
    const originalTier = inferTier(modelName);
    const clientKey = this.clientKey(req);

    // 活跃请求注册 + 客户端断开/优雅关闭联动 Abort
    const controller = new AbortController();
    this.ctx.activeRegistry.register({
      requestId,
      route: protocol === 'anthropic' ? '/v1/messages' : protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions',
      model: modelName,
      channelId: null,
      stream: isStream,
      startTime: startedAt,
      lastActivity: startedAt,
      controller,
    });
    const onClientAbort = () => controller.abort(new Error('client aborted'));
    const onClientClose = () => {
      if (!req.raw.complete) controller.abort(new Error('client closed early'));
    };
    req.raw.once('aborted', onClientAbort);
    req.raw.once('close', onClientClose);
    const cleanupRegistry = () => {
      req.raw.removeListener('aborted', onClientAbort);
      req.raw.removeListener('close', onClientClose);
      this.ctx.activeRegistry.unregister(requestId);
    };

    let maxRetry = this.maxRetry();
    const tried: number[] = [];
    let lastErr = '';
    let lastStatus = 502;
    let lastRawError = ''; // 上游原始错误体（非重试类流式错误时透传给客户端）
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      let sel: Selection | null = null;
      try {
        if (attempt === 0) {
          sel = await this.pool.selectExact(modelName, [], false, clientKey, controller.signal);
        } else {
          // 重试：优先同渠道（瞬时可恢复），其次借评分切到更健康渠道；
          // 熔断/冷却中的渠道被 isAvailable 自动排除，无需手动排除 tried；
          try {
            sel = await this.pool.selectExact(modelName, [], true, clientKey, controller.signal);
          } catch {
            let picked: Selection | null = null;
            for (const t of ModelPool.tierChain(originalTier)) {
              try {
                picked = await this.pool.selectTier(t, [], false, clientKey, controller.signal);
                break;
              } catch {
                /* try next tier */
              }
            }
            if (!picked) throw new PoolError('no fallback channel', 'NO_MODEL');
            sel = picked;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) break; // 客户端断开/服务关闭：不再等待也不重试
        lastErr = (err as Error).message;
        lastStatus = err instanceof PoolError && err.code === 'NO_MODEL' ? 404 : 503;
        // NO_MODEL：模型不存在（或已无可路由渠道）是确定性结果，不重试也不应降级到其它模型
        if (err instanceof PoolError && err.code === 'NO_MODEL') break;
        if (attempt < maxRetry) {
          await delay((attempt + 1) * 500);
          continue;
        }
        break;
      }

      const ch = sel.channel.provider;
      // 渠道级 retry_count 优先（-1 继承全局，0 不重试，>0 覆盖）
      maxRetry = this.effectiveMaxRetry(ch);
      // 限流（本地限流器不属于渠道故障，用中性释放，不计入熔断）
      if (!this.limiter.allowGlobal() || !this.limiter.allowChannel(ch.id, ch.rpm_limit)) {
        this.pool.releaseNeutral(ch.id);
        lastErr = 'rate limit exceeded';
        lastStatus = 429;
        if (attempt < maxRetry) {
          await delay(300);
          continue;
        }
        break;
      }

      tried.push(ch.id);
      this.ctx.activeRegistry.touch(requestId);
      let settled = false;
      const releaseOnce = (ok: boolean, tokens = 0) => {
        if (settled) return;
        settled = true;
        this.pool.release(ch.id, ok, tokens);
      };

      const extra = parseExtra(ch.extra_config);
      const base = resolveBaseURL(ch.base_url, extra);
      const spec = getSpec(ch.provider_type);
      const headers = buildHeaders(ch.provider_type, ch.api_key, extra);
      if (isStream) headers.Accept = 'text/event-stream';
      const upstreamBody = buildUpstreamBody(conv.openaiBody, {
        realModel: sel.realModel || modelName,
        providerType: ch.provider_type,
        isStream,
        modelPrefix: spec.modelPrefix,
      });
      const url = upstreamEndpoint(base, '/chat/completions', ch.provider_type, extra);
      const upstreamStart = Date.now();

      try {
        if (isStream) {
          const streamResult = await this.pipeStream(req, reply, protocol, {
            url,
            headers,
            body: upstreamBody,
            requestId,
            channelName: ch.name,
            routedVia: `${ch.name}/${sel.realModel || modelName}`,
            attempt,
            outerSignal: controller.signal,
          });
          const dur = Date.now() - upstreamStart;
          if (streamResult.ok) {
            releaseOnce(true, streamResult.usage.total_tokens);
            this.recordLog(requestId, modelName, ch.id, ch.name, 200, streamResult.usage, dur, '');
            cleanupRegistry();
            return;
          }
          // 流式失败：按失败原因释放（客户端/空闲/优雅关闭中断均不计入渠道熔断——都不是渠道故障），
          // 未写头时用真实上游状态决定是否重试（流式 401/404 不再盲重试）
          const reason = streamResult.reason ?? 'upstream';
          if (reason === 'client' || reason === 'idle' || reason === 'other') this.pool.releaseNeutral(ch.id);
          else releaseOnce(false, streamResult.usage.total_tokens);
          const status = streamResult.status && streamResult.status >= 400 ? streamResult.status : 502;
          lastStatus = status;
          lastErr = streamResult.errorBody ? `upstream ${streamResult.status}: ${streamResult.errorBody.slice(0, 300)}` : (reason === 'client' ? 'client aborted' : 'stream failed');
          if (streamResult.errorBody) lastRawError = streamResult.errorBody;
          this.recordLog(requestId, modelName, ch.id, ch.name, status, streamResult.usage, dur, lastErr);
          // 可重试（未写头）时保留活跃注册与 AbortController 继续下一轮尝试
          if (attempt < maxRetry && !reply.raw.headersSent && (streamResult.status === 0 || RETRYABLE.has(status))) {
            const retryAfterMs = streamResult.retryAfter ?? null;
            await delay(retryAfterMs ?? 500 * (attempt + 1));
            continue;
          }
          cleanupRegistry();
          break;
        }

        // 非流式
        const resp = await this.transport.request({
          method: 'POST',
          url,
          headers,
          body: upstreamBody,
          timeoutMs: this.timeoutMs(),
          socksProxy: this.proxy(),
          signal: controller.signal,
        });
        const dur = Date.now() - upstreamStart;
        if (RETRYABLE.has(resp.status) && attempt < maxRetry) {
          releaseOnce(false);
          lastErr = `upstream returned ${resp.status}`;
          lastStatus = resp.status;
          const retryAfterMs = parseRetryAfter(resp.headers['retry-after']);
          await delay(retryAfterMs ?? 500 * (attempt + 1));
          continue;
        }

        const usage = extractTokens(resp.text);
        let outBody = resp.text;
        reply.header('X-Routed-Via', `${ch.name}/${sel.realModel || modelName}`);
        reply.header('X-Fallback-Attempts', String(attempt));
        reply.header('X-Request-ID', requestId);
        if (protocol === 'anthropic') {
          if (resp.status >= 200 && resp.status < 300) outBody = openaiToAnthropic(resp.text, modelName);
          else outBody = openaiErrorToAnthropic(resp.text, resp.status);
          reply.header('Content-Type', 'application/json');
          reply.code(resp.status).send(outBody);
        } else if (protocol === 'responses') {
          if (resp.status >= 200 && resp.status < 300) outBody = openaiToResponses(resp.text, modelName);
          reply.header('Content-Type', 'application/json');
          reply.code(resp.status).send(outBody);
        } else {
          reply.header('Content-Type', 'application/json');
          reply.code(resp.status).send(Buffer.from(resp.buffer));
        }
        releaseOnce(resp.status < 400, usage.total_tokens);
        this.recordLog(
          requestId,
          modelName,
          ch.id,
          ch.name,
          resp.status,
          usage,
          dur,
          resp.status >= 400 ? resp.text.slice(0, 500) : '',
        );
        cleanupRegistry();
        return;
      } catch (err) {
        if (controller.signal.aborted) {
          // 客户端断开/服务关闭：非渠道故障，中性释放、不再重试
          this.pool.releaseNeutral(ch.id);
          logger.warn('上游请求因客户端断开/服务关闭中断', { attempt, error: (err as Error).message, channel: ch.name });
          break;
        }
        releaseOnce(false);
        lastErr = (err as Error).message;
        lastStatus = 502;
        logger.warn('上游请求异常，准备重试/切换', { attempt, error: lastErr, channel: ch.name });
        if (attempt < maxRetry) continue;
        break;
      }
    }

    // 全部失败
    cleanupRegistry();
    if (!reply.raw.headersSent) {
      this.recordLog(requestId, modelName, 0, '', lastStatus, zeroUsage(), Date.now() - startedAt, lastErr);
      if (protocol === 'anthropic') {
        // Anthropic 客户端依赖 {type:'error'} 结构解析失败信息
        reply
          .code(lastStatus)
          .header('Content-Type', 'application/json')
          .send(openaiErrorToAnthropic(lastRawError || lastErr || 'all attempts failed', lastStatus));
      } else if (lastRawError) {
        // 透传上游原始错误体（如 OpenAI 401/404 的 error JSON），保留其状态码
        reply.code(lastStatus).header('Content-Type', 'application/json').send(lastRawError);
      } else {
        writeJson(reply, lastStatus, { error: { message: lastErr || 'all attempts failed', type: 'proxy_error' } });
      }
    }
  }

  // ================= SSE 管道 =================
  private async pipeStream(
    req: FastifyRequest,
    reply: FastifyReply,
    protocol: InboundProtocol,
    p: { url: string; headers: Record<string, string>; body: string; requestId: string; channelName: string; routedVia: string; attempt: number; outerSignal?: AbortSignal },
  ): Promise<StreamResult> {
    const controller = new AbortController();
    const onClientClose = () => controller.abort(new Error('client disconnected'));
    req.raw.once('close', onClientClose);
    // 客户端在响应流进行中断开（Socket 关闭但响应未写完）→ 联动中止上游
    const onResClose = () => {
      if (!reply.raw.writableEnded) controller.abort(new Error('client disconnected'));
    };
    reply.raw.once('close', onResClose);
    const onOuterAbort = () => controller.abort(new Error('server shutdown'));
    if (p.outerSignal) {
      if (p.outerSignal.aborted) controller.abort();
      else p.outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let upstream: Awaited<ReturnType<Transport['requestStream']>>;
    try {
      upstream = await this.transport.requestStream(
        {
          method: 'POST',
          url: p.url,
          headers: p.headers,
          body: p.body,
          timeoutMs: 10 * 60 * 1000, // 流式 10 分钟硬上限
          socksProxy: this.proxy(),
        },
        controller.signal,
      );
    } catch (err) {
      req.raw.removeListener('close', onClientClose);
      reply.raw.removeListener('close', onResClose);
      if (p.outerSignal) p.outerSignal.removeEventListener('abort', onOuterAbort);
      logger.warn('建立上游流失败', { error: (err as Error).message });
      return { ok: false, usage: zeroUsage(), status: 0, reason: 'upstream' };
    }

    // 上游非 2xx：读取错误体并交由上层重试（尚未向客户端写头）
    if (upstream.statusCode && (upstream.statusCode < 200 || upstream.statusCode >= 300)) {
      const chunks: Buffer[] = [];
      for await (const c of upstream) chunks.push(c as Buffer);
      req.raw.removeListener('close', onClientClose);
      reply.raw.removeListener('close', onResClose);
      if (p.outerSignal) p.outerSignal.removeEventListener('abort', onOuterAbort);
      upstream.destroy();
      return {
        ok: false,
        usage: zeroUsage(),
        status: upstream.statusCode,
        errorBody: Buffer.concat(chunks).toString('utf-8'),
        retryAfter: parseRetryAfter(upstream.headers['retry-after']),
        reason: 'upstream',
      };
    }

    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader('Content-Type', protocol === 'openai' ? 'text/event-stream' : 'text/event-stream; charset=utf-8');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.setHeader('X-Routed-Via', p.routedVia);
    raw.setHeader('X-Request-ID', p.requestId);

    const anth = protocol === 'anthropic' ? new AnthropicSseConverter() : null;
    const respConv = protocol === 'responses' ? new ResponsesSseConverter() : null;
    const usageTracker = new StreamingUsageTracker();

    let lineBuf = '';
    let openaiLineBuf = '';
    let clientAborted = false;

    // 流式空闲超时：上游长时间无数据（半途卡死）→ 主动中断，避免挂死连接
    const idleMs = this.idleTimeoutMs();
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (idleMs > 0) {
        idleTimer = setTimeout(() => controller.abort(new Error('stream idle timeout')), idleMs);
        idleTimer.unref?.();
      }
    };
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const writeOut = (text: string): boolean => {
      if (!text || clientAborted) return false;
      if (!raw.writable) {
        clientAborted = true;
        return false;
      }
      return raw.write(text);
    };

    /** 从 abort 原因推断失败归属：idle=空闲超时、other=服务关闭、client=客户端断开（不计渠道熔断） */
    const abortReason = (): StreamResult['reason'] => {
      const why = (controller.signal.reason as Error | undefined)?.message ?? '';
      if (why.includes('idle timeout')) return 'idle';
      if (why.includes('server shutdown')) return 'other';
      return 'client';
    };

    try {
      armIdle();
      for await (const chunk of upstream) {
        if (controller.signal.aborted) {
          clientAborted = true;
          break;
        }
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        armIdle();
        if (protocol === 'openai') {
          writeOut(text);
          // 增量提取 usage / [DONE]：TCP chunk 不保证与 SSE 行边界一致，用增量行缓冲
          // 逐行消费完整 '\n' 行，仅保留未结束的一小段尾巴；不累积完整 SSE body。
          // 设上限防止异常上游一直不发换行造成无限增长。
          openaiLineBuf += text;
          if (openaiLineBuf.length > 65536) {
            openaiLineBuf = openaiLineBuf.slice(openaiLineBuf.length - 65536);
          }
          let nl: number;
          while ((nl = openaiLineBuf.indexOf('\n')) >= 0) {
            const line = openaiLineBuf.slice(0, nl).trim();
            openaiLineBuf = openaiLineBuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            usageTracker.feed(line.slice(5).trim());
          }
        } else {
          // 按行解析 OpenAI SSE，逐 data 转换；设上限防止异常上游一直不发换行造成无限增长（与 openai 分支一致）
          lineBuf += text;
          if (lineBuf.length > 65536) lineBuf = lineBuf.slice(lineBuf.length - 65536);
          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            usageTracker.feed(data);
            if (data === '[DONE]') continue;
            if (anth) writeOut(anth.feed(data));
            else if (respConv) writeOut(respConv.feed(data));
          }
        }
        // 背压：客户端写入缓冲区已满 → 暂停读上游，等待 drain 后再继续；
        // 竞速 close/error/abort，避免客户端半途关闭或空闲超时触发时 drain 永远不触发而挂死；
        // 结束后清理所有临时监听，避免遗留 listener
        if (raw.writableNeedDrain) {
          this.backpressure.pauseCount++;
          this.backpressure.maxBufferedBytes = Math.max(this.backpressure.maxBufferedBytes, raw.writableLength);
          upstream.pause();
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onClose = () => {
              cleanup();
              reject(new Error('client closed during backpressure'));
            };
            const onError = (e: Error) => {
              cleanup();
              reject(e);
            };
            const onAbort = () => {
              cleanup();
              reject(new Error(controller.signal.reason ?? new Error('stream aborted')));
            };
            const cleanup = () => {
              raw.removeListener('drain', onDrain);
              raw.removeListener('close', onClose);
              raw.removeListener('error', onError);
              controller.signal.removeEventListener('abort', onAbort);
            };
            raw.once('drain', onDrain);
            raw.once('close', onClose);
            raw.once('error', onError);
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          this.backpressure.resumeCount++;
          upstream.resume();
        }
      }
      // 收尾协议事件
      if (protocol === 'anthropic') writeOut(anth!.end());
      else if (protocol === 'responses') {
        const u = usageTracker.usage;
        writeOut(respConv!.end({ input: u.prompt_tokens, output: u.completion_tokens, total: u.total_tokens }));
      }
      if (protocol === 'openai' && !usageTracker.sawDone && !clientAborted) writeOut('data: [DONE]\n\n');
      raw.end();
      return { ok: !clientAborted, usage: usageTracker.usage, reason: clientAborted ? abortReason() : undefined };
    } catch (err) {
      logger.warn('SSE 管道中断', { error: (err as Error).message, channel: p.channelName });
      const reason: StreamResult['reason'] = controller.signal.aborted ? abortReason() : 'upstream';
      try {
        // 空闲超时：向已写头的客户端补发一条 error SSE 事件，再收尾
        if (controller.signal.aborted && !raw.writableEnded) {
          const why = (controller.signal.reason as Error | undefined)?.message || (err as Error).message || 'stream interrupted';
          if (protocol === 'openai') raw.write(`data: ${JSON.stringify({ error: { message: why, type: 'proxy_error' } })}\n\n`);
          else raw.write(`data: ${JSON.stringify({ type: 'error', error: { message: why } })}\n\n`);
        }
        if (!raw.writableEnded) raw.end();
      } catch {
        /* ignore */
      }
      return { ok: false, usage: usageTracker.usage, reason };
    } finally {
      clearIdle();
      req.raw.removeListener('close', onClientClose);
      reply.raw.removeListener('close', onResClose);
      if (p.outerSignal) p.outerSignal.removeEventListener('abort', onOuterAbort);
      upstream.destroy();
    }
  }

  // ================= embeddings（非流式透传）=================
  async handleEmbeddings(req: FastifyRequest, reply: FastifyReply) {
    const rawBody = JSON.stringify(req.body ?? {});
    let model = '';
    try {
      model = String((JSON.parse(rawBody) as { model?: string }).model ?? '');
    } catch {
      /* ignore */
    }
    if (!model) return writeJson(reply, 400, { error: { message: 'model is required' } });
    const rid = this.requestId('emb');
    const start = Date.now();

    let sel: Selection;
    try {
      sel = await this.pool.selectExact(model, [], false);
    } catch (err) {
      return writeJson(reply, err instanceof PoolError && err.code === 'NO_MODEL' ? 404 : 503, {
        error: { message: (err as Error).message },
      });
    }
    const ch = sel.channel.provider;
    let settled = false;
    const release = (ok: boolean) => {
      if (settled) return;
      settled = true;
      this.pool.release(ch.id, ok);
    };
    try {
      const extra = parseExtra(ch.extra_config);
      const resp = await this.transport.request({
        method: 'POST',
        url: upstreamEndpoint(resolveBaseURL(ch.base_url, extra), '/embeddings', ch.provider_type, extra),
        headers: buildHeaders(ch.provider_type, ch.api_key, extra),
        body: rawBody,
        timeoutMs: this.timeoutMs(),
        socksProxy: this.proxy(),
        signal: clientSignal(req),
      });
      reply.header('Content-Type', 'application/json');
      reply.code(resp.status).send(Buffer.from(resp.buffer));
      release(resp.status < 400);
      this.recordLog(rid, model, ch.id, ch.name, resp.status, zeroUsage(), Date.now() - start, resp.status >= 400 ? resp.text.slice(0, 300) : '');
    } catch (err) {
      release(false);
      writeJson(reply, 502, { error: { message: (err as Error).message } });
    }
  }

  // ================= 媒体生成（images / video，非流式透传）=================
  // 统一处理 OpenAI 风格 /v1/images/generations 与 /v1/video/generations：
  // 按 model 精确路由到渠道 → 原样转发 {base}/{kind} → 返回上游响应（JSON / 二进制）。
  // 视频等长任务使用更长超时（至少 10 分钟），避免生成过程中被超时截断。
  async handleMediaGeneration(req: FastifyRequest, reply: FastifyReply, kind: string) {
    const rawBody = Buffer.isBuffer(req.body) ? (req.body as Buffer) : JSON.stringify(req.body ?? {});
    let model = '';
    try {
      model = String((JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString() : String(rawBody)) as { model?: string }).model ?? '');
    } catch {
      /* ignore */
    }
    if (!model) return writeJson(reply, 400, { error: { message: 'model is required' } });
    const rid = this.requestId(kind.startsWith('images') ? 'img' : 'vid');
    const start = Date.now();

    let sel: Selection;
    try {
      sel = await this.pool.selectExact(model, [], false);
    } catch (err) {
      return writeJson(reply, err instanceof PoolError && err.code === 'NO_MODEL' ? 404 : 503, {
        error: { message: (err as Error).message },
      });
    }
    const ch = sel.channel.provider;
    let settled = false;
    const release = (ok: boolean) => {
      if (settled) return;
      settled = true;
      this.pool.release(ch.id, ok);
    };
    try {
      const extra = parseExtra(ch.extra_config);
      const timeoutMs = Math.max(this.timeoutMs(), 600_000); // 媒体生成长耗时：至少 10 分钟
      const resp = await this.transport.request({
        method: 'POST',
        url: upstreamEndpoint(resolveBaseURL(ch.base_url, extra), `/${kind}`, ch.provider_type, extra),
        headers: buildHeaders(ch.provider_type, ch.api_key, extra),
        body: rawBody,
        timeoutMs,
        socksProxy: this.proxy(),
        signal: clientSignal(req),
      });
      reply.header('Content-Type', resp.headers['content-type'] ?? 'application/json');
      reply.code(resp.status).send(Buffer.from(resp.buffer));
      release(resp.status < 400);
      this.recordLog(rid, model, ch.id, ch.name, resp.status, zeroUsage(), Date.now() - start, resp.status >= 400 ? resp.text.slice(0, 300) : '');
    } catch (err) {
      release(false);
      writeJson(reply, 502, { error: { message: (err as Error).message } });
    }
  }

  // ================= passthrough /p/:channelId/* =================
  // 支持按数据库 ID 或渠道名（大小写不敏感）匹配渠道；复用 Provider header/SOCKS5/超时/取消；
  // 上游路径做智能去重：baseURL 已含 /v1 时，/p/4/v1/models -> {base}/models；
  async handlePassthrough(req: FastifyRequest, reply: FastifyReply, identifier: string, subPath: string) {
    const ch = this.findChannel(identifier);
    if (!ch) return writeJson(reply, 404, { error: { message: `channel not found: ${identifier}` } });
    if (!ch.enabled) return writeJson(reply, 503, { error: { message: 'channel disabled' } });
    const extra = parseExtra(ch.extra_config);
    const base = resolveBaseURL(ch.base_url, extra).replace(/\/+$/, '');
    const upstreamPath = normalizeUpstreamPath(base, subPath);
    const search = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `${base}${upstreamPath}${search ? '?' + search : ''}`;
    const method = (req.method ?? 'GET').toUpperCase();
    // GET/HEAD 无 body；二进制请求体（multipart/octet-stream 等，由兜底解析器保留为 Buffer）原样透传
    let body: Buffer | string | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      body = Buffer.isBuffer(req.body) ? (req.body as Buffer) : JSON.stringify(req.body ?? {});
    }

    // 复用 Provider header，并透传客户端的关键请求头（保留 content-type 等）
    const headers = buildHeaders(ch.provider_type, ch.api_key, extra);
    // 非 JSON 请求（multipart/octet-stream 等）透传完整原始 Content-Type（含 boundary），
    // 保证上游能正确解析 multipart；JSON 请求沿用 buildHeaders 默认值。
    const clientCT = req.headers['content-type'];
    if (clientCT !== undefined && String(clientCT).toLowerCase() !== 'application/json') {
      headers['Content-Type'] = String(clientCT);
    }
    for (const h of ['accept', 'anthropic-version', 'x-api-key']) {
      const v = req.headers[h];
      if (v !== undefined) headers[toHeaderCase(h)] = String(v);
    }
    try {
      const resp = await this.transport.request({
        method,
        url,
        headers,
        body,
        timeoutMs: this.timeoutMs(),
        socksProxy: this.proxy(),
        signal: clientSignal(req),
      });
      reply.header('Content-Type', resp.headers['content-type'] ?? 'application/json');
      reply.code(resp.status).send(Buffer.from(resp.buffer));
    } catch (err) {
      writeJson(reply, 502, { error: { message: (err as Error).message } });
    }
  }

  /** 按数据库 ID 或渠道名（大小写不敏感）查找渠道 */
  private findChannel(identifier: string) {
    const num = Number(identifier);
    if (Number.isInteger(num) && num > 0) {
      const byId = this.ctx.repos.channels.get(num);
      if (byId) return byId;
    }
    const lower = identifier.toLowerCase();
    return this.ctx.repos.channels.list().find((c) => c.name.toLowerCase() === lower) ?? null;
  }

  private recordLog(
    requestId: string,
    model: string,
    channelId: number,
    channelName: string,
    status: number,
    usage: Usage,
    durationMs: number,
    errorMsg: string,
  ) {
    if (!this.logEnabled()) return;
    try {
      this.ctx.repos.logs.insert({
        requestId,
        model,
        channelId,
        channelName,
        statusCode: status,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        durationMs,
        errorMsg,
      });
    } catch (err) {
      logger.warn('写入请求日志失败', { error: (err as Error).message });
    }
  }

  dispose() {
    this.transport.dispose();
    this.pool.dispose();
  }
}

function requireModel(rawBody: string): string {
  try {
    return String((JSON.parse(rawBody) as { model?: string }).model ?? '');
  } catch {
    return '';
  }
}
function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** 客户端中断信号：下游断开时 abort 上游请求，避免连接/槽位泄漏 */
function clientSignal(req: FastifyRequest): AbortSignal {
  const ac = new AbortController();
  req.raw.once('aborted', () => ac.abort(new Error('client aborted')));
  req.raw.once('close', () => {
    if (!req.raw.complete) ac.abort(new Error('client closed early'));
  });
  return ac.signal;
}
function writeJson(reply: FastifyReply, status: number, body: unknown) {
  if (reply.raw.headersSent) return;
  reply.code(status).header('Content-Type', 'application/json').send(body);
}

/** 智能去重：upstreamPath 以 baseURL 的 path 部分开头时去掉重复段 */
function normalizeUpstreamPath(baseURL: string, upstreamPath: string): string {
  try {
    const basePath = new URL(baseURL).pathname.replace(/\/+$/, '');
    const path = upstreamPath.startsWith('/') ? upstreamPath : '/' + upstreamPath;
    if (basePath && path.startsWith(basePath + '/')) return path.slice(basePath.length);
    if (basePath && path === basePath) return '/';
    return path;
  } catch {
    return upstreamPath.startsWith('/') ? upstreamPath : '/' + upstreamPath;
  }
}

function toHeaderCase(name: string): string {
  return name
    .split('-')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join('-');
}

/** FNV-1a 32 位哈希（用于本地请求特征派生临时 clientKey） */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 解析 Retry-After（秒数或 HTTP 日期），上限 10s，避免无限拖长 */
function parseRetryAfter(v: string | string[] | undefined): number | null {
  if (v === undefined) return null;
  const s = Array.isArray(v) ? v[0] : v;
  const sec = Number(s);
  if (Number.isFinite(sec)) return Math.min(Math.max(0, sec), 10) * 1000;
  const t = Date.parse(String(s));
  if (Number.isFinite(t)) return Math.min(Math.max(0, t - Date.now()), 10_000);
  return null;
}

