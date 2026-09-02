<script setup>
import { cn } from '@/lib/utils'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  className: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])

function toggle() {
  if (!props.disabled) emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    :class="cn(
      'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      modelValue ? 'bg-gradient-to-r from-brand-blue to-brand-purple shadow-[0_0_12px_rgba(139,92,246,0.45)]' : 'bg-input',
      props.className
    )"
    @click="toggle"
  >
    <span
      :class="cn(
        'pointer-events-none block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform duration-200',
        modelValue ? 'translate-x-5' : 'translate-x-0'
      )"
    />
  </button>
</template>
