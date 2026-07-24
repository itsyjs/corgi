# Recipes

Task-focused walkthroughs for the things people actually build.

- **[Enhance native `fetch`](/recipes/enhance-fetch)** — add retry/timeout to plain
  `fetch` without adopting the client.
- **[Search-as-you-type](/recipes/search-as-you-type)** — cancel stale requests with
  `abortPrevious`.
- **[A resilient client](/recipes/resilient-corgi)** — retry + timeout, `Retry-After`,
  and per-attempt vs total budgets.
- **[Per-attempt + total timeouts](/recipes/total-timeout)** — a global total budget on
  top of per-attempt deadlines and retries.
- **[Auth & token refresh](/recipes/auth-refresh)** — a custom auth plugin, and
  refreshing an expired token exactly once.
- **[Error handling](/recipes/error-handling)** — `HttpError`, the error guards,
  and the no-throw escape hatches.
- **[ofetch-style interceptors](/recipes/interceptors)** — map ofetch's `onRequest` /
  `onResponse` / error hooks onto plugins.

New to the building blocks? Start with [Core concepts](/guide/concepts) and the
[Plugins overview](/plugins/).
