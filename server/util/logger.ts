import { createWriteStream, mkdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';

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

class Logger {
  private stream: WriteStream | null = null;
  private logFile = '';
  private minLevel: LogLevel = 'info';

  init(baseDir: string, level: LogLevel = 'info') {
    this.minLevel = level;
    const dir = join(baseDir, 'data', 'logs');
    mkdirSync(dir, { recursive: true });
    this.logFile = join(dir, 'server.log');
    this.rotateIfNeeded();
    this.stream = createWriteStream(this.logFile, { flags: 'a' });
  }

  private rotateIfNeeded() {
    try {
      if (!existsSync(this.logFile)) return;
      const { size } = statSync(this.logFile);
      if (size < MAX_LOG_BYTES) return;
      for (let i = KEEP_LOG_FILES - 1; i >= 1; i--) {
        const from = `${this.logFile}.${i}`;
        const to = `${this.logFile}.${i + 1}`;
        if (existsSync(from)) renameSync(from, to);
      }
      renameSync(this.logFile, `${this.logFile}.1`);
    } catch {
      // 滚动失败不影响主流程
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
    if (this.stream) {
      this.rotateIfNeeded();
      this.stream.write(line + '\n');
    }
  }

  debug(msg: string, meta?: Record<string, unknown>) { this.write('debug', msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.write('info', msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.write('warn', msg, meta); }
  error(msg: string, meta?: Record<string, unknown>) { this.write('error', msg, meta); }

  crash(baseDir: string, content: string) {
    try {
      const dir = join(baseDir, 'data', 'logs');
      mkdirSync(dir, { recursive: true });
      const name = join(dir, `crash-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      const s = createWriteStream(name);
      s.end(maskSecret(content));
    } catch {
      // ignore
    }
  }

  close() {
    this.stream?.end();
    this.stream = null;
  }
}

export const logger = new Logger();
