import request from './index'

export const getTemplates = () => request.get('/api/channels/templates')
export const getChannels = () => request.get('/api/channels')
export const getChannel = (id) => request.get(`/api/channels/${id}`)
export const createChannel = (data) => request.post('/api/channels', data)
export const updateChannel = (id, data) => request.put(`/api/channels/${id}`, data)
export const deleteChannel = (id) => request.delete(`/api/channels/${id}`)
export const toggleChannel = (id, enabled) => request.post(`/api/channels/${id}/toggle`, { enabled })
export const testChannel = (id) => request.post(`/api/channels/${id}/test`)
export const syncChannelModels = (id) => request.post(`/api/channels/${id}/sync`)
