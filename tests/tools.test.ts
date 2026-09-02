// Anthropic / Claude Code tools 边界 + Responses API tools 兼容测试（纯协议层，无网络）
import { describe, it, expect } from 'vitest';
import {
  anthropicToOpenAI,
  openaiToAnthropic,
  AnthropicSseConverter,
  responsesToOpenAI,
  openaiToResponses,
  ResponsesSseConverter,
} from '../server/gateway/protocol-in.js';

type AnyObj = Record<string, unknown>;

function parse(s: string): AnyObj {
  return JSON.parse(s) as AnyObj;
}

// ===================== Anthropic 工具边界 =====================

describe('Anthropic / Claude Code tools 边界', () => {
  it('assistant 同时返回 text + 多个 tool_use：非流式转 OpenAI 保留文本与全部 tool_calls（id/name/arguments）', () => {
    const anthropic = JSON.stringify({
      model: 'claude-3',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我查一下' },
            { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Beijing' } },
            { type: 'tool_use', id: 'toolu_02', name: 'get_time', input: { tz: 'Asia/Shanghai' } },
          ],
        },
      ],
    });
    const r = parse(anthropicToOpenAI(anthropic).openaiBody);
    const msg = (r.messages as AnyObj[])[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('让我查一下');
    const tcs = msg.tool_calls as AnyObj[];
    expect(tcs).toHaveLength(2);
    expect(tcs[0]).toMatchObject({ id: 'toolu_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } });
    expect(tcs[1]).toMatchObject({ id: 'toolu_02', type: 'function', function: { name: 'get_time' } });
    expect(JSON.parse(String((tcs[1].function as AnyObj).arguments))).toEqual({ tz: 'Asia/Shanghai' });
  });

  it('tool_result.content 为字符串：转为 OpenAI tool 消息，tool_use_id 保留', () => {
    const anthropic = JSON.stringify({
      model: 'claude-3',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'sunny 26c' }],
        },
      ],
    });
    const r = parse(anthropicToOpenAI(anthropic).openaiBody);
    const msg = (r.messages as AnyObj[])[0];
    expect(msg.role).toBe('tool');
    expect(msg.tool_call_id).toBe('toolu_01');
    expect(msg.content).toBe('sunny 26c');
  });

  it('tool_result.content 为 content block 数组：拼接文本不丢', () => {
    const anthropic = JSON.stringify({
      model: 'claude-3',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: [{ type: 'text', text: 'high 30' }, { type: 'text', text: 'low 18' }],
            },
          ],
        },
      ],
    });
    const r = parse(anthropicToOpenAI(anthropic).openaiBody);
    const msg = (r.messages as AnyObj[])[0];
    expect(msg.role).toBe('tool');
    expect(msg.content).toBe('high 30\nlow 18');
  });

  it('tool_result.is_error = true：仍完整转换（不丢 tool_use_id 与错误文本）', () => {
    const anthropic = JSON.stringify({
      model: 'claude-3',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_09', is_error: true, content: 'API timeout' }],
        },
      ],
    });
    const r = parse(anthropicToOpenAI(anthropic).openaiBody);
    const msg = (r.messages as AnyObj[])[0];
    expect(msg.role).toBe('tool');
    expect(msg.tool_call_id).toBe('toolu_09');
    expect(msg.content).toContain('API timeout');
  });

  it('tool_choice：auto / any / 指定 tool 映射为 OpenAI 形式', () => {
    const auto = parse(anthropicToOpenAI(JSON.stringify({ model: 'm', messages: [], tool_choice: { type: 'auto' } })).openaiBody);
    expect(auto.tool_choice).toBe('auto');
    const any = parse(anthropicToOpenAI(JSON.stringify({ model: 'm', messages: [], tool_choice: { type: 'any' } })).openaiBody);
    expect(any.tool_choice).toBe('required');
    const named = parse(anthropicToOpenAI(JSON.stringify({ model: 'm', messages: [], tool_choice: { type: 'tool', name: 'get_weather' } })).openaiBody);
    expect(named.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('多轮工具循环：tool_use → tool_result → assistant 再次 tool_use，逐轮往返不丢 id/name/arguments/stop_reason', () => {
    const anthropic = JSON.stringify({
      model: 'claude-3',
      messages: [
        { role: 'user', content: '北京天气？' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Beijing' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'get_humidity', input: { city: 'Beijing' } }] },
      ],
    });
    const r = parse(anthropicToOpenAI(anthropic).openaiBody);
    const msgs = r.messages as AnyObj[];
    expect(msgs).toHaveLength(4);
    expect(msgs[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'toolu_1', function: { name: 'get_weather' } }] });
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 'toolu_1', content: 'sunny' });
    expect(msgs[3]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'toolu_2', function: { name: 'get_humidity' } }] });

    // 反向：OpenAI tool_calls 响应 → Anthropic tool_use block（id/name/input + stop_reason）
    const openaiResp = JSON.stringify({
      id: 'chatcmpl-1',
      model: 'claude-3',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const anth = parse(openaiToAnthropic(openaiResp, 'claude-3'));
    expect(anth.stop_reason).toBe('tool_use');
    const content = anth.content as AnyObj[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather' });
    expect(content[0].input).toEqual({ city: 'Beijing' });
  });

  it('流式：一次返回多个 tool_calls，arguments 拆多个 delta，首包为空不产生事件，全部 block 正常关闭', () => {
    const c = new AnthropicSseConverter();
    const out =
      c.feed(JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] })) +
      c.feed(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] })) +
      c.feed(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Beijing"}' } }] } }] })) +
      c.feed(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] })) +
      c.feed('[DONE]') +
      c.end();
    // 首包空 arguments 不产生 input_json_delta（不崩），后续分片产生 delta
    expect(out).not.toContain('"partial_json":""');
    expect(out).toContain('"partial_json":"{\\"city\\":');
    expect(out).toContain('"partial_json":"\\"Beijing\\"}"');
    // 两个 tool block 各一次 start 与 stop
    expect(out.match(/event: content_block_start/g)?.length ?? 0).toBe(2);
    expect(out.match(/event: content_block_stop/g)?.length ?? 0).toBe(2);
    // tool_use block 的 id / name / index 保留
    expect(out).toContain('"id":"call_a"');
    expect(out).toContain('"name":"get_weather"');
    expect(out).toContain('"name":"get_time"');
    expect(out).toContain('"type":"tool_use"');
  });

  it('流式：文本与多个 tool_use 混合，text 块在 tool 块之前正确开关', () => {
    const c = new AnthropicSseConverter();
    const out =
      c.feed(JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { content: '准备调用' } }] })) +
      c.feed(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f1', arguments: '{}' } }] } }] })) +
      c.feed(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'f2', arguments: '{}' } }] } }] })) +
      c.end();
    expect(out).toContain('"type":"text_delta"');
    expect(out.match(/event: content_block_start/g)?.length ?? 0).toBe(3); // text + 2 tool
    expect(out.match(/event: content_block_stop/g)?.length ?? 0).toBe(3);
    expect(out).toContain('"id":"c1"');
    expect(out).toContain('"id":"c2"');
  });
});

// ===================== Responses API tools =====================

describe('Responses API tools 兼容', () => {
  it('responsesToOpenAI：tools + tool_choice + function_call + function_call_output + 多 tool call 全部保留', () => {
    const body = JSON.stringify({
      model: 'gpt-5',
      instructions: 'you are helpful',
      tools: [
        { type: 'function', name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
        { type: 'function', name: 'get_time', parameters: { type: 'object' } },
      ],
      tool_choice: { type: 'function', name: 'get_weather' },
      input: [
        { role: 'user', content: '北京天气' },
        { type: 'function_call', call_id: 'fc_1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
        { type: 'function_call', call_id: 'fc_2', name: 'get_time', arguments: '{}' },
        { type: 'function_call_output', call_id: 'fc_1', output: 'sunny' },
        { type: 'function_call_output', call_id: 'fc_2', output: '10:00' },
      ],
    });
    const r = parse(responsesToOpenAI(body).openaiBody);
    expect((r.tools as AnyObj[])).toHaveLength(2);
    expect((r.tools as AnyObj[])[0]).toMatchObject({ type: 'function', function: { name: 'get_weather' } });
    expect(r.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    const msgs = r.messages as AnyObj[];
    // 顺序：system, user, assistant(fc_1), assistant(fc_2), tool(fc_1), tool(fc_2)
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'fc_1', function: { name: 'get_weather' } }] });
    expect(msgs[3]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'fc_2', function: { name: 'get_time' } }] });
    expect(msgs[4]).toMatchObject({ role: 'tool', tool_call_id: 'fc_1', content: 'sunny' });
    expect(msgs[5]).toMatchObject({ role: 'tool', tool_call_id: 'fc_2', content: '10:00' });
  });

  it('responsesToOpenAI：tool_choice 字符串 auto / required / none 与函数对象形式', () => {
    for (const tc of ['auto', 'required', 'none']) {
      const r = parse(responsesToOpenAI(JSON.stringify({ model: 'm', input: 'hi', tool_choice: tc })).openaiBody);
      expect(r.tool_choice).toBe(tc);
    }
  });

  it('openaiToResponses：tool_calls → function_call 输出项（id/call_id/name/arguments 保留），文本与函数并存', () => {
    const openai = JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '马上查',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
              { id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const r = parse(openaiToResponses(openai, 'gpt-5'));
    const output = r.output as AnyObj[];
    expect(output[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: '马上查' }] });
    expect(output[1]).toMatchObject({ type: 'function_call', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Beijing"}' });
    expect(output[2]).toMatchObject({ type: 'function_call', call_id: 'call_b', name: 'get_time' });
  });

  it('Responses 流式：tool_calls → response.output_item.added(function_call) + function_call_arguments.delta', () => {
    const c = new ResponsesSseConverter();
    const out =
      c.feed(JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fc_s', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] })) +
      c.feed(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Beijing"}' } }] } }] })) +
      c.end({ input: 1, output: 2, total: 3 });
    expect(out).toContain('"type":"function_call"');
    expect(out).toContain('"name":"get_weather"');
    expect(out).toContain('response.function_call_arguments.delta');
    expect(out).toContain('"delta":"{\\"city\\":\\"Beijing\\"}"');
    expect(out).toContain('response.completed');
  });
});
