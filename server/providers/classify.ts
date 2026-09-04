// 模型分类打标与默认启用策略（迁移自旧 Go models/classify.go、sync.go）

const TAG_CODE_GEN = '代码生成';
const TAG_TEXT_ANALYZE = '文本分析';
const TAG_TEXT_GEN = '文本生成';
const TAG_CHAT = '对话';
const TAG_IMAGE = '图像';
const TAG_VIDEO = '视频';
const TAG_TRANSLATE = '翻译';
const TAG_SUMMARY = '摘要';
const TAG_MATH = '数学';
const TAG_REASON = '推理';
const TAG_WRITING = '写作';
const TAG_DATA = '数据分析';
const TAG_AGENT = 'Agent';

function containsAny(s: string, keywords: string[]): boolean {
  return keywords.some((k) => s.includes(k));
}

function unique(input: string[]): string[] {
  return [...new Set(input)];
}

/** 根据模型 ID 与模态分类打标（文本模型可多标签） */
export function classifyModel(modelId: string, modalType: string): string[] {
  const id = modelId.toLowerCase();

  if (modalType === 'image') return [TAG_IMAGE];
  if (modalType === 'video') return [TAG_VIDEO];

  const tags: string[] = [];
  if (containsAny(id, ['coder', 'code', 'deepseek-coder', 'qwen-coder', 'codellama', 'starcoder', 'codegeex'])) {
    tags.push(TAG_CODE_GEN);
  }

  const generalKeywords = [
    'llama', 'qwen', 'deepseek', 'glm', 'gpt', 'claude', 'gemini',
    'mistral', 'mixtral', 'nemotron', 'yi', 'phi', 'command',
    'chat', 'instruct', 'vl', 'vision', 'baichuan', 'internlm',
  ];
  const isGeneral = containsAny(id, generalKeywords);
  if (isGeneral) tags.push(TAG_CHAT, TAG_TEXT_GEN, TAG_TEXT_ANALYZE);

  // 扩展分类（仅按明确的模型 ID 关键词命中，避免误打）
  if (containsAny(id, ['translate', 'translation'])) tags.push(TAG_TRANSLATE);
  if (containsAny(id, ['summar', 'abstract'])) tags.push(TAG_SUMMARY);
  if (containsAny(id, ['math', 'mathstral'])) tags.push(TAG_MATH);
  if (containsAny(id, ['reason', 'deepseek-r1', 'o1', 'o3'])) tags.push(TAG_REASON);
  if (containsAny(id, ['writing', 'story', 'creative', 'novel'])) tags.push(TAG_WRITING);
  if (containsAny(id, ['sql', 'analys'])) tags.push(TAG_DATA);
  if (containsAny(id, ['agent', 'tool', 'function'])) tags.push(TAG_AGENT);

  if (tags.length === 0) tags.push(TAG_CHAT);
  return unique(tags);
}

/** 新同步模型是否默认启用（图像/视频默认关闭，主流文本模型默认开启） */
export function isDefaultEnabled(modelId: string, modalType: string): boolean {
  const id = modelId.toLowerCase();
  if (modalType === 'video' || modalType === 'image') return false;
  const keywords = [
    'llama', 'qwen', 'deepseek', 'glm', 'gpt', 'claude', 'gemini',
    'mistral', 'mixtral', 'nemotron', 'yi', 'phi', 'command',
    'coder', 'code', 'chat', 'instruct', 'vl', 'vision',
  ];
  return containsAny(id, keywords);
}
