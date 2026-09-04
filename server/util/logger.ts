import { mkdirSync, statSync, renameSync, existsSync, appendFileSync, writeFileSync, copyFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 单个日志 10MB 滚动
const KEEP_LOG_FILES = 5;

// 脱敏：隐藏 API Key / Authorization / Token
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(sk-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+/g, '$1****'],
  [/(nvapi-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+/g, '$1****'],
  [/(Bearer\s+)([A-Za-z0-9._\-]{6})[A-Za-z0-9._\-]+/gi, '$1$2****'],
  [/("api[_-]?key"\s*:\s*")([^"]{4})[^"]*"/gi, '$1$2****"'],
];

export function maskSecret(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * 同步文件日志：
 * - appendFileSync 逐行追加（本项目文件日志量很小，同步开销可忽略）；
 *   不持有长打开的句柄 → Supervisor/Worker 两进程共享同一文件时，
 *   Windows 上 rename 滚动不会因句柄占用失败，进程退出前日志也不会丢失。
 * - 滚动用「复制 + 截断」而非 rename：保证多进程同时打开写时也能滚动成功。
 */
class Logger {
  private logFile = '';
  private minLevel: LogLevel = 'info';
  private bytes = 0;

  init(baseDir: string, level: LogLevel = 'info') {
    this.minLevel = level;
    const dir = join(baseDir, 'data', 'logs');
    mkdirSync(dir, { recursive: true });
    this.logFile = join(dir, 'server.log');
    this.bytes = this.rotateIfNeeded();
  }

  /** 超过大小上限时滚动；返回滚动后的当前文件大小 */
  private rotateIfNeeded(): number {
    try {
      if (!this.logFile) return 0;
      const size = existsSync(this.logFile) ? statSync(this.logFile).size : 0;
      if (size < MAX_LOG_BYTES) return size;
      for (let i = KEEP_LOG_FILES - 1; i >= 1; i--) {
        const from = `${this.logFile}.${i}`;
        const to = `${this.logFile}.${i + 1}`;
        if (existsSync(from)) renameSync(from, to);
      }
      // 复制 + 截断：当前文件可能同时被 Supervisor/Worker 打开写入，rename 会失败
      copyFileSync(this.logFile, `${this.logFile}.1`);
      truncateSync(this.logFile, 0);
      return 0;
    } catch {
      // 滚动失败不影响主流程；返回未知大小时按已达上限处理，下次写日志再试
      return MAX_LOG_BYTES;
    }
  }

  setLevel(level: LogLevel) {
    this.minLevel = level;
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    const time = new Date().toISOString();
    let line = `${time} [${level.toUpperCase()}] ${msg}`;
    if (meta && Object.keys(meta).length > 0) {
      try {
        line += ' ' + maskSecret(JSON.stringify(meta));
      } catch {
        line += ' [unserializable meta]';
      }
    }
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(line);
    if (!this.logFile) return;
    try {
      if (this.bytes >= MAX_LOG_BYTES) this.bytes = this.rotateIfNeeded();
      appendFileSync(this.logFile, line + '\n', 'utf-8');
      this.bytes += Buffer.byteLength(line + '\n');
    } catch {
      /* 文件写入失败不影响主流程 */
    }
  }

  debug(msg: string, meta?: Record<string, unknown>) { this.write('debug', msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.write('info', msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.write('warn', msg, meta); }
  error(msg: string, meta?: Record<string, unknown>) { this.write('error', msg, meta); }

  /** 崩溃现场：进程即将退出，必须用同步写保证落盘 */
  crash(baseDir: string, content: string) {
    try {
      const dir = join(baseDir, 'data', 'logs');
      mkdirSync(dir, { recursive: true });
      const name = join(dir, `crash-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      writeFileSync(name, maskSecret(content), 'utf-8');
    } catch {
      // ignore
    }
  }

  /** 兼容保留：写入已改为同步，无需冲洗 */
  close() {
    /* no-op */
  }
}

export const logger = new Logger();
