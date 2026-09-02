import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
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
  const readServerLog = (): ServerLogEntry[] => {
    // 优先 Node 新日志，兼容旧 data/server.log
    const candidates = [
      join(ctx.config.baseDir, 'data', 'logs', 'server.log'),
      join(ctx.config.baseDir, 'data', 'server.log'),
    ];
    const file = candidates.find((p) => existsSync(p));
    if (!file) return [];
    const text = readFileSync(file, 'utf-8');
    return text.split(/\r?\n/).filter(Boolean).map(parseServerLine);
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
      const d = e.time.slice(0, 10);
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
