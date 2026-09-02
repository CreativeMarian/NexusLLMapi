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
import { Save, Settings2, Gauge, RotateCcw, FileText, Copy, Check, CheckCircle, Globe } from 'lucide-vue-next'

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
      </div>
    </template>
  </div>
</template>
