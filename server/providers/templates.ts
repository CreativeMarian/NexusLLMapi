// 内置渠道模板（与旧 Go channels.GetProviderTemplates 完全一致）
export interface ProviderTemplate {
  type: string;
  name: string;
  base_url: string;
  need_account: boolean;
  default_rpm: number;
  modalities: string;
  free_tier: string;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  { type: 'nvidia', name: 'NVIDIA NIM', base_url: 'https://integrate.api.nvidia.com/v1', need_account: false, default_rpm: 40, modalities: '文本、代码、图像', free_tier: '约40次/分钟' },
  { type: 'groq', name: 'Groq', base_url: 'https://api.groq.com/openai/v1', need_account: false, default_rpm: 30, modalities: '文本、代码', free_tier: '30 RPM / 1000次/天' },
  { type: 'cerebras', name: 'Cerebras', base_url: 'https://api.cerebras.ai/v1', need_account: false, default_rpm: 30, modalities: '文本、代码', free_tier: '30 RPM / 1M tokens/天' },
  { type: 'sambanova', name: 'SambaNova', base_url: 'https://api.sambanova.ai/v1', need_account: false, default_rpm: 50, modalities: '文本、代码', free_tier: '免费额度' },
  { type: 'openrouter', name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', need_account: false, default_rpm: 20, modalities: '文本、代码、图像', free_tier: '21个免费模型' },
  { type: 'mistral', name: 'Mistral AI', base_url: 'https://api.mistral.ai/v1', need_account: false, default_rpm: 60, modalities: '文本、代码', free_tier: '实验级免费额度' },
  { type: 'github', name: 'GitHub Models', base_url: 'https://models.inference.ai.azure.com', need_account: false, default_rpm: 15, modalities: '文本、代码、图像', free_tier: 'GPT-4o / GPT-4.1 免费' },
  { type: 'gemini', name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', need_account: false, default_rpm: 15, modalities: '文本、代码、图像', free_tier: 'Gemini 2.5 Flash 免费' },
  { type: 'cohere', name: 'Cohere', base_url: 'https://api.cohere.com/v2', need_account: false, default_rpm: 20, modalities: '文本、代码', free_tier: '试用额度' },
  { type: 'zhipu', name: '智谱 Zhipu AI', base_url: 'https://open.bigmodel.cn/api/paas/v4', need_account: false, default_rpm: 100, modalities: '文本、代码、图像', free_tier: 'GLM-4 免费额度' },
  { type: 'huggingface', name: 'HuggingFace', base_url: 'https://api-inference.huggingface.co/v1', need_account: false, default_rpm: 60, modalities: '文本、代码、图像', free_tier: '推理API免费额度' },
  { type: 'ollama', name: 'Ollama Cloud', base_url: 'https://api.ollama.com/v1', need_account: false, default_rpm: 60, modalities: '文本、代码', free_tier: '免费计划' },
  { type: 'pollinations', name: 'Pollinations', base_url: 'https://text.pollinations.ai', need_account: false, default_rpm: 30, modalities: '文本、代码', free_tier: '完全免费，无需Key' },
  { type: 'cloudflare', name: 'Cloudflare Workers AI', base_url: 'https://api.cloudflare.com/client/v4/accounts/{ID}/ai/v1', need_account: true, default_rpm: 10000, modalities: '文本、嵌入', free_tier: '每日10000次' },
  { type: 'modelscope', name: '魔搭 ModelScope', base_url: 'https://api-inference.modelscope.cn/v1', need_account: false, default_rpm: 2000, modalities: '文本、代码、图像', free_tier: '每日2000次' },
  { type: 'dashscope', name: '通义千问 DashScope', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码、图像', free_tier: '新用户赠百万Token' },
  { type: 'minimax', name: 'MiniMax', base_url: 'https://api.minimax.chat/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码、视频', free_tier: '新用户赠送额度' },
  { type: 'together', name: 'Together AI', base_url: 'https://api.together.xyz/v1', need_account: false, default_rpm: 60, modalities: '文本、代码、图像', free_tier: '新用户赠$5' },
  { type: 'fireworks', name: 'Fireworks AI', base_url: 'https://api.fireworks.ai/inference/v1', need_account: false, default_rpm: 60, modalities: '文本、代码、图像', free_tier: '新用户赠额度' },
  { type: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', need_account: false, default_rpm: 60, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'moonshot', name: '月之暗面 Moonshot', base_url: 'https://api.moonshot.cn/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码、图像', free_tier: '新用户赠15元' },
  { type: '01ai', name: '零一万物 01.AI', base_url: 'https://api.lingyiwanwu.com/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'baichuan', name: '百川智能 Baichuan', base_url: 'https://api.baichuan-ai.com/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'stepfun', name: '阶跃星辰 StepFun', base_url: 'https://api.stepfun.com/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码、图像', free_tier: '新用户赠额度' },
  { type: 'siliconflow', name: '硅基流动 SiliconFlow', base_url: 'https://api.siliconflow.cn/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码、图像', free_tier: '新用户赠14元' },
  { type: 'volcengine', name: '火山方舟 Volcengine', base_url: 'https://ark.cn-beijing.volces.com/api/v3', need_account: false, default_rpm: 1000, modalities: '文本、代码、图像', free_tier: '新用户赠额度' },
  { type: 'hunyuan', name: '腾讯混元 Tencent Hunyuan', base_url: 'https://api.hunyuan.cloud.tencent.com/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'ernie', name: '百度文心 Baidu ERNIE', base_url: 'https://qianfan.baidubce.com/v2', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'iflytek', name: '科大讯飞 iFlytek', base_url: 'https://spark-api-open.xf-yun.com/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: '360brain', name: '360智脑 360 Brain', base_url: 'https://api.360.cn/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'mimo', name: '小米 MiMo', base_url: 'https://api.xiaomi.com/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'sensechat', name: '商汤 SenseChat', base_url: 'https://api.sensenova.cn/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'mobvoi', name: '出门问问 Mobvoi', base_url: 'https://api.mobvoi.com/v1', need_account: false, default_rpm: 1000, modalities: '文本、代码', free_tier: '新用户赠额度' },
  { type: 'ppio', name: 'PPIO 派欧云', base_url: 'https://api.ppinfra.com/v3', need_account: false, default_rpm: 1000, modalities: '文本、代码、图像', free_tier: '新用户赠10元' },
  { type: 'azure', name: 'Azure OpenAI', base_url: 'https://{resource}.openai.azure.com/openai/deployments/{deployment}', need_account: true, default_rpm: 60, modalities: '文本、代码、图像', free_tier: '-' },
  { type: 'bedrock', name: 'AWS Bedrock', base_url: 'https://bedrock-runtime.{region}.amazonaws.com', need_account: true, default_rpm: 60, modalities: '文本、代码、图像', free_tier: '-' },
  { type: 'vertex', name: 'Google Vertex AI', base_url: 'https://{region}-aiplatform.googleapis.com/v1', need_account: true, default_rpm: 60, modalities: '文本、代码、图像', free_tier: '-' },
  { type: 'custom', name: '自定义 OpenAI 兼容', base_url: '', need_account: false, default_rpm: 60, modalities: '自定义', free_tier: '-' },
];

const TEMPLATE_BY_TYPE = new Map(PROVIDER_TEMPLATES.map((t) => [t.type, t]));

export function getTemplate(type: string): ProviderTemplate | undefined {
  return TEMPLATE_BY_TYPE.get(type);
}

function containsAny(s: string, keywords: string[]): boolean {
  return keywords.some((k) => s.includes(k));
}

/** 根据模型 ID 检测模态类型 */
export function detectModalType(modelId: string): string {
  const id = modelId.toLowerCase();
  if (containsAny(id, ['vision', 'vl', 'muse', 'flux', 'sdxl', 'stable-diffusion', 'image'])) return 'image';
  if (containsAny(id, ['video', 'h3', 'sora', 'kling', 'runway'])) return 'video';
  if (containsAny(id, ['embed', 'embedding'])) return 'embedding';
  if (containsAny(id, ['rerank'])) return 'rerank';
  if (containsAny(id, ['asr', 'whisper', 'speech-to-text'])) return 'asr';
  if (containsAny(id, ['tts', 'text-to-speech', 'audio'])) return 'tts';
  return 'text';
}

export type CapabilityTier = 'fast' | 'smart' | 'vision' | 'code' | 'image' | 'video';

/** 推断能力梯队 */
export function inferTier(modelId: string, modalType?: string): CapabilityTier {
  if (modalType === 'image') return 'image';
  if (modalType === 'video') return 'video';
  const id = modelId.toLowerCase();
  if (containsAny(id, ['flash', 'mini', 'small', 'lite', 'nano', 'tiny', '8b', '7b', 'distill'])) return 'fast';
  if (containsAny(id, ['vision', 'vl', 'llava', 'qwen-vl', 'gemini-2', 'gpt-4o', 'gpt-4v', 'claude-3', 'minicpm-v', 'internvl'])) return 'vision';
  if (containsAny(id, ['coder', 'code', 'codestral', 'deepseek-coder', 'qwen2.5-coder', 'codegeex', 'starcoder', 'wizardcoder', 'sql'])) return 'code';
  return 'smart';
}

/** 固定分类标签（与旧 models.AllTags 对齐） */
export const ALL_TAGS = ['代码生成', '文本分析', '文本生成', '对话', '图像', '视频', '翻译', '摘要', '数学', '推理', '写作', '数据分析', 'Agent'];
