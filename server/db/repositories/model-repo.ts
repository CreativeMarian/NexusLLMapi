import type { Database } from 'better-sqlite3';
import { nowDb } from '../../util/time.js';
import { modelToDTO, type ModelDTO, type ModelRow } from '../types.js';

export interface ModelQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  modalType?: string;
  tag?: string;
  channelId?: number;
  enabled?: boolean | null;
}

export interface ModelInput {
  model_id?: string;
  alias?: string;
  channel_id?: number;
  tags?: string;
  modal_type?: string;
  max_context?: number;
  enabled?: boolean;
  available?: boolean;
  remark?: string;
}

export class ModelRepository {
  constructor(private db: Database) {}

  private buildWhere(q: ModelQuery): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (q.keyword) {
      conds.push('(model_id LIKE ? OR alias LIKE ? OR remark LIKE ?)');
      const kw = `%${q.keyword}%`;
      params.push(kw, kw, kw);
    }
    if (q.modalType) {
      conds.push('modal_type = ?');
      params.push(q.modalType);
    }
    if (q.tag) {
      conds.push('tags LIKE ?');
      params.push(`%"${q.tag}"%`);
    }
    if (q.channelId) {
      conds.push('channel_id = ?');
      params.push(q.channelId);
    }
    if (q.enabled !== null && q.enabled !== undefined) {
      conds.push('enabled = ?');
      params.push(q.enabled ? 1 : 0);
    }
    return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
  }

  query(q: ModelQuery): { list: ModelDTO[]; total: number } {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 50));
    const { where, params } = this.buildWhere(q);
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM models ${where}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM models ${where} ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as ModelRow[];
    return { list: rows.map(modelToDTO), total };
  }

  listAll(): ModelDTO[] {
    return this.query({ page: 1, pageSize: 500 }).list;
  }

  listEnabled(): ModelDTO[] {
    const rows = this.db.prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY id ASC').all() as ModelRow[];
    return rows.map(modelToDTO);
  }

  listByChannel(channelId: number): ModelDTO[] {
    const rows = this.db.prepare('SELECT * FROM models WHERE channel_id = ? ORDER BY id ASC').all(channelId) as ModelRow[];
    return rows.map(modelToDTO);
  }

  get(id: number): ModelDTO | null {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
    return row ? modelToDTO(row) : null;
  }

  private getRaw(id: number): ModelRow | null {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
    return row ?? null;
  }

  create(input: ModelInput): ModelDTO {
    const now = nowDb();
    const info = this.db
      .prepare(
        `INSERT INTO models (model_id, alias, channel_id, tags, modal_type, max_context, enabled, available, remark, created_at, updated_at)
         VALUES (@model_id, @alias, @channel_id, @tags, @modal_type, @max_context, @enabled, @available, @remark, @now, @now)`,
      )
      .run({
        model_id: input.model_id ?? '',
        alias: input.alias ?? '',
        channel_id: input.channel_id ?? 0,
        tags: input.tags ?? '[]',
        modal_type: input.modal_type ?? 'text',
        max_context: input.max_context ?? 0,
        enabled: input.enabled === false ? 0 : 1,
        available: input.available ? 1 : 0,
        remark: input.remark ?? '',
        now,
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  /** 同步模型：同渠道同 model_id 存在则忽略（唯一索引保护），返回是否新增 */
  upsertIgnore(channelId: number, modelId: string, extra: Partial<ModelInput>): boolean {
    const exists = this.db
      .prepare('SELECT id FROM models WHERE channel_id = ? AND model_id = ?')
      .get(channelId, modelId);
    if (exists) return false;
    this.create({ model_id: modelId, channel_id: channelId, available: true, ...extra });
    return true;
  }

  update(id: number, patch: ModelInput): ModelDTO | null {
    const existing = this.getRaw(id);
    if (!existing) return null;
    const now = nowDb();
    this.db
      .prepare(
        `UPDATE models SET model_id=@model_id, alias=@alias, channel_id=@channel_id, tags=@tags, modal_type=@modal_type,
           max_context=@max_context, enabled=@enabled, available=@available, remark=@remark, updated_at=@now WHERE id=@id`,
      )
      .run({
        id,
        model_id: patch.model_id ?? existing.model_id,
        alias: patch.alias ?? existing.alias,
        channel_id: patch.channel_id ?? existing.channel_id,
        tags: patch.tags ?? existing.tags,
        modal_type: patch.modal_type ?? existing.modal_type,
        max_context: patch.max_context ?? existing.max_context,
        enabled: patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
        available: patch.available === undefined ? existing.available : patch.available ? 1 : 0,
        remark: patch.remark ?? existing.remark,
        now,
      });
    return this.get(id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }

  removeByChannel(channelId: number): void {
    this.db.prepare('DELETE FROM models WHERE channel_id = ?').run(channelId);
  }

  toggle(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE models SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowDb(), id);
  }

  batchToggle(ids: number[], enabled: boolean): void {
    if (!ids.length) return;
    const stmt = this.db.prepare('UPDATE models SET enabled = ? WHERE id = ?');
    const tx = this.db.transaction((rows: number[]) => {
      for (const id of rows) stmt.run(enabled ? 1 : 0, id);
    });
    tx(ids);
  }

  batchDelete(ids: number[]): number {
    if (!ids.length) return 0;
    const stmt = this.db.prepare('DELETE FROM models WHERE id = ?');
    const tx = this.db.transaction((rows: number[]) => {
      let n = 0;
      for (const id of rows) n += stmt.run(id).changes;
      return n;
    });
    return tx(ids) as number;
  }

  setAvailable(id: number, available: boolean): void {
    this.db.prepare('UPDATE models SET available = ? WHERE id = ?').run(available ? 1 : 0, id);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM models').get() as { c: number }).c;
  }
}
