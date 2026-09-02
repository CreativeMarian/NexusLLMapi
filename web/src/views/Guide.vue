<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  Rocket, KeyRound, Plug, DownloadCloud, Gauge, MonitorSmartphone, Bot,
  Code2, Globe, CheckCircle2, ChevronRight, Copy, Check, ExternalLink,
  HelpCircle, AlertTriangle, Info, Lightbulb, CheckCircle, AlertCircle, X
} from 'lucide-vue-next'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import { getChannels } from '@/api/channel'
import { getSettings } from '@/api/setting'
import { getModelStats } from '@/api/model'

const router = useRouter()
const loading = ref(true)
const channels = ref([])
const settings = ref({})
const modelStats = ref({}) // 用于判定“同步模型/检测清理”是否完成（store.Channel 无 model_count 字段）
const copiedIndex = ref(-1)
const verifying = ref(false)
const verifyResult = ref('')

// 默认展开核心流程，接入与可选配置收起
const expandedSteps = ref(new Set([1, 2, 3, 4, 5]))

function toggleStep(id) {
  if (expandedSteps.value.has(id)) expandedSteps.value.delete(id)
  else expandedSteps.value.add(id)
}

function scrollToStep(id) {
  document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ========== 核心流程（1-5，可自动判定完成，纳入进度） ==========
const coreSteps = computed(() => [
  {
    id: 1,
    title: '启动服务',
    icon: Rocket,
    color: 'from-blue-500 to-cyan-500',
    description: '启动 NexusLLMapi，确认管理后台可以访问。',
    action: { type: 'verify', label: '验证服务状态' },
    detail: [
      { type: 'step', text: '在项目根目录运行 npm install && npm start（Node 版）' },
      { type: 'warning', text: '服务在后台静默运行，没有窗口弹出。不要重复启动，否则 8787 端口冲突' },
      { type: 'step', text: '浏览器打开 http://127.0.0.1:8787 进入管理后台' },
      { type: 'tip', text: '看到本页面说明服务已在运行，此步骤自动标记完成' },
      { type: 'fail', text: '页面打不开？① 任务管理器确认服务进程存在 ② netstat -ano | findstr :8787 检查端口是否被占用 ③ 防火墙放行 8787' }
    ],
    isCompleted: () => true
  },
  {
    id: 2,
    title: '获取 API Key',
    icon: KeyRound,
    color: 'from-violet-500 to-purple-500',
    description: '网关本身不提供模型，需要上游服务商的 API Key。',
    action: { type: 'link', label: '打开 NVIDIA NIM', url: 'https://build.nvidia.com' },
    detail: [
      { type: 'subtitle', text: '免费推荐' },
      { type: 'step', text: 'NVIDIA NIM：打开 build.nvidia.com，Google/GitHub 账号直接登录，无需信用卡' },
      { type: 'step', text: '在任意模型页面点「Get API Key」，生成以 nvapi- 开头的密钥' },
      { type: 'subtitle', text: '国内直连' },
      { type: 'step', text: 'DeepSeek、Kimi、智谱、硅基流动等：官网注册后在控制台创建 API Key' },
      { type: 'warning', text: '密钥只在创建时显示一次，立刻复制保存' },
      { type: 'success', text: '手里有一串可用的 API Key（nvapi- 或 sk- 等开头）' }
    ],
    isCompleted: () => channels.value.length > 0
  },
  {
    id: 3,
    title: '添加渠道',
    icon: Plug,
    color: 'from-purple-500 to-pink-500',
    description: '把 API Key 填进渠道，内置 38+ 供应商模板。',
    action: { type: 'navigate', label: '去渠道管理', path: '/channels' },
    detail: [
      { type: 'step', text: '渠道管理 → 添加渠道' },
      { type: 'info', text: '渠道类型下拉框内置了 38+ 供应商模板（OpenAI、DeepSeek、Kimi、智谱、NVIDIA、Azure、Cloudflare 等），选中后自动填充 Base URL 与默认 RPM，绝大多数情况不用手动改' },
      { type: 'subtitle', text: '必填三项' },
      { type: 'step', text: '渠道名称：随意起，仅本地区分用' },
      { type: 'step', text: '渠道类型：下拉选择模板（OpenAI 兼容的服务商一律选 openai）' },
      { type: 'step', text: 'API Key：粘贴上一步获取的密钥' },
      { type: 'warning', text: '手动修改 Base URL 时，OpenAI 兼容地址必须以 /v1 结尾，否则请求 404' },
      { type: 'step', text: '保存后点渠道卡片上的「测试连接」，显示成功即配置正确' },
      { type: 'fail', text: '401/403 → API Key 错误\n404 → Base URL 结尾不对\nconnection refused → 网络不通，需要 SOCKS5 代理（见可选配置）' }
    ],
    isCompleted: () => channels.value.length > 0
  },
  {
    id: 4,
    title: '同步模型',
    icon: DownloadCloud,
    color: 'from-cyan-500 to-teal-500',
    description: '一键拉取上游所有可用模型到本地模型库。',
    action: { type: 'navigate', label: '去同步模型', path: '/channels' },
    detail: [
      { type: 'step', text: '渠道卡片上点「同步模型」，等待数秒' },
      { type: 'success', text: '显示同步结果：新增 / 更新 / 跳过的模型数量' },
      { type: 'info', text: '同步会自动跳过 embedding、tts、asr 等非对话模型' },
      { type: 'tip', text: '不同步也能用：已知模型 ID 的话，直接在客户端填写即可' }
    ],
    isCompleted: () => (modelStats.value.total || 0) > 0
  },
  {
    id: 5,
    title: '检测与清理',
    icon: Gauge,
    color: 'from-green-500 to-emerald-500',
    description: '测速、批量检测可用性，一键清理失效模型。',
    action: { type: 'navigate', label: '去模型库', path: '/models' },
    detail: [
      { type: 'subtitle', text: '速度测试' },
      { type: 'step', text: '模型卡片上的 ⚡ 按钮：测试单个模型的响应速度（快 <3s / 中 3-10s / 慢 >10s）' },
      { type: 'step', text: '右上角「一键检测连接」：并发检测当前页所有已启用模型' },
      { type: 'subtitle', text: '清理失效' },
      { type: 'step', text: '检测完成后，点「删除 N 个失效模型」一键清理' },
      { type: 'warning', text: '删除需要输入「删除」二字确认，删除后不可恢复' },
      { type: 'tip', text: '模型卡片还支持设置别名、查看客户端配置、启用/停用' }
    ],
    isCompleted: () => (modelStats.value.total || 0) > 0
  }
])

// ========== 接入客户端（6-8，手动跟随，不判定完成） ==========
const connectSteps = computed(() => [
  {
    id: 6,
    title: '接入客户端（OpenAI 兼容）',
    icon: MonitorSmartphone,
    color: 'from-indigo-500 to-blue-500',
    description: 'Cherry Studio、Trae、Cursor、ChatBox 等客户端通用配置。',
    action: { type: 'copy', label: '复制配置信息', copyId: 6 },
    detail: [
      { type: 'info', text: '所有支持 OpenAI 兼容接口的客户端配置方式相同，只需要三个参数' },
      { type: 'subtitle', text: '核心三参数' },
      { type: 'param', label: 'Base URL', value: 'http://127.0.0.1:8787/v1', note: '必须以 /v1 结尾' },
      { type: 'param', label: 'API Key', value: 'sk-nexus', note: '任意非空值，网关不校验' },
      { type: 'param', label: 'Model ID', value: '从模型库复制，如 meta/llama-3.1-8b-instruct', note: '必须与模型库完全一致' },
      { type: 'warning', text: '模型 ID 大小写和斜杠必须完全一致，填错会报「模型不存在」' },
      { type: 'step', text: '在模型库点击任意模型卡片，可查看配置信息并一键复制' },
      { type: 'success', text: '在客户端发一条消息，收到 AI 回复即配置成功' },
      { type: 'fail', text: '连接失败 → 网关没运行\n404 → Base URL 漏了 /v1\n模型不存在 → 模型 ID 填错\n空回复 → 换个模型重试' }
    ]
  },
  {
    id: 7,
    title: '接入 Claude Code（Anthropic 协议）',
    icon: Bot,
    color: 'from-amber-500 to-orange-600',
    description: '网关自动把 Anthropic 协议转换为 OpenAI 格式，含流式与工具调用。',
    action: { type: 'copy', label: '复制配置信息', copyId: 7 },
    detail: [
      { type: 'info', text: 'Claude Code 使用 Anthropic Messages API（/v1/messages），NexusLLMapi 自动完成协议转换，支持 tools / function calling 与流式输出' },
      { type: 'subtitle', text: '第一步：给模型设置别名' },
      { type: 'step', text: '模型库 → 选择一个已同步的模型 → 编辑别名' },
      { type: 'step', text: '别名填：anthropic/claude-3-5-sonnet（可指向任意模型，如 openai/gpt-oss-20b）' },
      { type: 'tip', text: '别名以 anthropic/ 开头，可避免 Claude Code 的模型名校验警告' },
      { type: 'subtitle', text: '第二步：在 Claude Code 中配置网关' },
      { type: 'param', label: '网关 URL', value: 'http://127.0.0.1:8787', note: '注意：不带 /v1！' },
      { type: 'param', label: 'API Key', value: 'sk-nexus', note: '任意值，Static API key + bearer' },
      { type: 'param', label: 'Model ID', value: 'anthropic/claude-3-5-sonnet', note: '填你设置的别名' },
      { type: 'warning', text: '网关 URL 带上 /v1 会拼成 /v1/v1/messages 导致 404，这是最常见的错误' },
      { type: 'step', text: '点「测试模型发现」，成功后「应用更改」' },
      { type: 'success', text: '在 Claude Code 中发消息，收到回复即接入成功' }
    ]
  },
  {
    id: 8,
    title: '代码调用（Python / JavaScript）',
    icon: Code2,
    color: 'from-slate-500 to-gray-600',
    description: '标准 OpenAI SDK，只需改 base_url 即可。',
    action: { type: 'copy', label: '复制代码', copyId: 8 },
    detail: [
      { type: 'subtitle', text: 'Python' },
      { type: 'code', text: 'from openai import OpenAI\n\nclient = OpenAI(\n    base_url="http://127.0.0.1:8787/v1",\n    api_key="sk-nexus"\n)\n\nresp = client.chat.completions.create(\n    model="meta/llama-3.1-8b-instruct",\n    messages=[{"role": "user", "content": "你好"}],\n)\nprint(resp.choices[0].message.content)' },
      { type: 'subtitle', text: 'JavaScript / TypeScript' },
      { type: 'code', text: 'import OpenAI from "openai";\n\nconst client = new OpenAI({\n  apiKey: "sk-nexus",\n  baseURL: "http://127.0.0.1:8787/v1",\n});\n\nconst resp = await client.chat.completions.create({\n  model: "meta/llama-3.1-8b-instruct",\n  messages: [{ role: "user", content: "你好" }],\n});\nconsole.log(resp.choices[0].message.content);' },
      { type: 'tip', text: '加 stream: true 即为流式输出，网关完整支持 SSE' }
    ]
  }
])

// ========== 可选配置（9） ==========
const optionalSteps = computed(() => [
  {
    id: 9,
    title: 'SOCKS5 出站代理（可选）',
    icon: Globe,
    color: 'from-cyan-500 to-blue-500',
    description: '国内访问 OpenAI / Anthropic / Gemini 等海外 API 时需要。',
    action: { type: 'navigate', label: '去代理设置', path: '/settings' },
    detail: [
      { type: 'step', text: '代理设置 → SOCKS5 代理地址 → 填 127.0.0.1:7890（按你的代理客户端修改）' },
      { type: 'warning', text: '只填 地址:端口，不要加 socks5:// 前缀' },
      { type: 'tip', text: '常见端口：Clash = 7890，V2RayN = 10808，Shadowsocks = 1080' },
      { type: 'step', text: '保存后立即生效，无需重启服务' },
      { type: 'success', text: '配置后重新「测试连接」之前失败的渠道' }
    ],
    isCompleted: () => !!settings.value.socks5_proxy
  }
])

// 分组渲染
const sections = computed(() => [
  { key: 'core', title: '核心流程', hint: '完成这 5 步即可开始使用', steps: coreSteps.value },
  { key: 'connect', title: '接入客户端', hint: '按你使用的工具选择配置', steps: connectSteps.value },
  { key: 'optional', title: '可选配置', hint: '按需选用', steps: optionalSteps.value }
])

const allStepsById = Object.fromEntries(sections.value.flatMap(s => s.steps).map(s => [s.id, s]))

// 进度只统计核心流程
const coreTotal = computed(() => coreSteps.value.length)
const coreCompleted = computed(() => coreSteps.value.filter(s => s.isCompleted && s.isCompleted()).length)
const progressPercent = computed(() => Math.round((coreCompleted.value / coreTotal.value) * 100))

const copyTexts = {
  6: 'Base URL: http://127.0.0.1:8787/v1\nAPI Key: sk-nexus\nModel ID: 从模型库复制（如 meta/llama-3.1-8b-instruct）',
  7: '网关 URL: http://127.0.0.1:8787\nAPI Key: sk-nexus\nAuth: bearer\nModel ID: anthropic/claude-3-5-sonnet（需先在模型库设置别名）',
  8: '# Python\nfrom openai import OpenAI\nclient = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-nexus")'
}

async function loadData() {
  loading.value = true
  try {
    const [chRes, setRes, statsRes] = await Promise.all([
      getChannels().catch(() => ({ data: [] })),
      getSettings().catch(() => ({ data: {} })),
      getModelStats().catch(() => ({ data: {} }))
    ])
    channels.value = chRes.data || []
    settings.value = setRes.data || {}
    modelStats.value = statsRes.data || {}
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

function handleAction(step) {
  const type = step.action.type
  if (type === 'navigate') {
    router.push(step.action.path)
  } else if (type === 'copy') {
    copyParam(copyTexts[step.action.copyId] || '', step.id)
  } else if (type === 'verify') {
    verifyService()
  } else if (type === 'link') {
    window.open(step.action.url, '_blank')
  }
}

async function verifyService() {
  verifying.value = true
  verifyResult.value = ''
  try {
    const res = await fetch('/api/dashboard')
    verifyResult.value = res.ok ? 'success' : 'fail'
    if (res.ok) await loadData()
  } catch {
    verifyResult.value = 'fail'
  } finally {
    verifying.value = false
    setTimeout(() => (verifyResult.value = ''), 3000)
  }
}

// 复制到剪贴板（非安全上下文下 navigator.clipboard 不可用，降级 execCommand）
function copyParam(value, key) {
  const done = () => {
    copiedIndex.value = key
    setTimeout(() => (copiedIndex.value = -1), 1500)
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value) && done())
  } else {
    fallbackCopy(value) && done()
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(ta)
  return ok
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- 头部 -->
    <div class="glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-orange/30 bg-brand-orange/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-orange">
          <Rocket class="h-3 w-3" />GETTING STARTED
        </span>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">快速开始</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ nexus setup <span class="text-brand-blue">--guide</span>
        </p>
      </div>
      <div class="shrink-0 text-right">
        <div class="text-3xl font-bold tracking-tight gradient-text">{{ coreCompleted }}/{{ coreTotal }}</div>
        <div class="mt-1 text-xs text-muted-foreground">核心步骤已完成</div>
      </div>
    </div>

    <!-- 进度条 -->
    <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        class="h-full rounded-full bg-gradient-to-r from-brand-blue via-brand-purple to-brand-cyan shadow-glow-purple transition-all duration-500"
        :style="{ width: progressPercent + '%' }"
      />
    </div>

    <!-- 分组步骤导航 -->
    <div class="space-y-2">
      <div v-for="section in sections" :key="section.key" class="flex flex-wrap items-center gap-2">
        <span class="mr-1 text-xs font-medium text-muted-foreground">{{ section.title }}</span>
        <Button
          v-for="step in section.steps"
          :key="step.id"
          variant="outline"
          size="sm"
          class="h-8 rounded-full px-3"
          :class="expandedSteps.has(step.id) ? 'border-primary/50 text-primary' : ''"
          @click="toggleStep(step.id); scrollToStep(step.id)"
        >
          <Check v-if="step.isCompleted && step.isCompleted()" class="mr-1 h-3 w-3 text-brand-green" />
          <span class="mr-1">{{ step.id }}</span>{{ step.title.replace('（', ' · ').replace('）', '') }}
        </Button>
      </div>
    </div>

    <div v-if="loading" class="py-12 text-center text-muted-foreground">加载中...</div>

    <!-- 步骤卡片 -->
    <div v-else class="space-y-8">
      <section v-for="section in sections" :key="section.key" class="space-y-4">
        <!-- 分组标题 -->
        <div class="flex items-center gap-3">
          <h3 class="text-sm font-semibold text-foreground">{{ section.title }}</h3>
          <span class="text-xs text-muted-foreground">{{ section.hint }}</span>
          <div class="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
        </div>

        <Card
          v-for="step in section.steps"
          :id="`step-${step.id}`"
          :key="step.id"
          class="scroll-mt-4"
          :class="step.isCompleted && step.isCompleted() ? 'border-brand-green/30' : ''"
        >
          <CardContent class="p-5">
            <div class="flex cursor-pointer items-start gap-4" @click="toggleStep(step.id)">
              <div class="relative shrink-0">
                <div
                  class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg"
                  :class="step.color"
                >
                  <component :is="step.icon" class="h-6 w-6" />
                </div>
                <div
                  v-if="step.isCompleted && step.isCompleted()"
                  class="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand-green text-white shadow-glow-green"
                >
                  <Check class="h-3 w-3" />
                </div>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-medium text-muted-foreground">步骤 {{ step.id }}</span>
                  <Badge v-if="section.key === 'optional'" variant="secondary" class="text-[10px]">可选</Badge>
                  <Badge v-if="step.isCompleted && step.isCompleted()" variant="success" class="text-[10px]">已完成</Badge>
                  <ChevronRight
                    class="ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200"
                    :class="expandedSteps.has(step.id) ? 'rotate-90' : ''"
                  />
                </div>
                <h3 class="mt-1 text-lg font-semibold">{{ step.title }}</h3>
                <p class="mt-1 text-sm text-muted-foreground">{{ step.description }}</p>
              </div>
            </div>

            <!-- 展开详情 -->
            <div v-show="expandedSteps.has(step.id)" class="mt-4 space-y-3 border-t border-border/40 pt-4">
              <template v-for="(item, i) in step.detail" :key="i">
                <!-- 小标题 -->
                <div v-if="item.type === 'subtitle'" class="mt-2 flex items-center gap-2">
                  <div class="h-4 w-1 rounded-full bg-gradient-to-b from-brand-blue to-brand-purple" />
                  <h4 class="text-sm font-semibold">{{ item.text }}</h4>
                </div>
                <!-- 参数行（玻璃内卡 + 复制） -->
                <div v-else-if="item.type === 'param'" class="flex items-center gap-3 rounded-xl border border-border/40 bg-card/40 px-3 py-2">
                  <span class="w-20 shrink-0 text-xs font-medium text-muted-foreground">{{ item.label }}</span>
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-primary">{{ item.value }}</code>
                  <span class="hidden shrink-0 text-[10px] text-muted-foreground sm:block">{{ item.note }}</span>
                  <button
                    v-if="!item.value.includes(' ') || item.value.startsWith('http')"
                    class="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                    title="复制"
                    @click="copyParam(item.value, `p${step.id}${i}`)"
                  >
                    <Check v-if="copiedIndex === `p${step.id}${i}`" class="h-3.5 w-3.5 text-brand-green" />
                    <Copy v-else class="h-3.5 w-3.5" />
                  </button>
                </div>
                <!-- 普通条目 -->
                <div v-else-if="item.type === 'step'" class="flex items-start gap-2 pl-1">
                  <ChevronRight class="mt-0.5 h-4 w-4 shrink-0 text-brand-blue" />
                  <span class="text-sm text-foreground/90">{{ item.text }}</span>
                </div>
                <div v-else-if="item.type === 'tip'" class="flex items-start gap-2 rounded-xl bg-amber-500/10 p-3">
                  <Lightbulb class="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div class="whitespace-pre-line text-xs text-amber-800 dark:text-amber-200">{{ item.text }}</div>
                </div>
                <div v-else-if="item.type === 'warning'" class="flex items-start gap-2 rounded-xl bg-red-500/10 p-3">
                  <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                  <div class="whitespace-pre-line text-xs font-medium text-red-800 dark:text-red-200">{{ item.text }}</div>
                </div>
                <div v-else-if="item.type === 'info'" class="flex items-start gap-2 rounded-xl bg-blue-500/10 p-3">
                  <Info class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                  <div class="whitespace-pre-line text-xs text-blue-800 dark:text-blue-200">{{ item.text }}</div>
                </div>
                <div v-else-if="item.type === 'success'" class="flex items-start gap-2 rounded-xl border border-brand-green/30 bg-brand-green/10 p-3">
                  <CheckCircle class="mt-0.5 h-4 w-4 shrink-0 text-brand-green" />
                  <div class="whitespace-pre-line text-xs text-brand-green">{{ item.text }}</div>
                </div>
                <div v-else-if="item.type === 'fail'" class="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                  <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div class="whitespace-pre-line text-xs text-destructive/90">{{ item.text }}</div>
                </div>
                <!-- 代码块 -->
                <div v-else-if="item.type === 'code'" class="overflow-x-auto rounded-xl bg-slate-950/90 p-3 shadow-inner ring-1 ring-white/10">
                  <pre class="text-xs text-slate-100"><code>{{ item.text }}</code></pre>
                </div>
              </template>

              <!-- 操作按钮 -->
              <div class="flex items-center pt-1">
                <Button
                  size="sm"
                  :variant="step.isCompleted && step.isCompleted() && step.action.type !== 'verify' ? 'outline' : 'default'"
                  :disabled="step.action.type === 'verify' && verifying"
                  @click="handleAction(step)"
                >
                  <component
                    :is="step.action.type === 'verify'
                      ? (verifying ? Gauge : (verifyResult === 'success' ? Check : (verifyResult === 'fail' ? X : ExternalLink)))
                      : (step.action.type === 'copy' ? (copiedIndex === step.id ? Check : Copy) : ExternalLink)"
                    class="mr-2 h-4 w-4"
                    :class="step.action.type === 'verify' && verifying ? 'animate-spin' : ''"
                  />
                  {{ step.action.type === 'verify'
                    ? (verifying ? '验证中...' : (verifyResult === 'success' ? '验证成功' : (verifyResult === 'fail' ? '验证失败' : step.action.label)))
                    : (step.action.type === 'copy' && copiedIndex === step.id ? '已复制' : step.action.label) }}
                </Button>
                <span v-if="step.action.type === 'verify' && verifyResult === 'success'" class="ml-3 text-sm font-medium text-brand-green">
                  服务正常运行
                </span>
                <span v-if="step.action.type === 'verify' && verifyResult === 'fail'" class="ml-3 text-sm font-medium text-destructive">
                  验证失败，请检查服务是否启动
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>

    <!-- 完成提示 -->
    <Card v-if="coreCompleted >= coreTotal" class="border-brand-green/30 bg-gradient-to-br from-brand-green/10 to-brand-cyan/5">
      <CardContent class="p-6 text-center">
        <CheckCircle2 class="mx-auto mb-3 h-12 w-12 text-brand-green drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]" />
        <h3 class="text-lg font-semibold text-brand-green">核心配置已完成！</h3>
        <p class="mt-1 text-sm text-muted-foreground">网关已就绪。接入客户端按上面的指引配置即可，SOCKS5 代理为可选项。</p>
      </CardContent>
    </Card>

    <!-- 常见问题 -->
    <Card>
      <CardContent class="p-5">
        <div class="flex items-center gap-2">
          <HelpCircle class="h-5 w-5 text-brand-blue" />
          <h3 class="font-semibold">常见问题</h3>
        </div>
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <div class="rounded-xl border border-border/40 bg-card/40 p-4">
            <h4 class="text-sm font-medium">Base URL 怎么填？</h4>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
              OpenAI 兼容客户端填 <code class="text-brand-blue">http://127.0.0.1:8787/v1</code>（带 /v1）。
              Claude Code 填 <code class="text-brand-blue">http://127.0.0.1:8787</code>（不带 /v1）。
            </p>
          </div>
          <div class="rounded-xl border border-border/40 bg-card/40 p-4">
            <h4 class="text-sm font-medium">API Key 填什么？</h4>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
              客户端连网关填任意值（如 <code class="text-brand-blue">sk-nexus</code>），网关不校验。
              上游服务商的 Key 配置在渠道管理里。
            </p>
          </div>
          <div class="rounded-xl border border-border/40 bg-card/40 p-4">
            <h4 class="text-sm font-medium">模型 ID 从哪来？</h4>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
              在模型库点击模型卡片即可复制完整 ID，必须与模型库完全一致（含大小写与斜杠）。
              Claude Code 需要使用 <code class="text-brand-blue">anthropic/</code> 开头的别名。
            </p>
          </div>
          <div class="rounded-xl border border-border/40 bg-card/40 p-4">
            <h4 class="text-sm font-medium">渠道停用后请求还在走？</h4>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
              渠道启停会热重载立即生效。触发限流或预算熔断的渠道会进入冷却状态，到期自动恢复。
            </p>
          </div>
          <div class="rounded-xl border border-border/40 bg-card/40 p-4">
            <h4 class="text-sm font-medium">仪表盘没有数据？</h4>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
              仪表盘只统计经过网关代理的请求。确认客户端 Base URL 指向了网关，而不是直连上游。
            </p>
          </div>
          <div class="rounded-xl border border-border/40 bg-card/40 p-4">
            <h4 class="text-sm font-medium">密钥安全吗？</h4>
            <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
              所有密钥明文保存在本机 SQLite 数据库中，仅供本机使用，不会上传到任何第三方。
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
