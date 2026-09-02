import { ConfigManager } from './config/manager.js';
import { DatabaseManager } from './db/database.js';
import { Repositories } from './db/repositories/index.js';
import { ActiveRequestRegistry } from './health/active-registry.js';
import { SelfHealth } from './health/self-health.js';
import { ChannelHealthService } from './health/channel-health.js';

/**
 * RuntimeContext 依赖容器：Worker 进程内全局单例。
 * 各子系统（DB / Pool / Gateway / Health）在此装配，避免循环依赖。
 */
export class RuntimeContext {
  readonly config: ConfigManager;
  readonly db: DatabaseManager;
  readonly repos: Repositories;
  readonly activeRegistry = new ActiveRequestRegistry();
  readonly selfHealth: SelfHealth;
  readonly channelHealth = new ChannelHealthService(this);
  shuttingDown = false;
  // 运行时（模型索引/路由池/网关）重载钩子，Phase D 注入
  private reloadHandle: (() => void) | null = null;
  // Phase C/D 装配
  // readonly providers: ProviderService;
  // readonly pool: ModelPool;
  // readonly gateway: Gateway;

  constructor(config: ConfigManager, db: DatabaseManager) {
    this.config = config;
    this.db = db;
    this.repos = new Repositories(db);
    this.selfHealth = new SelfHealth(this.activeRegistry);
    this.selfHealth.addReadyChecker(() => this.db.ping());
  }

  setReloadHandle(fn: () => void) {
    this.reloadHandle = fn;
  }

  /** 配置/数据变更后安全地重建运行时索引（永不抛错影响 API） */
  requestRuntimeReload() {
    if (this.reloadHandle) {
      try {
        this.reloadHandle();
      } catch (err) {
        // 重载失败不应让管理 API 失败
        console.error('[runtime reload failed]', (err as Error).message);
      }
    }
  }
}
