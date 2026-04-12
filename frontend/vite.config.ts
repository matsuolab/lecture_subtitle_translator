/// <reference types="vitest" />
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
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // Tauri の devUrl と一致させるため
    watch: {
      // node_modules・Rust成果物・gitを監視対象から除外（EMFILE対策）
      ignored: ['**/node_modules/**', '**/src-tauri/target/**', '**/.git/**'],
    },
  },
  build: {
    // Tauri ビルド時は環境変数でターゲットブラウザを指定
    target: process.env.TAURI_ENV_PLATFORM === 'windows'
      ? 'chrome105'
      : process.env.TAURI_ENV_PLATFORM === 'macos'
        ? 'safari13'
        : 'esnext',
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
