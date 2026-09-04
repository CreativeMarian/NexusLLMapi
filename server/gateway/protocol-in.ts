// 入站协议适配：把 Anthropic Messages / OpenAI Responses 请求转为 OpenAI Chat，
// 并把上游 OpenAI（非流式/SSE）响应转回对应协议。覆盖文本对话主链路与 function calling / tool_use。

type AnyObj = Record<string, unknown>;

function safeParse(s: string): AnyObj {
  return JSON.parse(s) as AnyObj;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as AnyObj;
        if (block?.type === 'text') return String(block.text ?? '');
        if (typeof block === 'string') return block;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 把 Anthropic content blocks 拆成 [{type:'text'...}] 数组（兼容字符串输入） */
function blocks(content: unknown): AnyObj[] {
  if (Array.isArray(content)) return content as AnyObj[];
  if (content === undefined || content === null) return [];
  return [{ type: 'text', text: String(content) }];
}

/** Anthropic tools → OpenAI tools（input_schema → parameters） */
function anthropicToolsToOpenAI(tools: unknown): AnyObj[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: AnyObj[] = [];
  for (const t of tools as AnyObj[]) {
    if (!t || t.type === 'custom') continue; // custom 工具无法映射
    out.push({
      type: 'function',
      function: {
        name: String(t.name ?? ''),
        description: t.description !== undefined ? String(t.description) : undefined,
        parameters: (t.input_schema ?? {}) as AnyObj,
      },
    });
  }
  return out.length ? out : undefined;
}

/** Anthropic tool_choice → OpenAI tool_choice */
function anthropicToolChoiceToOpenAI(tc: unknown): unknown {
  if (tc === undefined || tc === null) return undefined;
  const t = tc as AnyObj;
  const type = String(t.type ?? 'auto');
  if (type === 'any') return 'required';
  if (type === 'tool') return { type: 'function', function: { name: String(t.name ?? '') } };
  return 'auto'; // auto / none
}

// ===================== Anthropic → OpenAI =====================

export interface InboundConvertResult {
  openaiBody: string;
  model: string;
  stream: boolean;
}

export function anthropicToOpenAI(bodyStr: string): InboundConvertResult {
  const a = safeParse(bodyStr);
  const model = String(a.model ?? '');
  const stream = a.stream === true;
  const messages: AnyObj[] = [];

  // 顶层 system：字符串或 content blocks 数组
  if (a.system) {
    const text = typeof a.system === 'string' ? a.system : blockText(a.system);
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const m of (a.messages ?? []) as AnyObj[]) {
    const role = String(m.role ?? 'user');
    const content = m.content;
    if (role === 'assistant') {
      // assistant：text + tool_use 拆分为 OpenAI tool_calls
      const bs = blocks(content);
      const textParts: string[] = [];
      const toolCalls: AnyObj[] = [];
      for (const b of bs) {
        if (b.type === 'text') textParts.push(String(b.text ?? ''));
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: String(b.id ?? `call_${randomId()}`),
            type: 'function',
            function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg: AnyObj = { role: 'assistant' };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      msg.content = textParts.length ? textParts.join('\n') : toolCalls.length ? null : '';
      messages.push(msg);
    } else if (role === 'user' && Array.isArray(content)) {
      // user：text 与 tool_result 拆分（tool_result → 独立的 tool 消息）
      let textBuf: string[] = [];
      for (const b of content as AnyObj[]) {
        if (b.type === 'text') {
          textBuf.push(String(b.text ?? ''));
        } else if (b.type === 'tool_result') {
          if (textBuf.length) {
            messages.push({ role: 'user', content: textBuf.join('\n') });
            textBuf = [];
          }
          const result = typeof b.content === 'string' ? b.content : blockText(b.content);
          messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content: result });
        }
      }
      if (textBuf.length) messages.push({ role: 'user', content: textBuf.join('\n') });
    } else {
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blockText(content) });
    }
  }

  const openai: AnyObj = {
    model,
    messages,
    stream,
  };
  copyIfPresent(a, openai, ['temperature', 'top_p', 'max_tokens', 'stop', 'stop_sequences']);
  if (openai.stop_sequences) {
    openai.stop = openai.stop_sequences;
    delete openai.stop_sequences;
  }
  // tools / tool_choice 三向转换：Anthropic schema → OpenAI schema
  const tools = anthropicToolsToOpenAI(a.tools);
  if (tools) openai.tools = tools;
  const toolChoice = anthropicToolChoiceToOpenAI(a.tool_choice);
  if (toolChoice !== undefined) openai.tool_choice = toolChoice;
  return { openaiBody: JSON.stringify(openai), model, stream };
}

function copyIfPresent(src: AnyObj, dst: AnyObj, keys: string[]) {
  for (const k of keys) if (src[k] !== undefined) dst[k] = src[k];
}

// ===================== OpenAI 非流式 → Anthropic =====================

export function openaiToAnthropic(openaiBody: string, reqModel: string): string {
  const o = safeParse(openaiBody);
  const choice = ((o.choices as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
  const message = (choice.message ?? {}) as AnyObj;
  const text = typeof message.content === 'string' ? message.content : blockText(message.content);
  const usage = (o.usage ?? {}) as AnyObj;
  const finishMap: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'stop_sequence',
  };
  // text + tool_calls → Anthropic content blocks（text 在前，tool_use 在后）
  const content: AnyObj[] = [];
  if (text) content.push({ type: 'text', text });
  const toolCalls = (message.tool_calls as AnyObj[] | undefined) ?? [];
  for (const tc of toolCalls) {
    const fn = (tc.function ?? {}) as AnyObj;
    let input: unknown = {};
    try {
      input = JSON.parse(String(fn.arguments ?? '{}'));
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: String(tc.id ?? `toolu_${randomId()}`),
      name: String(fn.name ?? ''),
      input,
    });
  }
  return JSON.stringify({
    id: o.id ?? `msg_${randomId()}`,
    type: 'message',
    role: 'assistant',
    model: o.model ?? reqModel,
    content,
    stop_reason: finishMap[String(choice.finish_reason ?? 'stop')] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0) || 0,
      output_tokens: Number(usage.completion_tokens ?? 0) || 0,
    },
  });
}

/** 上游错误体 → Anthropic error 结构（Claude Code 等 Anthropic 客户端依赖该结构解析错误信息） */
export function openaiErrorToAnthropic(openaiBody: string, status: number): string {
  let message = 'upstream error';
  try {
    const o = JSON.parse(openaiBody) as { error?: { message?: string } | string; message?: string };
    if (o.error && typeof o.error === 'object' && o.error.message) message = String(o.error.message);
    else if (typeof o.error === 'string') message = o.error;
    else if (typeof o.message === 'string' && o.message) message = o.message;
  } catch {
    if (openaiBody.trim()) message = openaiBody.slice(0, 500);
  }
  const type =
    status === 400
      ? 'invalid_request_error'
      : status === 401 || status === 403
        ? 'authentication_error'
        : status === 404
          ? 'not_found_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'api_error';
  return JSON.stringify({ type: 'error', error: { type, message } });
}

/** Anthropic SSE 有状态转换器：逐 chunk 输入 OpenAI SSE data，输出 Anthropic 事件文本。
 *  支持文本 delta 与 tool_calls（tool_use block + input_json_delta + block_stop）。 */export class AnthropicSseConverter {
  private msgId = `msg_${randomId()}`;
  private started = false;
  private textBlockOpen = false;
  private textIndex = 0;
  private nextIndex = 1; // 文本块占 0，工具块从 1 起
  private toolBlocks = new Map<number, { anthIndex: number; id: string; name: string }>(); // openaiToolIdx -> anth 信息
  private openToolIndex: number | null = null; // 当前仍打开的 tool 块（openai 侧 index）
  private finished = false;
  private inputTokens = 0;
  private outputTokens = 0;

  feed(openaiData: string): string {
    if (openaiData === '[DONE]') return '';
    let chunk: AnyObj;
    try {
      chunk = JSON.parse(openaiData);
    } catch {
      return '';
    }
    let out = '';
    if (!this.started) {
      this.started = true;
      out += this.event('message_start', {
        type: 'message_start',
        message: {
          id: this.msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: chunk.model ?? '',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    const choice = ((chunk.choices as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
    const delta = (choice.delta ?? {}) as AnyObj;

    // 文本 delta
    const text = delta.content;
    if (typeof text === 'string' && text) {
      if (!this.textBlockOpen) {
        this.textBlockOpen = true;
        out += this.event('content_block_start', {
          type: 'content_block_start',
          index: this.textIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      out += this.event('content_block_delta', {
        type: 'content_block_delta',
        index: this.textIndex,
        delta: { type: 'text_delta', text },
      });
    }

    // tool_calls delta：每条产生 tool_use block（start + input_json_delta）
    const tcs = (delta.tool_calls as AnyObj[] | undefined) ?? [];
    for (const tc of tcs) {
      const idx = Number(tc.index ?? 0);
      const fn = (tc.function ?? {}) as AnyObj;
      let tb = this.toolBlocks.get(idx);
      if (!tb) {
        // 打开新 block 前先关闭已打开的文本块（Anthropic content 顺序要求）
        if (this.textBlockOpen) {
          this.textBlockOpen = false;
          out += this.event('content_block_stop', { type: 'content_block_stop', index: this.textIndex });
        }
        // Anthropic 要求块按顺序 start→stop；并行工具调用时关闭上一个仍打开的 tool 块
        if (this.openToolIndex !== null && this.openToolIndex !== idx) {
          const prev = this.toolBlocks.get(this.openToolIndex);
          if (prev) out += this.event('content_block_stop', { type: 'content_block_stop', index: prev.anthIndex });
        }
        this.openToolIndex = idx;
        tb = { anthIndex: this.nextIndex++, id: String(tc.id ?? `toolu_${randomId()}`), name: String(fn.name ?? '') };
        this.toolBlocks.set(idx, tb);
        out += this.event('content_block_start', {
          type: 'content_block_start',
          index: tb.anthIndex,
          content_block: { type: 'tool_use', id: tb.id, name: tb.name, input: {} },
        });
      }
      const args = fn.arguments;
      if (typeof args === 'string' && args) {
        out += this.event('content_block_delta', {
          type: 'content_block_delta',
          index: tb.anthIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }

    const usage = chunk.usage as AnyObj | undefined;
    if (usage) {
      this.inputTokens = Number(usage.prompt_tokens ?? this.inputTokens) || this.inputTokens;
      this.outputTokens = Number(usage.completion_tokens ?? this.outputTokens) || this.outputTokens;
    }
    return out;
  }

  end(): string {
    if (this.finished) return '';
    this.finished = true;
    let out = '';
    // 关闭所有已打开 block（text 在前；tool 块仅关闭尚未关闭的最后一个，其余已在流中按序关闭）
    if (this.textBlockOpen) {
      this.textBlockOpen = false;
      out += this.event('content_block_stop', { type: 'content_block_stop', index: this.textIndex });
    }
    if (this.openToolIndex !== null) {
      const tb = this.toolBlocks.get(this.openToolIndex);
      if (tb) out += this.event('content_block_stop', { type: 'content_block_stop', index: tb.anthIndex });
      this.openToolIndex = null;
    }
    out += this.event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    out += this.event('message_stop', { type: 'message_stop' });
    return out;
  }

  private event(name: string, data: unknown): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

// ===================== OpenAI Responses → OpenAI Chat =====================

/** Responses tools → OpenAI tools（{type:'function',name,description,parameters} → {type:'function',function:{...}}） */
function responsesToolsToOpenAI(tools: unknown): AnyObj[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: AnyObj[] = [];
  for (const t of tools as AnyObj[]) {
    if (!t || String(t.type ?? '') !== 'function') continue;
    out.push({
      type: 'function',
      function: {
        name: String(t.name ?? ''),
        description: t.description !== undefined ? String(t.description) : undefined,
        parameters: (t.parameters ?? {}) as AnyObj,
      },
    });
  }
  return out.length ? out : undefined;
}

/** Responses tool_choice → OpenAI tool_choice */
function responsesToolChoiceToOpenAI(tc: unknown): unknown {
  if (tc === undefined || tc === null) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'required' || tc === 'auto' || tc === 'none') return tc;
    return 'auto';
  }
  const t = tc as AnyObj;
  if (String(t.type ?? '') === 'function') {
    return { type: 'function', function: { name: String(t.name ?? '') } };
  }
  return 'auto';
}

/** 把 Responses input item（含 function_call / function_call_output）转为 OpenAI messages */
function responsesInputToMessages(input: unknown): AnyObj[] {
  const messages: AnyObj[] = [];
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input as AnyObj[]) {
    const type = String(item.type ?? 'message');
    if (type === 'function_call') {
      // assistant 工具调用 → OpenAI assistant tool_calls
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: String(item.call_id ?? `call_${randomId()}`),
            type: 'function',
            function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') },
          },
        ],
      });
    } else if (type === 'function_call_output') {
      // 工具结果 → OpenAI tool 消息
      const output = item.output;
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? ''),
        content: output === null || output === undefined ? '' : typeof output === 'string' ? output : JSON.stringify(output),
      });
    } else {
      // message / 其它：文本（content 可能是 string 或 blocks）
      const role = String(item.role ?? 'user') === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: blockText(item.content) });
    }
  }
  return messages;
}

export function responsesToOpenAI(bodyStr: string): InboundConvertResult {
  const r = safeParse(bodyStr);
  const model = String(r.model ?? '');
  const stream = r.stream === true;
  const messages: AnyObj[] = [];
  if (typeof r.instructions === 'string' && r.instructions) messages.push({ role: 'system', content: r.instructions });
  for (const m of responsesInputToMessages(r.input)) messages.push(m);

  const openai: AnyObj = { model, messages, stream };
  copyIfPresent(r, openai, ['temperature', 'top_p', 'max_output_tokens', 'max_tokens']);
  if (openai.max_output_tokens !== undefined && openai.max_tokens === undefined) {
    openai.max_tokens = openai.max_output_tokens;
  }
  // max_output_tokens 是 Responses 协议参数，chat/completions 上游不认识（严格上游会 400），映射后必须移除
  delete openai.max_output_tokens;
  const tools = responsesToolsToOpenAI(r.tools);
  if (tools) openai.tools = tools;
  const toolChoice = responsesToolChoiceToOpenAI(r.tool_choice);
  if (toolChoice !== undefined) openai.tool_choice = toolChoice;
  return { openaiBody: JSON.stringify(openai), model, stream };
}

export function openaiToResponses(openaiBody: string, reqModel: string): string {
  const o = safeParse(openaiBody);
  const choice = ((o.choices as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
  const message = (choice.message ?? {}) as AnyObj;
  const text = typeof message.content === 'string' ? message.content : blockText(message.content);
  const usage = (o.usage ?? {}) as AnyObj;
  const id = `resp_${randomId()}`;
  // 文本 + function_call（OpenAI tool_calls → Responses function_call items）
  const output: AnyObj[] = [];
  if (text) {
    output.push({
      id: `msg_${randomId()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }
  const toolCalls = (message.tool_calls as AnyObj[] | undefined) ?? [];
  for (const tc of toolCalls) {
    const fn = (tc.function ?? {}) as AnyObj;
    output.push({
      id: String(tc.id ?? `fc_${randomId()}`),
      type: 'function_call',
      status: 'completed',
      call_id: String(tc.id ?? `fc_${randomId()}`),
      name: String(fn.name ?? ''),
      arguments: String(fn.arguments ?? '{}'),
    });
  }
  return JSON.stringify({
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: o.model ?? reqModel,
    output,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0) || 0,
      output_tokens: Number(usage.completion_tokens ?? 0) || 0,
      total_tokens: Number(usage.total_tokens ?? 0) || 0,
    },
  });
}

/** Responses SSE 转换器：文本 delta + function_call（tool_calls → function_call 输出项与参数 delta，支持并行多工具） */
export class ResponsesSseConverter {
  private respId = `resp_${randomId()}`;
  private msgItemId = `msg_${randomId()}`;
  private started = false;
  private finished = false;
  /** openai 侧 tool index → function_call 输出项状态（并行工具调用各自独立 item） */
  private fcItems = new Map<number, { itemId: string; callId: string; name: string }>();

  feed(openaiData: string): string {
    if (openaiData === '[DONE]') return '';
    let chunk: AnyObj;
    try {
      chunk = JSON.parse(openaiData);
    } catch {
      return '';
    }
    let out = '';
    if (!this.started) {
      this.started = true;
      out += this.evt('response.created', {
        type: 'response.created',
        response: { id: this.respId, object: 'response', status: 'in_progress', model: chunk.model ?? '', output: [] },
      });
      out += this.evt('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: this.msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      out += this.evt('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: this.msgItemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      });
    }
    const choice = ((chunk.choices as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
    const delta = (choice.delta ?? {}) as AnyObj;
    const text = delta.content;
    if (typeof text === 'string' && text) {
      out += this.evt('response.output_text.delta', {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: text,
      });
    }
    // tool_calls → function_call 输出项（按 index 区分多工具，各自独立 item 与参数流）
    const tcs = (delta.tool_calls as AnyObj[] | undefined) ?? [];
    for (const tc of tcs) {
      const idx = Number(tc.index ?? 0);
      const fn = (tc.function ?? {}) as AnyObj;
      const name = String(fn.name ?? '');
      const args = fn.arguments;
      let item = this.fcItems.get(idx);
      if (!item) {
        const callId = String(tc.id ?? `fc_${randomId()}`);
        item = { itemId: `fc_${randomId()}`, callId, name };
        this.fcItems.set(idx, item);
        out += this.evt('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 1 + idx,
          item: { id: item.itemId, type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' },
        });
      }
      if (typeof args === 'string' && args) {
        out += this.evt('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          output_index: 1 + idx,
          item_id: item.itemId,
          delta: args,
        });
      }
    }
    return out;
  }

  end(usage?: { input: number; output: number; total: number }): string {
    if (this.finished) return '';
    this.finished = true;
    let out = '';
    out += this.evt('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '' });
    out += this.evt('response.content_part.done', {
      type: 'response.content_part.done',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });
    out += this.evt('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: this.msgItemId, type: 'message', status: 'completed', role: 'assistant' },
    });
    // 逐个关闭全部 function_call 输出项（按 output_index 顺序）
    for (const [idx, item] of [...this.fcItems.entries()].sort((a, b) => a[0] - b[0])) {
      out += this.evt('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: 1 + idx,
        item_id: item.itemId,
      });
      out += this.evt('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 1 + idx,
        item: { id: item.itemId, type: 'function_call', status: 'completed', call_id: item.callId, name: item.name, arguments: '' },
      });
    }
    out += this.evt('response.completed', {
      type: 'response.completed',
      response: {
        id: this.respId,
        object: 'response',
        status: 'completed',
        usage: { input_tokens: usage?.input ?? 0, output_tokens: usage?.output ?? 0, total_tokens: usage?.total ?? 0 },
      },
    });
    return out;
  }

  private evt(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}
