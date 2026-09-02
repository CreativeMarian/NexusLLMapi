import { fileURLToPath } from 'node:url';

// 无论从项目根目录还是 web/ 目录运行 vite，都显式指向 web/tailwind.config.js，
// 避免因 CWD 不同导致 Tailwind 找不到配置（content 为空、@apply 类不生成）。
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {}
  }
}
