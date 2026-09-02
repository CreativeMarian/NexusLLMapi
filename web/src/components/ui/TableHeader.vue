<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><thead :class="cn('[&_tr]:border-b', props.className)"><slot /></thead></template>
