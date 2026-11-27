import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: {
    license: { fileName: 'browser-licenses.md' },
    rolldownOptions: mode === 'mcp' ? { input: 'desktop-panel.html' } : undefined,
  },
}));
