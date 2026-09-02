// Supervisor 测试运行器：在独立进程内运行 Supervisor，通过 IPC 上报事件、接收控制指令。
// 用法：npx tsx tests/fixtures/supervisor-runner.ts <workerEntry> <port> <optionsJSON>
import { Supervisor } from '../../server/supervisor/supervisor.js';

const entry = process.argv[2];
const port = Number(process.argv[3] ?? '0');
let options: Record<string, unknown> = {};
try {
  options = JSON.parse(process.argv[4] ?? '{}');
} catch {
  options = {};
}
// 允许透传 worker 环境变量（如 NEXUS_WORKER_PORT），经 supervisor fork 链传播给 worker
const env = (options.env ?? {}) as Record<string, string>;
for (const [k, v] of Object.entries(env)) {
  process.env[k] = v;
}

function send(o: unknown) {
  if (typeof process.send === 'function') {
    try {
      process.send(o);
    } catch {
      /* ignore */
    }
  }
}

const sup = new Supervisor({
  workerEntry: entry,
  port,
  onWorkerReady: () => send({ type: 'ready', pid: sup.workerPid }),
  ...(options as unknown as Partial<ConstructorParameters<typeof Supervisor>[0]>),
});

send({ type: 'running', pid: process.pid });
const runPromise = sup.run();

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  const msg = m as { type?: string };
  if (msg.type === 'status') {
    const anySup = sup as unknown as { restartCount?: number; stopping?: boolean; workerStartTime?: number };
    send({
      type: 'status',
      restartCount: anySup.restartCount ?? 0,
      stopping: anySup.stopping ?? false,
      workerStartTime: anySup.workerStartTime ?? 0,
      workerPid: sup.workerPid ?? 0,
    });
  } else if (msg.type === 'stop') {
    // 生产 stop 路径：绝不 process.exit 帮助测试。
    // stop() 内部完成 Worker 升级终止（IPC→SIGTERM→SIGKILL）与端口释放确认；
    // 待 run() 因 stopping 自然返回后，上报 stopped 并断开 IPC，让事件循环自然结束进程。
    void (async () => {
      await sup.stop(0);
      await runPromise;
      const done = () => {
        try {
          process.disconnect();
        } catch {
          /* ignore */
        }
      };
      if (typeof process.send === 'function') {
        try {
          process.send({ type: 'stopped', workerPid: sup.workerPid ?? 0 }, done);
          return;
        } catch {
          /* ignore */
        }
      }
      done();
    })();
  }
});
