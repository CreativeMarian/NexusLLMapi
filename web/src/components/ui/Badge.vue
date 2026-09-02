<script setup>
import { computed } from 'vue'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    validator: (v) => ['default', 'secondary', 'destructive', 'outline', 'success', 'warning', 'info'].includes(v)
  },
  className: { type: String, default: '' }
})

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-brand-green/20 text-brand-green',
        warning: 'border-transparent bg-brand-orange/20 text-brand-orange',
        info: 'border-transparent bg-brand-blue/20 text-brand-blue'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

const classes = computed(() => cn(badgeVariants({ variant: props.variant }), props.className))
</script>
<template><span :class="classes"><slot /></span></template>
