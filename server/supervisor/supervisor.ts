import { fork, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { logger } from '../util/logger.js';

const HEARTBEAT_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 5_000;
const PROBE_FAIL_THRESHOLD = 3;
// 启动宽限：Worker 刚拉起（DB 初始化/首听端口）期间，心跳与探活失败不触发强制重启，避免启动慢被误杀
const STARTUP_GRACE_MS = 45_000;
// 终止升级阶梯
const IPC_GRACE_MS = 1_200; // 发送 IPC shutdown 后等待优雅退出
const SIGTERM_GRACE_MS = 5_000; // SIGTERM 后等待
const KILL_WAIT_MS = 8_000; // SIGKILL 后等待最终退出
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_BURST_MAX = 5;
const CRASH_LOOP_WAIT_MS = 5 * 60_000;
const STABLE_UPTIME_MS = 10 * 60_000;
const BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface SupervisorOptions {
  workerEntry: string; // worker 入口文件（main 脚本自身）
  port: number;
  onWorkerReady?: () => void;
  // 可测试性覆盖项（不传则用默认常数）
  heartbeatTimeoutMs?: number;
  probeIntervalMs?: number;
  probeFailThreshold?: number;
  startupGraceMs?: number;
  ipcGraceMs?: number;
  sigtermGraceMs?: number;
  killWaitMs?: number;
  crashWindowMs?: number;
  crashBurstMax?: number;
  crashLoopWaitMs?: number;
  stableUptimeMs?: number;
  backoffsMs?: number[];
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export class Supervisor {
  private worker: ChildProcess | null = null;
  private stopping = false;
  private crashTimes: number[] = [];
  private restartCount = 0;
  private lastHeartbeat = 0;
  private hbTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeFails = 0;
  private workerStartTime = 0;
  private readyFired = false;
  /** 每个 worker 的在途终止 Promise：heartbeat/probe/stop 并发触发时去重，避免两套 killWorker 并发 */
  private terminations = new Map<ChildProcess, Promise<boolean>>();

  constructor(private opts: SupervisorOptions) {}

  /** 当前 worker 的 PID（供测试/诊断） */
  get workerPid(): number | null {
    return this.worker?.pid ?? null;
  }

  private heartbeatTimeoutMs(): number {
    return this.opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }
  private probeIntervalMs(): number {
    return this.opts.probeIntervalMs ?? PROBE_INTERVAL_MS;
  }
  private probeFailThreshold(): number {
    return this.opts.probeFailThreshold ?? PROBE_FAIL_THRESHOLD;
  }
  private startupGraceMs(): number {
    return this.opts.startupGraceMs ?? STARTUP_GRACE_MS;
  }
  private ipcGraceMs(): number {
    return this.opts.ipcGraceMs ?? IPC_GRACE_MS;
  }
  private sigtermGraceMs(): number {
    return this.opts.sigtermGraceMs ?? SIGTERM_GRACE_MS;
  }
  private killWaitMs(): number {
    return this.opts.killWaitMs ?? KILL_WAIT_MS;
  }
  private crashWindowMs(): number {
    return this.opts.crashWindowMs ?? CRASH_WINDOW_MS;
  }
  private crashBurstMax(): number {
    return this.opts.crashBurstMax ?? CRASH_BURST_MAX;
  }
  private crashLoopWaitMs(): number {
    return this.opts.crashLoopWaitMs ?? CRASH_LOOP_WAIT_MS;
  }
  private stableUptimeMs(): number {
    return this.opts.stableUptimeMs ?? STABLE_UPTIME_MS;
  }
  private backoffsMs(): number[] {
    return this.opts.backoffsMs ?? BACKOFFS_MS;
  }

  async run(): Promise<void> {
    logger.info('Supervisor 启动', { worker: this.opts.workerEntry, port: this.opts.port });
    process.on('SIGINT', () => void this.stop(0));
    process.on('SIGTERM', () => void this.stop(0));

    while (!this.stopping) {
      if (this.inCrashLoop()) {
        logger.error('检测到 crash-loop，进入保护等待', { waitMs: this.crashLoopWaitMs() });
        if (await this.interruptibleDelay(this.crashLoopWaitMs())) return;
        this.crashTimes = [];
      }
      const needRestart = await this.runOneWorker();
      if (!needRestart) return;
      const backoff = this.backoffsMs()[Math.min(this.restartCount, this.backoffsMs().length - 1)] ?? 30_000;
      logger.warn('Worker 退出，准备重启', { backoffMs: backoff, restart: this.restartCount });
      if (await this.interruptibleDelay(backoff)) return;
    }
  }

  private async runOneWorker(): Promise<boolean> {
    this.readyFired = false;
    this.probeFails = 0;
    this.workerStartTime = Date.now();

    const child = fork(this.opts.workerEntry, ['--worker'], {
      env: { ...process.env, NEXUS_WORKER: '1' },
      execArgv: process.execArgv, // 透传 tsx loader，开发态 fork TS 也可运行
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    this.worker = child;
    this.lastHeartbeat = Date.now();

    child.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'heartbeat') {
        this.lastHeartbeat = Date.now();
        if (!this.readyFired) {
          this.readyFired = true;
          logger.info('Supervisor 收到首个 Worker heartbeat', { pid: child.pid });
          this.opts.onWorkerReady?.();
        }
      }
    });

    child.on('exit', (code, signal) => {
      logger.error('Worker 进程退出', { code, signal, uptimeMs: Date.now() - this.workerStartTime });
    });

    this.startWatchers(child);

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (restart: boolean) => {
        if (settled) return;
        settled = true;
        this.stopWatchers();
        resolve(restart);
      };

      child.on('exit', () => {
        const uptime = Date.now() - this.workerStartTime;
        if (uptime >= this.stableUptimeMs()) {
          // 稳定运行后崩溃计数与重启次数都归零：避免一次历史故障让后续 backoff 永远顶格
          this.crashTimes = [];
          this.restartCount = 0;
        } else {
          this.restartCount++;
          this.crashTimes.push(Date.now());
        }
        finish(!this.stopping);
      });

      child.on('error', (err) => {
        logger.error('Worker 进程错误', { error: err.message });
        finish(true);
      });
    });
  }

  private startWatchers(child: ChildProcess) {
    // IPC heartbeat 超时（启动宽限期内仅记录，不误杀）
    this.hbTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > this.heartbeatTimeoutMs()) {
        if (this.inStartupGrace()) {
          logger.warn('Worker heartbeat 未到（启动宽限期，暂不强制重启）', { sinceStartMs: Date.now() - this.workerStartTime });
          return;
        }
        logger.error('Worker heartbeat 超时，判定卡死，强制重启');
        void this.killWorker(child, 'heartbeat timeout');
      }
    }, 2000);
    this.hbTimer.unref?.();

    // HTTP live probe
    this.probeTimer = setInterval(() => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      fetch(`http://127.0.0.1:${this.opts.port}/health/live`, { signal: ctrl.signal })
        .then((r) => {
          clearTimeout(t);
          if (r.ok) this.probeFails = 0;
          else this.onProbeFail(child, `status=${r.status}`);
        })
        .catch((err: Error) => {
          clearTimeout(t);
          this.onProbeFail(child, err.message);
        });
    }, this.probeIntervalMs());
    this.probeTimer.unref?.();
  }

  private inStartupGrace(): boolean {
    return Date.now() - this.workerStartTime < this.startupGraceMs();
  }

  private onProbeFail(child: ChildProcess, reason: string) {
    if (this.inStartupGrace()) {
      logger.warn('HTTP 存活探测失败（启动宽限期，不累计）', { reason, sinceStartMs: Date.now() - this.workerStartTime });
      return;
    }
    this.probeFails++;
    logger.warn('Worker HTTP 存活探测失败', { fails: this.probeFails, reason });
    if (this.probeFails >= this.probeFailThreshold()) {
      logger.error('HTTP 探测连续失败达到阈值，强制重启');
      void this.killWorker(child, 'probe failed threshold');
    }
  }

  /**
   * 终止升级：IPC shutdown → SIGTERM → SIGKILL，每级等待退出确认。
   * - 不做 `if (this.stopping) return`：正常 stop() 也必须能终止当前 Worker；
   * - 通过 per-worker 在途 Promise 去重，heartbeat/probe/stop 并发触发时不会并发执行两套终止；
   * - 返回 Worker 是否**真实退出**（exit/close 事件），而不是是否发送了信号。
   */
  private killWorker(child: ChildProcess, reason: string): Promise<boolean> {
    if (exited(child)) return Promise.resolve(true);
    const existing = this.terminations.get(child);
    if (existing) return existing;
    const p = this.doKillWorker(child, reason);
    this.terminations.set(child, p);
    return p.finally(() => {
      if (this.terminations.get(child) === p) this.terminations.delete(child);
    });
  }

  private async doKillWorker(child: ChildProcess, reason: string): Promise<boolean> {
    logger.warn('开始终止 Worker', { reason, pid: child.pid });
    try {
      child.send({ type: 'shutdown' });
    } catch {
      /* IPC 通道可能已断开 */
    }
    if (await this.waitForExit(child, this.ipcGraceMs())) return true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (await this.waitForExit(child, this.sigtermGraceMs())) return true;
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    // SIGKILL 等待结束后若 Worker 仍存活，返回 false（调用方不得记录“干净退出”）
    return await this.waitForExit(child, this.killWaitMs());
  }

  /** 等待子进程退出；超时返回 false。不依赖 child.killed —— 以 exit/close 事件为准 */
  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (exited(child)) return resolve(true);
      let done = false;
      const onExit = () => finish(true);
      const onClose = () => finish(true);
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        // 超时路径清理残留监听，避免每次等待泄漏两个 once 监听器
        child.removeListener('exit', onExit);
        child.removeListener('close', onClose);
        resolve(v);
      };
      const t = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', onExit);
      child.once('close', onClose);
    });
  }

  /** 等待 Worker 已终止后端口被释放（连接被拒绝即视为释放）；超时返回 false */
  private waitPortReleased(timeoutMs: number): Promise<boolean> {
    const port = this.opts.port;
    const end = Date.now() + timeoutMs;
    const probe = () =>
      new Promise<boolean>((resolve) => {
        const sock = connect({ host: '127.0.0.1', port, timeout: 400 });
        sock.once('connect', () => {
          sock.destroy();
          resolve(false); // 仍可连接 → 端口未释放
        });
        sock.once('error', () => resolve(true)); // ECONNREFUSED → 已释放
        sock.once('timeout', () => {
          sock.destroy();
          resolve(false);
        });
      });
    return (async () => {
      while (Date.now() < end) {
        if (await probe()) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
  }

  private stopWatchers() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
  }

  private inCrashLoop(): boolean {
    const cutoff = Date.now() - this.crashWindowMs();
    this.crashTimes = this.crashTimes.filter((t) => t > cutoff);
    return this.crashTimes.length >= this.crashBurstMax();
  }

  private async interruptibleDelay(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    let check: NodeJS.Timeout | undefined;
    const stopped = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const stopSignal = new Promise<boolean>((resolve) => {
      check = setInterval(() => {
        if (this.stopping) {
          clearInterval(check);
          resolve(true);
        }
      }, 200);
      check.unref?.();
    });
    try {
      return await Promise.race([stopped, stopSignal]);
    } finally {
      // 正常到期路径也必须清理轮询 interval，否则长期运行会累积大量空转定时器
      if (timer) clearTimeout(timer);
      if (check) clearInterval(check);
    }
  }

  /**
   * 优雅停止：stopping=true 后 watchers 不再触发自动重启，但仍通过升级终止路径
   * （IPC→SIGTERM→SIGKILL）真正终止当前 Worker；确认 Worker exit/close、PID 不再存活、
   * 端口已释放后才置退出码完成（不立即 process.exit）。
   */
  async stop(exitCode = 0): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopWatchers();
    const child = this.worker;
    let workerExited = true;
    if (child && !exited(child)) {
      const reallyExited = await this.killWorker(child, 'supervisor stop');
      workerExited = reallyExited;
      if (reallyExited) {
        // 升级终止已确认 exit/close，再补充确认端口释放（避免监听 socket 残留）
        const portReleased = await this.waitPortReleased(this.sigtermGraceMs() + this.killWaitMs());
        if (!portReleased) {
          logger.warn('停止后端口仍被占用', { port: this.opts.port, pid: child.pid });
        }
      } else {
        // SIGKILL 等待结束后 Worker 仍存活：不得记录“干净退出”
        logger.error('停止时 Worker 未能在升级终止后退出', { pid: child.pid, port: this.opts.port });
      }
    }
    if (workerExited) logger.info('Supervisor 已干净退出', { exitCode });
    else logger.warn('Supervisor 结束（Worker 未能确认退出）', { exitCode });
    process.exitCode = exitCode;
  }
}
