/** @type {import('tailwindcss').Config} */
import { fileURLToPath } from 'node:url'

// content 使用基于本配置文件位置的绝对路径，避免因 CWD 不同（项目根 / web/ 目录）
// 导致 Tailwind 扫描不到源码、工具类全部丢失。
const rootDir = fileURLToPath(new URL('./', import.meta.url))

export default {
  darkMode: ['class'],
  content: [rootDir + 'index.html', rootDir + 'src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' }
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        // 玻璃拟态品牌色
        brand: {
          blue: '#3B82F6',
          purple: '#8B5CF6',
          cyan: '#06B6D4',
          orange: '#F97316',
          green: '#10B981',
          red: '#EF4444'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      boxShadow: {
        'card': '0 8px 32px rgba(0,0,0,0.18)',
        'card-hover': '0 12px 40px rgba(0,0,0,0.26)',
        'glow-blue': '0 0 20px rgba(59,130,246,0.35)',
        'glow-purple': '0 0 20px rgba(139,92,246,0.35)',
        'glow-cyan': '0 0 20px rgba(6,182,212,0.35)',
        'glow-green': '0 0 20px rgba(16,185,129,0.35)'
      },
      transitionTimingFunction: {
        'ui': 'cubic-bezier(0.4, 0, 0.2, 1)'
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' }
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.3s ease-out',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite'
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}
