import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/logger.js';

/** 启动自动备份的最大保留份数 */
const MAX_BACKUP_RETENTION = 5;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    provider_type TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    extra_config TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    rpm_limit INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    disabled_until DATETIME,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY,
    model_id TEXT NOT NULL DEFAULT '',
    alias TEXT NOT NULL DEFAULT '',
    channel_id INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    modal_type TEXT NOT NULL DEFAULT 'text',
    max_context INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    available INTEGER NOT NULL DEFAULT 0,
    remark TEXT NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_models_channel ON models(channel_id)`,
  `CREATE INDEX IF NOT EXISTS idx_models_model_id ON models(model_id)`,
  `CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    channel_id INTEGER NOT NULL DEFAULT 0,
    channel_name TEXT NOT NULL DEFAULT '',
    status_code INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_msg TEXT NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    created_date TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_date ON request_logs(created_date)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_channel ON request_logs(channel_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_models_channel_model ON models(channel_id, model_id)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS billing_records (
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL DEFAULT '',
    channel_id INTEGER NOT NULL DEFAULT 0,
    model_id TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    created_date TEXT NOT NULL DEFAULT '',
    created_month TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_billing_month_channel ON billing_records(created_month, channel_id)`,
];

export class DatabaseManager {
  readonly db: DB;
  private readonly baseDir: string;

  constructor(baseDir: string, dbPath: string) {
    this.baseDir = baseDir;
    const existed = existsSync(dbPath);
    if (!existed) {
      logger.warn('数据库文件不存在，将创建新库（请确认这是预期行为）', { path: dbPath });
    }
    this.db = new Database(dbPath);
    // 稳定性 PRAGMA
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.ensureSchema();
    if (existed) void this.backup();
    const integrity = this.integrityCheck();
    logger.info('SQLite 初始化完成', { path: dbPath, integrity });
  }

  private ensureSchema() {
    const tx = this.db.transaction(() => {
      for (const sql of SCHEMA_STATEMENTS) this.db.exec(sql);
    });
    tx();
  }

  /** 启动时自动备份一份一致性只读快照；保留最近 N 份（默认 5），超出删除最旧。
   *  使用 better-sqlite3 在线备份 API（SQLite backup API，worker 线程），
   *  WAL 模式下正在写入/未 checkpoint 的数据也会进入快照，可在连接存活时安全备份。 */
  async backup(): Promise<string | null> {
    try {
      const dir = join(this.baseDir, 'data', 'backups');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = join(dir, `store-${stamp}.db.bak`);
      await this.db.backup(dest);
      // 校验备份文件：切回 DELETE 日志模式（checkpoint 并入主文件）后做 quick_check，
      // 使备份成为单一自包含文件，避免 WAL 残留 -wal/-shm 侧文件
      try {
        const b = new Database(dest);
        b.pragma('journal_mode = DELETE');
        const qc = String(b.pragma('quick_check', { simple: true }));
        b.close();
        if (qc !== 'ok') {
          logger.warn('备份文件 quick_check 未通过，已删除', { dest, qc });
          try {
            unlinkSync(dest);
          } catch {
            /* ignore */
          }
          return null;
        }
      } catch (err) {
        logger.warn('校验备份文件失败', { error: (err as Error).message, dest });
        try {
          unlinkSync(dest);
        } catch {
          /* ignore */
        }
        return null;
      }
      // 保留上限：仅保留最近 limit 份基础备份（连同其 -wal/-shm 侧文件一起清理/保留）
      const limit = MAX_BACKUP_RETENTION;
      const all = readdirSync(dir).filter((f) => /^store-.*\.db\.bak(?:-wal|-shm)?$/.test(f));
      const bases = all
        .filter((f) => f.endsWith('.db.bak'))
        .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
      const keepBase = new Set(bases.slice(0, limit));
      for (const f of all) {
        const base = f.endsWith('-wal') || f.endsWith('-shm') ? f.slice(0, -4) : f;
        if (!keepBase.has(base)) {
          try {
            unlinkSync(join(dir, f));
          } catch {
            /* ignore */
          }
        }
      }
      return dest;
    } catch (err) {
      logger.warn('数据库备份失败', { error: (err as Error).message });
      return null;
    }
  }

  /** 启动/常规完整性检查用 quick_check（轻量）；full=true 时用全量 integrity_check（耗时） */
  integrityCheck(full = false): string {
    const row = this.db.pragma(full ? 'integrity_check' : 'quick_check', { simple: true });
    return String(row ?? 'unknown');
  }

  /** 全量完整性检查（手动触发/诊断用） */
  fullIntegrityCheck(): string {
    return this.integrityCheck(true);
  }

  /** 健康检查用的快速 ping */
  ping(): string | null {
    try {
      const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return row && row.ok === 1 ? null : 'db ping failed';
    } catch (err) {
      return (err as Error).message;
    }
  }

  checkpoint() {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.warn('WAL checkpoint 失败', { error: (err as Error).message });
    }
  }

  close() {
    this.checkpoint();
    this.db.close();
  }
}
