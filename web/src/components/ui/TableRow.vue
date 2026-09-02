<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><tr :class="cn('border-b border-border/50 transition-colors hover:bg-muted/50', props.className)"><slot /></tr></template>
