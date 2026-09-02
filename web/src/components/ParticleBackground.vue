<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

/**
 * ParticleBackground — 全屏 canvas 粒子网络背景
 * - 粒子缓慢漂移 + 近距离连线（科技感网络）
 * - 鼠标移动时粒子被轻微推开（互动）
 * - 自动适配分辨率与主题（深色下粒子更亮）
 * - 零依赖，原生 canvas 实现
 */
const canvasRef = ref(null)

let ctx = null
let rafId = null
let particles = []
let pointer = { x: null, y: null, active: false }
let w = 0
let h = 0
let dpr = 1

const COLORS = [
  [96, 165, 250],   // blue-400
  [139, 92, 246],   // violet-500
  [34, 211, 238],   // cyan-400
]

function isDark() {
  return document.documentElement.classList.contains('dark') || !document.documentElement.classList.contains('light')
}

function resize() {
  const el = canvasRef.value
  if (!el) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  w = window.innerWidth
  h = window.innerHeight
  el.width = Math.floor(w * dpr)
  el.height = Math.floor(h * dpr)
  el.style.width = w + 'px'
  el.style.height = h + 'px'
  ctx = el.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  initParticles()
}

function initParticles() {
  const dark = isDark()
  const count = Math.min(90, Math.floor((w * h) / 16000))
  const minCount = w < 768 ? 34 : 56
  const n = Math.max(minCount, count)
  particles = Array.from({ length: n }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
    r: Math.random() * 1.8 + 0.6,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    // 浅色模式下透明度更弱
    base: dark ? Math.random() * 0.55 + 0.25 : Math.random() * 0.35 + 0.12
  }))
}

function draw() {
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)

  const maxDist = 150
  const dark = isDark()

  // 先画连线
  ctx.lineWidth = 1
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    for (let j = i + 1; j < particles.length; j++) {
      const q = particles[j]
      const dx = p.x - q.x
      const dy = p.y - q.y
      const dist = dx * dx + dy * dy
      if (dist < maxDist * maxDist) {
        const alpha = (1 - Math.sqrt(dist) / maxDist) * (dark ? 0.28 : 0.12)
        ctx.strokeStyle = `rgba(96,165,250,${alpha.toFixed(3)})`
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
    }
  }

  // 再画粒子（带光晕）
  for (const p of particles) {
    // 更新位置
    p.x += p.vx
    p.y += p.vy

    // 鼠标推开
    if (pointer.active && pointer.x !== null) {
      const dx = p.x - pointer.x
      const dy = p.y - pointer.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 120 && dist > 0.01) {
        const force = (120 - dist) / 120 * 1.2
        p.x += (dx / dist) * force
        p.y += (dy / dist) * force
      }
    }

    // 边界回绕
    if (p.x < -20) p.x = w + 20
    if (p.x > w + 20) p.x = -20
    if (p.y < -20) p.y = h + 20
    if (p.y > h + 20) p.y = -20

    const [r, g, b] = p.color
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4)
    grad.addColorStop(0, `rgba(${r},${g},${b},${(p.base * 0.8).toFixed(3)})`)
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = `rgba(${r},${g},${b},${p.base.toFixed(3)})`
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
    ctx.fill()
  }

  rafId = requestAnimationFrame(draw)
}

function onPointerMove(e) {
  pointer.x = e.clientX
  pointer.y = e.clientY
  pointer.active = true
}
function onPointerLeave() {
  pointer.active = false
}

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false

onMounted(() => {
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
  if (!reduceMotion) {
    rafId = requestAnimationFrame(draw)
  } else {
    draw()
    cancelAnimationFrame(rafId)
  }
})

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId)
  window.removeEventListener('resize', resize)
  window.removeEventListener('pointermove', onPointerMove)
  document.documentElement.removeEventListener('pointerleave', onPointerLeave)
})
</script>

<template>
  <canvas ref="canvasRef" class="particle-canvas" aria-hidden="true" />
</template>
