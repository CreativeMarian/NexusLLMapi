import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigManager } from '../server/config/manager.js';
import { DatabaseManager } from '../server/db/database.js';
import { RuntimeContext } from '../server/context.js';
import { Gateway } from '../server/gateway/gateway.js';
import { createApp } from '../server/app.js';
import { ProviderService } from '../server/providers/service.js';
import { registerProviderService } from '../server/service-locator.js';
import type { FastifyInstance } from 'fastify';
import type { ChannelDTO } from '../server/db/types.js';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGINAL_DB = join(PROJECT_ROOT, 'data', 'store.db');

/** 创建临时基础目录（隔离 config/db/logs） */
export function tempBase(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-test-'));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface CtxBundle {
  ctx: RuntimeContext;
  config: ConfigManager;
  db: DatabaseManager;
  baseDir: string;
}

/** 构造隔离的 RuntimeContext（Provider 服务已注册，日志指向临时目录） */
export function makeCtx(baseDir = tempBase(), writeConfig?: Record<string, unknown>): CtxBundle {
  mkdirSync(join(baseDir, 'data'), { recursive: true });
  if (writeConfig) {
    writeFileSync(join(baseDir, 'data', 'config.json'), JSON.stringify(writeConfig, null, 2), 'utf-8');
  }
  const config = new ConfigManager(baseDir);
  const db = new DatabaseManager(baseDir, config.dbPath());
  const ctx = new RuntimeContext(config, db);
  const ps = new ProviderService(ctx);
  registerProviderService(ps);
  return { ctx, config, db, baseDir };
}

export interface AppBundle extends CtxBundle {
  gateway: Gateway;
  app: FastifyInstance;
}

/** 构造隔离的 Gateway + Fastify app（供 inject / 真实监听测试） */
export async function makeApp(bundle: CtxBundle = makeCtx()): Promise<AppBundle> {
  const { ctx } = bundle;
  const gateway = new Gateway(ctx);
  ctx.setReloadHandle(() => gateway.reload());
  const app = await createApp(ctx, gateway);
  return { ...bundle, gateway, app };
}

/** 同步复制 WAL 模式的 SQLite 库（db + wal + shm），保证包含 WAL 中未合并数据 */
export function copyDbSnapshot(src: string, dest: string): void {
  copyFileSync(src, dest);
  for (const ext of ['-wal', '-shm']) {
    const f = src + ext;
    if (existsSync(f)) copyFileSync(f, dest + ext);
  }
}

/** 通过 database.ts 打开一份原库副本，验证旧数据可读 */
export function openDbCopy(src: string): { db: DatabaseManager; baseDir: string } {
  const baseDir = tempBase();
  mkdirSync(join(baseDir, 'data'), { recursive: true });
  const dest = join(baseDir, 'data', 'store.db');
  copyDbSnapshot(src, dest);
  const db = new DatabaseManager(baseDir, dest);
  return { db, baseDir };
}

// ================= Mock 上游 =================

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type UpstreamHandler = (req: UpstreamRequest, res: http.ServerResponse) => void;

export interface MockUpstream {
  port: number;
  base: string; // http://127.0.0.1:port/v1
  requests: UpstreamRequest[];
  setHandler: (h: UpstreamHandler) => void;
  close: () => Promise<void>;
}

/** 启动一个可配置的 mock 上游 HTTP 服务 */
export function startMockUpstream(handler?: UpstreamHandler): Promise<MockUpstream> {
  const requests: UpstreamRequest[] = [];
  let current = handler;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const item: UpstreamRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      requests.push(item);
      if (current) current(item, res);
      else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        base: `http://127.0.0.1:${addr.port}/v1`,
        requests,
        setHandler: (h) => {
          current = h;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** 标准的 OpenAI 聊天完成响应体 */
export function chatCompletionJSON(model: string, content = 'hello'): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/** SSE 流式响应（默认带 usage 尾块 + [DONE]） */
export function sseStream(model: string, parts: string[] = ['Hello', ' world']): string {
  const id = 'chatcmpl-sse';
  const created = Math.floor(Date.now() / 1000);
  let out = '';
  parts.forEach((p, i) => {
    out += `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: p }, finish_reason: i === parts.length - 1 ? 'stop' : null }],
    })}\n\n`;
  });
  out += `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })}\n\n`;
  out += 'data: [DONE]\n\n';
  return out;
}

// ================= 数据播种 =================

export interface ChannelOpts {
  name?: string;
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  enabled?: boolean;
  rpm_limit?: number;
  retry_count?: number;
  extra_config?: string;
}

export function seedChannel(ctx: RuntimeContext, opts: ChannelOpts = {}): ChannelDTO {
  return ctx.repos.channels.create({
    name: opts.name ?? 'mock',
    provider_type: opts.provider_type ?? 'custom',
    base_url: opts.base_url ?? 'http://127.0.0.1:1/v1',
    api_key: opts.api_key ?? 'sk-test',
    enabled: opts.enabled ?? true,
    rpm_limit: opts.rpm_limit ?? 9999,
    retry_count: opts.retry_count ?? 2,
    extra_config: opts.extra_config ?? '{}',
  });
}

export interface ModelOpts {
  alias?: string;
  enabled?: boolean;
  available?: boolean;
  tags?: string;
  modal_type?: string;
  max_context?: number;
  remark?: string;
}

export function seedModel(ctx: RuntimeContext, channelId: number, modelId: string, opts: ModelOpts = {}) {
  return ctx.repos.models.create({
    model_id: modelId,
    alias: opts.alias ?? '',
    channel_id: channelId,
    tags: opts.tags ?? '["对话"]',
    modal_type: opts.modal_type ?? 'text',
    max_context: opts.max_context ?? 4096,
    enabled: opts.enabled ?? true,
    available: opts.available ?? true,
    remark: opts.remark ?? '',
  });
}

/** 便捷：渠道 + 文本模型一步到位 */
export function seedChannelModel(ctx: RuntimeContext, modelId = 'gpt-test', chOpts: ChannelOpts = {}) {
  const ch = seedChannel(ctx, chOpts);
  seedModel(ctx, ch.id, modelId);
  return { ch, modelId };
}

/** 读取渠道在 mock 上游收到的最近一次 chat 请求体 */
export function lastChatBody(mock: MockUpstream): { model: string; messages: unknown; stream?: boolean } {
  const req = [...mock.requests].reverse().find((r) => r.method === 'POST' && /chat\/completions/.test(r.url));
  if (!req) return { model: '', messages: [] };
  try {
    const j = JSON.parse(req.body);
    return { model: j.model ?? '', messages: j.messages ?? [], stream: j.stream };
  } catch {
    return { model: '', messages: [] };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
