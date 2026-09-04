<script setup>
import { ref, onMounted, computed } from 'vue'
import {
  getChannels, getTemplates, createChannel, updateChannel,
  deleteChannel, toggleChannel, testChannel, syncChannelModels
} from '@/api/channel'
import { getHealth, triggerHealth } from '@/api/health'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Badge from '@/components/ui/Badge.vue'
import Switch from '@/components/ui/Switch.vue'
import Select from '@/components/ui/Select.vue'
import Dialog from '@/components/ui/Dialog.vue'
import {
  Plus, Plug, Cpu, Trash2, RefreshCw, Activity,
  CheckCircle, AlertCircle, Key, Settings2, X
} from 'lucide-vue-next'

const loading = ref(true)
const channels = ref([])
const templates = ref([])

// Toast 通知
const toast = ref({ show: false, type: 'success', message: '' })
let toastTimer = null
function showToast(type, message) {
  toast.value = { show: true, type, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value.show = false }, 3000)
}

// 卡片上的测试状态
const cardTesting = ref({})
const cardTestResult = ref({})

// 卡片上的同步状态
const cardSyncing = ref({})
const cardSyncResult = ref({}) // { total, added, updated, skipped, text, image, video }

// 编辑对话框
// 渠道健康（/api/health）
const health = ref({ summary: null, channels: [] })
const healthChecking = ref(false)
async function loadHealth() {
  try {
    const res = await getHealth()
    health.value = res
  } catch (e) { /* 后端不可用时静默 */ }
}
function healthLabel(h) {
  const map = { ok: '正常', fail: '异常', pending: '检测中', disabled: '未启用' }
  return map[h.status] || h.status
}

function healthOf(id) {
  const h = (health.value.channels || []).find(c => c.channelId === id)
  return h || null
}
async function onHealthCheck() {
  if (healthChecking.value) return
  healthChecking.value = true
  try {
    await triggerHealth()
    // 后端「入队即返回」：轮询 /api/health 直到本轮检测结束（检测慢于固定延时很常见）
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      await loadHealth()
      if (health.value.summary && !health.value.summary.checking) break
    }
  } catch (e) {
    showToast('error', '健康检测失败: ' + (e.message || e))
  } finally {
    healthChecking.value = false
  }
}

const dialogOpen = ref(false)
const editing = ref(null)
const form = ref({
  name: '', provider_type: '', base_url: '', api_key: '',
  extra_config: '{}', rpm_limit: 60, retry_count: 2, enabled: true
})
const testing = ref(false)
const testResult = ref(null)
const syncing = ref(false)

async function loadData() {
  loading.value = true
  try {
    const [chRes, tplRes] = await Promise.all([getChannels(), getTemplates()])
    channels.value = chRes.data || []
    templates.value = tplRes.data || []
  } catch (e) { console.error(e) }
  finally { loading.value = false }
}

const providerOptions = computed(() =>
  templates.value.map(t => ({ value: t.type, label: t.name }))
)

function openAdd() {
  editing.value = null
  form.value = { name: '', provider_type: '', base_url: '', api_key: '', extra_config: '{}', rpm_limit: 60, retry_count: 2, enabled: true }
  testResult.value = null
  dialogOpen.value = true
}

function openEdit(ch) {
  editing.value = ch
  form.value = { ...ch, extra_config: ch.extra_config || '{}' }
  testResult.value = null
  dialogOpen.value = true
}

function onProviderChange() {
  const tpl = templates.value.find(t => t.type === form.value.provider_type)
  if (tpl && !editing.value) {
    // 仅在字段为空或仍是其它模板默认值时覆盖，避免抹掉用户已填内容
    const isTemplateValue = (val, field) => !val || templates.value.some(t => t[field] === val)
    if (isTemplateValue(form.value.base_url, 'base_url')) form.value.base_url = tpl.base_url
    if (!form.value.name || templates.value.some(t => t.name === form.value.name)) form.value.name = tpl.name
    if (!form.value.rpm_limit || templates.value.some(t => t.default_rpm === form.value.rpm_limit)) form.value.rpm_limit = tpl.default_rpm
    // Cloudflare 默认填充 account_id 模板
    if (tpl.type === 'cloudflare') {
      form.value.extra_config = '{\n  "account_id": "your-account-id"\n}'
    } else if (!form.value.extra_config || form.value.extra_config.trim() === '{}' || form.value.extra_config.includes('your-account-id')) {
      form.value.extra_config = '{}'
    }
  }
}

async function save() {
  if (!form.value.name || !form.value.provider_type) {
    showToast('error', '请填写渠道名称和类型')
    return
  }
  // 校验 extra_config 是否为合法 JSON
  try {
    if (form.value.extra_config && form.value.extra_config.trim()) {
      JSON.parse(form.value.extra_config)
    }
  } catch (e) {
    showToast('error', '额外配置不是合法的 JSON 格式')
    return
  }
  // 数字字段归一化：清空输入框时 v-model.number 得到 ''，直接提交会被后端当成 0（重试变「不重试」）
  const numOrUndef = (v, dflt) => {
    const n = Number(v)
    return v === '' || v === null || !Number.isFinite(n) ? dflt : n
  }
  const payload = {
    ...form.value,
    rpm_limit: numOrUndef(form.value.rpm_limit, ''),
    retry_count: numOrUndef(form.value.retry_count, ''),
  }
  if (payload.rpm_limit === '') delete payload.rpm_limit
  if (payload.retry_count === '') delete payload.retry_count
  try {
    if (editing.value) {
      await updateChannel(editing.value.id, payload)
      showToast('success', '保存成功')
    } else {
      await createChannel(payload)
      showToast('success', '创建成功')
    }
    dialogOpen.value = false
    loadData()
  } catch (e) { showToast('error', '保存失败: ' + (e.message || e)) }
}

async function onToggle(ch) {
  try { await toggleChannel(ch.id, !ch.enabled); ch.enabled = !ch.enabled } catch (e) { showToast('error', '操作失败') }
}

async function onDelete(ch) {
  if (!confirm(`确定删除「${ch.name}」？该渠道下的所有模型也将被删除。`)) return
  try { await deleteChannel(ch.id); showToast('success', '删除成功'); loadData() } catch (e) { showToast('error', '删除失败') }
}

// 卡片上的测试连接
async function onTestCard(ch) {
  cardTesting.value[ch.id] = true
  cardTestResult.value[ch.id] = null
  try {
    const res = await testChannel(ch.id)
    cardTestResult.value[ch.id] = { success: res.success, message: res.message }
    showToast(res.success ? 'success' : 'error', res.message)
  } catch (e) {
    cardTestResult.value[ch.id] = { success: false, message: e.message }
    showToast('error', e.message)
  } finally {
    cardTesting.value[ch.id] = false
  }
}

// 对话框内的测试连接
async function onTestDialog() {
  if (!editing.value) {
    showToast('error', '请先保存渠道后再测试')
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const res = await testChannel(editing.value.id)
    testResult.value = { success: res.success, message: res.message }
  } catch (e) { testResult.value = { success: false, message: e.message } }
  finally { testing.value = false }
}

async function onSync(ch) {
  if (!confirm(`确定同步「${ch.name}」的模型列表？\n\n将从上游拉取所有可用模型，保存到本地模型库。`)) return
  cardSyncing.value[ch.id] = true
  cardSyncResult.value[ch.id] = null
  try {
    const res = await syncChannelModels(ch.id)
    const r = res.data
    cardSyncResult.value[ch.id] = r
    const msg = `同步完成！共${r.total}个：新增${r.added}，更新${r.updated}，跳过${r.skipped}（文本${r.text}/图像${r.image}/视频${r.video}）`
    showToast('success', msg)
    // 重新加载渠道数据以更新 model_count
    await loadData()
  } catch (e) {
    cardSyncResult.value[ch.id] = { error: e.message }
    showToast('error', '同步失败: ' + e.message)
  } finally {
    cardSyncing.value[ch.id] = false
  }
}

onMounted(() => { loadData(); loadHealth() })
</script>

<template>
  <div class="space-y-6 relative">
    <!-- Toast 通知 -->
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0 -translate-y-4"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0 -translate-y-4"
    >
      <div v-if="toast.show" class="glass-strong flex items-center gap-2 rounded-xl px-4 py-3"
        :class="toast.type === 'success' ? 'text-brand-green' : 'text-destructive'">
        <CheckCircle v-if="toast.type === 'success'" class="h-5 w-5 drop-shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
        <AlertCircle v-else class="h-5 w-5 drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
        <span class="text-sm font-medium">{{ toast.message }}</span>
        <button @click="toast.show = false" class="ml-2 opacity-70 hover:opacity-100">
          <X class="h-4 w-4" />
        </button>
      </div>
    </Transition>

    <div class="glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-blue/30 bg-brand-blue/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-blue">
          <Plug class="h-3 w-3" />UPSTREAM PROVIDERS
        </span>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">渠道管理</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ nexus channel add <span class="text-brand-blue">--provider &lt;type&gt; --key &lt;api_key&gt;</span>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button variant="outline" :disabled="healthChecking" @click="onHealthCheck">
          <Activity class="mr-2 h-4 w-4" :class="healthChecking ? 'animate-pulse' : ''" />
          {{ healthChecking ? '检测中...' : '健康检测' }}
        </Button>
        <Button data-guide="add-channel" @click="openAdd">
          <Plus class="mr-2 h-4 w-4" />添加渠道
        </Button>
      </div>
    </div>

    <!-- 渠道卡片列表 -->
    <div v-if="loading" class="py-12 text-center text-muted-foreground">
      <RefreshCw class="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />加载中...
    </div>

    <div v-else-if="channels.length === 0" class="py-16">
      <Card>
        <CardContent class="flex flex-col items-center py-12">
          <Plug class="mb-4 h-16 w-16 text-muted-foreground/30" />
          <h3 class="text-lg font-semibold">暂无渠道</h3>
          <p class="mt-2 text-sm text-muted-foreground">添加你的第一个 API 渠道，开始使用中转网关</p>
          <Button class="mt-6" @click="openAdd"><Plus class="mr-2 h-4 w-4" />添加渠道</Button>
        </CardContent>
      </Card>
    </div>

    <div v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Card v-for="ch in channels" :key="ch.id" class="flex flex-col">
        <CardContent class="flex flex-1 flex-col p-5">
          <div class="flex items-start justify-between">
            <div class="flex items-center gap-3">
              <div :class="['flex h-11 w-11 items-center justify-center rounded-xl transition-shadow', ch.enabled ? 'bg-gradient-to-br from-brand-blue/25 to-brand-purple/25 shadow-glow-purple' : 'bg-muted']">
                <Cpu :class="['h-5 w-5', ch.enabled ? 'text-brand-blue drop-shadow-[0_0_6px_rgba(59,130,246,0.6)]' : 'text-muted-foreground']" />
              </div>
              <div>
                <h3 class="font-semibold">{{ ch.name }}</h3>
                <Badge variant="outline" class="mt-1">{{ ch.provider_type }}</Badge>
              </div>
            </div>
            <Switch :model-value="ch.enabled" @update:model-value="onToggle(ch)" />
          </div>

          <div class="mt-4 space-y-2 text-xs">
            <div class="flex items-center gap-2 text-muted-foreground">
              <Key class="h-3 w-3 shrink-0" />
              <span class="truncate font-mono">{{ ch.api_key ? ch.api_key.slice(0, 12) + '...' : '未设置' }}</span>
            </div>
            <div class="flex items-center gap-2 text-muted-foreground">
              <Settings2 class="h-3 w-3 shrink-0" />
              <span>RPM {{ ch.rpm_limit }} · 重试 {{ ch.retry_count }}</span>
<div v-if="healthOf(ch.id)" class="flex items-center gap-2 text-xs">
  <span class="inline-flex h-2 w-2 rounded-full"
    :class="healthOf(ch.id).status === 'ok' ? 'bg-brand-green' : healthOf(ch.id).status === 'fail' ? 'bg-destructive' : 'bg-muted-foreground/40'" />
  <span class="text-muted-foreground">健康: {{ healthLabel(healthOf(ch.id)) }}</span>
  <span v-if="healthOf(ch.id).latency_ms != null" class="text-muted-foreground">· {{ healthOf(ch.id).latency_ms }}ms</span>
</div>
            </div>
          </div>

          <!-- 卡片测试结果反馈 -->
          <div v-if="cardTestResult[ch.id]" class="mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
            :class="cardTestResult[ch.id].success ? 'bg-brand-green/10 text-brand-green' : 'bg-destructive/10 text-destructive'">
            <CheckCircle v-if="cardTestResult[ch.id].success" class="h-4 w-4 shrink-0" />
            <AlertCircle v-else class="h-4 w-4 shrink-0" />
            <span class="truncate">{{ cardTestResult[ch.id].message }}</span>
          </div>

          <!-- 卡片同步结果反馈 -->
          <div v-if="cardSyncResult[ch.id]" class="mt-3 rounded-lg px-3 py-2 text-xs"
            :class="cardSyncResult[ch.id].error ? 'bg-destructive/10 text-destructive' : 'bg-brand-blue/10 text-brand-blue'">
            <div v-if="cardSyncResult[ch.id].error" class="flex items-center gap-2">
              <AlertCircle class="h-4 w-4 shrink-0" />
              <span>同步失败：{{ cardSyncResult[ch.id].error }}</span>
            </div>
            <div v-else class="space-y-1">
              <div class="flex items-center gap-2 font-medium">
                <CheckCircle class="h-4 w-4 shrink-0" />
                <span>同步完成！共 {{ cardSyncResult[ch.id].total }} 个模型</span>
              </div>
              <div class="flex flex-wrap gap-3 text-muted-foreground">
                <span>新增 <b class="text-brand-green">{{ cardSyncResult[ch.id].added }}</b></span>
                <span>更新 <b class="text-brand-blue">{{ cardSyncResult[ch.id].updated }}</b></span>
                <span>跳过 <b class="text-muted-foreground">{{ cardSyncResult[ch.id].skipped }}</b></span>
                <span>文本 {{ cardSyncResult[ch.id].text }} / 图像 {{ cardSyncResult[ch.id].image }} / 视频 {{ cardSyncResult[ch.id].video }}</span>
              </div>
              <div class="text-muted-foreground">→ 去「模型库」页面查看和管理所有模型</div>
            </div>
          </div>

          <div class="mt-auto flex flex-wrap gap-2 border-t border-border/50 pt-4">
            <Button variant="outline" size="sm" @click="onTestCard(ch)" :loading="cardTesting[ch.id]">
              <Activity class="mr-1 h-3 w-3" />测试连接
            </Button>
            <Button variant="outline" size="sm" data-guide="sync-models" @click="onSync(ch)" :loading="cardSyncing[ch.id]">
              <RefreshCw class="mr-1 h-3 w-3" />同步模型
            </Button>
            <Button variant="ghost" size="sm" @click="openEdit(ch)">
              <Settings2 class="mr-1 h-3 w-3" />编辑
            </Button>
            <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="onDelete(ch)">
              <Trash2 class="mr-1 h-3 w-3" />删除
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- 编辑对话框 -->
    <Dialog v-model="dialogOpen" :title="editing ? '编辑渠道' : '添加渠道'" description="配置上游 API 渠道信息" size="lg">
      <div class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-medium">渠道名称 <span class="text-destructive">*</span></label>
            <Input v-model="form.name" placeholder="如：NVIDIA NIM、我的OpenAI号" />
            <p class="mt-1 text-xs text-muted-foreground">给这个渠道起个好记的名字，仅用于本地区分，不会发送给上游</p>
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium">渠道类型 <span class="text-destructive">*</span></label>
            <Select v-model="form.provider_type" :options="providerOptions" placeholder="选择渠道类型" @update:model-value="onProviderChange" />
            <p class="mt-1 text-xs text-muted-foreground">大多数服务商选 <code class="text-brand-blue">openai</code>；Anthropic选 anthropic；Google选 gemini；其他选 custom</p>
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium">API Base URL <span class="text-destructive">*</span></label>
          <Input v-model="form.base_url" placeholder="https://integrate.api.nvidia.com/v1" />
          <p class="mt-1 text-xs text-muted-foreground">
            上游API的根地址，通常以 <code class="text-brand-blue">/v1</code> 结尾。
            常见示例：NVIDIA NIM填 <code class="text-brand-blue">https://integrate.api.nvidia.com/v1</code>，
            OpenAI填 <code class="text-brand-blue">https://api.openai.com/v1</code>
          </p>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium">API Key <span class="text-destructive">*</span></label>
          <Input v-model="form.api_key" type="password" placeholder="nvapi-xxxxxxxx 或 sk-xxxxxxxx" />
          <p class="mt-1 text-xs text-muted-foreground">上游服务商的API密钥，<span class="text-amber-600">明文存储在本地 data/store.db</span>，不会上传到任何第三方。以 nvapi- 开头是NVIDIA，以 sk- 开头是OpenAI</p>
        </div>

        <!-- 额外配置（JSON 格式，所有渠道都可配置） -->
        <div>
          <label class="mb-1.5 block text-sm font-medium">额外配置（JSON 格式，可选）</label>
          <Textarea v-model="form.extra_config" rows="4" placeholder='{}' class="font-mono text-xs" />
          <p class="mt-1 text-xs text-muted-foreground">
            <span class="font-medium">绝大多数渠道保持 <code class="text-brand-blue">{}</code> 即可，不需要填！</span>
            仅以下特殊渠道需要：
          </p>
          <ul class="mt-1 list-inside list-disc text-xs text-muted-foreground">
            <li>Cloudflare Workers AI：<code class="text-brand-blue">{"account_id": "你的账户ID"}</code></li>
            <li>Azure OpenAI：<code class="text-brand-blue">{"api_version": "2024-02-01"}</code></li>
            <li>需要自定义请求头：<code class="text-brand-blue">{"headers": {"X-Org": "xxx"}}</code></li>
          </ul>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-medium">RPM 限制（每分钟请求数）</label>
            <Input v-model.number="form.rpm_limit" type="number" placeholder="60" />
            <p class="mt-1 text-xs text-muted-foreground">上游API的每分钟请求上限，免费密钥通常较低（如10-40），付费密钥较高（如60-600）。填0表示不限制</p>
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium">重试次数</label>
            <Input v-model.number="form.retry_count" type="number" placeholder="2" />
            <p class="mt-1 text-xs text-muted-foreground">请求失败时自动重试的次数。0=不重试，-1=跟随全局默认，建议 2-3 次</p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Switch v-model="form.enabled" />
          <span class="text-sm">创建后立即启用</span>
        </div>

        <!-- 对话框内测试 -->
        <div v-if="editing" class="flex items-center gap-2">
          <Button variant="outline" size="sm" @click="onTestDialog" :loading="testing">
            <Activity class="mr-1 h-3 w-3" />测试连接
          </Button>
        </div>

        <!-- 测试结果 -->
        <div v-if="testResult" class="flex items-center gap-2 rounded-lg p-3" :class="testResult.success ? 'bg-brand-green/10' : 'bg-destructive/10'">
          <CheckCircle v-if="testResult.success" class="h-5 w-5 text-brand-green" />
          <AlertCircle v-else class="h-5 w-5 text-destructive" />
          <span class="text-sm">{{ testResult.message }}</span>
        </div>
      </div>

      <template #footer>
        <Button variant="outline" @click="dialogOpen = false">取消</Button>
        <Button @click="save">{{ editing ? '保存' : '创建' }}</Button>
      </template>
    </Dialog>
  </div>
</template>
