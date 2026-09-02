import type { Database } from 'better-sqlite3';
import { nowDb } from '../../util/time.js';
import { channelToDTO, type ChannelDTO, type ChannelRow } from '../types.js';

export interface ChannelInput {
  name?: string;
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  extra_config?: string;
  enabled?: boolean;
  rpm_limit?: number;
  retry_count?: number;
}

export class ChannelRepository {
  constructor(private db: Database) {}

  list(): ChannelDTO[] {
    const rows = this.db.prepare('SELECT * FROM channels ORDER BY id ASC').all() as ChannelRow[];
    return rows.map(channelToDTO);
  }

  listEnabled(): ChannelDTO[] {
    const rows = this.db.prepare('SELECT * FROM channels WHERE enabled = 1 ORDER BY id ASC').all() as ChannelRow[];
    return rows.map(channelToDTO);
  }

  get(id: number): ChannelDTO | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    return row ? channelToDTO(row) : null;
  }

  getRaw(id: number): ChannelRow | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    return row ?? null;
  }

  create(input: ChannelInput): ChannelDTO {
    const now = nowDb();
    const info = this.db
      .prepare(
        `INSERT INTO channels (name, provider_type, base_url, api_key, extra_config, enabled, rpm_limit, retry_count, disabled_until, created_at, updated_at)
         VALUES (@name, @provider_type, @base_url, @api_key, @extra_config, @enabled, @rpm_limit, @retry_count, NULL, @now, @now)`,
      )
      .run({
        name: input.name ?? '',
        provider_type: input.provider_type ?? 'custom',
        base_url: input.base_url ?? '',
        api_key: input.api_key ?? '',
        extra_config: input.extra_config ?? '{}',
        enabled: input.enabled === false ? 0 : 1,
        rpm_limit: input.rpm_limit ?? 60,
        retry_count: input.retry_count ?? 2,
        now,
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, input: ChannelInput): ChannelDTO | null {
    const existing = this.getRaw(id);
    if (!existing) return null;
    const now = nowDb();
    this.db
      .prepare(
        `UPDATE channels SET name=@name, provider_type=@provider_type, base_url=@base_url, api_key=@api_key,
           extra_config=@extra_config, enabled=@enabled, rpm_limit=@rpm_limit, retry_count=@retry_count, updated_at=@now
         WHERE id=@id`,
      )
      .run({
        id,
        name: input.name ?? existing.name,
        provider_type: input.provider_type ?? existing.provider_type,
        base_url: input.base_url ?? existing.base_url,
        api_key: input.api_key ?? existing.api_key,
        extra_config: input.extra_config ?? existing.extra_config,
        enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        rpm_limit: input.rpm_limit ?? existing.rpm_limit,
        retry_count: input.retry_count ?? existing.retry_count,
        now,
      });
    return this.get(id);
  }

  /** 删除渠道并级联删除其模型（事务） */
  remove(id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM models WHERE channel_id = ?').run(id);
      this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    });
    tx();
  }

  toggle(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE channels SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowDb(), id);
  }

  setDisabledUntil(id: number, dbTime: string | null): void {
    this.db.prepare('UPDATE channels SET disabled_until = ? WHERE id = ?').run(dbTime, id);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM channels').get() as { c: number }).c;
  }
}
