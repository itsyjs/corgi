# Recipes

Worked examples for common setups.

- [Enhance native `fetch`](/recipes/enhance-fetch) adds retry and timeout to plain
  `fetch` without adopting the client.
- [Search-as-you-type](/recipes/search-as-you-type) cancels stale requests with
  `abortPrevious`.
- [A resilient client](/recipes/resilient-corgi) sets up retry with a deadline on
  each attempt.
- [Per-attempt + total timeouts](/recipes/total-timeout) adds a client-level total
  budget on top of those per-attempt deadlines.
- [Auth & token refresh](/recipes/auth-refresh) builds a custom auth plugin and
  refreshes an expired token exactly once.
- [Error handling](/recipes/error-handling) covers `HttpError`, the guards, and the
  no-throw escape hatches.
- [ofetch-style interceptors](/recipes/interceptors) maps ofetch's hooks onto plugins.

New to the building blocks? Start with [Core concepts](/guide/concepts) and the
[Plugins overview](/plugins/).
