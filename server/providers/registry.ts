import { detectModalType, type CapabilityTier, inferTier } from './templates.js';

export interface FetchedModel {
  id: string;
  modal_type: string;
  max_context: number;
  tier: CapabilityTier;
}

type AuthStyle = 'bearer-optional' | 'bearer-required' | 'header';
type ListShape = 'openai' | 'cloudflare';

export interface ProviderSpec {
  type: string;
  auth: AuthStyle;
  /** 额外固定头，值支持 {api_key} 与 extra 模板变量 */
  extraHeaders?: Record<string, string>;
  listShape: ListShape;
  /** 拉取模型列表时排除的模态 */
  excludeModals?: string[];
  /** 请求转发时为模型名补的前缀 */
  modelPrefix?: string;
}

// 绝大多数厂商走标准 OpenAI 兼容；仅列出有差异的厂商，其余用 DEFAULT_SPEC
const DEFAULT_SPEC: ProviderSpec = { type: '*', auth: 'bearer-required', listShape: 'openai' };

const SPECIAL: Record<string, ProviderSpec> = {
  // 免 Key / Key 可选
  pollinations: { type: 'pollinations', auth: 'bearer-optional', listShape: 'openai' },
  ollama: { type: 'ollama', auth: 'bearer-optional', listShape: 'openai' },
  // 额外头
  gemini: {
    type: 'gemini',
    auth: 'bearer-required',
    listShape: 'openai',
    extraHeaders: { 'x-goog-api-key': '{api_key}' },
  },
  openrouter: {
    type: 'openrouter',
    auth: 'bearer-required',
    listShape: 'openai',
    extraHeaders: { 'HTTP-Referer': 'https://github.com/nexus-llm-api', 'X-Title': 'NexusLLMapi' },
  },
  azure: {
    type: 'azure',
    auth: 'header',
    listShape: 'openai',
    extraHeaders: { 'api-key': '{api_key}' },
  },
  // Cloudflare 特殊列表结构 + 模型前缀
  cloudflare: {
    type: 'cloudflare',
    auth: 'bearer-required',
    listShape: 'cloudflare',
    excludeModals: ['embedding', 'rerank', 'asr', 'tts'],
    modelPrefix: '@cf/',
  },
};

export function getSpec(type: string): ProviderSpec {
  return SPECIAL[type] ?? { ...DEFAULT_SPEC, type };
}

/** 解析渠道 extra_config（JSON 字符串）为键值表 */
export function parseExtra(extraConfig: string | undefined | null): Record<string, string> {
  if (!extraConfig) return {};
  try {
    const obj = JSON.parse(extraConfig);
    if (obj && typeof obj === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = String(v ?? '');
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** 替换 URL / 头值中的 {var} 模板 */
function applyTemplate(text: string, apiKey: string, extra: Record<string, string>): string {
  let out = text.replaceAll('{api_key}', apiKey);
  for (const [k, v] of Object.entries(extra)) out = out.replaceAll(`{${k}}`, v);
  // Cloudflare 模板里是 {ID}，兼容 account_id
  if (extra.account_id) out = out.replaceAll('{ID}', extra.account_id).replaceAll('{ACCOUNT_ID}', extra.account_id);
  return out;
}

/** 计算最终 base_url：优先 DB 中用户配置，套用 extra 模板变量 */
export function resolveBaseURL(dbBaseURL: string, extra: Record<string, string>): string {
  let url = (dbBaseURL ?? '').trim();
  for (const [k, v] of Object.entries(extra)) url = url.replaceAll(`{${k}}`, v);
  if (extra.account_id) url = url.replaceAll('{ID}', extra.account_id).replaceAll('{ACCOUNT_ID}', extra.account_id);
  return url.replace(/\/+$/, '');
}

/** 构建上游请求头 */
export function buildHeaders(type: string, apiKey: string, extra: Record<string, string>): Record<string, string> {
  const spec = getSpec(type);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (spec.auth === 'bearer-required' || (spec.auth === 'bearer-optional' && apiKey)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (spec.extraHeaders) {
    for (const [k, v] of Object.entries(spec.extraHeaders)) {
      headers[k] = applyTemplate(v, apiKey, extra);
    }
  }
  return headers;
}

/** 解析上游 /models 响应为统一模型列表 */
export function parseModelList(type: string, json: unknown): FetchedModel[] {
  const spec = getSpec(type);
  const out: FetchedModel[] = [];
  if (spec.listShape === 'cloudflare') {
    const result = (json as { result?: Array<{ name?: string }> })?.result ?? [];
    for (const item of result) {
      const id = String(item.name ?? '').trim();
      if (!id) continue;
      const modal = detectModalType(id);
      if (spec.excludeModals?.includes(modal)) continue;
      out.push({ id, modal_type: modal, max_context: 4096, tier: inferTier(id, modal) });
    }
    return out;
  }

  // OpenAI 形态：{data:[{id}]}，也兼容裸数组与 Azure deployments 的 {value:[...]} 形态
  type ListItem = { id?: string; name?: string };
  const arr = Array.isArray(json)
    ? (json as ListItem[])
    : ((json as { data?: ListItem[] })?.data ?? (json as { value?: ListItem[] })?.value ?? []);
  for (const item of arr) {
    // Azure deployment 项的 id 可能是完整资源路径，取最后一段作为模型/部署名
    const raw = String(item?.name ?? item?.id ?? '').trim();
    const id = raw.split('/').pop()?.trim() ?? '';
    if (!id) continue;
    const modal = detectModalType(id);
    if (spec.excludeModals?.includes(modal)) continue;
    out.push({ id, modal_type: modal, max_context: 4096, tier: inferTier(id, modal) });
  }
  return out;
}

/** 请求体变换：如 Cloudflare 补 @cf/ 前缀 */
export function transformRequestBody(type: string, rawBody: string, fallbackModel: string): string {
  const spec = getSpec(type);
  if (!spec.modelPrefix) return rawBody;
  try {
    const obj = JSON.parse(rawBody) as Record<string, unknown>;
    let model = String(obj.model ?? fallbackModel);
    if (!model.startsWith(spec.modelPrefix)) model = spec.modelPrefix + model;
    obj.model = model;
    return JSON.stringify(obj);
  } catch {
    return rawBody;
  }
}

/** 拼接 models 列表 URL（兼容 base_url 是否已含 /models） */
export function modelsEndpoint(baseURL: string): string {
  const b = baseURL.replace(/\/+$/, '');
  return b.endsWith('/models') ? b : `${b}/models`;
}

/** 构造上游业务端点；Azure 需补 api-version 查询参数（取 extra.api_version，缺省用较新版本） */
export function upstreamEndpoint(
  baseURL: string,
  path: string,
  type: string,
  extra: Record<string, string> = {},
): string {
  const url = `${baseURL.replace(/\/+$/, '')}${path.startsWith('/') ? path : '/' + path}`;
  if (type !== 'azure') return url;
  const ver = (extra.api_version || '2024-10-21').trim();
  return `${url}${url.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(ver)}`;
}
