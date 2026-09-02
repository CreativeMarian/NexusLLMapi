<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><div :class="cn('flex items-center p-6 pt-0', props.className)"><slot /></div></template>
