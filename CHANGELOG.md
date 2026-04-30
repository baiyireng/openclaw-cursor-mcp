# Changelog

All notable changes to this project are documented in this file.

## 0.1.0

- Added end-to-end trace propagation (`traceId`) across MCP -> gateway -> provider.
- Added automatic/default idempotency key generation for message sending.
- Unified gateway error response schema with retryability hints.
- Added approval expiration support (`expiresInMs`, `OPENCLAW_PERMISSION_TTL_MS`).
- Improved provider resilience:
  - agent cache TTL and stale-agent auto-recovery
  - exponential polling backoff
  - richer reply extraction and fallback behavior
- Added observability tool:
  - `cursor_metrics_get` for lightweight reliability metrics.
- Added MCP configuration automation tools:
  - `cursor_gateway_config_get`
  - `cursor_gateway_config_update`
- Added MCP gateway process operations:
  - `cursor_gateway_process_status/start/stop/restart/logs`
- Added gateway process manager (`gateway/manage.mjs`) and npm scripts for controlled lifecycle.
- Added integrated CLI (`openclaw-cursor-mcp`) with:
  - `init`, `up`, `down`, `status`, `logs`, `doctor`
  - automatic gateway port selection
  - generated OpenClaw MCP template
  - diagnostics auto-fix via `doctor --fix`
