import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ActiveRequestRegistry } from './active-registry.js';

export type Checker = () => string | null; // 返回 null=健康，否则为问题描述

interface DeepSnapshot {
  status: 'ok' | 'starting' | 'degraded';
  uptime_sec: number;
  issue?: string;
  memory: ReturnType<typeof process.memoryUsage>;
  event_loop: { mean_ms: number; p95_ms: number; p99_ms: number; max_ms: number };
  active_requests: number;
  active_streams: number;
}

const startedAt = Date.now();

export class SelfHealth {
  private ready = false;
  private readyCheckers: Checker[] = [];
  private deepCheckers: Checker[] = [];
  private readonly registry: ActiveRequestRegistry;
  private elh: ReturnType<typeof monitorEventLoopDelay>;
  private lagDegraded = false;
  private lagHitCount = 0;

  constructor(registry: ActiveRequestRegistry) {
    this.registry = registry;
    this.elh = monitorEventLoopDelay({ resolution: 20 });
    this.elh.enable();
  }

  setReady(v: boolean) {
    this.ready = v;
  }
  isReady(): boolean {
    if (!this.ready) return false;
    for (const c of this.readyCheckers) {
      const issue = c();
      if (issue) return false;
    }
    return true;
  }
  addReadyChecker(c: Checker) { this.readyCheckers.push(c); }
  addDeepChecker(c: Checker) { this.deepCheckers.push(c); }

  /** 周期性评估 event-loop lag：连续多周期 >3000ms 才标记 degraded，避免单次 GC 抖动 */
  evaluateEventLoopLag() {
    const meanMs = Number(this.elh.mean) / 1e6;
    const maxMs = Number(this.elh.max) / 1e6;
    this.elh.reset();
    if (meanMs > 3000 || maxMs > 3000) {
      this.lagHitCount++;
      if (this.lagHitCount >= 3) this.lagDegraded = true;
    } else {
      this.lagHitCount = 0;
      this.lagDegraded = false;
    }
  }

  private snapshot(): DeepSnapshot {
    const snap: DeepSnapshot = {
      status: 'ok',
      uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
      memory: process.memoryUsage(),
      event_loop: {
        mean_ms: +(Number(this.elh.mean) / 1e6).toFixed(2),
        p95_ms: +(Number(this.elh.percentile(95)) / 1e6).toFixed(2),
        p99_ms: +(Number(this.elh.percentile(99)) / 1e6).toFixed(2),
        max_ms: +(Number(this.elh.max) / 1e6).toFixed(2),
      },
      active_requests: this.registry.count(),
      active_streams: this.registry.streamCount(),
    };
    if (!this.ready) {
      snap.status = 'starting';
      snap.issue = 'core not ready';
      return snap;
    }
    if (this.lagDegraded) {
      snap.status = 'degraded';
      snap.issue = 'event loop lag sustained > 3000ms';
      return snap;
    }
    for (const c of [...this.readyCheckers, ...this.deepCheckers]) {
      const issue = c();
      if (issue) {
        snap.status = 'degraded';
        snap.issue = issue;
        break;
      }
    }
    return snap;
  }

  live = async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ status: 'alive', pid: process.pid });
  };

  readyHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (this.isReady()) return reply.code(200).send({ status: 'ready' });
    return reply.code(503).send({ status: 'not_ready' });
  };

  deep = async (_req: FastifyRequest, reply: FastifyReply) => {
    const snap = this.snapshot();
    return reply.code(snap.status === 'ok' ? 200 : 503).send(snap);
  };

  /** 前端轮询用的简单健康端点 */
  health = async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ status: 'ok' });
  };

  /** 单实例识别 */
  nexusStatus = async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ app: 'NexusLLMapi', status: 'ok' });
  };
}
