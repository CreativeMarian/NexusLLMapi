import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCtx,
  makeApp,
  tempBase,
  cleanup,
  seedChannel,
  seedModel,
  startMockUpstream,
  type MockUpstream,
} from './helpers.js';
import { ConfigManager } from '../server/config/manager.js';
import { logger } from '../server/util/logger.js';
import { Gateway } from '../server/gateway/gateway.js';
import { responsesToOpenAI, AnthropicSseConverter, ResponsesSseConverter } from '../server/gateway/protocol-in.js';

const cleanupDirs: string[] = [];
const mocks: MockUpstream[] = [];

afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
  for (const d of cleanupDirs.splice(0)) cleanup(d);
});

describe('回归：模型列表不再截断 500 条', () => {
  it('listAll 返回全量模型且路由池可路由第 501 条', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = makeCtx(base);
    const ch = seedChannel(b.ctx, { name: 'bulk' });
    for (let i = 1; i <= 505; i++) seedModel(b.ctx, ch.id, `m-${String(i).padStart(4, '0')}`);
    expect(b.ctx.repos.models.listAll().length).toBe(505);
    // 路由池 rebuild 后，排序靠后的模型也能被路由到
    const gateway = new Gateway(b.ctx);
    const sel = await gateway.pool.selectExact('m-0501', [], true);
    expect(sel.realModel).toBe('m-0501');
    gateway.dispose();
    b.db.close();
  });
});

describe('回归：重新启用渠道清除持久化熔断', () => {
  it('toggle(true) 与 update({enabled:true}) 都会清空 disabled_until', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = makeCtx(base);
    const ch = seedChannel(b.ctx, { name: 'cool' });
    b.ctx.repos.channels.setDisabledUntil(ch.id, '2030-01-01T00:00:00.000Z');
    b.ctx.repos.channels.toggle(ch.id, false);
    expect(b.ctx.repos.channels.get(ch.id)!.disabled_until).toBe('2030-01-01T00:00:00.000Z');
    // 重新启用 → disabled_until 清空
    b.ctx.repos.channels.toggle(ch.id, true);
    expect(b.ctx.repos.channels.get(ch.id)!.disabled_until).toBeUndefined();
    // 再次熔断后走 update 启用路径
    b.ctx.repos.channels.setDisabledUntil(ch.id, '2030-01-01T00:00:00.000Z');
    b.ctx.repos.channels.update(ch.id, { enabled: true });
    expect(b.ctx.repos.channels.get(ch.id)!.disabled_until).toBeUndefined();
    b.db.close();
  });
});

describe('回归：Responses 协议转换不泄漏 max_output_tokens', () => {
  it('responsesToOpenAI 映射 max_tokens 并移除 max_output_tokens', () => {
    const out = responsesToOpenAI(
      JSON.stringify({ model: 'gpt-4o', input: 'hi', max_output_tokens: 256 }),
    );
    const body = JSON.parse(out.openaiBody) as Record<string, unknown>;
    expect(body.max_tokens).toBe(256);
    expect(body.max_output_tokens).toBeUndefined();
  });
});

describe('回归：并行工具调用的 SSE 协议转换', () => {
  it('AnthropicSseConverter：上一个 tool 块在新块打开前先 stop，且 end 不重复 stop', () => {
    const conv = new AnthropicSseConverter();
    const out1 = conv.feed(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'fa', arguments: '{"x"' } }] } }] }),
    );
    conv.feed(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }),
    );
    const out3 = conv.feed(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'fb', arguments: '{}' } }] } }] }),
    );
    const end = conv.end();
    const all = out1 + out3 + end;
    // call_a 的 content_block_stop 出现在其块之后；call_b 的块数据（"name":"fb"）出现在 call_a 的 stop 之后
    const stopA = all.indexOf('content_block_stop', all.indexOf('call_a'));
    const startB = all.indexOf('"name":"fb"');
    expect(stopA).toBeGreaterThan(-1);
    expect(startB).toBeGreaterThan(stopA);
    // 总共 2 次 stop 事件：call_a 与 call_b 各一次（end 不再重复关闭已关闭的块）
    expect((all.match(/event: content_block_stop/g) || []).length).toBe(2);
  });

  it('ResponsesSseConverter：多个 function_call 各自独立 item 且全部关闭', () => {
    const conv = new ResponsesSseConverter();
    const out1 = conv.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'fa', arguments: '{"x"' } }] } }] }));
    conv.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }));
    conv.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'fb', arguments: '{}' } }] } }] }));
    const end = conv.end({ input: 1, output: 2, total: 3 });
    const all = out1 + end;
    expect((all.match(/event: response\.output_item\.done/g) || []).length).toBe(3); // message + 2 function_call
    expect(end).toContain('call_a');
    expect(end).toContain('call_b');
    // message item 的 id 在 added 与 done 中一致
    const addedIdx = all.indexOf('"id":"msg_');
    const msgId = all.slice(addedIdx + 6, all.indexOf('"', addedIdx + 6));
    expect(end).toContain(msgId);
  });
});

describe('回归：CORS 不反射 null origin', () => {
  it('Origin: null 不返回 ACAO；本地 origin 正常返回', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = await makeApp(makeCtx(base));
    const nullRes = await b.app.inject({ method: 'GET', url: '/api/channels', headers: { origin: 'null' } });
    expect(nullRes.headers['access-control-allow-origin']).toBeUndefined();
    const localRes = await b.app.inject({ method: 'GET', url: '/api/channels', headers: { origin: 'http://localhost:5173' } });
    expect(localRes.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    b.db.close();
  });
});

describe('回归：二进制/multipart 请求体按原样透传', () => {
  it('POST /p/:id/upload 的 multipart body 不再被吞成 {}', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const mock = await startMockUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    mocks.push(mock);
    const b = await makeApp(makeCtx(base));
    const ch = seedChannel(b.ctx, { name: 'pt', provider_type: 'custom', base_url: mock.base });
    const raw = '--XX\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\n\x00\x01\x02raw\r\n--XX--\r\n';
    const res = await b.app.inject({
      method: 'POST',
      url: `/p/${ch.id}/upload`,
      headers: { 'content-type': 'multipart/form-data; boundary=XX' },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const req = mock.requests.find((r) => /\/upload$/.test(r.url));
    expect(req).toBeTruthy();
    expect(req!.body).toBe(raw);
    expect(String(req!.headers['content-type'])).toContain('multipart/form-data');
    expect(String(req!.headers['content-type'])).toContain('boundary=XX');
    b.db.close();
  });
});

describe('回归：MCP/Prompts 创建不再产生碰撞 ID', () => {
  it('连续创建两条 MCP 服务器得到不同 id 且互不覆盖', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = await makeApp(makeCtx(base));
    const r1 = await b.app.inject({ method: 'POST', url: '/api/mcp', payload: { name: 'a', type: 'stdio', command: 'x' } });
    const r2 = await b.app.inject({ method: 'POST', url: '/api/mcp', payload: { name: 'b', type: 'stdio', command: 'y' } });
    const id1 = (r1.json() as { data: { id: number } }).data.id;
    const id2 = (r2.json() as { data: { id: number } }).data.id;
    expect(id1).not.toBe(id2);
    const list = await b.app.inject({ method: 'GET', url: '/api/mcp' });
    expect((list.json() as { total: number }).total).toBe(2);
    b.db.close();
  });

  it('连续创建两条 Prompt 得到不同 id', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = await makeApp(makeCtx(base));
    const r1 = await b.app.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'p1', content: 'c1' } });
    const r2 = await b.app.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'p2', content: 'c2' } });
    expect((r1.json() as { data: { id: number } }).data.id).not.toBe((r2.json() as { data: { id: number } }).data.id);
    b.db.close();
  });
});

describe('回归：toggle 端点布尔解析', () => {
  it('空 body 翻转状态；表单编码 "false" 解析为禁用', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = await makeApp(makeCtx(base));
    const ch = seedChannel(b.ctx, { name: 'tg', enabled: true });
    // 表单编码 false → 禁用（旧实现 Boolean("false") === true 会误启用）
    await b.app.inject({
      method: 'POST',
      url: `/api/channels/${ch.id}/toggle`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'enabled=false',
    });
    expect(b.ctx.repos.channels.get(ch.id)!.enabled).toBe(false);
    // 空 body → 翻转为启用
    await b.app.inject({ method: 'POST', url: `/api/channels/${ch.id}/toggle` });
    expect(b.ctx.repos.channels.get(ch.id)!.enabled).toBe(true);
    b.db.close();
  });
});

describe('回归：端口设置持久化', () => {
  it('PUT /api/settings 保存 port 到 config.json（重启生效）', async () => {
    const base = tempBase();
    cleanupDirs.push(base);
    const b = await makeApp(makeCtx(base));
    const res = await b.app.inject({ method: 'PUT', url: '/api/settings', payload: { port: 9999, global_rpm: 500 } });
    expect(res.statusCode).toBe(200);
    const saved = JSON.parse(readFileSync(join(b.baseDir, 'data', 'config.json'), 'utf-8')) as { port: number; global_rpm: number };
    expect(saved.port).toBe(9999);
    expect(saved.global_rpm).toBe(500);
    b.db.close();
  });
});

describe('回归：配置加载对非法值做类型钳制', () => {
  it('config.json 中字符串/null 数值字段回退默认或收敛', () => {
    const base = tempBase();
    cleanupDirs.push(base);
    mkdirSync(join(base, 'data'), { recursive: true });
    writeFileSync(
      join(base, 'data', 'config.json'),
      JSON.stringify({ port: 'abc', global_rpm: null, default_retry: '5', request_timeout: 1 }),
      'utf-8',
    );
    const cfg = new ConfigManager(base);
    const snap = cfg.getSnapshot();
    expect(snap.port).toBe(8787);
    expect(snap.global_rpm).toBe(600);
    expect(snap.default_retry).toBe(5);
    expect(snap.request_timeout).toBe(5);
  });
});

describe('回归：日志滚动（复制+截断）', () => {
  it('超过大小上限后滚动出 server.log.1 且当前文件被截断', () => {
    const base = tempBase();
    cleanupDirs.push(base);
    logger.init(base, 'info');
    const chunk = 'x'.repeat(64 * 1024) + '\n';
    for (let i = 0; i < 170; i++) logger.info(chunk); // ~11MB
    const logPath = join(base, 'data', 'logs', 'server.log');
    const rotated = join(base, 'data', 'logs', 'server.log.1');
    expect(existsSync(rotated)).toBe(true);
    expect(statSync(logPath).size).toBeLessThan(10 * 1024 * 1024);
    expect(statSync(rotated).size).toBeGreaterThan(0);
  });
});
