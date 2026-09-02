// 运行时配置类型定义（与旧 data/config.json 字段保持兼容）
export interface AppConfig {
  port: number;
  auto_open_browser: boolean;
  data_dir: string;
  global_rpm: number;
  default_retry: number;
  default_cooldown: number; // 秒
  request_timeout: number; // 秒
  enable_log: boolean;
  socks5_proxy: string;
  max_channel_conns: number;
  max_cost_pct: number;
  channel_health_interval_sec: number;
  idle_timeout_ms: number; // 流式空闲超时（毫秒），0 = 关闭
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 8787,
  auto_open_browser: false,
  data_dir: 'data',
  global_rpm: 600,
  default_retry: 2,
  default_cooldown: 1,
  request_timeout: 120,
  enable_log: true,
  socks5_proxy: '',
  max_channel_conns: 100,
  max_cost_pct: 0.8,
  channel_health_interval_sec: 300,
  idle_timeout_ms: 300000,
};

// 允许通过 PUT /api/settings 热更新的字段（port 不在其中）
export const HOT_UPDATABLE_KEYS: (keyof AppConfig)[] = [
  'global_rpm',
  'default_retry',
  'default_cooldown',
  'request_timeout',
  'enable_log',
  'socks5_proxy',
  'max_channel_conns',
  'max_cost_pct',
  'channel_health_interval_sec',
  'idle_timeout_ms',
  'auto_open_browser',
];
