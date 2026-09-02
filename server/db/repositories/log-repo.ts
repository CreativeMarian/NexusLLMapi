import type { Database } from 'better-sqlite3';
import { nowDb, todayDate } from '../../util/time.js';
import { logToDTO, type LogDTO, type LogRow } from '../types.js';

const LOG_MAX = 10000;

export interface LogQuery {
  page?: number;
  pageSize?: number;
  model?: string;
  channelId?: number;
  statusCode?: number;
  startDate?: string;
  endDate?: string;
}

export interface NewLog {
  requestId: string;
  model: string;
  channelId: number;
  channelName: string;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  errorMsg: string;
}

export interface LogStats {
  total_requests: number;
  today_requests: number;
  total_tokens: number;
  today_tokens: number;
  success_count: number;
  fail_count: number;
  avg_duration_ms: number;
}

export class LogRepository {
  private insertCounter = 0;

  constructor(private db: Database) {}

  query(q: LogQuery): { list: LogDTO[]; total: number } {
    const conds: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q.model) {
      conds.push('LOWER(model) LIKE ?');
      params.push(`%${q.model.toLowerCase()}%`);
    }
    if (q.channelId) {
      conds.push('channel_id = ?');
      params.push(q.channelId);
    }
    if (q.statusCode && q.statusCode > 0) {
      conds.push('status_code = ?');
      params.push(q.statusCode);
    }
    if (q.startDate) {
      conds.push('created_date >= ?');
      params.push(q.startDate);
    }
    if (q.endDate) {
      conds.push('created_date <= ?');
      params.push(q.endDate);
    }
    const where = conds.join(' AND ');
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 20));

    const total = (this.db.prepare(`SELECT COUNT(*) c FROM request_logs WHERE ${where}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT id, request_id, model, channel_id, channel_name, status_code, prompt_tokens, completion_tokens,
                total_tokens, duration_ms, error_msg, created_at FROM request_logs
         WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as LogRow[];
    return { list: rows.map(logToDTO), total };
  }

  /** 取最近 N 条原始行（趋势统计用，上限 10000） */
  private recentRows(limit = LOG_MAX): LogRow[] {
    return this.db
      .prepare(
        `SELECT id, request_id, model, channel_id, channel_name, status_code, prompt_tokens, completion_tokens,
                total_tokens, duration_ms, error_msg, created_at, created_date FROM request_logs
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as LogRow[];
  }

  get(id: number): LogDTO | null {
    const row = this.db
      .prepare(
        `SELECT id, request_id, model, channel_id, channel_name, status_code, prompt_tokens, completion_tokens,
                total_tokens, duration_ms, error_msg, created_at FROM request_logs WHERE id = ?`,
      )
      .get(id) as LogRow | undefined;
    return row ? logToDTO(row) : null;
  }

  insert(l: NewLog): number {
    const now = nowDb();
    const info = this.db
      .prepare(
        `INSERT INTO request_logs
          (request_id, model, channel_id, channel_name, status_code, prompt_tokens, completion_tokens, total_tokens, duration_ms, error_msg, created_at, created_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        l.requestId, l.model, l.channelId, l.channelName, l.statusCode, l.promptTokens, l.completionTokens,
        l.totalTokens, l.durationMs, l.errorMsg, now, todayDate(),
      );
    this.insertCounter++;
    if (this.insertCounter >= 500) {
      this.insertCounter = 0;
      this.prune();
    }
    return Number(info.lastInsertRowid);
  }

  /** 清理超出上限的旧日志 */
  prune(): void {
    const count = (this.db.prepare('SELECT COUNT(*) c FROM request_logs').get() as { c: number }).c;
    if (count > LOG_MAX) {
      this.db
        .prepare('DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs ORDER BY id ASC LIMIT ?)')
        .run(count - LOG_MAX);
    }
  }

  clear(): void {
    this.db.prepare('DELETE FROM request_logs').run();
  }

  stats(): LogStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) total,
                COALESCE(SUM(total_tokens),0) tokens,
                COALESCE(SUM(duration_ms),0) duration,
                COALESCE(SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END),0) success,
                COALESCE(SUM(CASE WHEN status_code >= 400 OR status_code = 0 THEN 1 ELSE 0 END),0) fail
         FROM request_logs`,
      )
      .get() as { total: number; tokens: number; duration: number; success: number; fail: number };
    const today = this.db
      .prepare(
        `SELECT COUNT(*) total, COALESCE(SUM(total_tokens),0) tokens FROM request_logs WHERE created_date = ?`,
      )
      .get(todayDate()) as { total: number; tokens: number };
    return {
      total_requests: row.total,
      today_requests: today.total,
      total_tokens: row.tokens,
      today_tokens: today.tokens,
      success_count: row.success,
      fail_count: row.fail,
      avg_duration_ms: row.total > 0 ? row.duration / row.total : 0,
    };
  }

  /** 最近 N 天趋势，date 为 MM-DD */
  trend(days: number): Array<{ date: string; requests: number; tokens: number; success: number; fail: number }> {
    const rows = this.recentRows();
    const map = new Map<string, { requests: number; tokens: number; success: number; fail: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const full = todayDate(d);
      map.set(full, { requests: 0, tokens: 0, success: 0, fail: 0 });
    }
    for (const r of rows) {
      const full = r.created_date || (r.created_at || '').slice(0, 10).replace('T', ' ').slice(0, 10);
      const agg = map.get(full);
      if (!agg) continue;
      agg.requests++;
      agg.tokens += r.total_tokens;
      if (r.status_code >= 200 && r.status_code < 300) agg.success++;
      else agg.fail++;
    }
    return [...map.entries()].map(([full, v]) => ({ date: full.slice(5), ...v }));
  }

  /** 按渠道聚合统计 */
  channelStats(): Array<{
    channel_id: number; channel_name: string; requests: number; tokens: number;
    success: number; fail: number; avg_duration_ms: number;
  }> {
    const rows = this.recentRows();
    const map = new Map<number, { channel_name: string; requests: number; tokens: number; success: number; fail: number; duration: number }>();
    for (const r of rows) {
      if (!r.channel_id) continue;
      let agg = map.get(r.channel_id);
      if (!agg) {
        agg = { channel_name: r.channel_name, requests: 0, tokens: 0, success: 0, fail: 0, duration: 0 };
        map.set(r.channel_id, agg);
      }
      agg.requests++;
      agg.tokens += r.total_tokens;
      agg.duration += r.duration_ms;
      if (r.status_code >= 200 && r.status_code < 300) agg.success++;
      else agg.fail++;
    }
    return [...map.entries()]
      .map(([channel_id, a]) => ({
        channel_id,
        channel_name: a.channel_name,
        requests: a.requests,
        tokens: a.tokens,
        success: a.success,
        fail: a.fail,
        avg_duration_ms: a.requests > 0 ? a.duration / a.requests : 0,
      }))
      .sort((a, b) => b.requests - a.requests);
  }

  /** 按模型聚合统计 */
  modelStats(limit: number): Array<{
    model_id: string; requests: number; tokens: number; success: number; fail: number; avg_duration_ms: number;
  }> {
    const rows = this.recentRows();
    const map = new Map<string, { requests: number; tokens: number; success: number; fail: number; duration: number }>();
    for (const r of rows) {
      if (!r.model) continue;
      let agg = map.get(r.model);
      if (!agg) {
        agg = { requests: 0, tokens: 0, success: 0, fail: 0, duration: 0 };
        map.set(r.model, agg);
      }
      agg.requests++;
      agg.tokens += r.total_tokens;
      agg.duration += r.duration_ms;
      if (r.status_code >= 200 && r.status_code < 300) agg.success++;
      else agg.fail++;
    }
    return [...map.entries()]
      .map(([model_id, a]) => ({
        model_id,
        requests: a.requests,
        tokens: a.tokens,
        success: a.success,
        fail: a.fail,
        avg_duration_ms: a.requests > 0 ? a.duration / a.requests : 0,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, limit);
  }
}
