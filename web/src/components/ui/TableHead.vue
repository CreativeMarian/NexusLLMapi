<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><th :class="cn('h-12 px-4 text-left align-middle font-medium text-muted-foreground', props.className)"><slot /></th></template>
