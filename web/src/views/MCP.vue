<script setup>
import { ref, onMounted } from 'vue'
import {
  getMcpServers, createMcpServer, updateMcpServer,
  deleteMcpServer, toggleMcpServer, exportMcpServers
} from '@/api/mcp'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Select from '@/components/ui/Select.vue'
import Switch from '@/components/ui/Switch.vue'
import Badge from '@/components/ui/Badge.vue'
import Dialog from '@/components/ui/Dialog.vue'
import { Boxes, Plus, Pencil, Trash2, RefreshCw, Download, Copy, Terminal, Globe, Check } from 'lucide-vue-next'

const loading = ref(true)
const servers = ref([])
const saving = ref(false)

const dialogOpen = ref(false)
const editingId = ref(null)
const form = ref(blankForm())

const exportOpen = ref(false)
const exportJson = ref('')
const copied = ref(false)

const typeOptions = [
  { value: 'stdio', label: 'stdio · 本地命令' },
  { value: 'http', label: 'http · 远程服务' }
]

function blankForm() {
  return { name: '', description: '', type: 'stdio', command: '', args: '', env: '', url: '', enabled: true }
}

async function loadData() {
  loading.value = true
  try {
    const res = await getMcpServers()
    servers.value = res.data || []
  } catch (e) { console.error(e) }
  finally { loading.value = false }
}

function openCreate() {
  editingId.value = null
  form.value = blankForm()
  dialogOpen.value = true
}
function openEdit(srv) {
  editingId.value = srv.id
  form.value = {
    name: srv.name || '',
    description: srv.description || '',
    type: srv.type || 'stdio',
    command: srv.command || '',
    args: srv.args || '',
    env: srv.env || '',
    url: srv.url || '',
    enabled: srv.enabled ?? true
  }
  dialogOpen.value = true
}

async function onSave() {
  if (!form.value.name.trim()) { alert('请输入服务器名称'); return }
  if (form.value.type === 'stdio' && !form.value.command.trim()) { alert('stdio 类型需要填写启动命令'); return }
  if (form.value.type !== 'stdio' && !form.value.url.trim()) { alert('http 类型需要填写服务 URL'); return }
  saving.value = true
  try {
    const payload = {
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      type: form.value.type,
      command: form.value.type === 'stdio' ? form.value.command.trim() : '',
      args: form.value.type === 'stdio' ? form.value.args.trim() : '',
      env: form.value.type === 'stdio' ? form.value.env.trim() : '',
      url: form.value.type === 'stdio' ? '' : form.value.url.trim(),
      enabled: form.value.enabled
    }
    if (editingId.value) await updateMcpServer(editingId.value, payload)
    else await createMcpServer(payload)
    dialogOpen.value = false
    loadData()
  } catch (e) { alert(e.displayMessage || '保存失败') }
  finally { saving.value = false }
}

async function onToggle(srv) {
  try {
    await toggleMcpServer(srv.id, !srv.enabled)
    srv.enabled = !srv.enabled
  } catch (e) { alert(e.displayMessage || '切换失败') }
}

async function onDelete(srv) {
  if (!confirm(`确定删除 MCP 服务器「${srv.name}」？此操作不可恢复。`)) return
  try {
    await deleteMcpServer(srv.id)
    loadData()
  } catch (e) { alert(e.displayMessage || '删除失败') }
}

async function onExport() {
  try {
    const res = await exportMcpServers()
    exportJson.value = JSON.stringify(res.mcpServers || {}, null, 2)
    copied.value = false
    exportOpen.value = true
  } catch (e) { alert(e.displayMessage || '导出失败') }
}

async function copyExport() {
  const text = exportJson.value
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- 页面标题 -->
    <div class="glass flex items-center justify-between rounded-2xl p-5 md:p-6">
      <div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-purple/30 bg-brand-purple/10 px-3 py-1 text-[10px] font-semibold tracking-wider text-brand-purple">
          <Boxes class="h-3 w-3" />MCP SERVERS
        </span>
        <h2 class="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          <span class="gradient-text-animated">MCP 服务器</span>
        </h2>
        <p class="mt-2 font-mono text-xs text-muted-foreground md:text-sm">
          nexus@local ~ $ nexus mcp <span class="text-brand-blue">--list</span>
          <span class="text-muted-foreground/60">· {{ servers.length }} servers</span>
        </p>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" @click="onExport">
          <Download class="mr-2 h-4 w-4" />导出配置
        </Button>
        <Button variant="outline" size="sm" @click="loadData" :loading="loading">
          <RefreshCw class="mr-2 h-4 w-4" />刷新
        </Button>
        <Button size="sm" @click="openCreate">
          <Plus class="mr-2 h-4 w-4" />添加服务器
        </Button>
      </div>
    </div>

    <!-- 说明 -->
    <Card>
      <CardContent class="p-4">
        <p class="text-xs leading-relaxed text-muted-foreground">
          注册 <span class="font-mono text-foreground/80">Model Context Protocol</span> 服务器，供 Claude Code / MCP 客户端接入。
          <span class="font-medium text-foreground/80">stdio</span> 通过本地命令启动进程；
          <span class="font-medium text-foreground/80">http</span> 连接远程服务端点。
          配置完成后点击「导出配置」可生成客户端可直接使用的 <code class="rounded bg-card/60 px-1.5 py-0.5 font-mono text-[10px]">mcpServers</code> JSON。
        </p>
      </CardContent>
    </Card>

    <!-- 列表 -->
    <Card>
      <CardContent class="p-0">
        <div v-if="loading" class="py-16 text-center text-muted-foreground">
          <Boxes class="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />加载中...
        </div>

        <div v-else-if="servers.length === 0" class="py-16 text-center">
          <Boxes class="mx-auto mb-4 h-16 w-16 text-muted-foreground/30" />
          <h3 class="text-lg font-semibold">暂无 MCP 服务器</h3>
          <p class="mt-2 text-sm text-muted-foreground">点击右上角「添加服务器」创建第一个 MCP 服务器</p>
        </div>

        <div v-else class="divide-y divide-border/50">
          <div
            v-for="srv in servers"
            :key="srv.id"
            class="flex flex-col gap-3 p-4 transition-colors hover:bg-muted/30 md:flex-row md:items-center"
          >
            <div class="flex flex-1 items-center gap-3">
              <div :class="['flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', srv.enabled ? 'bg-gradient-to-br from-brand-purple/20 to-brand-cyan/20 shadow-glow-purple' : 'bg-muted']">
                <Terminal v-if="srv.type === 'stdio'" :class="['h-5 w-5', srv.enabled ? 'text-brand-purple' : 'text-muted-foreground']" />
                <Globe v-else :class="['h-5 w-5', srv.enabled ? 'text-brand-purple' : 'text-muted-foreground']" />
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <p class="truncate text-sm font-medium">{{ srv.name }}</p>
                  <Badge variant="info" class="shrink-0 text-[10px]">{{ srv.type === 'stdio' ? 'stdio' : 'http' }}</Badge>
                  <Badge v-if="srv.enabled" variant="success" class="shrink-0 text-[10px]">启用</Badge>
                  <Badge v-else variant="secondary" class="shrink-0 text-[10px]">停用</Badge>
                </div>
                <p class="mt-1 truncate font-mono text-xs text-muted-foreground">
                  <template v-if="srv.type === 'stdio'">{{ srv.command || '未配置命令' }}<span v-if="srv.args"> {{ srv.args }}</span></template>
                  <template v-else>{{ srv.url || '未配置 URL' }}</template>
                </p>
                <p v-if="srv.description" class="mt-0.5 truncate text-xs text-muted-foreground/70">{{ srv.description }}</p>
              </div>
            </div>

            <div class="flex items-center gap-2 md:shrink-0">
              <div class="flex items-center gap-2 rounded-full border border-border/50 bg-card/40 px-2 py-1">
                <span class="text-[10px] text-muted-foreground">启用</span>
                <Switch :model-value="srv.enabled" @update:model-value="onToggle(srv)" />
              </div>
              <Button variant="ghost" size="icon" class="h-8 w-8" title="编辑" @click="openEdit(srv)">
                <Pencil class="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" class="h-8 w-8 text-destructive" title="删除" @click="onDelete(srv)">
                <Trash2 class="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 新增 / 编辑对话框 -->
    <Dialog v-model="dialogOpen" :title="editingId ? '编辑 MCP 服务器' : '添加 MCP 服务器'" size="lg">
      <div class="space-y-4">
        <div class="grid gap-4 md:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-medium">服务器名称 <span class="text-destructive">*</span></label>
            <Input v-model="form.name" placeholder="如：filesystem / fetch / playwright" />
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium">连接类型 <span class="text-destructive">*</span></label>
            <Select v-model="form.type" :options="typeOptions" />
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium">描述</label>
          <Input v-model="form.description" placeholder="可选，说明该服务器的用途" />
        </div>

        <template v-if="form.type === 'stdio'">
          <div>
            <label class="mb-1.5 block text-sm font-medium">启动命令 <span class="text-destructive">*</span></label>
            <Input v-model="form.command" placeholder="如：npx -y @modelcontextprotocol/server-filesystem /path" class="font-mono" />
          </div>
          <div class="grid gap-4 md:grid-cols-2">
            <div>
              <label class="mb-1.5 block text-sm font-medium">参数 args（JSON 数组，可选）</label>
              <Textarea v-model="form.args" rows="3" placeholder='["/path/to/dir"]' class="font-mono text-xs" />
            </div>
            <div>
              <label class="mb-1.5 block text-sm font-medium">环境变量 env（JSON 对象，可选）</label>
              <Textarea v-model="form.env" rows="3" placeholder='{"KEY":"value"}' class="font-mono text-xs" />
            </div>
          </div>
        </template>

        <div v-else>
          <label class="mb-1.5 block text-sm font-medium">服务 URL <span class="text-destructive">*</span></label>
          <Input v-model="form.url" placeholder="https://mcp.example.com/sse 或 http://127.0.0.1:3000/mcp" class="font-mono" />
        </div>

        <div class="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
          <span class="text-sm font-medium">启用</span>
          <Switch v-model="form.enabled" />
          <span class="ml-1 text-xs text-muted-foreground">停用后不参与 MCP 客户端发现</span>
        </div>
      </div>
      <template #footer>
        <Button variant="outline" @click="dialogOpen = false">取消</Button>
        <Button :loading="saving" @click="onSave">{{ editingId ? '保存修改' : '创建' }}</Button>
      </template>
    </Dialog>

    <!-- 导出配置对话框 -->
    <Dialog v-model="exportOpen" title="MCP 配置导出" description="粘贴到 Claude Code / 支持 mcpServers 的客户端配置文件中" size="lg">
      <pre class="max-h-[50vh] overflow-auto rounded-xl bg-black/40 p-4 font-mono text-xs text-foreground/90">{{ exportJson || '（无已启用的 MCP 服务器）' }}</pre>
      <template #footer>
        <Button variant="outline" @click="exportOpen = false">关闭</Button>
        <Button :disabled="!exportJson" @click="copyExport">
          <Check v-if="copied" class="mr-2 h-4 w-4 text-brand-green" />
          <Copy v-else class="mr-2 h-4 w-4" />
          {{ copied ? '已复制' : '复制配置' }}
        </Button>
      </template>
    </Dialog>
  </div>
</template>
