<script setup>
import { cn } from '@/lib/utils'
import { Check } from 'lucide-vue-next'

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
    role="checkbox"
    :aria-checked="modelValue"
    :disabled="disabled"
    :class="cn(
      'peer h-4 w-4 shrink-0 rounded border border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200',
      modelValue ? 'bg-gradient-to-br from-brand-blue to-brand-purple text-white shadow-[0_0_8px_rgba(139,92,246,0.5)]' : 'bg-card/60 backdrop-blur',
      props.className
    )"
    @click="toggle"
  >
    <Check v-if="modelValue" class="h-3 w-3" />
  </button>
</template>
