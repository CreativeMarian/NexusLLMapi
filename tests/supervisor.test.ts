import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { PROJECT_ROOT } from './helpers.js';

const RUNNER = join(PROJECT_ROOT, 'tests', 'fixtures', 'supervisor-runner.ts');
const FIX = (name: string) => join(PROJECT_ROOT, 'tests', 'fixtures', name);

interface EventMsg {
  type: string;
  [k: string]: unknown;
}

class SupervisorHarness {
  events: EventMsg[] = [];
  exitCode: number | null = null;
  child: ReturnType<typeof spawn>;
  port: number;

  constructor(entry: string, opts: Record<string, unknown> = {}, port?: number) {
    this.port = port ?? 20000 + Math.floor(Math.random() * 20000);
    this.child = spawn(process.execPath, ['--import', 'tsx', RUNNER, entry, String(this.port), JSON.stringify(opts)], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.stderr?.pipe(process.stderr);
    this.child.on('message', (m) => {
      if (m && typeof m === 'object') this.events.push(m as EventMsg);
    });
    this.child.on('exit', (code) => {
      this.exitCode = code;
    });
  }

  async waitFor(predicate: (events: EventMsg[]) => boolean, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate(this.events)) return;
      await sleep(80);
    }
    throw new Error(`waitFor timeout; events=${JSON.stringify(this.events)}`);
  }

  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }

  async stop(timeoutMs = 5000): Promise<void> {
    try {
      this.child.send({ type: 'stop' });
    } catch {
      /* ignore */
    }
    await this.waitExit(timeoutMs);
  }

  waitExit(timeoutMs: number): Promise<void> {
    return new Promise((resolveExit) => {
      if (this.exitCode !== null) return resolveExit();
      const t = setTimeout(() => resolveExit(), timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(t);
        resolveExit();
      });
    });
  }

  async getStatus(): Promise<{ restartCount: number; stopping: boolean; workerPid: number }> {
    return new Promise((resolveStatus) => {
      const onMsg = (m: EventMsg) => {
        if (m.type === 'status') {
          this.child.removeListener('message', onMsg);
          resolveStatus({
            restartCount: Number(m.restartCount ?? 0),
            stopping: Boolean(m.stopping),
            workerPid: Number(m.workerPid ?? 0),
          });
        }
      };
      this.child.on('message', onMsg);
      this.child.send({ type: 'status' });
      setTimeout(() => {
        this.child.removeListener('message', onMsg);
        resolveStatus({ restartCount: 0, stopping: true, workerPid: 0 });
      }, 3000);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const harnesses: SupervisorHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    try {
      h.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await h.waitExit(2000);
  }
  const marker = FIX('.exit-once-marker');
  if (existsSync(marker)) rmSync(marker);
  const sm = FIX('.sigterm-marker');
  if (existsSync(sm)) rmSync(sm);
  const hh = FIX('.hard-hang-marker');
  if (existsSync(hh)) rmSync(hh);
  const smk = FIX('.stop-marker');
  if (existsSync(smk)) rmSync(smk);
});

describe('Supervisor 自愈', () => {
  it('正常运行：worker 健康时不被重启，SIGINT 干净退出（exit 0）', async () => {
    const h = new SupervisorHarness(FIX('worker-ok.mjs'));
    harnesses.push(h);
    await h.waitFor((e) => e.some((x) => x.type === 'ready'));
    // 再等一会，确认没有多余重启
    await sleep(1200);
    const st = await h.getStatus();
    expect(st.restartCount).toBe(0);
    expect(h.count('ready')).toBe(1);
    // 干净退出（IPC stop 与 SIGINT/SIGTERM 同为 stop(0) 路径）→ exit 0
    await h.stop();
    expect(h.exitCode).toBe(0);
  });

  it('worker exit(1) 自动重启：第二个 worker 接管并恢复 ready', async () => {
    const marker = FIX('.exit-once-marker');
    if (existsSync(marker)) rmSync(marker);
    const h = new SupervisorHarness(FIX('worker-exit-once.mjs'));
    harnesses.push(h);
    await h.waitFor((e) => e.filter((x) => x.type === 'ready').length >= 2, 20000);
    expect(h.count('ready')).toBeGreaterThanOrEqual(2);
    const st = await h.getStatus();
    expect(st.restartCount).toBeGreaterThanOrEqual(1);
    await h.stop();
    expect(h.exitCode).toBe(0);
  });

  it('事件循环卡死 / 心跳超时：Supervisor 强制重启', async () => {
    const h = new SupervisorHarness(FIX('worker-hang.mjs'), {
      heartbeatTimeoutMs: 800,
      backoffsMs: [100, 100, 100, 100, 100],
      startupGraceMs: 0,
    });
    harnesses.push(h);
    await h.waitFor((e) => e.filter((x) => x.type === 'ready').length >= 2, 20000);
    expect(h.count('ready')).toBeGreaterThanOrEqual(2);
    await h.stop();
  });

  it('crash-loop 保护：连续崩溃达到阈值后进入保护等待，不再无限高速重启', async () => {
    const h = new SupervisorHarness(FIX('worker-crashloop.mjs'), {
      backoffsMs: [50, 50, 50, 50, 50],
      crashBurstMax: 3,
      crashWindowMs: 60000,
      crashLoopWaitMs: 60000,
      stableUptimeMs: 60000,
    });
    harnesses.push(h);
    // 等 restartCount 累积到 3（进入保护）
    let prev = -1;
    const start = Date.now();
    let entered = false;
    while (Date.now() - start < 15000) {
      const st = await h.getStatus();
      if (st.restartCount >= 3) {
        entered = true;
        prev = st.restartCount;
        break;
      }
      await sleep(150);
    }
    expect(entered).toBe(true);
    // 保护期内 restartCount 不应继续上涨（没有无限重启）
    await sleep(800);
    const after = await h.getStatus();
    expect(after.restartCount).toBe(prev);
    await h.stop();
  });

  it('kill 升级路径：Worker 忽略 IPC shutdown 与 SIGTERM → 超时后 SIGKILL → 自动重启', async () => {
    const marker = FIX('.sigterm-marker');
    if (existsSync(marker)) rmSync(marker);
    const h = new SupervisorHarness(FIX('worker-ignore-sigterm.mjs'), {
      ipcGraceMs: 300,
      sigtermGraceMs: 700,
      killWaitMs: 3000,
      heartbeatTimeoutMs: 20000,
      startupGraceMs: 0,
      backoffsMs: [100, 100, 100, 100],
      probeIntervalMs: 500,
      probeFailThreshold: 2,
      env: { NEXUS_SIGTERM_MARKER: marker },
    });
    harnesses.push(h);
    await h.waitFor((e) => e.filter((x) => x.type === 'ready').length >= 2, 20000);
    expect(h.count('ready')).toBeGreaterThanOrEqual(2);
    // SIGTERM 确实被 Worker 收到（升级路径走通），随后 SIGKILL 生效触发重启
    expect(existsSync(marker)).toBe(true);
    await h.stop();
    if (existsSync(marker)) rmSync(marker);
  });

  it('干净退出：Supervisor stop → Worker 优雅释放端口并退出，端口可复用重启', async () => {
    const port = 21000 + Math.floor(Math.random() * 1000);
    const opts = {
      ipcGraceMs: 1500,
      sigtermGraceMs: 3000,
      heartbeatTimeoutMs: 20000,
      startupGraceMs: 0,
      env: { NEXUS_WORKER_PORT: String(port) },
    };
    // 第一轮启动
    const h1 = new SupervisorHarness(FIX('worker-port.mjs'), opts, port);
    harnesses.push(h1);
    await h1.waitFor((e) => e.some((x) => x.type === 'ready'), 15000);
    await waitHealth(port, true, 10000);
    const ready1 = h1.events.find((e) => e.type === 'ready');
    const workerPid = Number(ready1?.pid ?? 0);
    expect(workerPid).toBeGreaterThan(0);

    // 停止 → 干净退出 exit 0
    await h1.stop();
    expect(h1.exitCode).toBe(0);
    await waitHealth(port, false, 8000);
    // worker 进程已退出（pid 不存在）
    expect(processAlive(workerPid)).toBe(false);

    // 第二轮：同一端口可再次绑定启动（端口已释放）
    const h2 = new SupervisorHarness(FIX('worker-port.mjs'), opts, port);
    harnesses.push(h2);
    await h2.waitFor((e) => e.some((x) => x.type === 'ready'), 15000);
    await waitHealth(port, true, 10000);
    await h2.stop();
    expect(h2.exitCode).toBe(0);
    await waitHealth(port, false, 8000);
  });

  it('真卡死 Worker（不发心跳/不响应HTTP/忽略IPC与SIGTERM/占用端口）：升级终止→旧PID消失→端口释放→新Worker恢复ready', async () => {
    const marker = FIX('.hard-hang-marker');
    if (existsSync(marker)) rmSync(marker);
    const port = 22000 + Math.floor(Math.random() * 1000);
    const h = new SupervisorHarness(FIX('worker-hard-hang.mjs'), {
      ipcGraceMs: 300,
      sigtermGraceMs: 700,
      killWaitMs: 3000,
      heartbeatTimeoutMs: 600,
      startupGraceMs: 0,
      probeIntervalMs: 5000,
      probeFailThreshold: 10,
      backoffsMs: [100, 100, 100, 100],
      env: { NEXUS_WORKER_PORT: String(port), NEXUS_HARD_HANG_MARKER: marker },
    });
    harnesses.push(h);
    // 在卡死 worker 被终止前，先抓到它的 PID（当前 worker = 第一个卡死 worker）
    let hungPid = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 2000 && hungPid === 0) {
      const st0 = await h.getStatus();
      if (st0.workerPid > 0) hungPid = st0.workerPid;
      if (hungPid > 0) break;
      await sleep(100);
    }
    // 第一个 worker 卡死占端口；等第二个健康 worker ready
    await h.waitFor((e) => e.filter((x) => x.type === 'ready').length >= 1, 20000);
    // 至少经历过一次重启
    const st = await h.getStatus();
    expect(st.restartCount).toBeGreaterThanOrEqual(1);
    // 用 PID 是否仍存在（而非 child.killed）确认卡死 Worker 真正退出
    expect(hungPid).toBeGreaterThan(0);
    expect(processAlive(hungPid)).toBe(false);
    // 端口已释放并被新 Worker 重新绑定，/health/live 恢复 200
    await waitHealth(port, true, 10000);
    await h.stop();
    expect(h.exitCode).toBe(0);
    if (existsSync(marker)) rmSync(marker);
  });

  it('永不就绪 Worker：超过启动宽限后进入正常故障恢复，最终重启且不永久卡住', async () => {
    const marker = FIX('.hard-hang-marker');
    if (existsSync(marker)) rmSync(marker);
    const port = 23000 + Math.floor(Math.random() * 1000);
    const h = new SupervisorHarness(FIX('worker-hard-hang.mjs'), {
      ipcGraceMs: 200,
      sigtermGraceMs: 500,
      killWaitMs: 2000,
      heartbeatTimeoutMs: 500,
      startupGraceMs: 1200, // 有宽限：先观察，超时后照常恢复
      probeIntervalMs: 5000,
      probeFailThreshold: 10,
      backoffsMs: [100, 100, 100, 100],
      env: { NEXUS_WORKER_PORT: String(port), NEXUS_HARD_HANG_MARKER: marker },
    });
    harnesses.push(h);
    await h.waitFor((e) => e.filter((x) => x.type === 'ready').length >= 1, 25000);
    const st = await h.getStatus();
    expect(st.restartCount).toBeGreaterThanOrEqual(1);
    await waitHealth(port, true, 10000);
    await h.stop();
    if (existsSync(marker)) rmSync(marker);
  });

  it('慢启动 Worker：宽限期内不被重启（restartCount=0），就绪后正常', async () => {
    const port = 24000 + Math.floor(Math.random() * 1000);
    const h = new SupervisorHarness(FIX('worker-slow-start.mjs'), {
      heartbeatTimeoutMs: 800,
      startupGraceMs: 8000, // 宽限 > 慢启动时长（4s），验证不误杀
      probeIntervalMs: 5000,
      probeFailThreshold: 10,
      backoffsMs: [100, 100, 100, 100],
      env: { NEXUS_WORKER_PORT: String(port), NEXUS_SLOW_START_MS: '4000' },
    });
    harnesses.push(h);
    // 慢启动期间（4s 内）不应发生重启
    await sleep(2500);
    const during = await h.getStatus();
    expect(during.restartCount).toBe(0);
    // 4s 后 Worker 就绪
    await h.waitFor((e) => e.some((x) => x.type === 'ready'), 12000);
    await waitHealth(port, true, 10000);
    await sleep(1000);
    const after = await h.getStatus();
    expect(after.restartCount).toBe(0);
    expect(h.count('ready')).toBe(1);
    await h.stop();
    expect(h.exitCode).toBe(0);
  });

  it('P0-2 生产 stop 路径（正常 Worker）：IPC shutdown → Worker exit → PID 不存在 → 端口释放 → Supervisor 自然结束', async () => {
    const port = 25000 + Math.floor(Math.random() * 1000);
    const h = new SupervisorHarness(FIX('worker-port.mjs'), {
      ipcGraceMs: 1500,
      sigtermGraceMs: 3000,
      killWaitMs: 4000,
      heartbeatTimeoutMs: 20000,
      startupGraceMs: 0,
      env: { NEXUS_WORKER_PORT: String(port) },
    }, port);
    harnesses.push(h);
    await h.waitFor((e) => e.some((x) => x.type === 'ready'), 15000);
    await waitHealth(port, true, 10000);
    const ready = h.events.find((e) => e.type === 'ready');
    const pid = Number(ready?.pid ?? 0);
    expect(pid).toBeGreaterThan(0);

    // 发送 stop；等待 runner 上报 stopped（该事件只在 sup.stop() 确认 Worker 已退出后才发出）
    h.child.send({ type: 'stop' });
    await h.waitFor((e) => e.some((x) => x.type === 'stopped'), 20000);
    // Worker PID 已不存在
    expect(processAlive(pid)).toBe(false);
    // 端口不可访问
    await waitHealth(port, false, 10000);
    // Supervisor 进程自然结束（exitCode 0，未靠 runner 的 process.exit 强杀 Worker）
    await h.waitExit(10000);
    expect(h.exitCode).toBe(0);
  });

  it('P0-2 生产 stop 路径（拒绝 IPC shutdown 的 Worker）：IPC 超时 → SIGTERM →（如仍不退出）SIGKILL → PID 消失 → 端口释放 → Supervisor 才结束', async () => {
    const marker = FIX('.stop-marker');
    if (existsSync(marker)) rmSync(marker);
    const port = 26000 + Math.floor(Math.random() * 1000);
    const h = new SupervisorHarness(FIX('worker-stop-stubborn.mjs'), {
      ipcGraceMs: 800, // IPC shutdown 被拒绝 → 快速超时
      sigtermGraceMs: 1200,
      killWaitMs: 4000,
      heartbeatTimeoutMs: 20000,
      startupGraceMs: 0,
      env: { NEXUS_WORKER_PORT: String(port), NEXUS_STOP_MARKER: marker },
    }, port);
    harnesses.push(h);
    await h.waitFor((e) => e.some((x) => x.type === 'ready'), 15000);
    await waitHealth(port, true, 10000);
    const ready = h.events.find((e) => e.type === 'ready');
    const pid = Number(ready?.pid ?? 0);
    expect(pid).toBeGreaterThan(0);

    h.child.send({ type: 'stop' });
    await h.waitFor((e) => e.some((x) => x.type === 'stopped'), 20000);
    // Worker 确实收到过 IPC shutdown（升级路径先走 IPC，而不是直接被强杀）
    expect(existsSync(marker)).toBe(true);
    // 顽固 Worker 最终被升级终止：PID 消失
    expect(processAlive(pid)).toBe(false);
    // 端口释放
    await waitHealth(port, false, 10000);
    // Supervisor 自然结束 exit 0
    await h.waitExit(10000);
    expect(h.exitCode).toBe(0);
    if (existsSync(marker)) rmSync(marker);
  });
});

async function waitHealth(port: number, expectUp: boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: ctrl.signal });
      clearTimeout(t);
      if (resp.ok) {
        if (expectUp) return;
      } else if (!expectUp) {
        return;
      }
    } catch {
      if (!expectUp) return;
    }
    await sleep(120);
  }
  throw new Error(`health ${expectUp ? '未就绪' : '未释放'} on port ${port}`);
}

function processAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
