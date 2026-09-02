import request from './index'

export const getHealth = () => request.get('/api/health')
export const triggerHealth = () => request.post('/api/health/trigger')
