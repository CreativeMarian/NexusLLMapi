<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><td :class="cn('p-4 align-middle', props.className)"><slot /></td></template>
