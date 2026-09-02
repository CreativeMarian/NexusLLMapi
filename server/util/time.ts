// 时间工具：兼容旧 Go 后端写入 SQLite 的 "2026-08-23 20:14:59.254+08:00" 格式

/** 当前本地时间，格式化为 SQLite DATETIME（与 Go time.Time 驱动写入风格一致） */
export function nowDb(): string {
  return formatDb(new Date());
}

export function formatDb(d: Date): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${tz}`
  );
}

/** 仅日期 YYYY-MM-DD（本地） */
export function todayDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 月份 YYYY-MM */
export function monthKey(d = new Date()): string {
  return todayDate(d).slice(0, 7);
}

/** DB 时间字符串 -> ISO（RFC3339，前端/JSON 用）；无法解析则原样返回 */
export function toIso(dbTime: string | null | undefined): string {
  if (!dbTime) return '';
  // 已经是 ISO（含 T）直接返回
  if (dbTime.includes('T')) return dbTime;
  // "YYYY-MM-DD HH:MM:SS.xxx+08:00" -> "YYYY-MM-DDTHH:MM:SS.xxx+08:00"
  return dbTime.replace(' ', 'T');
}

/** 前 n 天的日期键数组（含今天，升序） */
export function lastNDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(todayDate(d));
  }
  return out;
}
