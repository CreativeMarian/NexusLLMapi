<script setup>
import { ref, onMounted, computed } from 'vue'
import { getPrompts, createPrompt, updatePrompt, deletePrompt, activatePrompt } from '@/api/prompt'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Select from '@/components/ui/Select.vue'
import Badge from '@/components/ui/Badge.vue'
import Dialog from '@/components/ui/Dialog.vue'
import { FileText, Plus, Pencil, Trash2, RefreshCw, Check, Sparkles, Tag } from 'lucide-vue-next'

const loading = ref(true)
const prompts = ref([])
const saving = ref(false)
const activatingId = ref(null)

const categoryFilter = ref('')
const dialogOpen = ref(false)
const editingId = ref(null)
const form = ref(blankForm())

const categoryOptions = computed(() => {
  const set = new Set(prompts.value.map((p) => p.category).filter(Boolean))
  return [
    { value: '', label: '全部分类' },
    ...[...set].sort().map((c) => ({ value: c, label: c }))
  ]
})

function blankForm() {
  return { name: '', description: '', category: 'custom', tags: '', content: '' }
}

async function loadData() {
  loading.value = true
  try {
    const params = {}
    if (categoryFilter.value) params.category = categoryFilter.value
    const res = await getPrompts(params)
    prompts.value = res.data || []
  } catch (e) { console.error(e) }
  finally { loading.value = false }
}

function applyFilter() {
  loadData()
}

function openCreate() {
  editingId.value = null
  form.value = blankForm()
  dialogOpen.value = true
}
function openEdit(p) {
  editingId.value = p.id
  form.value = {
    name: p.name || '',
    description: p.description || '',
    category: p.category || 'custom',
    tags: p.tags || '',
    content: p.content || ''
  }
  dialogOpen.value = true
}

async function onSave() {
  if (!form.value.name.trim()) { alert('请输入提示词名称'); return }
  if (!form.value.content.trim()) { alert('请输入提示词内容'); return }
  saving.value = true
  try {
    const payload = {
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      category: form.value.category.trim() || 'custom',
      tags: form.value.tags.trim(),
      content: form.value.content
    }
    if (editingId.value) await updatePrompt(editingId.value, payload)
    else await createPrompt(payload)
    dialogOpen.value = false
    loadData()
  } catch (e) { alert(e.displayMessage || '保存失败') }
  finally { saving.value = false }
}

async function onActivate(p) {
  if (p.active) return
  activatingId.value = p.id
  try {
    await activatePrompt(p.id)
    loadData()
  } catch (e) { alert(e.displayMessage || '激活失败') }
  finally { activatingId.value = null }
}

async function onDelete(p) {
  if (!confirm(`确定删除提示词「${p.name}」？此操作不可恢复。`)) return
  try {
    await deletePrompt(p.id)
    loadData()
  } catch (e) { alert(e.displayMessage || '删除失败') }
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- 页面标题 -->
    <div class="glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-cyan/30 bg-brand-cyan/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-cyan">
          <FileText class="h-3 w-3" />PROMPT LIBRARY
        </span>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">提示词</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ nexus prompts <span class="text-brand-blue">--active</span>
          <span class="text-muted-foreground/60">· {{ prompts.length }} prompts</span>
        </p>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" @click="loadData" :loading="loading">
          <RefreshCw class="mr-2 h-4 w-4" />刷新
        </Button>
        <Button size="sm" @click="openCreate">
          <Plus class="mr-2 h-4 w-4" />添加提示词
        </Button>
      </div>
    </div>

    <!-- 筛选栏 -->
    <Card>
      <CardContent class="p-4">
        <div class="flex flex-wrap items-center gap-3">
          <Select v-model="categoryFilter" :options="categoryOptions" class="w-48" @update:model-value="applyFilter" />
          <p class="text-xs text-muted-foreground">同一时间仅一条提示词处于「当前激活」状态，供外部 /api/prompts/active 读取。</p>
        </div>
      </CardContent>
    </Card>

    <!-- 列表 -->
    <div v-if="loading" class="py-16 text-center text-muted-foreground">
      <FileText class="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />加载中...
    </div>

    <div v-else-if="prompts.length === 0" class="glass rounded-2xl py-16 text-center">
      <FileText class="mx-auto mb-4 h-16 w-16 text-muted-foreground/30" />
      <h3 class="text-lg font-semibold">暂无提示词</h3>
      <p class="mt-2 text-sm text-muted-foreground">点击右上角「添加提示词」创建第一个提示词</p>
    </div>

    <div v-else class="grid gap-4 lg:grid-cols-2">
      <Card v-for="p in prompts" :key="p.id" class="glass-hover flex flex-col">
        <CardContent class="flex flex-1 flex-col p-5">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2">
              <div :class="['flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', p.active ? 'bg-gradient-to-br from-brand-cyan/25 to-brand-blue/25 shadow-glow-cyan' : 'bg-muted']">
                <Sparkles :class="['h-4 w-4', p.active ? 'text-brand-cyan' : 'text-muted-foreground']" />
              </div>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-sm font-semibold">{{ p.name }}</p>
                  <Badge variant="info" class="text-[10px]">{{ p.category }}</Badge>
                  <Badge v-if="p.active" variant="success" class="text-[10px]">
                    <Check class="mr-0.5 inline h-3 w-3" />当前激活
                  </Badge>
                </div>
              </div>
            </div>
            <div class="flex shrink-0 gap-1">
              <Button variant="ghost" size="icon" class="h-8 w-8" title="编辑" @click="openEdit(p)">
                <Pencil class="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" class="h-8 w-8 text-destructive" title="删除" @click="onDelete(p)">
                <Trash2 class="h-4 w-4" />
              </Button>
            </div>
          </div>

          <p v-if="p.description" class="mt-3 text-xs text-muted-foreground">{{ p.description }}</p>
          <pre class="mt-3 flex-1 whitespace-pre-wrap break-all rounded-lg bg-black/30 p-3 font-mono text-xs leading-relaxed text-foreground/75">{{ p.content }}</pre>

          <div class="mt-3 flex items-center justify-between gap-2 border-t border-border/40 pt-3">
            <div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Tag class="h-3 w-3 shrink-0" />
              <span class="truncate">{{ p.tags || '未打标签' }}</span>
            </div>
            <Button
              v-if="!p.active"
              variant="outline"
              size="sm"
              class="h-8 shrink-0"
              :loading="activatingId === p.id"
              @click="onActivate(p)"
            >
              <Check class="mr-1.5 h-3.5 w-3.5" />设为激活
            </Button>
            <span v-else class="text-xs font-medium text-brand-green">使用中</span>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- 新增 / 编辑对话框 -->
    <Dialog v-model="dialogOpen" :title="editingId ? '编辑提示词' : '添加提示词'" size="lg">
      <div class="space-y-4">
        <div class="grid gap-4 md:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-medium">名称 <span class="text-destructive">*</span></label>
            <Input v-model="form.name" placeholder="如：代码审查助手" />
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium">分类</label>
            <Input v-model="form.category" placeholder="如：custom / coding / writing" />
          </div>
        </div>
        <div>
          <label class="mb-1.5 block text-sm font-medium">描述</label>
          <Input v-model="form.description" placeholder="可选，说明该提示词用途" />
        </div>
        <div>
          <label class="mb-1.5 block text-sm font-medium">标签</label>
          <Input v-model="form.tags" placeholder="可选，逗号分隔，如：review,typescript" />
        </div>
        <div>
          <label class="mb-1.5 block text-sm font-medium">内容 <span class="text-destructive">*</span></label>
          <Textarea v-model="form.content" rows="8" placeholder="粘贴提示词正文..." class="font-mono text-xs" />
        </div>
      </div>
      <template #footer>
        <Button variant="outline" @click="dialogOpen = false">取消</Button>
        <Button :loading="saving" @click="onSave">{{ editingId ? '保存修改' : '创建' }}</Button>
      </template>
    </Dialog>
  </div>
</template>
