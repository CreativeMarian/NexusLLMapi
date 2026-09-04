import request from './index'

export const getPrompts = (params) => request.get('/api/prompts', { params })
export const getPrompt = (id) => request.get(`/api/prompts/${id}`)
export const getActivePrompt = () => request.get('/api/prompts/active')
export const createPrompt = (data) => request.post('/api/prompts', data)
export const updatePrompt = (id, data) => request.put(`/api/prompts/${id}`, data)
export const deletePrompt = (id) => request.delete(`/api/prompts/${id}`)
export const activatePrompt = (id) => request.post(`/api/prompts/${id}/activate`)
