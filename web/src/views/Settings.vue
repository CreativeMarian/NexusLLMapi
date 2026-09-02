<script setup>
import { ref, computed, onMounted } from 'vue'
import { getSettings, updateSettings } from '@/api/setting'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import CardHeader from '@/components/ui/CardHeader.vue'
import CardTitle from '@/components/ui/CardTitle.vue'
import CardDescription from '@/components/ui/CardDescription.vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Switch from '@/components/ui/Switch.vue'
import { Save, Settings2, Gauge, RotateCcw, FileText, Copy, Check, CheckCircle, Globe, MonitorSmartphone, Bot, Code2, HelpCircle, Terminal } from 'lucide-vue-next'

const loading = ref(true)
const saving = ref(false)
const form = ref({
  port: 8787, auto_open_browser: true, global_rpm: 600,
  default_retry: 2, default_cooldown: 1, request_timeout: 120, enable_log: true,
  socks5_proxy: ''
})
const saved = ref(false)
const copied = ref(false) // 复制代理配置的独立状态（不复用 saved，避免误显“已保存”）

async function loadData() {
  loading.value = true
  try {
    const res = await getSettings()
    form.value = { ...res.data }
  } catch (e) { console.error(e) }
  finally { loading.value = false }
}

async function save() {
  saving.value = true
  try {
    await updateSettings(form.value)
    saved.value = true
    setTimeout(() => saved.value = false, 2000)
  } catch (e) { alert('保存失败: ' + e.message) }
  finally { saving.value = false }
}

// 代理配置信息：用 computed 跟随端口/SOCKS5 变化，原普通常量在 form 被后端覆盖或用户编辑后不会更新
const proxyConfig = computed(() => `# OpenAI 兼容代理配置
Base URL: http://127.0.0.1:${form.value.port}/v1
API Key: 任意值（本地自用无需鉴权）

# 支持的接口（OpenAI 兼容）
POST /v1/chat/completions    # 对话补全（支持流式）
GET  /v1/models               # 模型列表
POST /v1/embeddings           # 向量嵌入（需 X-Channel 指定渠道）
POST /v1/responses           # OpenAI Responses 协议（自动转换）

# 通用 HTTP 透传（任意协议/任意端点）
# 路径格式：/p/{渠道ID或名称}/{上游路径}
# 例如：/p/1/v1/messages → 渠道ID=1，转发到 {base_url}/v1/messages
#       /p/nvidia/v1/models → 渠道名称=nvidia，转发到 {base_url}/v1/models
# 自动注入 API Key，支持 SOCKS5 出站

# Anthropic 原生协议（自动协议转换，支持 Claude Code）
POST /v1/messages             # 自动转为 OpenAI 格式走智能路由

# SOCKS5 出站代理（当前：${form.value.socks5_proxy || '未配置，直连'}）`)

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(proxyConfig.value)
    copied.value = true
    setTimeout(() => copied.value = false, 2000)
  } catch (e) {
    // 非安全上下文（http）或用户拒绝：剪贴板 API 会 reject，给出回退提示
    alert('复制失败，请手动选择上方文本复制')
  }
}

// ===== 客户端接入信息（由原「快速开始」页迁移而来） =====
const clientCopied = ref('')
const clientConfigs = computed(() => ({
  openai: `Base URL: http://127.0.0.1:${form.value.port}/v1
API Key: sk-nexus（任意非空值）
Model: 从模型库复制（如 meta/llama-3.1-8b-instruct）`,
  claude: `网关 URL: http://127.0.0.1:${form.value.port}（注意不带 /v1）
API Key: sk-nexus
Auth: bearer
Model: anthropic/claude-3-5-sonnet（需先在模型库设置别名）`,
  python: `from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:${form.value.port}/v1",
    api_key="sk-nexus"
)

resp = client.chat.completions.create(
    model="meta/llama-3.1-8b-instruct",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)`
}))
async function copyClientConfig(key) {
  try {
    await navigator.clipboard.writeText(clientConfigs.value[key])
    clientCopied.value = key
    setTimeout(() => clientCopied.value = '', 2000)
  } catch (e) {
    alert('复制失败，请手动选择文本复制')
  }
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <div class="glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-cyan/30 bg-brand-cyan/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-cyan">
          <Settings2 class="h-3 w-3" />GATEWAY CONFIG
        </span>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">代理设置</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ nexus config <span class="text-brand-blue">--port 8787 --rpm 600 --retry 2</span>
        </p>
      </div>
      <Button class="shrink-0" @click="save" :loading="saving">
        <Save v-if="!saved" class="mr-2 h-4 w-4" />
        <CheckCircle v-else class="mr-2 h-4 w-4 text-brand-green" />
        {{ saved ? '已保存' : '保存设置' }}
      </Button>
    </div>

    <div v-if="loading" class="py-12 text-center text-muted-foreground">加载中...</div>

    <template v-else>
      <div class="grid gap-6 lg:grid-cols-2">
        <!-- 基础设置 -->
        <Card class="flex flex-col">
          <CardHeader>
            <div class="flex items-center gap-2">
              <Settings2 class="h-5 w-5 text-brand-blue" />
              <CardTitle>基础设置</CardTitle>
            </div>
            <CardDescription>服务运行的基础参数配置</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col justify-center space-y-4">
            <div>
              <label class="mb-1.5 block text-sm font-medium">服务端口</label>
              <Input v-model.number="form.port" type="number" />
              <p class="mt-1 text-xs text-muted-foreground">修改后需重启服务生效</p>
            </div>
            <div class="flex items-center justify-between rounded-lg border border-border/50 p-3">
              <div>
                <p class="text-sm font-medium">自动打开浏览器</p>
                <p class="text-xs text-muted-foreground">启动时自动打开管理后台</p>
              </div>
              <Switch v-model="form.auto_open_browser" />
            </div>
            <div class="flex items-center justify-between rounded-lg border border-border/50 p-3">
              <div>
                <p class="text-sm font-medium">启用请求日志</p>
                <p class="text-xs text-muted-foreground">记录所有代理请求到本地数据库</p>
              </div>
              <Switch v-model="form.enable_log" />
            </div>
          </CardContent>
        </Card>

        <!-- 限流设置 -->
        <Card class="flex flex-col">
          <CardHeader>
            <div class="flex items-center gap-2">
              <Gauge class="h-5 w-5 text-brand-purple" />
              <CardTitle>限流设置</CardTitle>
            </div>
            <CardDescription>全局与渠道级别的速率限制</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col justify-center space-y-4">
            <div>
              <label class="mb-1.5 block text-sm font-medium">全局 RPM 限制</label>
              <Input v-model.number="form.global_rpm" type="number" />
              <p class="mt-1 text-xs text-muted-foreground">所有渠道合计每分钟最大请求数</p>
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-medium">请求超时（秒）</label>
              <Input v-model.number="form.request_timeout" type="number" />
              <p class="mt-1 text-xs text-muted-foreground">上游请求最大等待时间</p>
            </div>
          </CardContent>
        </Card>

        <!-- 网络代理设置 -->
        <Card class="flex flex-col">
          <CardHeader>
            <div class="flex items-center gap-2">
              <Globe class="h-5 w-5 text-brand-cyan" />
              <CardTitle>网络代理</CardTitle>
            </div>
            <CardDescription>上游请求出站代理配置（SOCKS5）</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col justify-center space-y-4">
            <div>
              <label class="mb-1.5 block text-sm font-medium">SOCKS5 代理地址</label>
              <Input v-model="form.socks5_proxy" placeholder="127.0.0.1:1080" />
              <p class="mt-1 text-xs text-muted-foreground">所有上游请求通过此 SOCKS5 代理出站，留空则直连。保存后立即生效，无需重启。</p>
            </div>
            <div class="rounded-lg border border-border/50 bg-muted/30 p-3">
              <p class="text-xs text-muted-foreground">
                <strong>适用场景：</strong>国内环境访问 OpenAI / Anthropic / Google Gemini 等需要翻墙的 API 时，配置本地 SOCKS5 代理（如 Clash / V2Ray 的 1080 端口），所有渠道统一走代理出站。
              </p>
            </div>
          </CardContent>
        </Card>

        <!-- 重试设置 -->
        <Card class="flex flex-col">
          <CardHeader>
            <div class="flex items-center gap-2">
              <RotateCcw class="h-5 w-5 text-brand-orange" />
              <CardTitle>重试设置</CardTitle>
            </div>
            <CardDescription>失败自动重试与渠道切换策略</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col justify-center space-y-4">
            <div>
              <label class="mb-1.5 block text-sm font-medium">默认重试次数</label>
              <Input v-model.number="form.default_retry" type="number" />
              <p class="mt-1 text-xs text-muted-foreground">遇到 429/500/502/503/504 时自动切换渠道重试</p>
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-medium">重试冷却时间（秒）</label>
              <Input v-model.number="form.default_cooldown" type="number" />
              <p class="mt-1 text-xs text-muted-foreground">两次重试之间的等待时间</p>
            </div>
          </CardContent>
        </Card>

        <!-- 代理配置信息 -->
        <Card class="flex flex-col">
          <CardHeader>
            <div class="flex items-center gap-2">
              <FileText class="h-5 w-5 text-brand-green" />
              <CardTitle>代理配置信息</CardTitle>
            </div>
            <CardDescription>在下游客户端中使用以下配置</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col justify-center">
            <div class="relative">
              <pre class="overflow-x-auto rounded-xl bg-slate-950/90 p-4 text-xs leading-relaxed text-slate-100 ring-1 ring-white/10 shadow-inner">{{ proxyConfig }}</pre>
              <button class="absolute right-2 top-2 rounded-lg p-1.5 text-slate-400 backdrop-blur transition-colors hover:bg-white/10 hover:text-white" @click="copyConfig">
                <Check v-if="copied" class="h-4 w-4 text-brand-green" />
                <Copy v-else class="h-4 w-4" />
              </button>
            </div>
          </CardContent>
        </Card>

        <!-- 客户端接入（由原「快速开始」页迁移） -->
        <Card class="flex flex-col lg:col-span-2">
          <CardHeader>
            <div class="flex items-center gap-2">
              <MonitorSmartphone class="h-5 w-5 text-brand-blue" />
              <CardTitle>客户端接入</CardTitle>
            </div>
            <CardDescription>把网关接入 OpenAI 兼容客户端、Claude Code 或代码调用</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col space-y-6">
            <!-- OpenAI 兼容客户端 -->
            <div>
              <div class="flex items-center gap-2">
                <MonitorSmartphone class="h-4 w-4 text-brand-blue" />
                <h4 class="text-sm font-semibold">OpenAI 兼容客户端（Cherry Studio / Trae / Cursor / ChatBox）</h4>
              </div>
              <div class="mt-2 space-y-1.5">
                <div class="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-2">
                  <span class="w-16 shrink-0 text-xs text-muted-foreground">Base URL</span>
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-primary">http://127.0.0.1:{{ form.port }}/v1</code>
                  <button class="rounded p-1 text-muted-foreground hover:text-primary" title="复制全部配置" @click="copyClientConfig('openai')">
                    <Check v-if="clientCopied === 'openai'" class="h-3.5 w-3.5 text-brand-green" />
                    <Copy v-else class="h-3.5 w-3.5" />
                  </button>
                </div>
                <div class="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-2">
                  <span class="w-16 shrink-0 text-xs text-muted-foreground">API Key</span>
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">sk-nexus（任意非空值）</code>
                </div>
                <div class="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-2">
                  <span class="w-16 shrink-0 text-xs text-muted-foreground">Model ID</span>
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">从「模型库」点击模型卡片复制，如 meta/llama-3.1-8b-instruct</code>
                </div>
              </div>
              <p class="mt-1.5 text-xs text-muted-foreground">模型 ID 大小写与斜杠必须与模型库完全一致，否则报「模型不存在」。</p>
            </div>

            <!-- Claude Code -->
            <div>
              <div class="flex items-center gap-2">
                <Bot class="h-4 w-4 text-brand-purple" />
                <h4 class="text-sm font-semibold">Claude Code（Anthropic 协议）</h4>
              </div>
              <div class="mt-2 space-y-1.5">
                <div class="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-2">
                  <span class="w-16 shrink-0 text-xs text-muted-foreground">网关 URL</span>
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-primary">http://127.0.0.1:{{ form.port }}</code>
                  <button class="rounded p-1 text-muted-foreground hover:text-primary" title="复制全部配置" @click="copyClientConfig('claude')">
                    <Check v-if="clientCopied === 'claude'" class="h-3.5 w-3.5 text-brand-green" />
                    <Copy v-else class="h-3.5 w-3.5" />
                  </button>
                </div>
                <div class="flex items-center gap-2 rounded-lg border border-border/40 bg-card/40 px-3 py-2">
                  <span class="w-16 shrink-0 text-xs text-muted-foreground">Model ID</span>
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">anthropic/claude-3-5-sonnet（在模型库设置别名）</code>
                </div>
              </div>
              <p class="mt-1.5 text-xs text-muted-foreground">
                网关 URL 带 /v1 会拼成 /v1/v1/messages 导致 404，这是最常见的错误。
              </p>
            </div>

            <!-- 代码调用 -->
            <div>
              <div class="flex items-center gap-2">
                <Code2 class="h-4 w-4 text-brand-green" />
                <h4 class="text-sm font-semibold">代码调用（Python）</h4>
              </div>
              <div class="relative mt-2">
                <pre class="overflow-x-auto rounded-xl bg-slate-950/90 p-3 text-xs leading-relaxed text-slate-100 ring-1 ring-white/10">from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:{{ form.port }}/v1", api_key="sk-nexus")
resp = client.chat.completions.create(model="meta/llama-3.1-8b-instruct", messages=[{"role": "user", "content": "你好"}])
print(resp.choices[0].message.content)</pre>
                <button class="absolute right-2 top-2 rounded-lg p-1.5 text-slate-400 backdrop-blur transition-colors hover:bg-white/10 hover:text-white" @click="copyClientConfig('python')">
                  <Check v-if="clientCopied === 'python'" class="h-4 w-4 text-brand-green" />
                  <Copy v-else class="h-4 w-4" />
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- 常见问题（由原「快速开始」页迁移） -->
        <Card class="flex flex-col lg:col-span-2">
          <CardHeader>
            <div class="flex items-center gap-2">
              <HelpCircle class="h-5 w-5 text-brand-orange" />
              <CardTitle>常见问题</CardTitle>
            </div>
            <CardDescription>接入网关时最常见的几个问题</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col">
            <div class="grid gap-4 md:grid-cols-2">
              <div class="rounded-xl border border-border/40 bg-card/40 p-4">
                <h4 class="text-sm font-medium">Base URL 怎么填？</h4>
                <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
                  OpenAI 兼容客户端填 <code class="text-brand-blue">http://127.0.0.1:{{ form.port }}/v1</code>（带 /v1）。
                  Claude Code 填 <code class="text-brand-blue">http://127.0.0.1:{{ form.port }}</code>（不带 /v1）。
                </p>
              </div>
              <div class="rounded-xl border border-border/40 bg-card/40 p-4">
                <h4 class="text-sm font-medium">API Key 填什么？</h4>
                <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
                  客户端连网关填任意值（如 <code class="text-brand-blue">sk-nexus</code>），网关不校验。
                  上游服务商的 Key 配置在「渠道管理」里。
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
  </div>
</template>
