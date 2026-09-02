<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ className: { type: String, default: '' } })
</script>
<template><tbody :class="cn('[&_tr:last-child]:border-0', props.className)"><slot /></tbody></template>
