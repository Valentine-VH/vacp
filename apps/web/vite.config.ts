import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig(({ mode }) => {
  const port = Number(loadEnv(mode, process.cwd(), 'VACP_DEV_').VACP_DEV_API_PORT ?? '3320')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VACP_DEV_API_PORT')
  const api = 'http://127.0.0.1:' + port
  return {
    plugins: [react()],
    server: { proxy: { '/api/v1/dsh-connector/ws': { target: api, ws: true }, '/health': api, '/api': api, '/v1': api } },
  }
})
