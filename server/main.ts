import { fileURLToPath } from 'node:url';
import { ConfigManager } from './config/manager.js';
import { logger } from './util/logger.js';
import { openBrowser } from './util/open-browser.js';
import { startWorker, EXIT } from './worker.js';
import { Supervisor } from './supervisor/supervisor.js';
import { resolveProjectRoot } from './paths.js';

function isWorkerMode(): boolean {
  return process.argv.includes('--worker') || process.env.NEXUS_WORKER === '1';
}

async function detectExistingInstance(port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/__nexus/status`, { signal: ctrl.signal });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { app?: string };
    return body.app === 'NexusLLMapi';
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function runSupervisor() {
  const config = new ConfigManager(resolveProjectRoot());
  logger.init(config.baseDir, 'info');
  const snap = config.getSnapshot();

  if (await detectExistingInstance(snap.port)) {
    logger.warn(`检测到已有 NexusLLMapi 实例运行在 ${snap.port}，本次不重复启动`);
    process.exit(EXIT.OK);
  }

  // Supervisor 模式下入口脚本即 Worker 入口（fork 自身并传 --worker）
  const workerEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
  let browserOpened = false;

  const supervisor = new Supervisor({
    workerEntry,
    port: snap.port,
    onWorkerReady: () => {
      if (browserOpened) return;
      browserOpened = true;
      if (config.getSnapshot().auto_open_browser) {
        openBrowser(`http://127.0.0.1:${snap.port}`);
      }
      logger.info(`NexusLLMapi 已启动：http://127.0.0.1:${snap.port}`);
    },
  });

  await supervisor.run();
}

async function main() {
  if (isWorkerMode()) {
    await startWorker();
    return;
  }
  await runSupervisor();
}

main().catch((err) => {
  logger.error('启动失败', { error: (err as Error).stack ?? String(err) });
  process.exit(EXIT.STARTUP_FAILED);
});
