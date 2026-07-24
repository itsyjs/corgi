---
layout: home

hero:
  name: 'Corgi'
  tagline: That's so fetch! ~1.4 KB gzipped, zero dependencies, ESM, isomorphic.
  image:
    src: /corgi-icon.svg
    alt: Corgi
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Plugins
      link: /plugins

features:
  - title: Composable middleware
    details: Everything is built from two shapes — Fetcher and Plugin. Writing your own plugin takes just a few lines of code.
  - title: Pay only for what you import
    details: Plugins that extend functionality - retry, abort-previous, timeout, and schema - live on their own import paths, they cost nothing unless used.
  - title: Runs everywhere
    details: Node 18.17+, Deno, Bun, Cloudflare Workers, and evergreen browsers. Web-standard globals only.
---
