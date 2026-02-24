# Changelog

## 0.1.0

- Initial public package release.
- Added HTTP session auth hardening for all `/mcp` methods.
- Added session ownership, TTL expiration, and max-session eviction.
- Added configurable body limits and structured error envelopes.
- Added optional Redis-backed distributed rate limiting.
- Added bounded LRU+TTL caches for API-key and workspace lookups.
- Added metrics endpoint and graceful shutdown handling.
- Added deterministic prepack/pack validation for npm publishing.
