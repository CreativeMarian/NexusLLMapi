// 项目根目录解析：保证不依赖启动时的工作目录（CWD）。
// 规则：NEXUS_BASE_DIR 环境变量 > 入口脚本所在目录的上一级（dist-server/ 或 server/ 的父目录）。
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function detectEntryDir(): string {
  const entry = process.argv[1];
  if (entry) return dirname(entry);
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

let cached: string | null = null;

export function resolveProjectRoot(): string {
  if (cached) return cached;
  const env = process.env.NEXUS_BASE_DIR;
  const base = env && env.trim() ? resolve(env) : resolve(detectEntryDir(), '..');
  cached = base;
  return base;
}

/** 供测试/工具重置缓存 */
export function __resetProjectRoot(): void {
  cached = null;
}
