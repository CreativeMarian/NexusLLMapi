import axios from 'axios'

const request = axios.create({
  baseURL: '/',
  timeout: 30000
})

request.interceptors.response.use(
  (response) => response.data,
  (error) => {
    // 透出后端错误体中的具体信息，页面 toast 不再只显示 axios 的通用文案
    const data = error.response?.data
    const serverMessage =
      (typeof data === 'string' && data) ||
      data?.error?.message ||
      data?.message ||
      (data?.error && typeof data.error === 'string' ? data.error : '')
    if (serverMessage) error.message = serverMessage
    error.displayMessage = serverMessage || error.message
    console.error('API Error:', error.displayMessage)
    return Promise.reject(error)
  }
)

export default request
