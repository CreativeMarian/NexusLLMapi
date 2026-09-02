import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, makeApp, cleanup, tempBase, type CtxBundle, type AppBundle } from './helpers.js';

/**
 * SPA 回退回归测试：
 * Vue Router 为 history 模式，直接访问/刷新 /logs /channels /models /settings /guide
 * 等子路由时，服务端必须回退到 index.html 渲染前端 UI，而不是返回 404。
 * 同时 API（/api /v1 /p /health）与缺失的真实静态资源仍保持 404。
 */
const bundles: CtxBundle[] = [];
const apps: AppBundle[] = [];

function freshCtxWithDist(): CtxBundle {
  const baseDir = tempBase();
  const distDir = join(baseDir, 'web', 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, 'index.html'),
    '<!DOCTYPE html><html><head><title>SPA-TEST</title></head><body><div id="app">spa-marker</div></body></html>',
    'utf-8',
  );
  // 放一个真实静态资源，验证它能被正常服务
  writeFileSync(join(distDir, 'asset.js'), 'console.log("asset");', 'utf-8');
  const b = makeCtx(baseDir);
  bundles.push(b);
  return b;
}

afterEach(async () => {
  for (const a of apps.splice(0)) {
    try {
      await a.app.close();
    } catch {
      /* ignore */
    }
  }
  while (bundles.length) {
    const b = bundles.pop()!;
    try {
      b.db.close();
    } catch {
      /* ignore */
    }
    cleanup(b.baseDir);
  }
});

describe('SPA 回退：前端 history 路由刷新/直接访问', () => {
  it('GET /logs /channels /models /settings /guide → 200 返回 index.html', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    for (const route of ['/logs', '/channels', '/models', '/settings', '/guide']) {
      const res = await a.app.inject({ method: 'GET', url: route });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('spa-marker');
    }
  });

  it('GET / → 200 index.html（fastifyStatic 默认 index）', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('spa-marker');
  });

  it('带查询串的子路由仍回退 index.html', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'GET', url: '/logs?page=2&status=success' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-marker');
  });

  it('真实静态资源正常服务（不落入回退）', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'GET', url: '/asset.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain('console.log');
  });

  it('缺失的静态资源（带扩展名）→ 404，不回退 index.html', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'GET', url: '/assets/not-exist.js' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('spa-marker');
  });

  it('API 未匹配路径 /api/xxx → 404 JSON（不影响回退）', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().message).toContain('not found');
  });

  it('网关未匹配路径 /v1/xxx 与 /p/xxx → 404 JSON', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    for (const route of ['/v1/nonexistent', '/p/xx/models']) {
      const res = await a.app.inject({ method: 'GET', url: route });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  it('健康检查未匹配路径 /health/xxx → 404 JSON', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'GET', url: '/health/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('非 GET 方法（如 POST /logs）→ 404，不回退 index.html', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'POST', url: '/logs', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('spa-marker');
  });

  it('API 真实路由不受影响：GET /api/channels → 200 JSON', async () => {
    const b = freshCtxWithDist();
    const a = await makeApp(b);
    apps.push(a);
    const res = await a.app.inject({ method: 'GET', url: '/api/channels' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().data).toBeInstanceOf(Array);
  });
});
