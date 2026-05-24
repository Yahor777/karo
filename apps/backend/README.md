# backend

Backend services for AI Agent Orchestrator. Houses the API gateway plus the modules listed in the design:

- `gateway` — API gateway
- `auth` — Auth Service (API-key validation, sessions, Gmail OAuth)
- `settings` — Settings Store (local + cloud)
- `models` — Model Catalog
- `orchestrator` — Orchestrator Core (pipeline state machine)
- `runtime` — Agent Runtime Pool
- `search` — Web Search Tool (DuckDuckGo backend)
- `trace` — Trace Event Bus
- `artifacts` — Artifact Store
- `persistence` — Storage adapters
- `secrets` — Secrets / KMS
- `fallback` — Fallback Model Manager

Concrete service implementations land in tasks 4.x, 6.x, 7.x, 9.x, 10.x, 11.x, 13.x, 14.x, 15.x, 17.x and 19.x.
