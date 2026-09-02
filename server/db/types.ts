import { toIso } from '../util/time.js';

// ===== 数据库原始行（SQLite 列名 snake_case，布尔为 0/1）=====
export interface ChannelRow {
  id: number;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  extra_config: string;
  enabled: number;
  rpm_limit: number;
  retry_count: number;
  disabled_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelRow {
  id: number;
  model_id: string;
  alias: string;
  channel_id: number;
  tags: string;
  modal_type: string;
  max_context: number;
  enabled: number;
  available: number;
  remark: string;
  created_at: string;
  updated_at: string;
}

export interface LogRow {
  id: number;
  request_id: string;
  model: string;
  channel_id: number;
  channel_name: string;
  status_code: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  error_msg: string;
  created_at: string;
  created_date: string;
}

// ===== 对外 DTO（与旧 Go 后端 JSON 完全一致，snake_case，布尔化，时间 ISO）=====
export interface ChannelDTO {
  id: number;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  extra_config: string;
  enabled: boolean;
  rpm_limit: number;
  retry_count: number;
  disabled_until?: string;
  created_at: string;
  updated_at: string;
}

export interface ModelDTO {
  id: number;
  model_id: string;
  alias: string;
  channel_id: number;
  tags: string;
  modal_type: string;
  max_context: number;
  enabled: boolean;
  available: boolean;
  remark: string;
  created_at: string;
  updated_at: string;
}

export interface LogDTO {
  id: number;
  request_id: string;
  model: string;
  channel_id: number;
  channel_name: string;
  status_code: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  error_msg: string;
  created_at: string;
}

export function channelToDTO(r: ChannelRow): ChannelDTO {
  const dto: ChannelDTO = {
    id: r.id,
    name: r.name,
    provider_type: r.provider_type,
    base_url: r.base_url,
    api_key: r.api_key,
    extra_config: r.extra_config ?? '',
    enabled: !!r.enabled,
    rpm_limit: r.rpm_limit,
    retry_count: r.retry_count,
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
  if (r.disabled_until) dto.disabled_until = toIso(r.disabled_until);
  return dto;
}

export function modelToDTO(r: ModelRow): ModelDTO {
  return {
    id: r.id,
    model_id: r.model_id,
    alias: r.alias ?? '',
    channel_id: r.channel_id,
    tags: r.tags ?? '[]',
    modal_type: r.modal_type ?? 'text',
    max_context: r.max_context,
    enabled: !!r.enabled,
    available: !!r.available,
    remark: r.remark ?? '',
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

export function logToDTO(r: LogRow): LogDTO {
  return {
    id: r.id,
    request_id: r.request_id,
    model: r.model,
    channel_id: r.channel_id,
    channel_name: r.channel_name,
    status_code: r.status_code,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    total_tokens: r.total_tokens,
    duration_ms: r.duration_ms,
    error_msg: r.error_msg ?? '',
    created_at: toIso(r.created_at),
  };
}
