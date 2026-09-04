import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';
import { parseId } from './helpers.js';

interface McpServer {
  id: number;
  name: string;
  description: string;
  type: string;
  command: string;
  args: string;
  env: string;
  url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const PREFIX = 'mcp_server_';

export function registerMcpRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  const s = ctx.repos.settings;

  const listAll = (): McpServer[] =>
    s.byPrefix(PREFIX)
      .map((r) => safeParse(r.value))
      .filter((x): x is McpServer => !!x)
      .sort((a, b) => a.id - b.id);

  app.get('/api/mcp', async () => {
    const list = listAll();
    return { data: list, total: list.length };
  });

  app.get('/api/mcp/export', async () => {
    const result: Record<string, unknown> = {};
    for (const srv of listAll()) {
      if (!srv.enabled) continue;
      const cfg: Record<string, unknown> = {};
      if (srv.type === 'stdio') {
        cfg.command = srv.command;
        if (srv.args) {
          try {
            cfg.args = JSON.parse(srv.args);
          } catch {
            cfg.args = srv.args;
          }
        }
        if (srv.env) {
          try {
            cfg.env = JSON.parse(srv.env);
          } catch {
            /* ignore */
          }
        }
      } else {
        cfg.url = srv.url;
      }
      // 重名服务器导出时追加序号，避免后者覆盖前者
      let key = srv.name || `server-${srv.id}`;
      let n = 2;
      while (key in result) key = `${srv.name}-${n++}`;
      result[key] = cfg;
    }
    return { mcpServers: result };
  });

  app.get('/api/mcp/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const raw = s.get(PREFIX + id);
    if (!raw) return reply.code(404).send({ error: 'MCP 服务器不存在' });
    return { data: safeParse(raw) };
  });

  app.post('/api/mcp', async (req) => {
    const body = (req.body ?? {}) as Partial<McpServer>;
    const now = new Date().toISOString();
    // 生成唯一 id：毫秒时间戳放大 + 随机后缀，并确认不与现有记录冲突
    let id = nextUniqueId((key) => s.get(key) !== undefined);
    const srv: McpServer = {
      id,
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
      type: String(body.type ?? 'stdio'),
      command: String(body.command ?? ''),
      args: String(body.args ?? ''),
      env: String(body.env ?? ''),
      url: String(body.url ?? ''),
      enabled: body.enabled ?? true,
      created_at: now,
      updated_at: now,
    };
    s.set(PREFIX + srv.id, JSON.stringify(srv));
    return { message: '创建成功', data: srv };
  });

  app.put('/api/mcp/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const raw = s.get(PREFIX + id);
    if (!raw) return reply.code(404).send({ error: 'MCP 服务器不存在' });
    const existing = safeParse(raw);
    const body = (req.body ?? {}) as Partial<McpServer>;
    const srv: McpServer = { ...(existing ?? {}), ...body, id, updated_at: new Date().toISOString() } as McpServer;
    s.set(PREFIX + id, JSON.stringify(srv));
    return { message: '更新成功', data: srv };
  });

  app.delete('/api/mcp/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    s.remove(PREFIX + id);
    return { message: '删除成功' };
  });

  app.post('/api/mcp/:id/toggle', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const raw = s.get(PREFIX + id);
    if (!raw) return reply.code(404).send({ error: 'MCP 服务器不存在' });
    const srv = safeParse(raw)!;
    // 布尔严格解析（避免空 body / "false" 字符串误判）
    const rawEnabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    srv.enabled =
      typeof rawEnabled === 'boolean'
        ? rawEnabled
        : rawEnabled === 'true' || rawEnabled === '1'
          ? true
          : rawEnabled === 'false' || rawEnabled === '0'
            ? false
            : !srv.enabled;
    srv.updated_at = new Date().toISOString();
    s.set(PREFIX + id, JSON.stringify(srv));
    return { message: '切换成功', data: srv };
  });
}

/** 生成不与现有键冲突的唯一数字 id（毫秒时间戳放大 + 随机后缀） */
function nextUniqueId(exists: (key: string) => boolean): number {
  for (let i = 0; i < 100; i++) {
    const candidate = Date.now() * 100 + Math.floor(Math.random() * 100);
    if (!exists(PREFIX + candidate)) return candidate;
  }
  return Date.now() * 100 + Math.floor(Math.random() * 100);
}

function safeParse(raw: string): McpServer | null {
  try {
    return JSON.parse(raw) as McpServer;
  } catch {
    return null;
  }
}
