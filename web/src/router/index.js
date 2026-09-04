import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('@/views/Dashboard.vue'),
    meta: { title: '仪表盘' }
  },
  {
    path: '/channels',
    name: 'Channels',
    component: () => import('@/views/Channels.vue'),
    meta: { title: '渠道管理' }
  },
  {
    path: '/models',
    name: 'Models',
    component: () => import('@/views/Models.vue'),
    meta: { title: '模型库' }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/views/Settings.vue'),
    meta: { title: '代理设置' }
  },
  {
    path: '/logs',
    name: 'Logs',
    component: () => import('@/views/Logs.vue'),
    meta: { title: '请求日志' }
  },
  {
    path: '/mcp',
    name: 'MCP',
    component: () => import('@/views/MCP.vue'),
    meta: { title: 'MCP 服务器' }
  },
  {
    path: '/prompts',
    name: 'Prompts',
    component: () => import('@/views/Prompts.vue'),
    meta: { title: '提示词' }
  },
  // 兜底：未知路径回首页，避免内容区空白无提示
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 切换路由自动回顶（smooth），保留前进/后退的滚动位置
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0, behavior: 'smooth' }
  }
})

router.beforeEach((to, from, next) => {
  document.title = `${to.meta.title || 'NexusLLMapi'} - NexusLLMapi`
  next()
})

export default router
