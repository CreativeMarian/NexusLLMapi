// 请求体出站转换与 token 提取（迁移自旧 translate / gateway）

const SYSTEM_MERGE_PROVIDERS = new Set(['modelscope']);

export function needsSystemMerge(providerType: string): boolean {
  return SYSTEM_MERGE_PROVIDERS.has(providerType);
}

type AnyObj = Record<string, unknown>;

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 把 system/developer/tool 角色合并进第一条 user 消息（部分上游不接受 system） */
function mergeSystemMessages(req: AnyObj): void {
  const systemParts: string[] = [];
  if (typeof req.system === 'string' && req.system) {
    systemParts.push(req.system);
    delete req.system;
  }
  if (!Array.isArray(req.messages)) return;
  const filtered: unknown[] = [];
  for (const msg of req.messages as unknown[]) {
    const m = msg as AnyObj;
    if (!m || typeof m !== 'object') {
      filtered.push(msg);
      continue;
    }
    const role = String(m.role ?? '');
    if (role === 'system' || role === 'developer' || role === 'tool') {
      const text = contentToString(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    filtered.push(msg);
  }
  if (systemParts.length > 0 && filtered.length > 0) {
    const systemText = systemParts.join('\n\n');
    let merged = false;
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i] as AnyObj;
      if (String(m.role) === 'user') {
        if (typeof m.content === 'string') m.content = systemText + '\n\n' + m.content;
        else m.content = systemText;
        merged = true;
        break;
      }
      if (i === 0 && String(m.role) !== 'user') {
        filtered.unshift({ role: 'user', content: systemText });
        merged = true;
        break;
      }
    }
    void merged;
  }
  req.messages = filtered;
}

export interface OutgoingOptions {
  realModel: string;
  providerType: string;
  isStream: boolean;
  modelPrefix?: string;
}

/** 构造发往上游的请求体：替换模型名、按需合并 system、流式注入 usage */
export function buildUpstreamBody(rawBody: string, opts: OutgoingOptions): string {
  let req: AnyObj;
  try {
    req = JSON.parse(rawBody);
  } catch {
    return rawBody; // 非 JSON 原样转发
  }
  if (req && typeof req === 'object') {
    let model = opts.realModel;
    if (opts.modelPrefix && !model.startsWith(opts.modelPrefix)) model = opts.modelPrefix + model;
    req.model = model;
    if (needsSystemMerge(opts.providerType)) mergeSystemMessages(req);
    if (opts.isStream && req.stream_options === undefined) {
      req.stream_options = { include_usage: true };
    }
  }
  return JSON.stringify(req);
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function extractTokens(body: string): Usage {
  try {
    const obj = JSON.parse(body) as { usage?: Partial<Usage> };
    const u = obj.usage ?? {};
    return {
      prompt_tokens: Number(u.prompt_tokens ?? 0) || 0,
      completion_tokens: Number(u.completion_tokens ?? 0) || 0,
      total_tokens: Number(u.total_tokens ?? 0) || 0,
    };
  } catch {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
}

/** 从 SSE 累积缓冲中解析最后一个带 usage 的 chunk */
export function extractStreamUsage(buffer: string): Usage {
  const lines = buffer.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    try {
      const chunk = JSON.parse(data) as { usage?: Partial<Usage> };
      if (chunk.usage && Number(chunk.usage.total_tokens ?? 0) > 0) {
        const u = chunk.usage;
        return {
          prompt_tokens: Number(u.prompt_tokens ?? 0) || 0,
          completion_tokens: Number(u.completion_tokens ?? 0) || 0,
          total_tokens: Number(u.total_tokens ?? 0) || 0,
        };
      }
    } catch {
      /* ignore malformed line */
    }
  }
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/**
 * 流式增量 Usage 跟踪器：逐个 data 行解析，有 usage 即更新。
 * 不累积原始文本（避免长流内存膨胀），仅保留最近解析到的 usage 与是否见过 [DONE]。
 */
export class StreamingUsageTracker {
  private u: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  sawDone = false;

  /** 喂入一条 SSE data 负载（不含 'data:' 前缀） */
  feed(data: string): void {
    if (data === '[DONE]') {
      this.sawDone = true;
      return;
    }
    try {
      const chunk = JSON.parse(data) as { usage?: Partial<Usage> };
      const us = chunk.usage;
      if (us && Number(us.total_tokens ?? 0) > 0) {
        this.u = {
          prompt_tokens: Number(us.prompt_tokens ?? 0) || 0,
          completion_tokens: Number(us.completion_tokens ?? 0) || 0,
          total_tokens: Number(us.total_tokens ?? 0) || 0,
        };
      }
    } catch {
      /* ignore malformed line */
    }
  }

  get usage(): Usage {
    return { ...this.u };
  }
}

/** 读取请求体中的 model 字段 */
export function peekModel(rawBody: string): string {
  try {
    const obj = JSON.parse(rawBody) as { model?: unknown };
    return typeof obj.model === 'string' ? obj.model : '';
  } catch {
    return '';
  }
}

export function peekStream(rawBody: string): boolean {
  try {
    const obj = JSON.parse(rawBody) as { stream?: unknown };
    return obj.stream === true;
  } catch {
    return false;
  }
}
