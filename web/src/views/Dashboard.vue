<script setup>
import { ref, onMounted, computed } from 'vue'
import { getDashboard } from '@/api/dashboard'
import { getChannels } from '@/api/channel'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import {
  Activity, Cpu, Plug, Coins, TrendingUp, ArrowRight, RefreshCw, Zap, Clock, Radio
} from 'lucide-vue-next'

const loading = ref(true)
const dashboard = ref(null)
const channels = ref([])

async function loadData() {
  loading.value = true
  try {
    const [dashRes, chRes] = await Promise.all([getDashboard(), getChannels()])
    dashboard.value = dashRes.data
    channels.value = chRes.data || []
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

function formatNumber(n) {
  const num = Number(n)
  if (!isFinite(num) || isNaN(num)) return '0'
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

// 7 天趋势最大请求数（用于柱高归一）
const maxReq = computed(() => {
  const t = dashboard.value?.weekly_trend || []
  if (!t.length) return 1
  return Math.max(...t.map(d => d.requests), 1)
})

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- 页面标题（uupm 风格 hero 区） -->
    <div class="glass-hover glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-blue/30 bg-brand-blue/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-blue">
            <Radio class="h-3 w-3" />
            LIVE TELEMETRY
          </span>
        </div>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">网关实时仪表盘</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ tail -f <span class="text-brand-blue">/metrics</span> --live
        </p>
      </div>
      <Button variant="outline" size="sm" @click="loadData" :loading="loading" class="shrink-0">
        <RefreshCw class="mr-2 h-4 w-4" />刷新
      </Button>
    </div>

    <!-- 统计卡片行（uupm 大数字风格） -->
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card class="flex flex-col glass-hover overflow-hidden">
        <CardContent class="flex flex-1 flex-col justify-center p-5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium text-muted-foreground">总请求数</p>
              <p class="mt-2 text-3xl font-bold tracking-tight gradient-text md:text-4xl">{{ loading ? '…' : formatNumber(dashboard?.stats?.total_requests || 0) }}</p>
              <p class="mt-2 text-xs text-brand-green">今日 <span class="font-mono font-semibold">{{ formatNumber(dashboard?.stats?.today_requests || 0) }}</span></p>
            </div>
            <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-blue/25 to-brand-cyan/25 shadow-glow-blue">
              <Activity class="h-6 w-6 text-brand-blue drop-shadow-[0_0_8px_rgba(59,130,246,0.7)]" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card class="flex flex-col glass-hover">
        <CardContent class="flex flex-1 flex-col justify-center p-5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium text-muted-foreground">Token 消耗</p>
              <p class="mt-2 text-3xl font-bold tracking-tight gradient-text md:text-4xl">{{ loading ? '…' : formatNumber(dashboard?.stats?.total_tokens || 0) }}</p>
              <p class="mt-2 text-xs text-brand-green">今日 <span class="font-mono font-semibold">{{ formatNumber(dashboard?.stats?.today_tokens || 0) }}</span></p>
            </div>
            <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-purple/25 to-brand-blue/25 shadow-glow-purple">
              <Coins class="h-6 w-6 text-brand-purple drop-shadow-[0_0_8px_rgba(139,92,246,0.7)]" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card class="flex flex-col glass-hover">
        <CardContent class="flex flex-1 flex-col justify-center p-5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium text-muted-foreground">渠道 / 模型</p>
              <p class="mt-2 text-3xl font-bold tracking-tight gradient-text md:text-4xl">{{ dashboard?.stats?.channels || 0 }} <span class="text-lg text-muted-foreground">/</span> {{ dashboard?.stats?.models || 0 }}</p>
              <p class="mt-2 text-xs text-brand-blue">启用 <span class="font-mono font-semibold">{{ dashboard?.stats?.enabled_channels || 0 }}</span> / <span class="font-mono font-semibold">{{ dashboard?.stats?.enabled_models || 0 }}</span></p>
            </div>
            <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-orange/25 to-brand-cyan/25">
              <Plug class="h-6 w-6 text-brand-orange drop-shadow-[0_0_8px_rgba(249,115,22,0.6)]" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card class="flex flex-col glass-hover">
        <CardContent class="flex flex-1 flex-col justify-center p-5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium text-muted-foreground">成功率 / 平均耗时</p>
              <p class="mt-2 text-3xl font-bold tracking-tight gradient-text md:text-4xl">{{ (dashboard?.stats?.success_rate ?? 100).toFixed(1) }}<span class="text-xl">%</span></p>
              <p class="mt-2 text-xs text-muted-foreground"><span class="font-mono font-semibold">{{ dashboard?.stats?.avg_duration || 0 }}ms</span></p>
            </div>
            <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-green/25 to-brand-cyan/25">
              <TrendingUp class="h-6 w-6 text-brand-green drop-shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <div class="grid gap-6 lg:grid-cols-3">
      <!-- 渠道状态概览 -->
      <Card class="glass lg:col-span-2">
        <div class="flex items-center justify-between border-b border-white/5 p-5">
          <h3 class="font-semibold">渠道状态</h3>
          <router-link to="/channels" class="flex items-center text-xs text-primary hover:underline">
            管理渠道 <ArrowRight class="ml-1 h-3 w-3" />
          </router-link>
        </div>
        <div class="p-5">
          <div v-if="channels.length === 0" class="py-8 text-center text-sm text-muted-foreground">
            <Plug class="mx-auto mb-3 h-10 w-10 opacity-30" />
            暂无渠道，点击右上角添加
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="ch in channels"
              :key="ch.id"
              class="glass-hover flex items-center justify-between rounded-xl border border-white/5 bg-card/40 p-3 backdrop-blur transition-all duration-200 hover:border-brand-blue/30 hover:bg-card/70"
            >
              <div class="flex items-center gap-3">
                <div :class="['flex h-10 w-10 items-center justify-center rounded-xl', ch.enabled ? 'bg-gradient-to-br from-brand-green/20 to-brand-cyan/20 shadow-glow-green' : 'bg-muted']">
                  <Cpu :class="['h-5 w-5', ch.enabled ? 'text-brand-green' : 'text-muted-foreground']" />
                </div>
                <div>
                  <p class="text-sm font-medium">{{ ch.name }}</p>
                  <p class="text-xs text-muted-foreground">{{ ch.provider_type }} · RPM <span class="font-mono">{{ ch.rpm_limit }}</span></p>
                </div>
              </div>
              <Badge :variant="ch.enabled ? 'success' : 'secondary'">
                {{ ch.enabled ? '运行中' : '已停用' }}
              </Badge>
            </div>
          </div>
        </div>
      </Card>

      <!-- 快捷操作 -->
      <Card class="glass flex flex-col">
        <div class="border-b border-white/5 p-5">
          <h3 class="font-semibold">快捷操作</h3>
        </div>
        <div class="flex flex-1 flex-col justify-center space-y-2 p-5">
          <router-link to="/channels">
            <Button variant="outline" class="w-full justify-start" size="sm">
              <Plug class="mr-2 h-4 w-4" />添加渠道
            </Button>
          </router-link>
          <router-link to="/models">
            <Button variant="outline" class="w-full justify-start" size="sm">
              <Cpu class="mr-2 h-4 w-4" />浏览模型库
            </Button>
          </router-link>
          <router-link to="/settings">
            <Button variant="outline" class="w-full justify-start" size="sm">
              <Clock class="mr-2 h-4 w-4" />代理设置
            </Button>
          </router-link>
          <router-link to="/logs">
            <Button variant="outline" class="w-full justify-start" size="sm">
              <Activity class="mr-2 h-4 w-4" />查看请求日志
            </Button>
          </router-link>
        </div>
        <div class="border-t border-white/5 p-5">
          <div class="term-box rounded-xl p-3">
            <p class="flex items-center gap-1.5 text-xs font-medium text-cyan-400">
              <Zap class="h-3 w-3" />PROXY_ENDPOINT
            </p>
            <p class="term-prompt mt-1 font-mono text-xs text-foreground/90">http://127.0.0.1:8787/v1</p>
          </div>
        </div>
      </Card>
    </div>

    <!-- 请求趋势 -->
    <Card v-if="dashboard?.weekly_trend?.length" class="glass">
      <div class="border-b border-white/5 p-5">
        <h3 class="font-semibold">近 7 天请求趋势</h3>
      </div>
      <div class="p-5">
        <div class="flex h-48 items-stretch justify-between gap-2">
          <div v-for="day in dashboard.weekly_trend" :key="day.date" class="flex flex-1 flex-col items-center gap-2">
            <div class="flex w-full flex-1 items-end justify-center">
              <div
                class="w-full max-w-[48px] rounded-t-lg bg-gradient-to-t from-brand-blue/60 to-brand-purple shadow-glow-purple transition-all duration-500 hover:from-brand-purple/60 hover:to-brand-cyan"
                :style="{ height: (day.requests > 0 ? Math.max(8, (day.requests / maxReq) * 100) : 0) + '%' }"
                :title="`${day.date}: ${day.requests} 请求, ${day.tokens} Tokens`"
              >
                <span v-if="day.requests > 0" class="flex h-full items-start justify-center pt-1 text-[10px] font-bold text-white">{{ day.requests }}</span>
              </div>
            </div>
            <span class="text-xs text-muted-foreground">{{ day.date }}</span>
          </div>
        </div>
      </div>
    </Card>
  </div>
</template>
