import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { transformerTwoslash } from '@shikijs/vitepress-twoslash';
import { createFileSystemTypesCache } from '@shikijs/vitepress-twoslash/cache-fs';

// Repo root (this file lives at docs/.vitepress/config.ts).
const root = fileURLToPath(new URL('../../', import.meta.url));

// GitHub Pages project-site base. Single source of truth: used for `base` AND for
// `head` asset URLs (VitePress does NOT auto-apply base to head). Change to '/' for
// a user/org site or a custom domain.
const base = '/corgi/';

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: '@itsy/corgi',
  description:
    'Tiny composable typed fetch — one-off or client; cancel-previous, retry, timeout, and schema-validated transforms.',
  lang: 'en-US',
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}corgi-icon.svg` }],
    ['meta', { name: 'theme-color', content: '#ba490f' }],
  ],

  markdown: {
    // Type-hover on code samples. Snippets that `import { … } from '@itsy/corgi'`
    // resolve against the built declaration files (so `pnpm docs:*` builds first).
    codeTransformers: [
      transformerTwoslash({
        // Keep the cache inside docs/.vitepress/cache (gitignored) rather than the
        // default `.vitepress/cache` resolved from cwd (which lands at the repo root).
        typesCache: createFileSystemTypesCache({
          dir: fileURLToPath(new URL('./cache/twoslash', import.meta.url)),
        }),
        twoslashOptions: {
          compilerOptions: {
            target: 99, // ScriptTarget.ESNext
            module: 99, // ModuleKind.ESNext
            moduleResolution: 100, // ModuleResolutionKind.Bundler
            strict: true,
            // Passed straight to the compiler API, so lib needs the full file names.
            lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
            types: [], // web globals only — no @types/node in snippets
            baseUrl: root,
            paths: {
              '@itsy/corgi': [`${root}dist/index.d.ts`],
              '@itsy/corgi/*': [`${root}dist/*.d.ts`],
            },
          },
        },
      }),
    ],
    languages: ['js', 'jsx', 'ts', 'tsx'],
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Plugins', link: '/plugins/', activeMatch: '/plugins/' },
      { text: 'Recipes', link: '/recipes/', activeMatch: '/recipes/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      {
        text: 'v1',
        items: [
          { text: 'Changelog', link: 'https://github.com/itsyjs/corgi/releases' },
          { text: 'npmx', link: 'https://npmx.dev/package/@itsy/corgi' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Features', link: '/guide/features' },
          ],
        },
        {
          text: 'Usage',
          items: [
            { text: 'The Corgi export', link: '/guide/corgi' },
            { text: 'Building requests', link: '/guide/requests' },
            { text: 'Responses & errors', link: '/guide/responses' },
            { text: 'TypeScript', link: '/guide/typescript' },
            { text: 'Corgi chonk', link: '/guide/chonk' },
          ],
        },
        {
          text: 'Design',
          items: [
            { text: 'Core concepts', link: '/guide/concepts' },
            { text: `Bundle size ramblings`, link: '/guide/library-size' },
          ],
        },
      ],
      '/plugins/': [
        {
          text: 'Plugins',
          items: [
            { text: 'Overview & usage', link: '/plugins/' },
            { text: 'Write your own', link: '/plugins/custom' },
          ],
        },
        {
          text: 'Built-in plugins',
          items: [
            { text: 'timeout', link: '/plugins/timeout' },
            { text: 'retry', link: '/plugins/retry' },
            { text: 'abort-previous', link: '/plugins/abort-previous' },
            { text: 'schema (transform)', link: '/plugins/schema' },
          ],
        },
      ],
      '/recipes/': [
        {
          text: 'Recipes',
          items: [
            { text: 'Overview', link: '/recipes/' },
            { text: 'Enhance native fetch', link: '/recipes/enhance-fetch' },
            { text: 'Search-as-you-type', link: '/recipes/search-as-you-type' },
            { text: 'A resilient client', link: '/recipes/resilient-corgi' },
            { text: 'Per-attempt + total timeouts', link: '/recipes/total-timeout' },
            { text: 'Auth & token refresh', link: '/recipes/auth-refresh' },
            { text: 'Error handling', link: '/recipes/error-handling' },
            { text: 'ofetch-style interceptors', link: '/recipes/interceptors' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'The Corgi interface', link: '/api/corgi-interface' },
            { text: 'Options & types', link: '/api/types' },
            { text: 'Errors & guards', link: '/api/errors' },
            { text: 'Composition engine', link: '/api/composition' },
            { text: 'Plugins', link: '/api/plugins' },
          ],
        },
      ],
    },

    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/itsyjs/corgi' }],
    editLink: {
      pattern: 'https://github.com/itsyjs/corgi/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Dave Honneffer',
    },
  },
});
