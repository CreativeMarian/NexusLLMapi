import type { Database } from 'better-sqlite3';

export class SettingRepository {
  constructor(private db: Database) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** 删除一个 key（MCP/Prompt 删除时 value 置空不如物理删除） */
  remove(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  all(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  /** 按前缀列出 key/value */
  byPrefix(prefix: string): Array<{ key: string; value: string }> {
    return this.db
      .prepare('SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key ASC')
      .all(`${prefix}%`) as Array<{ key: string; value: string }>;
  }
}
