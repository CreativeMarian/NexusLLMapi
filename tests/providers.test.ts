import { describe, it, expect, afterEach } from 'vitest';
import {
  buildHeaders,
  getSpec,
  modelsEndpoint,
  parseExtra,
  parseModelList,
  resolveBaseURL,
  transformRequestBody,
} from '../server/providers/registry.js';
import { makeCtx, startMockUpstream, seedChannel, seedModel, makeApp, cleanup, tempBase } from './helpers.js';
import { ProviderService } from '../server/providers/service.js';

describe('Provider 适配器：URL / 认证 / 模型端点', () => {
  it('resolveBaseURL：套用 extra 模板变量', () => {
    expect(resolveBaseURL('https://a.com/{region}/v1', { region: 'cn' })).toBe('https://a.com/cn/v1');
    expect(resolveBaseURL('https://a.com/v1/', {})).toBe('https://a.com/v1');
  });

  it('extra_config 解析为键值表', () => {
    expect(parseExtra('{"a":"1","b":2}')).toEqual({ a: '1', b: '2' });
    expect(parseExtra('not-json')).toEqual({});
    expect(parseExtra(null)).toEqual({});
  });

  it('getSpec：未知厂商回退 OpenAI 兼容（bearer-required）', () => {
    expect(getSpec('openai').auth).toBe('bearer-required');
    expect(getSpec('custom').auth).toBe('bearer-required');
    expect(getSpec('nonexistent-vendor').auth).toBe('bearer-required');
  });

  it('buildHeaders：标准 OpenAI 兼容 → Authorization Bearer', () => {
    const h = buildHeaders('custom', 'sk-abc', {});
    expect(h.Authorization).toBe('Bearer sk-abc');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('buildHeaders：azure → api-key 头（不用 Bearer）', () => {
    const h = buildHeaders('azure', 'KEY123', {});
    expect(h['api-key']).toBe('KEY123');
    expect(h.Authorization).toBeUndefined();
  });

  it('buildHeaders：gemini → x-goog-api-key', () => {
    const h = buildHeaders('gemini', 'GKEY', {});
    expect(h['x-goog-api-key']).toBe('GKEY');
  });

  it('buildHeaders：openrouter → HTTP-Referer + X-Title', () => {
    const h = buildHeaders('openrouter', 'sk-or-1', {});
    expect(h['HTTP-Referer']).toContain('github');
    expect(h['X-Title']).toBe('NexusLLMapi');
  });

  it('buildHeaders：免 Key 厂商（pollinations/ollama）空 Key 不附加 Authorization', () => {
    expect(buildHeaders('pollinations', '', {}).Authorization).toBeUndefined();
    expect(buildHeaders('ollama', '', {}).Authorization).toBeUndefined();
    // 有 Key 则仍带
    expect(buildHeaders('ollama', 'k', {}).Authorization).toBe('Bearer k');
  });

  it('extraHeaders 支持 {api_key} 模板', () => {
    // azure api-key 走模板
    const h = buildHeaders('azure', 'XYZ', {});
    expect(h['api-key']).toBe('XYZ');
  });

  it('modelsEndpoint：兼容 base_url 已含 /models', () => {
    expect(modelsEndpoint('https://a.com/v1')).toBe('https://a.com/v1/models');
    expect(modelsEndpoint('https://a.com/v1/models')).toBe('https://a.com/v1/models');
  });

  it('parseModelList：OpenAI 形态', () => {
    const list = parseModelList('custom', { data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1' }] });
    expect(list.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-image-1']);
    expect(list.find((m) => m.id === 'gpt-image-1')?.modal_type).toBe('image');
  });

  it('parseModelList：Cloudflare 形态 result[].name + 排除 embedding', () => {
    const list = parseModelList('cloudflare', {
      result: [
        { name: '@cf/meta/llama-3-8b-instruct' },
        { name: '@cf/baai/text-embedding-3-small' },
        { name: 'non-matching' },
      ],
    });
    const ids = list.map((m) => m.id);
    expect(ids).toContain('@cf/meta/llama-3-8b-instruct');
    expect(ids).not.toContain('@cf/baai/text-embedding-3-small'); // embedding 被排除
  });

  it('transformRequestBody：Cloudflare 补 @cf/ 前缀', () => {
    const body = JSON.stringify({ model: 'meta/llama-3-8b-instruct', messages: [] });
    const out = JSON.parse(transformRequestBody('cloudflare', body, 'x'));
    expect(out.model).toBe('@cf/meta/llama-3-8b-instruct');
    // 已带前缀不再重复
    const body2 = JSON.stringify({ model: '@cf/a/b', messages: [] });
    expect(JSON.parse(transformRequestBody('cloudflare', body2, 'x')).model).toBe('@cf/a/b');
  });

  it('cloudflare 的模型列表会套用 account_id 模板（URL 层面）', () => {
    const url = resolveBaseURL('https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', { account_id: 'acc123' });
    expect(url).toContain('/accounts/acc123/ai/v1');
  });
});

describe('ProviderService 通过真实 Transport 与 mock 上游联调', () => {
  const mocks: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const m of mocks.splice(0)) await m.close();
  });

  it('testChannel：openai 渠道 → 上游收到 GET /v1/models 与 Bearer 认证', async () => {
    const mock = await startMockUpstream();
    mocks.push(mock);
    const b = makeCtx(tempBase());
    try {
      seedChannel(b.ctx, { name: 'c', provider_type: 'openai', base_url: mock.base, api_key: 'sk-secret-123' });
      const svc = new ProviderService(b.ctx);
      const r = await svc.testChannel(1);
      expect(r.success).toBe(true);
      const req = mock.requests.find((x) => x.method === 'GET' && x.url.endsWith('/models'));
      expect(req).toBeTruthy();
      expect(req!.headers.authorization).toBe('Bearer sk-secret-123');
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('testChannel：azure 渠道 → 上游收到 api-key 头且无 Bearer', async () => {
    const mock = await startMockUpstream();
    mocks.push(mock);
    const b = makeCtx(tempBase());
    try {
      seedChannel(b.ctx, { name: 'az', provider_type: 'azure', base_url: mock.base, api_key: 'AZKEY' });
      const svc = new ProviderService(b.ctx);
      await svc.testChannel(1);
      const req = mock.requests.find((x) => x.method === 'GET' && x.url.endsWith('/models'));
      expect(req?.headers['api-key']).toBe('AZKEY');
      expect(req?.headers.authorization).toBeUndefined();
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('syncChannel：拉取模型并保留 alias/enabled（不覆盖用户配置）', async () => {
    const mock = await startMockUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm-alpha' }, { id: 'm-beta' }] }));
    });
    mocks.push(mock);
    const b = makeCtx(tempBase());
    try {
      const ch = seedChannel(b.ctx, { name: 'sync', provider_type: 'custom', base_url: mock.base });
      // 预置一个 alias 与 enabled=false 的模型
      seedModel(b.ctx, ch.id, 'm-alpha', { alias: 'my-alias', enabled: false });
      const svc = new ProviderService(b.ctx);
      const r = await svc.syncChannel(ch.id);
      expect(r.total).toBe(2);
      expect(r.added).toBe(1);
      expect(r.updated).toBe(1);
      const alpha = b.ctx.repos.models.listByChannel(ch.id).find((m) => m.model_id === 'm-alpha')!;
      expect(alpha.alias).toBe('my-alias'); // 用户 alias 不丢失
      expect(alpha.enabled).toBe(false); // 用户 enabled 不丢失
      expect(alpha.available).toBe(true);
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('testChannel 失败时返回 success=false 与错误信息', async () => {
    const mock = await startMockUpstream((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    mocks.push(mock);
    const b = makeCtx(tempBase());
    try {
      seedChannel(b.ctx, { name: 'bad', provider_type: 'custom', base_url: mock.base });
      const svc = new ProviderService(b.ctx);
      const r = await svc.testChannel(1);
      expect(r.success).toBe(false);
      expect(r.message).toContain('500');
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });

  it('网关真实聊天：mock 上游收到的请求体与返回一致（非流式）', async () => {
    const mock = await startMockUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x1',
          object: 'chat.completion',
          created: 1,
          model: 'm1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
    mocks.push(mock);
    const b = makeCtx(tempBase());
    try {
      seedChannel(b.ctx, { name: 'gw', provider_type: 'custom', base_url: mock.base, api_key: 'sk-gw' });
      seedModel(b.ctx, 1, 'm1');
      const app = await makeApp(b);
      const res = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'm1', messages: [{ role: 'user', content: 'ping' }], stream: false },
        headers: { 'x-client-id': 'provider-e2e-1' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.choices[0].message.content).toBe('pong');
      expect(res.headers['x-routed-via']).toBe('gw/m1');
      const body = lastChatBodyLocal(mock);
      expect(body.model).toBe('m1');
      expect(body.messages[0].content).toBe('ping');
      await app.app.close();
    } finally {
      b.db.close();
      cleanup(b.baseDir);
    }
  });
});

function lastChatBodyLocal(mock: { requests: Array<{ method: string; url: string; body: string }> }): { model: string; messages: Array<{ content: string }>; stream?: boolean } {
  const req = [...mock.requests].reverse().find((r) => r.method === 'POST' && /chat\/completions/.test(r.url));
  const j = JSON.parse(req?.body ?? '{}');
  return { model: j.model ?? '', messages: j.messages ?? [], stream: j.stream };
}
