import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [
    react(),
    {
      // The support footer reads `data-version` off its own script tag, and
      // Vite's `define` only reaches JavaScript — index.html is copied
      // verbatim. Without this hook the attribute ships as the literal
      // `__APP_VERSION__` and every bug report arrives with no version on it.
      //
      // It throws rather than warns: the markup is hand-written, and a rename
      // that quietly stopped matching would unversion every later report with
      // nothing to notice.
      name: 'burrow-app-version',
      transformIndexHtml(html: string) {
        if (!html.includes('__APP_VERSION__')) {
          throw new Error(
            'index.html no longer contains __APP_VERSION__ — the support footer ' +
              'would ship without a version. Put the placeholder back on the ' +
              'support-footer.js script tag.',
          )
        }
        return html.replace(/__APP_VERSION__/g, `v${pkg.version}`)
      },
    },
  ],
  // Relative, so assets resolve under Tauri's tauri:// scheme. An absolute
  // base works on a hosted origin and 404s inside the app.
  base: './',
  clearScreen: false,
  server: { port: 5176, strictPort: true },
  build: { target: 'safari15', outDir: 'dist', sourcemap: true },
})
