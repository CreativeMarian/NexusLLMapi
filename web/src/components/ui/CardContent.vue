<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><div :class="cn('p-6', props.className)"><slot /></div></template>
