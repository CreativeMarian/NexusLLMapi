<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><div :class="cn('flex flex-col space-y-1.5 p-6', props.className)"><slot /></div></template>
