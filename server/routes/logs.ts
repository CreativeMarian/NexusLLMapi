import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeContext } from '../context.js';
import { parseId } from './helpers.js';

interface ServerLogEntry {
  time: string;
  level: string;
  message: string;
  raw: string;
}

function parseServerLine(line: string): ServerLogEntry {
  // Node 格式: 2026-08-31T03:36:32.096Z [INFO] message {...}
  const m = line.match(/^(\S+)\s+\[([A-Z]+)\]\s?(.*)$/);
  if (m) return { time: m[1], level: m[2], message: m[3], raw: line };
  // 兼容旧 Go 格式: time=... level=INFO msg="..."
  const t = line.match(/time=(\S+)/);
  const l = line.match(/level=(\w+)/);
  const msg = line.match(/msg="?([^"]*)"?/);
  return { time: t?.[1] ?? '', level: l?.[1] ?? '', message: msg?.[1] ?? line, raw: line };
}

/** UTC ISO 时间串 → 本地日期串（YYYY-MM-DD），与日志页日期选择器的本地时区一致 */
function localDateStr(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function registerLogRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  const repo = ctx.repos.logs;

  app.get('/api/logs', async (req) => {
    const q = req.query as Record<string, string>;
    const page = Number(q.page ?? 1) || 1;
    const pageSize = Number(q.page_size ?? 20) || 20;
    const { list, total } = repo.query({
      page,
      pageSize,
      model: q.model || '',
      channelId: Number(q.channel_id ?? 0) || 0,
      statusCode: Number(q.status_code ?? 0) || 0,
      startDate: q.start_date || '',
      endDate: q.end_date || '',
    });
    return { data: list, total, page, page_size: pageSize };
  });

  app.get('/api/logs/stats', async () => ({ data: repo.stats() }));

  app.get('/api/logs/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const log = repo.get(id);
    if (!log) return reply.code(404).send({ error: 'log not found' });
    return { data: log };
  });

  app.delete('/api/logs', async () => {
    repo.clear();
    return { message: 'cleared' };
  });

  // ===== 服务运行日志 =====
  // 按 mtime 缓存整个日志文件的解析结果，避免 dashboard/日志页轮询时反复同步读大文件
  let logCache: { file: string; mtimeMs: number; size: number; entries: ServerLogEntry[] } | null = null;
  const readServerLog = (): ServerLogEntry[] => {
    // 优先 Node 新日志，兼容旧 data/server.log
    const candidates = [
      join(ctx.config.baseDir, 'data', 'logs', 'server.log'),
      join(ctx.config.baseDir, 'data', 'server.log'),
    ];
    const file = candidates.find((p) => existsSync(p));
    if (!file) {
      logCache = null;
      return [];
    }
    try {
      const st = statSync(file);
      if (logCache && logCache.file === file && logCache.mtimeMs === st.mtimeMs && logCache.size === st.size) {
        return logCache.entries;
      }
      const text = readFileSync(file, 'utf-8');
      const entries = text.split(/\r?\n/).filter(Boolean).map(parseServerLine);
      logCache = { file, mtimeMs: st.mtimeMs, size: st.size, entries };
      return entries;
    } catch {
      // 读取/滚动窗口期：退回上一次缓存
      return logCache?.entries ?? [];
    }
  };

  app.get('/api/server-logs', async (req) => {
    const q = req.query as Record<string, string>;
    let page = Number(q.page ?? 1) || 1;
    let pageSize = Number(q.page_size ?? 50) || 50;
    if (page < 1) page = 1;
    if (pageSize < 1 || pageSize > 500) pageSize = 50;
    const level = (q.level ?? '').toUpperCase();
    const keyword = (q.keyword ?? '').toLowerCase();
    const startDate = q.start_date ?? '';
    const endDate = q.end_date ?? '';

    const filtered = readServerLog().filter((e) => {
      if (level && e.level !== level) return false;
      if (keyword && !e.raw.toLowerCase().includes(keyword)) return false;
      // 日志时间戳为 UTC ISO，与用户输入的本地日期比较前先换算成本地日期
      const d = localDateStr(e.time);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
    const total = filtered.length;
    const start = Math.max(0, total - page * pageSize);
    const end = Math.max(0, total - (page - 1) * pageSize);
    const pageData = start >= total || end <= 0 ? [] : filtered.slice(start, end).reverse();
    return { data: pageData, total, page, page_size: pageSize };
  });

  app.get('/api/server-logs/stats', async () => {
    const entries = readServerLog();
    let info = 0,
      warn = 0,
      error = 0;
    let first = '',
      last = '';
    for (const e of entries) {
      if (e.level === 'INFO') info++;
      else if (e.level === 'WARN') warn++;
      else if (e.level === 'ERROR') error++;
      if (!first && e.time) first = e.time;
      if (e.time) last = e.time;
    }
    return {
      data: {
        info_count: info,
        warn_count: warn,
        error_count: error,
        total_lines: info + warn + error,
        first_time: first,
        last_time: last,
        startup_today: entries.filter((e) => e.message.includes('Worker 启动中')).length,
      },
    };
  });
}
