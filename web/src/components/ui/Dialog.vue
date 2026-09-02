<script setup>
import { ref, watch } from 'vue'
import { cn } from '@/lib/utils'
import { X } from 'lucide-vue-next'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  size: { type: String, default: 'md', validator: (v) => ['sm', 'md', 'lg', 'xl'].includes(v) },
  className: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'close'])

const visible = ref(props.modelValue)

watch(() => props.modelValue, (val) => {
  visible.value = val
})

function close() {
  visible.value = false
  emit('update:modelValue', false)
  emit('close')
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl'
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="close" />
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="opacity-0 scale-95 translate-y-4"
          enter-to-class="opacity-100 scale-100 translate-y-0"
          leave-active-class="transition duration-150 ease-in"
          leave-from-class="opacity-100 scale-100"
          leave-to-class="opacity-0 scale-95"
        >
          <div
            v-if="visible"
            :class="cn(
              'glass-strong relative z-10 w-full rounded-2xl text-card-foreground',
              sizeClasses[size],
              props.className
            )"
          >
            <div class="flex items-start justify-between border-b border-border/40 bg-gradient-to-r from-brand-blue/5 via-brand-purple/5 to-brand-cyan/5 p-6 first:rounded-t-2xl">
              <div>
                <h2 v-if="title" class="text-lg font-semibold">{{ title }}</h2>
                <p v-if="description" class="mt-1 text-sm text-muted-foreground">{{ description }}</p>
              </div>
              <button class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" @click="close">
                <X class="h-5 w-5" />
              </button>
            </div>
            <div class="max-h-[70vh] overflow-y-auto p-6">
              <slot />
            </div>
            <div v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-border/50 p-4">
              <slot name="footer" />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
