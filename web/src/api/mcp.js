import request from './index'

export const getMcpServers = () => request.get('/api/mcp')
export const getMcpServer = (id) => request.get(`/api/mcp/${id}`)
export const createMcpServer = (data) => request.post('/api/mcp', data)
export const updateMcpServer = (id, data) => request.put(`/api/mcp/${id}`, data)
export const deleteMcpServer = (id) => request.delete(`/api/mcp/${id}`)
export const toggleMcpServer = (id, enabled) => request.post(`/api/mcp/${id}/toggle`, { enabled })
// 导出为 Claude Code / 客户端可用的 mcpServers 配置
export const exportMcpServers = () => request.get('/api/mcp/export')
