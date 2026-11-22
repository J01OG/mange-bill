import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new version waits until the user taps "Update" (never reloads mid-bill).
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Mushroom Farm',
        short_name: 'Farm',
        description: 'Billing, workforce, orders and reports for the farm',
        theme_color: '#166534',
        background_color: '#f7f7f2',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        lang: 'en-IN',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Long-press the app icon on Android to jump straight to these.
        shortcuts: [
          { name: 'New bill', short_name: 'Bill', url: '/bill', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
          { name: 'Cash', short_name: 'Cash', url: '/cash', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
          { name: 'Attendance', short_name: 'Attendance', url: '/attendance', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // Cache only the app shell. Data always comes live from Supabase.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Supabase + React in their own long-lived files so app updates download less.
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'], supabase: ['@supabase/supabase-js'] },
      },
    },
  },
});
