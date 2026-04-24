import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: ['chrome80', 'edge80', 'firefox78', 'safari13']
  },
  server: {
    port: 5174
  }
})
