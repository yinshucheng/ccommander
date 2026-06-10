import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dev: vite 跑前端 (5173)，把 /api 和 /ws 代理到后端 (3890)
// prod: `vite build` 产物由后端 express 静态托管
export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3890',
      '/ws': { target: 'ws://localhost:3890', ws: true },
    },
  },
})
