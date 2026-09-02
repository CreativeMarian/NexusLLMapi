import request from './index'

export const getModels = (params) => request.get('/api/models', { params })
export const getModel = (id) => request.get(`/api/models/${id}`)
export const updateModel = (id, data) => request.put(`/api/models/${id}`, data)
export const deleteModel = (id) => request.delete(`/api/models/${id}`)
export const toggleModel = (id, enabled) => request.post(`/api/models/${id}/toggle`, { enabled })
export const batchToggleModels = (ids, enabled) => request.post('/api/models/batch-toggle', { ids, enabled })
export const batchTestModels = (data) => request.post('/api/models/batch-test', data, { timeout: 300000 })
export const batchDeleteModels = (ids) => request.post('/api/models/batch-delete', { ids })
export const getModelTags = () => request.get('/api/models/tags')
export const getModelStats = () => request.get('/api/models/stats')
export const testModelSpeed = (id) => request.post(`/api/models/${id}/test`)
