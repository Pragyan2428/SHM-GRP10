import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// In development the API is proxied so the session cookie stays same-origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    // Keeps paths as given (helps when the project lives in a virtualised/symlinked folder).
    resolve: { preserveSymlinks: true },
    build: {
      rollupOptions: { output: { manualChunks: { charts: ['recharts'], vendor: ['react', 'react-dom', 'react-router-dom'] } } },
    },
    server: {
      port: 5173,
      proxy: { '/api': { target: env.VITE_API_PROXY || 'http://127.0.0.1:8000', changeOrigin: false } },
    },
  }
})
