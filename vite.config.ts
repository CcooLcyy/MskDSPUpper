import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: process.env.MSKDSP_UPPER_SOURCEMAP === 'true',
  },
})
