import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const backend = 'http://127.0.0.1:8787'

export default defineConfig({
  // 从项目根目录运行 `vite --config web/vite.config.ts` 时，显式指定前端根目录
  root: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/v1': { target: backend, changeOrigin: true },
      '/health': { target: backend, changeOrigin: true },
      '/p': { target: backend, changeOrigin: true },
      '/__nexus': { target: backend, changeOrigin: true }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500
  }
})
