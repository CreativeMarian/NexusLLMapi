import type { FastifyReply } from 'fastify';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 校验路径 ID 为合法正整数 */
export function parseId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '非法 ID');
  return n;
}

/** 解析分页参数，强制边界 */
export function parsePaging(query: Record<string, unknown>): { page: number; pageSize: number } {
  let page = Number(query.page ?? 1);
  let pageSize = Number(query.page_size ?? 50);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 50;
  if (pageSize > 500) pageSize = 500;
  return { page, pageSize };
}

export function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}
