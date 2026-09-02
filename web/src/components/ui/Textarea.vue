<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  rows: { type: Number, default: 3 },
  disabled: { type: Boolean, default: false },
  className: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])
</script>
<template>
  <textarea
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    :class="cn('flex min-h-[80px] w-full rounded-xl border border-input bg-card/60 px-3 py-2 text-sm shadow-sm backdrop-blur placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 resize-none', props.className)"
    @input="emit('update:modelValue', $event.target.value)"
  />
</template>
