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

// 处理中文输入法 composition：composition 期间不触发更新，
// compositionend 后手动 emit，避免中文选字后 v-model 不更新
function onInput(e) {
  if (e.target.composing) return
  emit('update:modelValue', e.target.value)
}
function onCompositionEnd(e) {
  e.target.composing = false
  emit('update:modelValue', e.target.value)
}
</script>

<template>
  <input
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="cn('flex h-10 w-full rounded-xl border border-input bg-card/60 px-3 py-2 text-sm shadow-sm backdrop-blur file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200', props.className)"
    @input="onInput"
    @compositionstart="$event.target.composing = true"
    @compositionend="onCompositionEnd"
  />
</template>
