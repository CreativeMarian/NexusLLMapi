<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>

<template>
  <div :class="cn('glass neon-border flow-border rounded-2xl text-card-foreground transition-all duration-300 hover:shadow-card-hover hover:-translate-y-0.5', props.className)">
    <slot />
  </div>
</template>
