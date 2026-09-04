<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import {
  Sparkles, Plug, DownloadCloud, Activity, Copy, Rocket,
  X, ChevronRight, ChevronLeft, Check
} from 'lucide-vue-next'

/**
 * OnboardingGuide — 首次使用聚焦点击新手向导
 * - 全屏遮罩（box-shadow 挖洞）+ 目标元素呼吸高亮
 * - 气泡提示 + 下一步/跳过推进，支持跨路由聚焦
 * - localStorage 记录完成状态，完成/跳过后不再自动弹出
 */
const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['update:open', 'done'])

const router = useRouter()

const STORAGE_KEY = 'nexus_onboarding_v1'

const steps = [
  {
    type: 'intro', icon: Sparkles,
    title: '欢迎使用 NexusLLMapi',
    desc: '一个把多家大模型 API 统一成 OpenAI / Anthropic / Responses 三种协议的中转网关。跟随引导，几分钟即可完成配置。'
  },
  {
    type: 'focus', icon: Plug,
    route: '/channels', target: '[data-guide="add-channel"]', pos: 'bottom',
    title: '添加渠道',
    desc: '点击右上角「添加渠道」按钮，把上游服务商的 Base URL 和 API Key 填进来（支持 OpenAI、NVIDIA、Gemini 等 38+ 模板）。'
  },
  {
    type: 'focus', icon: DownloadCloud,
    route: '/channels', target: '[data-guide="sync-models"]', pos: 'top',
    title: '同步模型',
    desc: '在渠道卡片上点击「同步模型」，一键把上游所有可用模型拉进本地模型库。'
  },
  {
    type: 'focus', icon: Activity,
    route: '/models', target: '[data-guide="check-models"]', pos: 'bottom',
    title: '检测模型',
    desc: '在模型库点击「一键检测连接」，批量测速并清理失效模型。'
  },
  {
    type: 'focus', icon: Copy,
    route: '/models', target: '[data-guide="copy-config"]', pos: 'top',
    title: '接入客户端',
    desc: '点击模型卡片「查看配置」，一键复制 Base URL / Model / API Key，粘贴到 OpenAI 客户端或 Claude Code 即可使用。'
  },
  {
    type: 'outro', icon: Rocket,
    title: '全部完成',
    desc: '网关已就绪。把客户端 Base URL 指向 http://127.0.0.1:8787/v1，任何支持 OpenAI / Anthropic 协议的客户端都能接入。'
  }
]

const current = ref(0)
const shown = ref(false)
const highlight = ref({ show: false, x: 0, y: 0, w: 0, h: 0 })
const found = ref(false)
const polling = ref(false)

const total = steps.length
const currentStep = computed(() => steps[current.value])
const isLast = computed(() => current.value >= total - 1)
const isIntro = computed(() => currentStep.value.type === 'intro')
const isOutro = computed(() => currentStep.value.type === 'outro')

let pollTimer = null
let pollGen = 0 // 轮询代际：快速切换步骤时让旧的轮询链失效
let resizeHandler = null
let scrollHandler = null

function lockScroll(lock) {
  document.body.style.overflow = lock ? 'hidden' : ''
}

function markDone() {
  try { localStorage.setItem(STORAGE_KEY, '1') } catch (e) { /* ignore */ }
}

async function locateTarget() {
  const step = currentStep.value
  const gen = ++pollGen
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  if (!step.target) {
    highlight.value.show = false
    found.value = false
    polling.value = false
    return
  }
  // 等待目标元素出现（跨路由渲染后）
  polling.value = true
  let tries = 0
  const poll = async () => {
    if (gen !== pollGen) return // 已切换到其它步骤：本次轮询链作废
    tries++
    const el = document.querySelector(step.target)
    if (el) {
      polling.value = false
      found.value = true
      placeOn(el)
      return
    }
    if (tries < 40) { // ~4s
      pollTimer = setTimeout(poll, 100)
    } else {
      polling.value = false
      found.value = false
      highlight.value.show = false
    }
  }
  poll()
}

function placeOn(el) {
  const r = el.getBoundingClientRect()
  const pad = 8
  highlight.value = {
    show: true,
    x: r.left - pad,
    y: r.top - pad,
    w: r.width + pad * 2,
    h: r.height + pad * 2
  }
}

function bubblePos() {
  const h = highlight.value
  if (!h.show) return { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }
  const step = currentStep.value
  if (step.pos === 'top') {
    return { bottom: `${window.innerHeight - h.y + 14}px`, left: `${Math.min(Math.max(h.x, 16), window.innerWidth - 340)}px` }
  }
  return { top: `${h.y + h.h + 14}px`, left: `${Math.min(Math.max(h.x, 16), window.innerWidth - 340)}px` }
}

function refreshLayout() {
  if (!shown.value || !currentStep.value?.target) return
  const el = document.querySelector(currentStep.value.target)
  if (el) placeOn(el)
}

function goNext() {
  if (isLast.value) {
    finish()
    return
  }
  current.value++
  shown.value = false
  nextTick(() => {
    shown.value = true
    activate()
  })
}

function goPrev() {
  if (current.value === 0) return
  current.value--
  shown.value = false
  nextTick(() => {
    shown.value = true
    activate()
  })
}

function skip() {
  markDone()
  emit('done', { completed: false })
  close()
}

function finish() {
  markDone()
  emit('done', { completed: true })
  close()
}

function close() {
  emit('update:open', false)
}

async function activate() {
  const step = currentStep.value
  if (step.route) {
    if (router.currentRoute.value.path !== step.route) {
      await router.push(step.route)
    }
  }
  locateTarget()
  await nextTick()
  refreshLayout()
}

watch(() => props.open, (v) => {
  if (v) {
    current.value = 0
    shown.value = true
    lockScroll(true)
    nextTick(activate)
  } else {
    shown.value = false
    lockScroll(false)
    highlight.value.show = false
    polling.value = false
    pollGen++
    if (pollTimer) clearTimeout(pollTimer)
  }
})

onMounted(() => {
  resizeHandler = () => refreshLayout()
  scrollHandler = () => refreshLayout()
  window.addEventListener('resize', resizeHandler)
  window.addEventListener('scroll', scrollHandler, { passive: true })
})
onUnmounted(() => {
  lockScroll(false)
  pollGen++
  if (pollTimer) clearTimeout(pollTimer)
  window.removeEventListener('resize', resizeHandler)
  window.removeEventListener('scroll', scrollHandler)
})

// 供外部检查是否已完成
function hasCompleted() {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch (e) { return false }
}
defineExpose({ hasCompleted })
</script>

<template>
  <Teleport to="body">
    <!-- 容器 pointer-events-none：引导期间用户仍可真实点击页面元素完成操作；气泡单独恢复交互 -->
    <div v-if="props.open" class="guide-fade pointer-events-none fixed inset-0 z-[100]">
      <!-- 高亮窗口：box-shadow 挖洞遮罩 + 呼吸高亮边框 -->
      <div
        v-if="currentStep.target && highlight.show"
        class="guide-highlight pointer-events-none fixed"
        :style="{ left: highlight.x + 'px', top: highlight.y + 'px', width: highlight.w + 'px', height: highlight.h + 'px', boxShadow: '0 0 0 9999px rgba(2,6,23,0.62)' }"
      />

      <!-- 目标缺失提示 -->
      <div
        v-if="currentStep.target && !highlight.show && !polling"
        class="guide-fade pointer-events-none fixed inset-0 flex items-center justify-center"
      >
        <div class="glass-strong guide-pop max-w-sm rounded-2xl p-6 text-center">
          <p class="text-sm text-muted-foreground">当前页面还没有可聚焦的元素，请先完成上一步操作。</p>
        </div>
      </div>

      <!-- 气泡 -->
      <div
        v-if="shown"
        class="guide-pop glass-strong pointer-events-auto absolute z-[110] w-[320px] rounded-2xl p-5 shadow-2xl"
        :style="bubblePos()"
      >
        <div class="flex items-start gap-3">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-blue via-brand-purple to-brand-cyan text-white shadow-glow-blue">
            <component :is="currentStep.icon" class="h-5 w-5" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-semibold tracking-wider text-muted-foreground">第 {{ current + 1 }} / {{ total }} 步</span>
              <span class="ml-auto flex gap-1">
                <span
                  v-for="i in total"
                  :key="i"
                  class="h-1.5 w-1.5 rounded-full transition-all duration-300"
                  :class="i <= current + 1 ? 'bg-brand-blue shadow-[0_0_6px_rgba(59,130,246,0.8)]' : 'bg-muted'"
                />
              </span>
            </div>
            <h3 class="mt-1.5 text-base font-semibold leading-tight">{{ currentStep.title }}</h3>
            <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">{{ currentStep.desc }}</p>
          </div>
        </div>

        <div class="mt-4 flex items-center justify-between border-t border-border/40 pt-3">
          <button
            class="text-xs text-muted-foreground transition-colors hover:text-foreground"
            @click="skip"
          >
            跳过
          </button>
          <div class="flex items-center gap-2">
            <button
              v-if="current > 0 && !isIntro"
              class="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 text-muted-foreground transition-all hover:text-foreground"
              @click="goPrev"
            >
              <ChevronLeft class="h-4 w-4" />
            </button>
            <button
              class="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-blue via-brand-purple to-brand-cyan px-4 py-2 text-xs font-semibold text-white shadow-glow-blue transition-all hover:brightness-110"
              @click="goNext"
            >
              <Check v-if="isLast" class="h-3.5 w-3.5" />
              <ChevronRight v-else class="h-3.5 w-3.5" />
              {{ isIntro ? '开始引导' : (isLast ? '完成' : '下一步') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
