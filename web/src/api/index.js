import axios from 'axios'

const request = axios.create({
  baseURL: '/',
  timeout: 30000
})

request.interceptors.response.use(
  (response) => response.data,
  (error) => {
    console.error('API Error:', error.message)
    return Promise.reject(error)
  }
)

export default request
