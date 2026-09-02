<script setup>
import { ref, watch } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps({
  modelValue: { type: String, default: '' },
  className: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])

const active = ref(props.modelValue)
watch(() => props.modelValue, (val) => { active.value = val })

function setActive(val) {
  active.value = val
  emit('update:modelValue', val)
}

defineExpose({ active, setActive })
</script>

<template>
  <div :class="cn('w-full', props.className)">
    <div class="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground">
      <slot name="tabs" :active="active" :setActive="setActive" />
    </div>
    <div class="mt-4">
      <slot :active="active" />
    </div>
  </div>
</template>
