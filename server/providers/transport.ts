import http from 'node:http';
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'node:http';
import { logger } from '../util/logger.js';

export interface RequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer | string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 当前 SOCKS5 代理（空字符串=直连），热更新时每次读取最新值 */
  socksProxy?: string;
}

export interface FullResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  buffer: Buffer;
}

/**
 * 统一上游传输：Node 原生 http/https + 可选 SOCKS5。
 * - Agent 按代理地址缓存，代理变更自动重建；
 * - AbortController + 硬超时双保险，确保 socket 不泄漏；
 * - 同时提供一次性 request 与流式 requestStream（SSE 用）。
 */
export class Transport {
  private agentCache = new Map<string, Agent>();

  private getAgent(socksProxy: string): Agent | undefined {
    const proxy = (socksProxy ?? '').trim();
    if (!proxy) return undefined; // 直连，用全局默认 agent
    let agent = this.agentCache.get(proxy);
    if (!agent) {
      agent = new SocksProxyAgent(proxy);
      this.agentCache.set(proxy, agent);
      // 代理地址变更后清理旧 agent，避免反复改配置泄漏连接池
      for (const [key, old] of this.agentCache) {
        if (key !== proxy) {
          this.agentCache.delete(key);
          try {
            (old as { destroy?: () => void }).destroy?.();
          } catch {
            /* ignore */
          }
        }
      }
      logger.info('Transport 创建 SOCKS5 Agent', { proxy: maskProxy(proxy) });
    }
    return agent;
  }

  private pick(target: URL) {
    return target.protocol === 'http:' ? http : https;
  }

  /** 一次性请求：聚合完整响应体，超时/中断时销毁 socket */
  async request(opts: RequestOptions): Promise<FullResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), opts.timeoutMs);
    const onOuterAbort = () => controller.abort(new Error('client aborted'));
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      const { res } = await this.rawRequest(opts, controller.signal);
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);
      return {
        status: res.statusCode ?? 0,
        headers: res.headers,
        buffer,
        text: buffer.toString('utf-8'),
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** 流式请求：返回原始 IncomingMessage，调用方负责消费/销毁（SSE 管道用） */
  async requestStream(opts: RequestOptions, signal?: AbortSignal): Promise<http.IncomingMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), opts.timeoutMs);
    const onOuter = () => controller.abort(new Error('client aborted'));
    // 与 request() 一致：进入时 signal 已 aborted（客户端已断开 / server 已 shutdown）必须立即中止，
    // 避免在已失效的上下文中仍发起新的上游请求。
    if (signal) {
      if (signal.aborted) controller.abort(new Error('client aborted'));
      else signal.addEventListener('abort', onOuter, { once: true });
    }
    let req: http.ClientRequest;
    let res: http.IncomingMessage;
    try {
      ({ req, res } = await this.rawRequest(opts, controller.signal));
    } catch (err) {
      // 建连失败：清理定时器与外部 abort 监听，避免泄漏
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuter);
      throw err;
    }
    res.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuter);
    });
    res.on('error', () => req.destroy());
    return res;
  }

  private rawRequest(
    opts: RequestOptions,
    signal: AbortSignal,
  ): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
    const target = new URL(opts.url);
    const lib = this.pick(target);
    const agent = this.getAgent(opts.socksProxy ?? '');
    const body = opts.body == null ? undefined : opts.body;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          path: target.pathname + target.search,
          method: opts.method,
          headers: opts.headers,
          agent,
          signal,
        },
        (res) => resolve({ req, res }),
      );
      req.on('error', (err) => {
        req.destroy();
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  }

  dispose(): void {
    for (const agent of this.agentCache.values()) {
      try {
        (agent as { destroy?: () => void }).destroy?.();
      } catch {
        /* ignore */
      }
    }
    this.agentCache.clear();
  }
}

function maskProxy(proxy: string): string {
  // 不记录代理中的账号密码
  return proxy.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
}
