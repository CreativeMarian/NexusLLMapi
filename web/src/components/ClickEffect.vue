<script setup>
import { onMounted, onUnmounted } from 'vue'

/**
 * ClickEffect — 全局鼠标点击特效
 * 每次点击创建一个独立容器（含波纹环 + 核心闪光 + 粒子爆发），
 * 动画结束后整体移除，避免 DOM 累积与误删。
 */
const HOST_ID = '__nexus-click-burst'

const COLORS = ['96,165,250', '139,92,246', '34,211,238', '59,130,246', '167,139,250']

function ensureHost() {
  let host = document.getElementById(HOST_ID)
  if (!host) {
    host = document.createElement('div')
    host.id = HOST_ID
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '9999',
      pointerEvents: 'none'
    })
    document.body.appendChild(host)
  }
  return host
}

function makeEl(cls, style) {
  const el = document.createElement('div')
  el.className = cls
  Object.assign(el.style, style)
  return el
}

function spawn(e) {
  const host = ensureHost()
  const x = e.clientX
  const y = e.clientY

  // 独立容器：本次爆发的所有子节点都放这里，超时后整体移除
  const burst = document.createElement('div')
  burst.className = 'click-burst'
  Object.assign(burst.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    pointerEvents: 'none'
  })
  host.appendChild(burst)

  // 波纹环
  burst.appendChild(makeEl('ripple-ring', { left: x + 'px', top: y + 'px' }))
  // 核心闪光
  burst.appendChild(makeEl('core', { left: x + 'px', top: y + 'px' }))

  // 粒子爆发（8 颗）
  const count = 8
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6
    const dist = 34 + Math.random() * 30
    const size = 3 + Math.random() * 4
    const color = COLORS[Math.floor(Math.random() * COLORS.length)]
    burst.appendChild(makeEl('spark', {
      left: x + 'px',
      top: y + 'px',
      width: size + 'px',
      height: size + 'px',
      background: `rgba(${color},0.95)`,
      boxShadow: `0 0 ${size * 2}px rgba(${color},0.8)`,
      '--tx': `${Math.cos(angle) * dist}px`,
      '--ty': `${Math.sin(angle) * dist}px`
    }))
  }

  setTimeout(() => burst.remove(), 780)
}

function onClick(e) {
  spawn(e)
}

onMounted(() => {
  window.addEventListener('click', onClick, { passive: true })
})
onUnmounted(() => {
  window.removeEventListener('click', onClick)
  document.getElementById(HOST_ID)?.remove()
})
</script>

<template>
  <!-- 特效节点直接挂在 body，组件本身不渲染 DOM -->
</template>
