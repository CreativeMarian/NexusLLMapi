import request from './index'

export const getLogs = (params) => request.get('/api/logs', { params })
export const getLog = (id) => request.get(`/api/logs/${id}`)
export const clearLogs = () => request.delete('/api/logs')
export const getLogStats = () => request.get('/api/logs/stats')

// 服务运行日志（server.log）
export const getServerLogs = (params) => request.get('/api/server-logs', { params })
export const getServerLogStats = () => request.get('/api/server-logs/stats')
