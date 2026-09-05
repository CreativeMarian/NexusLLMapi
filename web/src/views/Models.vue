<script setup>
import { ref, onMounted, computed, watch, nextTick } from 'vue'
import {
  getModels, toggleModel, batchToggleModels, updateModel,
  getModelTags, testModelSpeed, deleteModel,
  batchTestModels, batchDeleteModels
} from '@/api/model'
import { getChannels } from '@/api/channel'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Badge from '@/components/ui/Badge.vue'
import Switch from '@/components/ui/Switch.vue'
import Select from '@/components/ui/Select.vue'
import Checkbox from '@/components/ui/Checkbox.vue'
import Dialog from '@/components/ui/Dialog.vue'
import {
  Cpu, Search, Filter, Power, PowerOff, Edit3, X,
  Image as ImageIcon, Video, Layers, ArrowUpDown, Mic, Volume2, FileText, Copy, Check, Link, Key, Settings, Terminal,
  Zap, Loader2, Trash2, Activity, CheckCircle2, XCircle, AlertTriangle, RefreshCw
} from 'lucide-vue-next'

const loading = ref(true)
const models = ref([])
const total = ref(0)
const channels = ref([])
const tags = ref([])

// 筛选
const keyword = ref('')
const modalType = ref('')
const tagFilter = ref('')
const channelFilter = ref('')
const enabledFilter = ref('')
const page = ref(1)
const pageSize = ref(48)

// 批量选择
const selected = ref(new Set())

// 编辑别名
const editDialog = ref(false)
const editingModel = ref(null)
const aliasInput = ref('')

// 配置信息对话框
const configDialog = ref(false)
const configModel = ref(null)
const copiedField = ref('')

// 模型速度测试（单个）
const testingId = ref(null)
const testResults = ref({})

// 批量检测
const batchTesting = ref(false)
const batchTestResults = ref({}) // model_id -> result
const batchTestSummary = ref(null) // { total, success, failed }

// 删除确认
const deleteDialog = ref(false)
const deletingModel = ref(null)
const deletingIds = ref([])
const deleteText = ref('')

// 弹窗打开后自动 focus 到确认输入框，引导用户输入"删除"
watch(deleteDialog, (v) => {
  if (v) {
    nextTick(() => {
      const input = document.querySelector('.glass-strong input')
      if (input) input.focus()
    })
  }
})

const modalTypeOptions = [
  { value: '', label: '全部模态' },
  { value: 'text', label: '文本' },
  { value: 'image', label: '图像' },
  { value: 'video', label: '视频' },
  { value: 'embedding', label: '嵌入' },
  { value: 'rerank', label: '重排' },
  { value: 'asr', label: '语音识别' },
  { value: 'tts', label: '语音合成' }
]

const enabledOptions = [
  { value: '', label: '全部状态' },
  { value: 'true', label: '已启用' },
  { value: 'false', label: '已停用' }
]

const channelOptions = computed(() => [
  { value: '', label: '全部渠道' },
  ...channels.value.map(c => ({ value: String(c.id), label: c.name }))
])

const tagOptions = computed(() => [
  { value: '', label: '全部分类' },
  ...tags.value.map(t => ({ value: t, label: t }))
])

// 配置信息计算
const configBaseUrl = computed(() => `${window.location.protocol}//${window.location.host}/v1`)
const configChannel = computed(() => {
  if (!configModel.value) return null
  return channels.value.find(c => c.id === configModel.value.channel_id) || null
})
const configApiKey = computed(() => configChannel.value?.api_key || '（未设置 API Key，请在渠道管理中配置）')

// 批量检测失败的模型 ID 列表（跨页汇总：结果自带 DB id，不依赖当前页数据）
const failedModelIds = computed(() => {
  const ids = []
  for (const r of Object.values(batchTestResults.value)) {
    if (r && r.success === false && r.id) ids.push(r.id)
  }
  return ids
})

async function copyText(text, field) {
  try {
    await navigator.clipboard.writeText(text)
    copiedField.value = field
    setTimeout(() => { copiedField.value = '' }, 2000)
  } catch (e) {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    copiedField.value = field
    setTimeout(() => { copiedField.value = '' }, 2000)
  }
}

function openConfig(m) {
  configModel.value = m
  configDialog.value = true
}

async function loadData() {
  loading.value = true
  selected.value.clear()
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (keyword.value) params.keyword = keyword.value
    if (modalType.value) params.modal_type = modalType.value
    if (tagFilter.value) params.tag = tagFilter.value
    if (channelFilter.value) params.channel_id = channelFilter.value
    if (enabledFilter.value) params.enabled = enabledFilter.value

    const res = await getModels(params)
    models.value = res.data || []
    total.value = res.total || 0
  } catch (e) { console.error(e) }
  finally { loading.value = false }
}

async function loadMeta() {
  try {
    const [chRes, tagRes] = await Promise.all([getChannels(), getModelTags()])
    channels.value = chRes.data || []
    tags.value = tagRes.data || []
  } catch (e) { console.error(e) }
}

function resetFilters() {
  keyword.value = ''; modalType.value = ''; tagFilter.value = ''
  channelFilter.value = ''; enabledFilter.value = ''; page.value = 1
  loadData()
}

// 筛选条件变更：必须重置到第 1 页，否则在非首页时 offset 越界会返回空列表
function applyFilters() {
  page.value = 1
  loadData()
}

function toggleSelect(id) {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
}

async function onToggle(m) {
  try { await toggleModel(m.id, !m.enabled); m.enabled = !m.enabled } catch (e) { alert('操作失败') }
}

async function onBatchToggle(enabled) {
  if (selected.value.size === 0) { alert('请先选择模型'); return }
  try {
    await batchToggleModels([...selected.value], enabled)
    models.value.forEach(m => { if (selected.value.has(m.id)) m.enabled = enabled })
    selected.value.clear()
  } catch (e) { alert('批量操作失败') }
}

async function onTestSpeed(m) {
  if (testingId.value) return
  testingId.value = m.id
  try {
    const res = await testModelSpeed(m.id)
    const data = res.data || res
    testResults.value[m.id] = data
    // 同步到批量检测结果（保持「删除失效模型」名单一致）
    batchTestResults.value[m.model_id] = data
  } catch (e) {
    const data = { id: m.id, success: false, error: e.message || '测试失败', duration_ms: 0 }
    testResults.value[m.id] = data
    batchTestResults.value[m.model_id] = data
  } finally {
    testingId.value = null
  }
}

// 一键检测当前页所有已启用模型
async function onBatchTest() {
  if (batchTesting.value) return
  const toTest = models.value.filter(m => m.enabled)
  if (toTest.length === 0) {
    alert('当前页面没有已启用的模型')
    return
  }

  batchTesting.value = true
  batchTestResults.value = {}
  batchTestSummary.value = null

  try {
    const ids = toTest.map(m => m.id)
    const res = await batchTestModels({ ids })
    const data = res.data || res

    // 将结果按 model_id 索引
    const resultMap = {}
    for (const r of (data.results || [])) {
      resultMap[r.model_id] = r
    }
    batchTestResults.value = resultMap
    batchTestSummary.value = {
      total: data.total || 0,
      success: data.success || 0,
      failed: data.failed || 0
    }
  } catch (e) {
    alert('批量检测失败: ' + (e.message || '未知错误'))
  } finally {
    batchTesting.value = false
  }
}

// 打开删除确认（单个）
function openDelete(m) {
  deletingModel.value = m
  deletingIds.value = [m.id]
  deleteText.value = ''
  deleteDialog.value = true
}

// 打开批量删除确认
function openBatchDelete(ids) {
  if (ids.length === 0) { alert('没有要删除的模型'); return }
  deletingModel.value = null
  deletingIds.value = ids
  deleteText.value = ''
  deleteDialog.value = true
}

// 确认删除
async function confirmDelete() {
  if (deleteText.value !== '删除') {
    alert('请输入"删除"以确认')
    return
  }

  try {
    if (deletingIds.value.length === 1) {
      await deleteModel(deletingIds.value[0])
    } else {
      await batchDeleteModels(deletingIds.value)
    }

    // 先快照待删 ID（清空 deletingIds 后再读取会得到空集合，导致本地乐观删除与 total 递减失效）
    const deletedIds = new Set(deletingIds.value)
    const deletedCount = deletingIds.value.length

    deleteDialog.value = false
    deletingModel.value = null
    deletingIds.value = []

    // 清除被删除模型的检测结果
    models.value = models.value.filter(m => !deletedIds.has(m.id))
    total.value = Math.max(0, total.value - deletedCount)

    // 重新加载数据
    loadData()
  } catch (e) {
    alert('删除失败: ' + (e.message || '未知错误'))
  }
}

// 一键删除所有模型配置
const deletingAll = ref(false)
async function deleteAllModels() {
  if (!confirm('确定要删除所有模型配置吗？此操作不可恢复！\n\n渠道配置和API Key将保留，仅删除模型列表。')) {
    return
  }
  deletingAll.value = true
  try {
    // 后端分页 pageSize 上限 500，必须循环拉取才能拿到全部模型
    const allIds = []
    for (let p = 1; ; p++) {
      const res = await getModels({ page: p, page_size: 500 })
      const list = res.data || []
      allIds.push(...list.map(m => m.id))
      if (allIds.length >= (res.total || 0) || list.length === 0) break
    }
    if (allIds.length === 0) {
      alert('没有可删除的模型')
      return
    }
    if (!confirm(`将删除 ${allIds.length} 个模型配置，确定继续？`)) {
      return
    }
    await batchDeleteModels(allIds)
    models.value = []
    total.value = 0
    selected.value.clear()
    batchTestResults.value = {}
    batchTestSummary.value = null
    loadData()
  } catch (e) {
    alert('删除失败: ' + (e.message || '未知错误'))
  } finally {
    deletingAll.value = false
  }
}

// 全部启动：启用所有模型配置（跨页循环拉取）
const enablingAll = ref(false)
async function enableAllModels() {
  if (enablingAll.value) return
  const allIds = []
  for (let p = 1; ; p++) {
    const res = await getModels({ page: p, page_size: 500 })
    const list = res.data || []
    allIds.push(...list.map(m => m.id))
    if (allIds.length >= (res.total || 0) || list.length === 0) break
  }
  if (allIds.length === 0) { alert('没有可启用的模型'); return }
  if (!confirm(`将启用全部 ${allIds.length} 个模型，确定继续？`)) return
  enablingAll.value = true
  try {
    await batchToggleModels(allIds, true)
    selected.value.clear()
    loadData()
    alert(`已启用 ${allIds.length} 个模型`)
  } catch (e) {
    alert('全部启动失败: ' + (e.message || '未知错误'))
  } finally {
    enablingAll.value = false
  }
}

function getSpeedBadge(result) {
  if (!result) return null
  if (!result.success) return { text: '失败', class: 'bg-destructive/10 text-destructive' }
  if (result.speed_level === 'fast') return { text: '快', class: 'bg-green-500/15 text-green-400' }
  if (result.speed_level === 'medium') return { text: '中', class: 'bg-yellow-500/15 text-yellow-400' }
  return { text: '慢', class: 'bg-orange-500/15 text-orange-400' }
}

function getBatchTestStatus(m) {
  return batchTestResults.value[m.model_id]
}

function openEdit(m) {
  editingModel.value = m
  aliasInput.value = m.alias || ''
  editDialog.value = true
}

async function saveAlias() {
  try {
    await updateModel(editingModel.value.id, { alias: aliasInput.value })
    editingModel.value.alias = aliasInput.value
    editDialog.value = false
  } catch (e) { alert('保存失败') }
}

function getModalIcon(type) {
  if (type === 'image') return ImageIcon
  if (type === 'video') return Video
  if (type === 'embedding') return Layers
  if (type === 'rerank') return ArrowUpDown
  if (type === 'asr') return Mic
  if (type === 'tts') return Volume2
  return FileText
}

function getModalColor(type) {
  if (type === 'image') return 'text-brand-purple'
  if (type === 'video') return 'text-brand-orange'
  if (type === 'embedding') return 'text-brand-green'
  if (type === 'rerank') return 'text-amber-400'
  if (type === 'asr') return 'text-cyan-400'
  if (type === 'tts') return 'text-pink-400'
  return 'text-brand-blue'
}

function parseTags(tagsStr) {
  try { return JSON.parse(tagsStr) } catch { return [] }
}

// 根据 channel_id 获取渠道名称
function getChannelName(channelId) {
  const ch = channels.value.find(c => c.id === channelId)
  return ch ? ch.name : '未知渠道'
}

// 渠道颜色映射（根据渠道ID哈希生成稳定颜色）
const channelColors = {}
function getChannelColor(channelId) {
  if (channelColors[channelId]) return channelColors[channelId]
  const colors = [
    'bg-blue-500/15 text-blue-400 border-blue-500/20',
    'bg-green-500/15 text-green-400 border-green-500/20',
    'bg-purple-500/15 text-purple-400 border-purple-500/20',
    'bg-orange-500/15 text-orange-400 border-orange-500/20',
    'bg-pink-500/15 text-pink-400 border-pink-500/20',
    'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',
    'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
    'bg-red-500/15 text-red-400 border-red-500/20',
  ]
  const idx = Number(channelId) % colors.length
  channelColors[channelId] = colors[idx]
  return channelColors[channelId]
}

const totalPages = computed(() => Math.ceil(total.value / pageSize.value))

onMounted(async () => { await loadMeta(); loadData() })
</script>

<template>
  <div class="space-y-6">
    <div class="glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-purple/30 bg-brand-purple/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-purple">
          <Cpu class="h-3 w-3" />MODEL REGISTRY
        </span>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">模型库</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ nexus models list <span class="text-brand-blue">--filter {{ total }} --page 1</span>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          :disabled="enablingAll || total === 0"
          @click="enableAllModels"
        >
          <Loader2 v-if="enablingAll" class="mr-2 h-4 w-4 animate-spin" />
          <Power v-else class="mr-2 h-4 w-4" />
          {{ enablingAll ? '启动中...' : '全部启动' }}
        </Button>
        <Button data-guide="check-models"
          :disabled="batchTesting"
          @click="onBatchTest"
        >
          <Loader2 v-if="batchTesting" class="mr-2 h-4 w-4 animate-spin" />
          <Activity v-else class="mr-2 h-4 w-4" />
          {{ batchTesting ? '检测中...' : '一键检测连接' }}
        </Button>
        <Button
          variant="outline"
          :disabled="deletingAll || total === 0"
          class="text-destructive hover:bg-destructive/10 border-destructive/30"
          @click="deleteAllModels"
        >
          <Loader2 v-if="deletingAll" class="mr-2 h-4 w-4 animate-spin" />
          <Trash2 v-else class="mr-2 h-4 w-4" />
          一键删除所有模型
        </Button>
      </div>
    </div>

    <!-- 筛选栏 -->
    <Card className="relative z-30">
      <CardContent class="p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="relative flex-1 min-w-[200px]">
            <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="keyword" placeholder="搜索模型 ID 或别名..." class="pl-9" @keyup.enter="applyFilters" />
          </div>
          <Select v-model="modalType" :options="modalTypeOptions" class="w-32" @update:model-value="applyFilters" />
          <Select v-model="tagFilter" :options="tagOptions" class="w-36" @update:model-value="applyFilters" />
          <Select v-model="channelFilter" :options="channelOptions" class="w-40" @update:model-value="applyFilters" />
          <Select v-model="enabledFilter" :options="enabledOptions" class="w-32" @update:model-value="applyFilters" />
          <Button variant="ghost" size="sm" @click="resetFilters"><X class="h-4 w-4" /></Button>
        </div>

        <!-- 批量操作栏 -->
        <div v-if="selected.size > 0" class="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-primary/5 p-2">
          <span class="text-sm text-primary">已选 {{ selected.size }} 个模型</span>
          <Button variant="outline" size="sm" @click="onBatchToggle(true)"><Power class="mr-1 h-3 w-3" />批量启用</Button>
          <Button variant="outline" size="sm" @click="onBatchToggle(false)"><PowerOff class="mr-1 h-3 w-3" />批量停用</Button>
          <Button variant="outline" size="sm" class="text-destructive hover:bg-destructive/10" @click="openBatchDelete([...selected])">
            <Trash2 class="mr-1 h-3 w-3" />批量删除
          </Button>
        </div>

        <!-- 批量检测结果汇总 -->
        <div v-if="batchTestSummary" class="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border/50 p-3">
          <div class="flex items-center gap-4 text-sm">
            <span class="flex items-center gap-1.5">
              <Activity class="h-4 w-4 text-primary" />
              检测完成
            </span>
            <span class="flex items-center gap-1 text-brand-green">
              <CheckCircle2 class="h-4 w-4" />
              {{ batchTestSummary.success }} 个正常
            </span>
            <span class="flex items-center gap-1 text-destructive">
              <XCircle class="h-4 w-4" />
              {{ batchTestSummary.failed }} 个失效
            </span>
          </div>
          <div class="flex-1" />
          <Button
            v-if="failedModelIds.length > 0"
            variant="outline"
            size="sm"
            class="text-destructive hover:bg-destructive/10"
            @click="openBatchDelete(failedModelIds)"
          >
            <Trash2 class="mr-1 h-3 w-3" />
            删除 {{ failedModelIds.length }} 个失效模型
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="text-destructive hover:bg-destructive/10"
            :disabled="deletingAll"
            @click="deleteAllModels"
          >
            <Trash2 class="mr-1 h-3 w-3" />
            删除所有模型
          </Button>
          <Button variant="ghost" size="sm" @click="batchTestSummary = null; batchTestResults = {}">
            <X class="h-3 w-3" />清除结果
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- 模型卡片网格 -->
    <div v-if="loading" class="py-12 text-center text-muted-foreground">
      <Cpu class="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />加载中...
    </div>

    <div v-else-if="models.length === 0" class="py-16">
      <Card>
        <CardContent class="flex flex-col items-center py-12">
          <Cpu class="mb-4 h-16 w-16 text-muted-foreground/30" />
          <h3 class="text-lg font-semibold">暂无模型</h3>
          <p class="mt-2 text-sm text-muted-foreground">请先在渠道管理中添加渠道并同步模型</p>
          <router-link to="/channels" class="mt-6">
            <Button>前往渠道管理</Button>
          </router-link>
        </CardContent>
      </Card>
    </div>

    <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <Card
        v-for="m in models"
        :key="m.id"
        :class="['flex flex-col cursor-pointer',
          selected.has(m.id) ? 'ring-2 ring-primary shadow-glow-purple' : '',
          getBatchTestStatus(m)?.success === false ? 'border-destructive/40' : ''
        ]"
        @click="openConfig(m)"
      >
        <CardContent class="flex flex-1 flex-col p-4">
          <div class="flex flex-1 items-start gap-3">
            <Checkbox :model-value="selected.has(m.id)" class="mt-1" @click.stop @update:model-value="toggleSelect(m.id)" />
            <div class="min-w-0 flex-1 self-stretch flex flex-col justify-center">
              <div class="flex items-center gap-2">
                <component :is="getModalIcon(m.modal_type)" :class="['h-4 w-4 shrink-0', getModalColor(m.modal_type)]" />
                <h4 class="truncate text-sm font-medium" :title="m.model_id">{{ m.model_id }}</h4>
              </div>
              <p v-if="m.alias" class="mt-0.5 truncate text-xs text-brand-blue" :title="m.alias">别名: {{ m.alias }}</p>
              <!-- 渠道来源标签 -->
              <div class="mt-1 flex items-center gap-1">
                <Link class="h-3 w-3 shrink-0 text-muted-foreground" />
                <span
                  class="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                  :class="getChannelColor(m.channel_id)"
                  :title="`来源渠道: ${getChannelName(m.channel_id)}`"
                >
                  {{ getChannelName(m.channel_id) }}
                </span>
              </div>
              <div class="mt-2 flex flex-wrap gap-1">
                <Badge v-for="t in parseTags(m.tags)" :key="t" variant="secondary" class="text-[10px]">{{ t }}</Badge>
              </div>

              <!-- 批量检测状态图标 -->
              <div v-if="getBatchTestStatus(m)" class="mt-2 flex items-center gap-1.5">
                <CheckCircle2 v-if="getBatchTestStatus(m).success" class="h-3.5 w-3.5 text-brand-green" />
                <XCircle v-else class="h-3.5 w-3.5 text-destructive" />
                <span
                  v-if="getBatchTestStatus(m).success"
                  class="text-[11px] text-brand-green"
                >
                  {{ getBatchTestStatus(m).duration_ms }}ms
                </span>
                <span
                  v-else
                  class="truncate text-[11px] text-destructive"
                  :title="getBatchTestStatus(m).error"
                >
                  {{ getBatchTestStatus(m).error || '连接失败' }}
                </span>
              </div>

              <!-- 单模型速度测试结果 -->
              <div v-if="testResults[m.id]" class="mt-2 rounded-md bg-muted/50 p-2" @click.stop>
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      :class="getSpeedBadge(testResults[m.id])?.class"
                    >
                      {{ getSpeedBadge(testResults[m.id])?.text }}
                    </span>
                    <span class="text-xs font-medium">{{ testResults[m.id].duration_ms }}ms</span>
                  </div>
                  <span class="text-[10px] text-muted-foreground">{{ testResults[m.id].total_tokens || 0 }} tokens</span>
                </div>
                <p v-if="testResults[m.id].content_preview" class="mt-1 truncate text-[10px] text-muted-foreground" :title="testResults[m.id].content_preview">
                  {{ testResults[m.id].content_preview }}
                </p>
                <p v-if="!testResults[m.id].success && testResults[m.id].error" class="mt-1 truncate text-[10px] text-destructive" :title="testResults[m.id].error">
                  {{ testResults[m.id].error }}
                </p>
              </div><div class="mt-2 flex items-center justify-between">
                <span class="text-xs text-muted-foreground">{{ m.modal_type }} · {{ m.max_context }}k</span>
                <div class="flex items-center gap-1" @click.stop>
                  <button
                    class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    :title="testResults[m.id] ? `上次测试: ${testResults[m.id].duration_ms}ms` : '测试连接速度'"
                    @click="onTestSpeed(m)"
                  >
                    <Zap v-if="testingId !== m.id" class="h-3.5 w-3.5" />
                    <Loader2 v-else class="h-3.5 w-3.5 animate-spin" />
                  </button>
                  <button class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="编辑别名" @click="openEdit(m)">
                    <Edit3 class="h-3.5 w-3.5" />
                  </button>
                  <button class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" data-guide="copy-config" title="查看配置" @click="openConfig(m)">
                    <Settings class="h-3.5 w-3.5" />
                  </button>
                  <button
                    class="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title="删除模型"
                    @click="openDelete(m)"
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                  </button>
                  <Switch :model-value="m.enabled" size="sm" @update:model-value="onToggle(m)" />
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="flex items-center justify-center gap-2">
      <Button variant="outline" size="sm" :disabled="page <= 1" @click="page--; loadData()">上一页</Button>
      <span class="text-sm text-muted-foreground">{{ page }} / {{ totalPages }}</span>
      <Button variant="outline" size="sm" :disabled="page >= totalPages" @click="page++; loadData()">下一页</Button>
    </div>

    <!-- 编辑别名对话框 -->
    <Dialog v-model="editDialog" title="编辑模型别名" description="设置自定义别名后，可通过别名调用该模型" size="sm">
      <div class="space-y-4">
        <div>
          <label class="mb-1.5 block text-sm font-medium">模型 ID</label>
          <Input :model-value="editingModel?.model_id" disabled />
        </div>
        <div>
          <label class="mb-1.5 block text-sm font-medium">自定义别名</label>
          <Input v-model="aliasInput" placeholder="如：gpt-4" />
          <p class="mt-1 text-xs text-muted-foreground">留空则不设置别名</p>
        </div>
      </div>
      <template #footer>
        <Button variant="outline" @click="editDialog = false">取消</Button>
        <Button @click="saveAlias">保存</Button>
      </template>
    </Dialog>

    <!-- 删除确认对话框 -->
    <Dialog v-model="deleteDialog" title="确认删除模型" size="sm">
      <div class="space-y-4">
        <div class="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div class="text-sm">
            <p v-if="deletingModel">
              确定要删除模型 <strong class="font-mono">{{ deletingModel.model_id }}</strong> 吗？
            </p>
            <p v-else>
              确定要删除选中的 <strong>{{ deletingIds.length }}</strong> 个模型吗？
            </p>
            <p class="mt-1 text-xs text-muted-foreground">删除后不可恢复，相关的路由配置也会同步移除。</p>
          </div>
        </div>
        <div>
          <label class="mb-1.5 block text-sm font-medium">请输入"删除"以确认</label>
          <Input v-model="deleteText" placeholder="删除" />
        </div>
      </div>
      <template #footer>
        <Button variant="outline" @click="deleteDialog = false">取消</Button>
        <Button variant="destructive" :disabled="deleteText !== '删除'" @click="confirmDelete">
          <Trash2 class="mr-2 h-4 w-4" />确认删除
        </Button>
      </template>
    </Dialog>

    <!-- 配置信息对话框 -->
    <Dialog v-model="configDialog" title="客户端配置信息" description="将以下参数填入你的 AI 客户端即可使用该模型" size="lg">
      <div v-if="configModel" class="space-y-5">
        <!-- 模型基本信息 -->
        <div class="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
          <component :is="getModalIcon(configModel.modal_type)" :class="['h-6 w-6', getModalColor(configModel.modal_type)]" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ configModel.model_id }}</p>
            <p class="text-xs text-muted-foreground">
              {{ configModel.modal_type }} · {{ configModel.max_context }}k 上下文
              <span v-if="configChannel"> · 渠道: {{ configChannel.name }}</span>
            </p>
          </div>
          <Badge :variant="configModel.enabled ? 'success' : 'secondary'">
            {{ configModel.enabled ? '已启用' : '已停用' }}
          </Badge>
        </div>

        <!-- 配置参数 -->
        <div class="space-y-3">
          <!-- Base URL -->
          <div>
            <label class="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
              <Link class="h-3.5 w-3.5" />代理地址（Base URL）
            </label>
            <div class="flex gap-2">
              <Input :model-value="configBaseUrl" readonly class="font-mono text-xs" />
              <Button variant="outline" size="icon" class="shrink-0" @click="copyText(configBaseUrl, 'baseUrl')">
                <Check v-if="copiedField === 'baseUrl'" class="h-4 w-4 text-brand-green" />
                <Copy v-else class="h-4 w-4" />
              </Button>
            </div>
          </div>

          <!-- 模型 ID -->
          <div>
            <label class="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
              <Cpu class="h-3.5 w-3.5" />模型 ID（Model）
            </label>
            <div class="flex gap-2">
              <Input :model-value="configModel.model_id" readonly class="font-mono text-xs" />
              <Button variant="outline" size="icon" class="shrink-0" @click="copyText(configModel.model_id, 'modelId')">
                <Check v-if="copiedField === 'modelId'" class="h-4 w-4 text-brand-green" />
                <Copy v-else class="h-4 w-4" />
              </Button>
            </div>
            <p v-if="configModel.alias" class="mt-1 text-xs text-brand-blue">也可使用别名: {{ configModel.alias }}</p>
          </div>

          <!-- API Key -->
          <div>
            <label class="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
              <Key class="h-3.5 w-3.5" />API Key
            </label>
            <div class="flex gap-2">
              <Input :model-value="configApiKey" readonly type="password" class="font-mono text-xs" />
              <Button v-if="configChannel && configChannel.api_key" variant="outline" size="icon" class="shrink-0" @click="copyText(configApiKey, 'apiKey')">
                <Check v-if="copiedField === 'apiKey'" class="h-4 w-4 text-brand-green" />
                <Copy v-else class="h-4 w-4" />
              </Button>
            </div>
            <p v-if="!configChannel || !configChannel.api_key" class="mt-1 text-xs text-destructive">
              该渠道未配置 API Key，请先在渠道管理中设置
            </p>
          </div>
        </div>

        <!-- 客户端配置说明 -->
        <div class="rounded-lg border border-border/50 p-4">
          <p class="mb-3 text-sm font-medium">支持的客户端类型</p>
          <div class="space-y-2 text-xs text-muted-foreground">
            <div class="flex items-start gap-2">
              <Terminal class="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-blue" />
              <span><strong class="text-foreground">OpenAI 兼容客户端</strong>：API 格式选 OpenAI，Base URL 填上面的代理地址，Model 填模型 ID</span>
            </div>
            <div class="flex items-start gap-2">
              <Terminal class="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-purple" />
              <span><strong class="text-foreground">TraeWork / Cherry Studio</strong>：自定义模型 → API 格式选 OpenAI Chat Completions → 填入上述三项参数</span>
            </div>
            <div class="flex items-start gap-2">
              <Terminal class="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-green" />
              <span><strong class="text-foreground">curl 测试</strong>：<code class="rounded bg-muted px-1.5 py-0.5 font-mono">curl {{ configBaseUrl }}/chat/completions -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"model":"{{ configModel.model_id }}","messages":[{"role":"user","content":"hi"}]}'</code></span>
            </div>
          </div>
        </div>

        <!-- 一键复制全部 -->
        <Button class="w-full" @click="copyText(`Base URL: ${configBaseUrl}\nModel: ${configModel.model_id}\nAPI Key: ${configApiKey}`, 'all')">
          <Check v-if="copiedField === 'all'" class="mr-2 h-4 w-4" />
          <Copy v-else class="mr-2 h-4 w-4" />
          {{ copiedField === 'all' ? '已复制全部配置' : '一键复制全部配置' }}
        </Button>
      </div>

      <template #footer>
        <Button variant="outline" @click="configDialog = false">关闭</Button>
      </template>
    </Dialog>
  </div>
</template>
