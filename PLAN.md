# Chernoff Monitor — Implementation Plan

Lightweight Chernoff-face dashboard for monitoring OTel-instrumented services via Prometheus.

---

## Goal

A single Docker-deployable app that connects to an existing Prometheus (or compatible) instance, auto-discovers services, and renders a grid of Chernoff faces — one per service. No config files for the basics. Just `docker run` and go.

**Target Audience:** Standard SaaS startups.
**Compatibility:** Works with Prometheus, Thanos, Mimir, VictoriaMetrics, and cloud-managed Prometheus services (AWS/GCP/Azure).

---

## Architecture

```
Browser (vanilla HTML/JS)
   │
   │  fetch /api/metrics
   ▼
Bun server (server.ts)
   │
   │  executes specific PromQL queries
   ▼
Prometheus (user's existing instance)
```

**Why a backend?**

1.  **Security**: We do not expose a generic PromQL proxy. The server only runs specific, safe queries.
2.  **CORS**: Browsers can't usually talk to Prometheus directly.
3.  **Performance**: The server aggregates logic.

---

## File Structure

```
chernoffOT2/
├── server.ts              # Bun HTTP server: static files + API
├── public/
│   ├── index.html         # Single page
│   ├── style.css          # Dark theme, premium monitoring aesthetic
│   ├── app.js             # Discovery, polling, metrics, layout
│   └── face.js            # SVG face renderer (pure function)
├── Dockerfile             # Uses oven/bun
├── .dockerignore
├── package.json
├── PLAN.md                # This file
└── README.md
```

Total: ~7 source files.

---

## Component Details

### 1. `server.ts` — Bun Server

**API Endpoints:**

| Endpoint            | Purpose                                            |
| ------------------- | -------------------------------------------------- |
| `GET /api/services` | Returns list of active `service_name` values       |
| `GET /api/metrics`  | Returns aggregated metrics (errors, latency, load) |
| `GET /api/config`   | Returns frontend config (refresh interval)         |

**Environment Variables (Configuration):**

| Var                | Default                                | Description                                |
| ------------------ | -------------------------------------- | ------------------------------------------ |
| `PROMETHEUS_URL`   | `http://localhost:9090`                | Base URL for Prometheus/Thanos/Mimir       |
| `REFRESH_INTERVAL` | `15`                                   | Seconds between dashboard refreshes        |
| `PORT`             | `3000`                                 | Server port                                |
| `LABEL_SERVICE`    | `service_name`                         | Label used for service discovery           |
| `METRIC_DURATION`  | `http_server_request_duration_seconds` | Base metric name for latency/requests      |
| `LABEL_STATUS`     | `http_response_status_code`            | Label for HTTP status (e.g. `status_code`) |

**Security Note:** Unlike a generic proxy, this backend _constructs_ the queries. It prevents arbitrary PromQL injection by whitelisting the query patterns.

---

### 2. `public/face.js` — SVG Face Renderer

A pure function: `renderFace(params) → SVG string`

**Input parameters (all 0–1):**

| Param       | Driven by             | Visual effect                                 |
| ----------- | --------------------- | --------------------------------------------- |
| `mouth`     | Error rate (inverted) | 0 = deep frown, 1 = wide smile                |
| `eyeSize`   | Latency p95           | 0 = relaxed small eyes, 1 = wide/shocked eyes |
| `browAngle` | Request rate          | 0 = furrowed/worried, 1 = relaxed             |
| `health`    | Composite score       | 0 = red face, 0.5 = yellow, 1 = green         |

**SVG structure (viewBox 0 0 200 200):**
_Standard Chernoff components (Head, Ears, Eyebrows, Eyes, Pupils, Nose, Mouth)._

**Face color mapping:**

- `health=1.0` → `hsl(140, 45%, 82%)` (calm green)
- `health=0.5` → `hsl(45, 55%, 80%)` (amber/yellow)
- `health=0.0` → `hsl(0, 60%, 78%)` (warm red)

---

### 3. `public/app.js` — Main App Logic

**Boot sequence:**

1.  `GET /api/config`
2.  `GET /api/services` → List of services
3.  `GET /api/metrics` → All metrics in one go

**Normalization Strategy (Crucial for generic support):**

1.  **Error Rate (Mouth)**:
    - **Logic**: Non-linear sensitivity.
    - `raw_error_rate < 0.001` (0.1%) → 😁 (1.0)
    - `raw_error_rate > 0.05` (5%) → ☹️ (0.0)
    - Formula: `1 - CLAMP(log10(error_rate * 1000 + 1) / log10(50 + 1), 0, 1)` (approximated)
    - _Why_: A 1% error rate is usually bad. A linear scale makes 1% look like 99% health. We need 1% to look concerning.

2.  **Latency p95 (Eyes)**:
    - **Logic**: Logarithmic scale relative to cohort.
    - Since services vary from 1ms to 5s, we can't use a linear max.
    - Value = `log(service_latency) / log(max_latency_in_cluster)`
    - Or simpler: `CLAMP(log10(latency_ms) / 4, 0, 1)` where 10s = 1.0 (shocked), 1ms = 0.0.
    - _Decision_: Use `log10` scaling. `1ms` -> closed eyes, `1000ms` -> wide eyes.

3.  **Request Rate (Brows)**:
    - **Logic**: Logarithmic relative to max.
    - `val = log10(req_rate + 1) / log10(max_req_rate + 1)`
    - Ensures small services don't disappear against a monolith.

**Handling missing data:**

- Missing metrics → neutral face feature (0.5).
- All missing → generic "ghost" face.

---

### 4. `public/index.html` — Page Structure

Standard layout with:

- Header (Title, Status Dot)
- Grid Main (injected cards)
- Footer/Metadata

**Card Interaction:**

- Hover: Scale up + Glossy effect.
- Click: Disabled for v1 (placeholder for future deep links).

---

### 5. `public/style.css` — Design System

**Aesthetics:**

- **Techno/Cyberpunk Lite**: Dark mode, glassmorphism, neon accents (`#00e5a0`).
- **Typography**: Inter/Roboto.
- **Responsiveness**: Grid adapts columns automatically.

---

### 6. Dockerfile

```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY . .
EXPOSE 3000
CMD ["bun", "server.ts"]
```

**Usage:**

```bash
docker build -t chernoff-monitor .
docker run -d -p 3000:3000 -e PROMETHEUS_URL=http://host.docker.internal:9090 chernoff-monitor
```

---

## Build Phases

### Phase 1 — Face Renderer (`face.js`)

- Implement `renderFace` with SVG paths.
- Create a test harness HTML file to tweak the "emotions" ensuring 1% error looks sad.

### Phase 2 — Bun Server (`server.ts`)

- Setup Bun HTTP server.
- Implement PromQL execution logic (using `fetch` to upstream).
- Add robust error handling for upstream failures.

### Phase 3 — Dashboard App (`app.js`)

- Fetch data.
- Apply normalization logic.
- Render.

### Phase 4 — Polish

- CSS Glassmorphism.
- Animations (face transitions).

---

## Future (Post-MVP)

- Deep linking (click face -> go to Grafana).
- Historical playback.
- Auth (Basic Auth).
