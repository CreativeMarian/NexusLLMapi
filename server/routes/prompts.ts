import type { FastifyInstance } from 'fastify';
import type { RuntimeContext } from '../context.js';
import { parseId } from './helpers.js';

interface Prompt {
  id: number;
  name: string;
  description: string;
  content: string;
  category: string;
  tags: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const PREFIX = 'prompt_';

export function registerPromptRoutes(app: FastifyInstance, ctx: RuntimeContext) {
  const s = ctx.repos.settings;

  const listAll = (): Prompt[] =>
    s.byPrefix(PREFIX)
      .map((r) => safeParse(r.value))
      .filter((x): x is Prompt => !!x)
      .sort((a, b) => a.id - b.id);

  app.get('/api/prompts/active', async () => {
    const found = listAll().find((p) => p.active);
    return { data: found ?? null };
  });

  app.get('/api/prompts', async (req) => {
    const category = String((req.query as { category?: string }).category ?? '');
    let list = listAll();
    if (category) list = list.filter((p) => p.category === category);
    return { data: list, total: list.length };
  });

  app.get('/api/prompts/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const raw = s.get(PREFIX + id);
    if (!raw) return reply.code(404).send({ error: '提示词不存在' });
    return { data: safeParse(raw) };
  });

  app.post('/api/prompts', async (req) => {
    const body = (req.body ?? {}) as Partial<Prompt>;
    const now = new Date().toISOString();
    const p: Prompt = {
      id: Date.now() % 100000,
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
      content: String(body.content ?? ''),
      category: String(body.category ?? 'custom'),
      tags: String(body.tags ?? ''),
      active: false,
      created_at: now,
      updated_at: now,
    };
    s.set(PREFIX + p.id, JSON.stringify(p));
    return { message: '创建成功', data: p };
  });

  app.put('/api/prompts/:id', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const raw = s.get(PREFIX + id);
    if (!raw) return reply.code(404).send({ error: '提示词不存在' });
    const existing = safeParse(raw)!;
    const body = (req.body ?? {}) as Partial<Prompt>;
    const p: Prompt = { ...existing, ...body, id, updated_at: new Date().toISOString() };
    s.set(PREFIX + id, JSON.stringify(p));
    return { message: '更新成功', data: p };
  });

  app.delete('/api/prompts/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    s.remove(PREFIX + id);
    return { message: '删除成功' };
  });

  app.post('/api/prompts/:id/activate', async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    const raw = s.get(PREFIX + id);
    if (!raw) return reply.code(404).send({ error: '提示词不存在' });
    // 先取消其它激活
    for (const p of listAll()) {
      if (p.active) {
        p.active = false;
        s.set(PREFIX + p.id, JSON.stringify(p));
      }
    }
    const target = safeParse(raw)!;
    target.active = true;
    target.updated_at = new Date().toISOString();
    s.set(PREFIX + id, JSON.stringify(target));
    return { message: '激活成功', data: target };
  });
}

function safeParse(raw: string): Prompt | null {
  try {
    return JSON.parse(raw) as Prompt;
  } catch {
    return null;
  }
}
