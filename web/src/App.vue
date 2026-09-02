<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  LayoutDashboard, Plug, Cpu, Settings, ScrollText,
  Menu, X, Sun, Moon, Terminal, Activity
} from 'lucide-vue-next'
import { useTheme } from '@/composables/useTheme'
import ParticleBackground from '@/components/ParticleBackground.vue'
import ClickEffect from '@/components/ClickEffect.vue'
import OnboardingGuide from '@/components/OnboardingGuide.vue'

const route = useRoute()
const { theme, toggleTheme } = useTheme()
const mobileMenuOpen = ref(false)
const serviceRunning = ref(true)
const onboardingOpen = ref(false)

const navItems = [
  { name: '仪表盘', path: '/', icon: LayoutDashboard },
  { name: '渠道管理', path: '/channels', icon: Plug },
  { name: '模型库', path: '/models', icon: Cpu },
  { name: '代理设置', path: '/settings', icon: Settings },
  { name: '请求日志', path: '/logs', icon: ScrollText }
]

const activeItem = computed(() =>
  navItems.find(i => i.path === route.path) || null
)

// 鼠标光斑跟随
const cursorGlowOn = ref(false)
function onPointerMove(e) {
  const root = document.documentElement
  root.style.setProperty('--cx', e.clientX + 'px')
  root.style.setProperty('--cy', e.clientY + 'px')
  cursorGlowOn.value = true
}

// 定期检查服务状态
let healthTimer = null
onMounted(() => {
  checkHealth()
  healthTimer = setInterval(checkHealth, 10000)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  maybeOpenOnboarding()
})
onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer)
  window.removeEventListener('pointermove', onPointerMove)
})
async function checkHealth() {
  try {
    const res = await fetch('/api/channels', { signal: AbortSignal.timeout(3000) })
    serviceRunning.value = res.ok
  } catch {
    serviceRunning.value = false
  }
}

// 首次进入且尚无渠道时自动弹出新手引导
let onboardingChecked = false
async function maybeOpenOnboarding() {
  if (onboardingChecked) return
  onboardingChecked = true
  try {
    if (localStorage.getItem('nexus_onboarding_v1') === '1') return
    const res = await fetch('/api/channels', { signal: AbortSignal.timeout(4000) })
    const data = await res.json()
    const list = Array.isArray(data) ? data : (data.data || [])
    if (list.length === 0) onboardingOpen.value = true
  } catch (e) { /* 服务不可用或异常时不打扰 */ }
}
</script>

<template>
  <div class="relative min-h-screen overflow-x-hidden bg-background text-foreground">
    <!-- ========== 背景特效层（极光 + 流光光带 + 网格 + 粒子 + 鼠标光斑） ========== -->
    <div class="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div
        class="aurora-blob h-[520px] w-[520px] bg-brand-blue/40"
        style="top: -160px; left: -100px;"
      />
      <div
        class="aurora-blob h-[460px] w-[460px] bg-brand-purple/30"
        style="top: 22%; right: -140px; animation-delay: -7s;"
      />
      <div
        class="aurora-blob h-[420px] w-[420px] bg-brand-cyan/25"
        style="bottom: -140px; left: 28%; animation-delay: -13s;"
      />
      <!-- 沉浸式流光光带 -->
      <div class="aurora-stream" />
      <div
        class="absolute inset-0 opacity-[0.05]"
        style="background-image: linear-gradient(hsl(var(--foreground) / 0.5) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground) / 0.5) 1px, transparent 1px); background-size: 52px 52px;"
      />
      <!-- 粒子网络 -->
      <ParticleBackground />
    </div>

    <!-- 鼠标光斑（跟随光感） -->
    <div class="cursor-glow" :class="cursorGlowOn ? 'on' : ''" aria-hidden="true" />

    <!-- ========== 顶部终端状态栏（uupm 终端美学） ========== -->
    <div class="relative z-40 border-b border-white/5 bg-black/30 backdrop-blur-md">
      <div class="mx-auto flex h-8 max-w-7xl items-center gap-3 px-4 text-[11px] md:px-8">
        <span class="flex items-center gap-1.5 font-mono text-cyan-400/90">
          <Terminal class="h-3.5 w-3.5" />
          nexus@local
          <span class="text-muted-foreground">~</span>
          <span class="text-brand-blue">$</span>
        </span>
        <span class="hidden font-mono text-muted-foreground/70 sm:inline">
          export BASE_URL=http://127.0.0.1:8787/v1
        </span>
        <div class="ml-auto flex items-center gap-3">
          <span class="hidden items-center gap-1.5 text-muted-foreground/70 md:flex">
            <Activity class="h-3 w-3" />
            <span class="font-mono">PROXY</span>
          </span>
          <span
            class="flex items-center gap-1.5 font-medium"
            :class="serviceRunning ? 'text-brand-green' : 'text-destructive'"
          >
            <span class="relative inline-flex h-1.5 w-1.5">
              <span
                v-if="serviceRunning"
                class="absolute inline-flex h-full w-full rounded-full bg-brand-green dot-ping"
              />
              <span
                class="relative inline-flex h-1.5 w-1.5 rounded-full"
                :class="serviceRunning ? 'bg-brand-green' : 'bg-destructive'"
              />
            </span>
            {{ serviceRunning ? 'RUNNING' : 'DOWN' }}
          </span>
        </div>
      </div>
    </div>

    <!-- ========== 玻璃导航栏 ========== -->
    <header class="glass-nav sticky top-0 z-50">
      <div class="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 md:px-8">
        <!-- Logo -->
        <router-link to="/" class="group flex items-center gap-3">
          <div class="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-blue via-brand-purple to-brand-cyan shadow-glow-blue transition-transform duration-300 group-hover:scale-105">
            <Zap class="h-5 w-5 text-white" fill="currentColor" />
          </div>
          <div class="flex flex-col leading-none">
            <span class="gradient-text-animated text-base font-bold tracking-tight">NexusLLMapi</span>
            <span class="mt-0.5 text-[10px] text-muted-foreground">Design Intelligence Gateway</span>
          </div>
        </router-link>

        <!-- 桌面端横向导航 -->
        <nav class="mx-auto hidden items-center gap-1 md:flex">
          <router-link
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="group relative flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all duration-200"
            :class="route.path === item.path
              ? 'bg-gradient-to-r from-brand-blue/15 via-brand-purple/15 to-brand-cyan/15 text-primary shadow-[inset_0_0_0_1px_rgba(96,165,250,0.35)]'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
          >
            <component
              :is="item.icon"
              class="h-4 w-4 transition-transform duration-200 group-hover:scale-110"
              :class="route.path === item.path ? 'drop-shadow-[0_0_6px_rgba(96,165,250,0.8)]' : ''"
            />
            {{ item.name }}
          </router-link>
        </nav>

        <!-- 右侧：服务状态 + 主题切换 + 移动端菜单 -->
        <div class="ml-auto flex items-center gap-2 md:ml-0">
          <!-- 主题切换 -->
          <button
            @click="toggleTheme"
            class="flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-card/60 text-muted-foreground backdrop-blur transition-all duration-200 hover:border-primary/40 hover:text-primary hover:shadow-glow-blue"
            :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
          >
            <Sun v-if="theme === 'dark'" class="h-4 w-4" />
            <Moon v-else class="h-4 w-4" />
          </button>

          <!-- 移动端汉堡 -->
          <button
            class="flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-card/60 text-muted-foreground backdrop-blur md:hidden"
            @click="mobileMenuOpen = !mobileMenuOpen"
          >
            <X v-if="mobileMenuOpen" class="h-4 w-4" />
            <Menu v-else class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- 移动端下拉菜单 -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="-translate-y-2 opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="translate-y-0 opacity-100"
        leave-to-class="-translate-y-2 opacity-0"
      >
        <nav v-if="mobileMenuOpen" class="glass-strong mx-4 mb-4 rounded-2xl p-2 md:hidden">
          <router-link
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors"
            :class="route.path === item.path
              ? 'bg-gradient-to-r from-brand-blue/15 via-brand-purple/15 to-brand-cyan/15 text-primary'
              : 'text-muted-foreground hover:bg-accent/60'"
            @click="mobileMenuOpen = false"
          >
            <component :is="item.icon" class="h-4 w-4" />
            {{ item.name }}
          </router-link>
        </nav>
      </Transition>
    </header>

    <!-- ========== 内容区 ========== -->
    <main class="relative z-10 mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
      <router-view v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </router-view>
    </main>

    <!-- 页脚 -->
    <footer class="relative z-10 pb-8 text-center">
      <p class="text-xs text-muted-foreground/60">
        NexusLLMapi · 代理地址 <code class="rounded bg-card/60 px-1.5 py-0.5 font-mono text-[10px]">http://127.0.0.1:8787/v1</code>
      </p>
    </footer>

    <!-- 鼠标点击特效 -->
    <ClickEffect />

    <!-- 首次使用新手引导（聚焦点击） -->
    <OnboardingGuide v-model:open="onboardingOpen" />
  </div>
</template>

<style>
.page-enter-active,
.page-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.page-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.page-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
