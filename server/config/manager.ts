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
    // 回写补全新字段；只读文件系统等场景不应阻断启动
    try {
      this.persist(merged);
    } catch (err) {
      console.warn('[config] 配置文件写入失败（将以只读方式运行）:', (err as Error).message);
    }
    return merged;
  }

  /** 类型安全钳制：手改 config.json 可能引入 null/字符串，非法值一律回退默认或边界值（数字字符串会先收敛为数字） */
  private clamp(cfg: AppConfig) {
    const num = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return null;
    };
    const p = num(cfg.port);
    cfg.port = p !== null && p > 0 && p <= 65535 ? Math.floor(p) : DEFAULT_CONFIG.port;
    const rpm = num(cfg.global_rpm);
    cfg.global_rpm = rpm !== null ? Math.max(0, Math.floor(rpm)) : DEFAULT_CONFIG.global_rpm;
    const retry = num(cfg.default_retry);
    cfg.default_retry = retry !== null ? Math.min(10, Math.max(0, Math.floor(retry))) : DEFAULT_CONFIG.default_retry;
    const cd = num(cfg.default_cooldown);
    cfg.default_cooldown = cd !== null ? Math.max(0, cd) : DEFAULT_CONFIG.default_cooldown;
    const timeout = num(cfg.request_timeout);
    cfg.request_timeout = timeout !== null ? Math.max(5, timeout) : DEFAULT_CONFIG.request_timeout;
    const conns = num(cfg.max_channel_conns);
    cfg.max_channel_conns = conns !== null ? Math.max(1, Math.floor(conns)) : DEFAULT_CONFIG.max_channel_conns;
    const cost = num(cfg.max_cost_pct);
    cfg.max_cost_pct = cost !== null && cost > 0 && cost <= 1 ? cost : 0.8;
    const healthSec = num(cfg.channel_health_interval_sec);
    cfg.channel_health_interval_sec =
      healthSec !== null && healthSec >= 30 ? Math.floor(healthSec) : DEFAULT_CONFIG.channel_health_interval_sec;
    const idle = num(cfg.idle_timeout_ms);
    cfg.idle_timeout_ms = idle !== null ? Math.max(0, Math.floor(idle)) : DEFAULT_CONFIG.idle_timeout_ms;
    if (typeof cfg.socks5_proxy !== 'string') cfg.socks5_proxy = '';
    if (typeof cfg.auto_open_browser !== 'boolean') cfg.auto_open_browser = DEFAULT_CONFIG.auto_open_browser;
    if (typeof cfg.enable_log !== 'boolean') cfg.enable_log = DEFAULT_CONFIG.enable_log;
    if (typeof cfg.data_dir !== 'string' || !cfg.data_dir) cfg.data_dir = DEFAULT_CONFIG.data_dir;
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

  /**
   * 持久化端口（不参与热更新）。端口在两个进程各自启动时读取，
   * 保存到 config.json 后重启生效；校验/钳制失败返回 null。
   */
  persistPort(port: unknown): number | null {
    const p = typeof port === 'number' && Number.isFinite(port) ? Math.floor(port) : null;
    if (p === null || p <= 0 || p > 65535) return null;
    if (p !== this.cfg.port) {
      this.cfg = { ...this.cfg, port: p };
      try {
        this.persist(this.cfg);
      } catch (err) {
        console.warn('[config] 端口写入失败:', (err as Error).message);
      }
    }
    return p;
  }

  get dataDir(): string {
    return join(this.baseDir, this.cfg.data_dir);
  }

  dbPath(): string {
    return join(this.dataDir, 'store.db');
  }
}
