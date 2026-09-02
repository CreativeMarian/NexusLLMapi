import type { FastifyInstance } from 'fastify';
import { ConfigManager } from './config/manager.js';
import { DatabaseManager } from './db/database.js';
import { RuntimeContext } from './context.js';
import { createApp } from './app.js';
import { ProviderService } from './providers/service.js';
import { registerProviderService } from './service-locator.js';
import { Gateway } from './gateway/gateway.js';
import { logger } from './util/logger.js';
import { resolveProjectRoot } from './paths.js';

export const EXIT = {
  OK: 0,
  CONFIG: 10,
  PORT_BUSY: 11,
  STARTUP_FAILED: 12,
  WORKER_CRASH: 20,
  WORKER_HANG: 21,
  ORPHAN: 22,
  CRASH_LOOP: 23,
} as const;

interface WorkerHandles {
  app: FastifyInstance;
  ctx: RuntimeContext;
}

/** 启动 Worker（真正绑定 8787 的进程） */
export async function startWorker(): Promise<WorkerHandles> {
  const config = new ConfigManager(resolveProjectRoot());
  logger.init(config.baseDir, 'info');
  logger.info('Worker 启动中', { pid: process.pid, port: config.getSnapshot().port });

  // 1. 先初始化 DB（关键依赖）
  const db = new DatabaseManager(config.baseDir, config.dbPath());
  const ctx = new RuntimeContext(config, db);

  // 1.5 装配 Provider 服务（渠道测试/同步/模型测速/批量检测）
  const providerService = new ProviderService(ctx);
  registerProviderService(providerService);

  // 1.6 装配核心网关（模型路由池/限流/熔断/转发），CRUD 后自动重建索引
  const gateway = new Gateway(ctx);
  ctx.setReloadHandle(() => gateway.reload());

  // 2. 创建 app
  const app = await createApp(ctx, gateway);

  // 3. 先绑定端口（同步等待 listen 成功），失败立即退出
  const port = config.getSnapshot().port;
  try {
    await app.listen({ host: '127.0.0.1', port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      logger.error(`端口 ${port} 已被占用（ExitPortBusy）`, { error: (err as Error).message });
      process.exit(EXIT.PORT_BUSY);
    }
    logger.error('HTTP 监听失败', { error: (err as Error).stack });
    process.exit(EXIT.STARTUP_FAILED);
  }

  // 4. listen 成功后，标记 ready（子系统在 Phase B-E 继续装配）
  ctx.selfHealth.setReady(true);
  logger.info(`Worker 已就绪，API 监听 http://127.0.0.1:${port}`);

  // 5. IPC heartbeat
  startHeartbeat(ctx);

  // 6. event-loop lag 周期评估
  const lagTimer = setInterval(() => ctx.selfHealth.evaluateEventLoopLag(), 5000);
  lagTimer.unref?.();

  // 6.5 渠道健康检查（后台定时 + 手动触发）
  ctx.channelHealth.start();

  // 7. 优雅退出
  setupShutdown(ctx, app);

  // 8. fatal 错误：记录后退出，交由 Supervisor 重启
  setupFatalHandlers(config.baseDir, ctx);

  return { app, ctx };
}

function startHeartbeat(ctx: RuntimeContext) {
  if (typeof process.send !== 'function') return; // 非 fork 模式（如 tsx watch）
  const timer = setInterval(() => {
    try {
      process.send?.({
        type: 'heartbeat',
        pid: process.pid,
        time: Date.now(),
        activeRequests: ctx.activeRegistry.count(),
        activeStreams: ctx.activeRegistry.streamCount(),
        mem: process.memoryUsage(),
        ready: ctx.selfHealth.isReady(),
      });
    } catch {
      /* 父进程可能已退出 */
    }
  }, 1000);
  timer.unref?.();
}

let shutdownStarted = false;
function setupShutdown(ctx: RuntimeContext, app: FastifyInstance) {
  const graceful = async (source: string, exitCode: number = EXIT.OK) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    ctx.shuttingDown = true;
    logger.info(`Worker 收到关闭信号 (${source})，开始优雅退出`);
    try {
      ctx.activeRegistry.abortAll('server shutting down');
      ctx.channelHealth.stop();
      await app.close();
      ctx.db.close();
      logger.close();
      process.exit(exitCode);
    } catch (err) {
      logger.error('优雅退出异常，强制退出', { error: (err as Error).message });
      process.exit(EXIT.WORKER_CRASH);
    }
  };

  process.on('SIGINT', () => void graceful('SIGINT'));
  process.on('SIGTERM', () => void graceful('SIGTERM'));
  process.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'shutdown') {
      void graceful('ipc');
    }
  });
  // 父进程（Supervisor）断开：说明 Supervisor 已退出/重启，本 Worker 成为孤儿，
  // 优雅退出并释放端口，避免残留进程占用 8787。
  process.on('disconnect', () => {
    if (process.env.NEXUS_WORKER === '1') {
      logger.warn('与 Supervisor 的 IPC 连接断开，判定为孤儿进程，优雅退出');
      void graceful('orphan', EXIT.ORPHAN);
    }
  });
}

function setupFatalHandlers(baseDir: string, ctx: RuntimeContext) {
  const onFatal = (kind: string, err: unknown) => {
    const e = err as Error;
    const content = [
      `time=${new Date().toISOString()}`,
      `kind=${kind}`,
      `pid=${process.pid}`,
      `name=${e?.name ?? ''}`,
      `message=${e?.message ?? String(err)}`,
      `stack=${e?.stack ?? ''}`,
      `activeRequests=${ctx.activeRegistry.count()}`,
      `activeStreams=${ctx.activeRegistry.streamCount()}`,
      `memory=${JSON.stringify(process.memoryUsage())}`,
    ].join('\n');
    logger.crash(baseDir, content);
    logger.error('Worker 发生致命错误，退出由 Supervisor 重启', { kind, message: e?.message });
    process.exit(EXIT.WORKER_CRASH);
  };
  process.on('uncaughtException', (err) => onFatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason));
}
