import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  base: './',
  clearScreen: false, // Tauri のログと混在させない
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true, // Tauri の devUrl と一致させるため
  },
  build: {
    // Tauri ビルド時は環境変数でターゲットブラウザを指定
    target: process.env.TAURI_ENV_PLATFORM === 'windows'
      ? 'chrome105'
      : process.env.TAURI_ENV_PLATFORM === 'macos'
        ? 'safari13'
        : 'esnext',
  },
})
