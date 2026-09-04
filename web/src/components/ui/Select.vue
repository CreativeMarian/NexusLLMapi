<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { cn } from '@/lib/utils'
import { ChevronDown, Check } from 'lucide-vue-next'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  className: { type: String, default: '' },
  options: {
    type: Array,
    default: () => []
  }
})
const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const containerRef = ref(null)

const selectedLabel = computed(() => {
  const opt = props.options.find(o => o.value === props.modelValue)
  return opt ? opt.label : props.placeholder
})

function select(value) {
  emit('update:modelValue', value)
  open.value = false
}

function handleClickOutside(e) {
  if (containerRef.value && !containerRef.value.contains(e.target)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onUnmounted(() => document.removeEventListener('click', handleClickOutside))
</script>

<template>
  <div ref="containerRef" :class="cn('relative', props.className)">
    <button
      type="button"
      :disabled="disabled"
      :class="cn(
        'flex h-10 w-full items-center justify-between rounded-xl border border-input bg-card/60 px-3 py-2 text-sm shadow-sm backdrop-blur placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200',
        open && 'border-primary/50 ring-2 ring-primary/20'
      )"
      @click="open = !open"
    >
      <span :class="modelValue ? 'text-foreground' : 'text-muted-foreground'">{{ selectedLabel }}</span>
      <ChevronDown :class="cn('h-4 w-4 opacity-50 transition-transform duration-200', open && 'rotate-180')" />
    </button>
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 scale-95 -translate-y-1"
      enter-to-class="opacity-100 scale-100 translate-y-0"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="open"
        class="glass-strong absolute z-[1000] mt-1 max-h-60 w-full overflow-auto rounded-xl p-1 text-popover-foreground"
      >
        <div
          v-for="opt in options"
          :key="opt.value"
          :class="cn(
            'relative flex w-full cursor-pointer select-none items-center rounded-lg py-1.5 pl-8 pr-2 text-sm outline-none transition-colors hover:bg-primary/10 hover:text-primary',
            modelValue === opt.value && 'bg-primary/10 text-primary font-medium'
          )"
          @click="select(opt.value)"
        >
          <span v-if="modelValue === opt.value" class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
            <Check class="h-4 w-4" />
          </span>
          {{ opt.label }}
        </div>
      </div>
    </Transition>
  </div>
</template>
