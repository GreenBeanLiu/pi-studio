import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // 云端图像中继的地址/key 在构建期烧进主进程(打包后的 Electron 主进程读不到
    // 用户 shell 的 process.env)。可用构建机的 PI_CLOUD_IMAGE_* 覆盖默认值。
    // relay 是公网 HTTPS URL;key 是设计上就随客户端分发的扫描防护 key。
    define: {
      __CLOUD_IMAGE_RELAY__: JSON.stringify(
        process.env.PI_CLOUD_IMAGE_RELAY || 'https://trail-api.glanger.xyz',
      ),
      __CLOUD_IMAGE_KEY__: JSON.stringify(
        process.env.PI_CLOUD_IMAGE_KEY || '8f3b404477548a7a59223fceec483bae',
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
