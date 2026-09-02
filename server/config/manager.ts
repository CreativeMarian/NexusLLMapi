import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig, HOT_UPDATABLE_KEYS } from './types.js';

type Listener = (cfg: AppConfig) => void;

function clone(cfg: AppConfig): AppConfig {
  return { ...cfg };
}

export class ConfigManager {
  private cfg: AppConfig;
  private readonly configPath: string;
  readonly baseDir: string;
  private listeners = new Set<Listener>();

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
    const dataDir = join(baseDir, DEFAULT_CONFIG.data_dir);
    mkdirSync(dataDir, { recursive: true });
    this.configPath = join(dataDir, 'config.json');
    this.cfg = this.load();
  }

  private load(): AppConfig {
    let merged: AppConfig = clone(DEFAULT_CONFIG);
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<AppConfig>;
        // 在默认值上叠加：缺失字段用默认，显式 0/false 保留
        merged = { ...DEFAULT_CONFIG, ...parsed };
      } catch (err) {
        // 损坏：备份，使用默认
        try {
          writeFileSync(this.configPath + '.corrupt', readFileSync(this.configPath));
        } catch {
          /* ignore */
        }
        merged = clone(DEFAULT_CONFIG);
      }
    }
    this.clamp(merged);
    this.persist(merged); // 回写补全新字段
    return merged;
  }

  private clamp(cfg: AppConfig) {
    if (!Number.isFinite(cfg.port) || cfg.port <= 0 || cfg.port > 65535) cfg.port = DEFAULT_CONFIG.port;
    if (cfg.global_rpm < 0) cfg.global_rpm = 0;
    if (cfg.default_retry < 0) cfg.default_retry = 0;
    if (cfg.default_retry > 10) cfg.default_retry = 10;
    if (cfg.request_timeout < 5) cfg.request_timeout = 5;
    if (cfg.max_channel_conns < 1) cfg.max_channel_conns = 1;
    if (cfg.max_cost_pct <= 0 || cfg.max_cost_pct > 1) cfg.max_cost_pct = 0.8;
    if (cfg.channel_health_interval_sec < 30) cfg.channel_health_interval_sec = 300;
  }

  /** 原子写文件 */
  private persist(cfg: AppConfig) {
    const tmp = this.configPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    renameSync(tmp, this.configPath);
  }

  /** 获取当前配置快照（不可变副本） */
  getSnapshot(): AppConfig {
    return clone(this.cfg);
  }

  /** 同步读取最新值（供热更新场景） */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.cfg[key];
  }

  /** 订阅配置变更 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 仅更新允许热更新的字段，原子保存并发布 */
  update(patch: Partial<AppConfig>): AppConfig {
    const next = clone(this.cfg);
    for (const key of HOT_UPDATABLE_KEYS) {
      // 仅更新实际传入且非 undefined 的字段（部分更新语义）
      if (key in patch && patch[key] !== undefined) {
        (next[key] as unknown) = patch[key];
      }
    }
    this.clamp(next);
    this.persist(next);
    this.cfg = next;
    const snap = this.getSnapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* listener 异常不影响更新 */
      }
    }
    return snap;
  }

  get dataDir(): string {
    return join(this.baseDir, this.cfg.data_dir);
  }

  dbPath(): string {
    return join(this.dataDir, 'store.db');
  }
}
