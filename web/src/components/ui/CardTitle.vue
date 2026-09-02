<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><h3 :class="cn('text-lg font-semibold leading-none tracking-tight', props.className)"><slot /></h3></template>
