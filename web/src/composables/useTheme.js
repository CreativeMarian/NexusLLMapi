import { ref, watch } from 'vue'

const STORAGE_KEY = 'nexus-theme'
// 默认深色（uupm.cc 风格），浅色通过 .light 类覆盖 :root 深色变量
// URL ?theme=light|dark 可临时覆盖（与 index.html 预渲染逻辑保持一致）
function initialTheme() {
  const q = new URLSearchParams(window.location.search).get('theme')
  if (q === 'light' || q === 'dark') return q
  return localStorage.getItem(STORAGE_KEY) || 'dark'
}
const theme = ref(initialTheme())

// 立即应用主题（避免页面加载时闪烁）
function applyTheme(value) {
  const root = document.documentElement
  if (value === 'light') {
    root.classList.add('light')
    root.classList.remove('dark')
  } else {
    root.classList.remove('light')
    root.classList.add('dark')
  }
}

// 初始化时立即应用
applyTheme(theme.value)

// 监听变化自动应用
watch(theme, (newVal) => {
  applyTheme(newVal)
  localStorage.setItem(STORAGE_KEY, newVal)
})

export function useTheme() {
  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  function setTheme(value) {
    theme.value = value
  }

  return {
    theme,
    toggleTheme,
    setTheme
  }
}
