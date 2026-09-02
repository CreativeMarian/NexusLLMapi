<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template>
  <div class="relative w-full overflow-auto">
    <table :class="cn('w-full caption-bottom text-sm', props.className)"><slot /></table>
  </div>
</template>
