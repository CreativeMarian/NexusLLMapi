<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  className: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <input
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="cn('flex h-10 w-full rounded-xl border border-input bg-card/60 px-3 py-2 text-sm shadow-sm backdrop-blur file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200', props.className)"
    @input="emit('update:modelValue', $event.target.value)"
  />
</template>
