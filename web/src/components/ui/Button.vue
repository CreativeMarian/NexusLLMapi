<script setup>
import { computed } from 'vue'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    validator: (v) => ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'].includes(v)
  },
  size: {
    type: String,
    default: 'default',
    validator: (v) => ['default', 'sm', 'lg', 'icon'].includes(v)
  },
  className: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false }
})

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default: 'bg-gradient-to-r from-brand-blue to-brand-purple text-white shadow-md hover:shadow-glow-purple hover:brightness-110',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-border/60 bg-card/60 backdrop-blur hover:border-primary/40 hover:text-primary hover:shadow-glow-purple',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

const classes = computed(() => cn(buttonVariants({ variant: props.variant, size: props.size }), props.className))
</script>

<template>
  <button :class="classes" :disabled="disabled || loading">
    <span v-if="loading" class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
    <slot />
  </button>
</template>
