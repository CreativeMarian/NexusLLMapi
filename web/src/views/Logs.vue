<script setup>
import { ref, onMounted, computed } from 'vue'
import { getLogs, clearLogs, getLog, getServerLogs, getServerLogStats } from '@/api/log'
import { getChannels } from '@/api/channel'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Badge from '@/components/ui/Badge.vue'
import Select from '@/components/ui/Select.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Table from '@/components/ui/Table.vue'
import TableHeader from '@/components/ui/TableHeader.vue'
import TableBody from '@/components/ui/TableBody.vue'
import TableRow from '@/components/ui/TableRow.vue'
import TableHead from '@/components/ui/TableHead.vue'
import TableCell from '@/components/ui/TableCell.vue'
import {
  ScrollText, Search, Trash2, Eye, RefreshCw,
  CheckCircle, AlertCircle, Clock, Cpu, Server, Activity
} from 'lucide-vue-next'

// Tab 切换
const activeTab = ref('request') // 'request' | 'server'

// ===== 请求日志 =====
const loading = ref(true)
const logs = ref([])
const total = ref(0)
const channels = ref([])

const keyword = ref('')
const channelFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const detailOpen = ref(false)
const detailLog = ref(null)

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: '200', label: '成功 (200)' },
  { value: '429', label: '限流 (429)' },
  { value: '500', label: '错误 (500)' },
  { value: '503', label: '不可用 (503)' }
]

const channelOptions = computed(() => [
  { value: '', label: '全部渠道' },
  ...channels.value.map(c => ({ value: String(c.id), label: c.name }))
])

async function loadData() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (keyword.value) params.model = keyword.value
    if (channelFilter.value) params.channel_id = channelFilter.value
    if (statusFilter.value) params.status_code = statusFilter.value
    const res = await getLogs(params)
    logs.value = res.data || []
    total.value = res.total || 0
  } catch (e) { console.error(e) }
  finally { loading.value = false }
}

// 筛选条件变更：必须重置到第 1 页，否则在非首页时 offset 越界会返回空列表
function applyFilters() {
  page.value = 1
  loadData()
}

async function loadChannels() {
  try {
    const res = await getChannels()
    channels.value = res.data || []
  } catch (e) { console.error(e) }
}

async function viewDetail(log) {
  try {
    const res = await getLog(log.id)
    detailLog.value = res.data
    detailOpen.value = true
  } catch (e) { alert('获取详情失败') }
}

async function onClear() {
  if (!confirm('确定清空所有请求日志？此操作不可恢复。')) return
  try { await clearLogs(); loadData() } catch (e) { alert('清空失败') }
}

function getStatusBadge(status) {
  if (status == null) return { variant: 'secondary', text: '-' }
  if (status === 0) return { variant: 'destructive', text: '失败' }
  if (status >= 200 && status < 300) return { variant: 'success', text: '成功' }
  if (status === 429) return { variant: 'warning', text: '限流' }
  if (status === 404) return { variant: 'destructive', text: '未找到' }
  if (status >= 500) return { variant: 'destructive', text: '错误' }
  return { variant: 'secondary', text: String(status) }
}

// ===== 服务运行日志 =====
const serverLoading = ref(true)
const serverLogs = ref([])
const serverTotal = ref(0)
const serverStats = ref(null)

const serverKeyword = ref('')
const serverLevel = ref('')
const serverPage = ref(1)
const serverPageSize = ref(50)

const levelOptions = [
  { value: '', label: '全部级别' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARN', label: 'WARN' },
  { value: 'ERROR', label: 'ERROR' }
]

async function loadServerData() {
  serverLoading.value = true
  try {
    const params = { page: serverPage.value, page_size: serverPageSize.value }
    if (serverKeyword.value) params.keyword = serverKeyword.value
    if (serverLevel.value) params.level = serverLevel.value
    const res = await getServerLogs(params)
    serverLogs.value = res.data || []
    serverTotal.value = res.total || 0
  } catch (e) { console.error(e) }
  finally { serverLoading.value = false }
}

// 筛选条件变更：与请求日志一致，先重置到第 1 页，否则在非首页时 offset 越界返回空列表
function applyServerFilters() {
  serverPage.value = 1
  loadServerData()
}

async function loadServerStats() {
  try {
    const res = await getServerLogStats()
    serverStats.value = res.data
  } catch (e) { console.error(e) }
}

function getLevelBadge(level) {
  if (level === 'INFO') return { variant: 'secondary', text: 'INFO' }
  if (level === 'WARN') return { variant: 'warning', text: 'WARN' }
  if (level === 'ERROR') return { variant: 'destructive', text: 'ERROR' }
  return { variant: 'secondary', text: level || '-' }
}

// ===== 通用函数 =====
function formatDuration(ms) {
  if (ms == null || ms === '') return '-'
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(2) + 's'
}

function formatTime(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatServerTime(timeStr) {
  if (!timeStr) return '-'
  // 格式: 2026-08-27T08:00:47.823+08:00
  const d = new Date(timeStr)
  if (isNaN(d.getTime())) return timeStr.substring(11, 19)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const totalPages = computed(() => Math.ceil(total.value / pageSize.value))
const serverTotalPages = computed(() => Math.ceil(serverTotal.value / serverPageSize.value))

function switchTab(tab) {
  activeTab.value = tab
  if (tab === 'server') {
    serverPage.value = 1
    loadServerData()
    loadServerStats()
  } else {
    page.value = 1
    loadData()
  }
}

onMounted(async () => { await loadChannels(); loadData() })
</script>

<template>
  <div class="space-y-6">
    <!-- 标题 -->
    <div class="glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-green/30 bg-brand-green/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-green">
          <ScrollText class="h-3 w-3" />EVENT STREAM
        </span>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">日志中心</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ nexus logs <span class="text-brand-blue">--tail</span>
          <span v-if="activeTab === 'request'" class="text-muted-foreground/60">· {{ total }} requests</span>
          <span v-else class="text-muted-foreground/60">· {{ serverTotal }} events</span>
        </p>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" @click="activeTab === 'request' ? loadData() : loadServerData()" :loading="activeTab === 'request' ? loading : serverLoading">
          <RefreshCw class="mr-2 h-4 w-4" />刷新
        </Button>
        <Button v-if="activeTab === 'request'" variant="outline" size="sm" class="text-destructive" @click="onClear">
          <Trash2 class="mr-2 h-4 w-4" />清空
        </Button>
      </div>
    </div>

    <!-- Tab 切换（玻璃胶囊式） -->
    <div class="glass inline-flex w-fit gap-1 rounded-full p-1">
      <button
        @click="switchTab('request')"
        :class="['flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-all duration-200', activeTab === 'request'
          ? 'bg-gradient-to-r from-brand-blue/20 via-brand-purple/20 to-brand-cyan/20 text-primary shadow-[inset_0_0_0_1px_rgba(139,92,246,0.25)]'
          : 'text-muted-foreground hover:text-foreground']"
      >
        <Activity class="h-4 w-4" />请求日志
      </button>
      <button
        @click="switchTab('server')"
        :class="['flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-all duration-200', activeTab === 'server'
          ? 'bg-gradient-to-r from-brand-blue/20 via-brand-purple/20 to-brand-cyan/20 text-primary shadow-[inset_0_0_0_1px_rgba(139,92,246,0.25)]'
          : 'text-muted-foreground hover:text-foreground']"
      >
        <Server class="h-4 w-4" />服务运行日志
      </button>
    </div>

    <!-- ===== 请求日志 Tab ===== -->
    <div v-if="activeTab === 'request'">
      <!-- 筛选栏 -->
      <Card class="mb-4">
        <CardContent class="p-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="relative flex-1 min-w-[200px]">
              <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="keyword" placeholder="搜索模型名称..." class="pl-9" @keyup.enter="applyFilters" />
            </div>
            <Select v-model="channelFilter" :options="channelOptions" class="w-40" @update:model-value="applyFilters" />
            <Select v-model="statusFilter" :options="statusOptions" class="w-36" @update:model-value="applyFilters" />
          </div>
        </CardContent>
      </Card>

      <!-- 日志表格 -->
      <Card>
        <CardContent class="p-0">
          <div v-if="loading" class="py-12 text-center text-muted-foreground">
            <ScrollText class="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />加载中...
          </div>

          <div v-else-if="logs.length === 0" class="py-16 text-center">
            <ScrollText class="mx-auto mb-4 h-16 w-16 text-muted-foreground/30" />
            <h3 class="text-lg font-semibold">暂无日志</h3>
            <p class="mt-2 text-sm text-muted-foreground">代理请求记录将显示在这里</p>
          </div>

          <Table v-else>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>渠道</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead class="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="log in logs" :key="log.id" class="hover:bg-muted/30">
                <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ formatTime(log.created_at) }}</TableCell>
                <TableCell>
                  <div class="flex items-center gap-2">
                    <Cpu class="h-3.5 w-3.5 text-brand-blue" />
                    <span class="max-w-[200px] truncate font-mono text-xs" :title="log.model">{{ log.model }}</span>
                  </div>
                </TableCell>
                <TableCell class="text-xs">{{ log.channel_name || '-' }}</TableCell>
                <TableCell>
                  <Badge :variant="getStatusBadge(log.status_code).variant" class="text-[10px]">
                    {{ getStatusBadge(log.status_code).text }}
                  </Badge>
                </TableCell>
                <TableCell class="text-xs">{{ log.total_tokens || '-' }}</TableCell>
                <TableCell>
                  <div class="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock class="h-3 w-3" />{{ formatDuration(log.duration_ms) }}
                  </div>
                </TableCell>
                <TableCell class="text-right">
                  <Button variant="ghost" size="sm" class="h-8 px-2" @click="viewDetail(log)">
                    <Eye class="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="mt-4 flex items-center justify-center gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" @click="page--; loadData()">上一页</Button>
        <span class="text-sm text-muted-foreground">{{ page }} / {{ totalPages }}</span>
        <Button variant="outline" size="sm" :disabled="page >= totalPages" @click="page++; loadData()">下一页</Button>
      </div>
    </div>

    <!-- ===== 服务运行日志 Tab ===== -->
    <div v-if="activeTab === 'server'">
      <!-- 统计卡片 -->
      <div v-if="serverStats" class="grid grid-cols-2 gap-3 md:grid-cols-4 mb-4">
        <Card>
          <CardContent class="p-3">
            <p class="text-xs text-muted-foreground">INFO</p>
            <p class="mt-1 text-xl font-bold gradient-text">{{ serverStats.info_count }}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent class="p-3">
            <p class="text-xs text-muted-foreground">WARN</p>
            <p class="mt-1 text-xl font-bold text-brand-orange drop-shadow-[0_0_8px_rgba(249,115,22,0.5)]">{{ serverStats.warn_count }}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent class="p-3">
            <p class="text-xs text-muted-foreground">ERROR</p>
            <p class="mt-1 text-xl font-bold text-destructive drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]">{{ serverStats.error_count }}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent class="p-3">
            <p class="text-xs text-muted-foreground">今日启动次数</p>
            <p class="mt-1 text-xl font-bold" :class="serverStats.startup_today > 5 ? 'text-destructive drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]' : 'text-brand-green drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]'">{{ serverStats.startup_today }}</p>
          </CardContent>
        </Card>
      </div>

      <!-- 筛选栏 -->
      <Card class="mb-4">
        <CardContent class="p-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="relative flex-1 min-w-[200px]">
              <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="serverKeyword" placeholder="搜索关键词（如：启动、错误、panic）..." class="pl-9" @keyup.enter="applyServerFilters" />
            </div>
            <Select v-model="serverLevel" :options="levelOptions" class="w-32" @update:model-value="applyServerFilters" />
          </div>
        </CardContent>
      </Card>

      <!-- 日志列表 -->
      <Card>
        <CardContent class="p-0">
          <div v-if="serverLoading" class="py-12 text-center text-muted-foreground">
            <ScrollText class="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />加载中...
          </div>

          <div v-else-if="serverLogs.length === 0" class="py-16 text-center">
            <Server class="mx-auto mb-4 h-16 w-16 text-muted-foreground/30" />
            <h3 class="text-lg font-semibold">暂无运行日志</h3>
            <p class="mt-2 text-sm text-muted-foreground">服务运行日志将显示在这里</p>
          </div>

          <div v-else class="max-h-[600px] overflow-y-auto">
            <div
              v-for="(log, index) in serverLogs"
              :key="index"
              class="border-b border-border/50 px-4 py-2 font-mono text-xs hover:bg-muted/30"
            >
              <div class="flex items-start gap-2">
                <span class="shrink-0 text-muted-foreground">{{ formatServerTime(log.time) }}</span>
                <Badge :variant="getLevelBadge(log.level).variant" class="shrink-0 text-[10px]">
                  {{ log.level || '-' }}
                </Badge>
                <span class="break-all text-foreground/80">{{ log.message || log.raw }}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- 分页 -->
      <div v-if="serverTotalPages > 1" class="mt-4 flex items-center justify-center gap-2">
        <Button variant="outline" size="sm" :disabled="serverPage <= 1" @click="serverPage--; loadServerData()">上一页</Button>
        <span class="text-sm text-muted-foreground">{{ serverPage }} / {{ serverTotalPages }}</span>
        <Button variant="outline" size="sm" :disabled="serverPage >= serverTotalPages" @click="serverPage++; loadServerData()">下一页</Button>
      </div>
    </div>

    <!-- 请求详情对话框 -->
    <Dialog v-model="detailOpen" title="请求详情" size="lg">
      <div v-if="detailLog" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">请求 ID</p>
            <p class="mt-1 font-mono text-xs">{{ detailLog.request_id }}</p>
          </div>
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">状态码</p>
            <p class="mt-1 text-sm font-semibold">
              <Badge :variant="getStatusBadge(detailLog.status_code).variant">{{ detailLog.status_code }}</Badge>
            </p>
          </div>
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">模型</p>
            <p class="mt-1 font-mono text-xs">{{ detailLog.model }}</p>
          </div>
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">渠道</p>
            <p class="mt-1 text-sm">{{ detailLog.channel_name }}</p>
          </div>
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">Prompt Tokens</p>
            <p class="mt-1 text-sm font-semibold">{{ detailLog.prompt_tokens || 0 }}</p>
          </div>
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">Completion Tokens</p>
            <p class="mt-1 text-sm font-semibold">{{ detailLog.completion_tokens || 0 }}</p>
          </div>
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">总 Tokens</p>
            <p class="mt-1 text-sm font-semibold text-brand-blue">{{ detailLog.total_tokens || 0 }}</p>
          </div>
          <div class="rounded-lg bg-muted/50 p-3">
            <p class="text-xs text-muted-foreground">耗时</p>
            <p class="mt-1 text-sm font-semibold">{{ formatDuration(detailLog.duration_ms) }}</p>
          </div>
        </div>
        <div class="rounded-lg bg-muted/50 p-3">
          <p class="text-xs text-muted-foreground">请求时间</p>
          <p class="mt-1 text-sm">{{ formatTime(detailLog.created_at) }}</p>
        </div>
        <div v-if="detailLog.error_msg" class="rounded-lg bg-destructive/10 p-3">
          <div class="flex items-center gap-2">
            <AlertCircle class="h-4 w-4 text-destructive" />
            <p class="text-sm font-medium text-destructive">错误信息</p>
          </div>
          <p class="mt-2 break-all text-xs text-destructive/80">{{ detailLog.error_msg }}</p>
        </div>
      </div>
      <template #footer>
        <Button @click="detailOpen = false">关闭</Button>
      </template>
    </Dialog>
  </div>
</template>
