import request from './index'

export const getSettings = () => request.get('/api/settings')
export const updateSettings = (data) => request.put('/api/settings', data)
