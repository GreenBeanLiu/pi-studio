import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // 云端图像中继地址在构建期写入主进程；Key 不再随构建产物分发，
    // 由设置页的加密配置或开发环境 PI_CLOUD_IMAGE_KEY 提供。
    define: {
      __CLOUD_IMAGE_RELAY__: JSON.stringify(
        process.env.PI_CLOUD_IMAGE_RELAY || 'https://trail-api.glanger.xyz',
      ),
    },
    resolve: {
      alias: { '@main': resolve('src/main') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
      },
    },
  },
})
