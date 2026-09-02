<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><p :class="cn('text-sm text-muted-foreground', props.className)"><slot /></p></template>
