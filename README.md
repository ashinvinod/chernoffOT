# ChernoffOT

**Real-time service monitoring with Chernoff faces.**
Spot outages at a glance — happy faces mean healthy services, angry faces mean something's wrong.

ChernoffOT queries any **Prometheus-compatible** endpoint and turns your services into expressive cartoon faces. Point it at your existing Prometheus, Amazon Managed Prometheus, Google Managed Prometheus, Grafana Cloud, or any other PromQL-compatible backend.

## Quick Start

### Docker

```bash
docker build -t chernoffot .
docker run \
  -e PROMETHEUS_URL=https://your-prometheus-endpoint \
  -p 3000:3000 \
  chernoffot
```

Open [http://localhost:3000](http://localhost:3000) — you'll see faces for every discovered service.

### Docker Compose

Copy the provided `docker-compose.yml`, set `PROMETHEUS_URL` in a `.env` file, then:

```bash
echo 'PROMETHEUS_URL=https://your-prometheus-endpoint' > .env
docker compose up
```

### From Source

```bash
bun install
PROMETHEUS_URL=https://your-prometheus-endpoint bun run dev
```

> **Prerequisite:** [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)

---

## How It Works

Each service in your infrastructure becomes a **face**. By default, facial features encode these four outage signals:

| Feature        | Default Metric  | Good → Bad               |
| -------------- | --------------- | ------------------------ |
| **Mouth**      | Error rate      | 😊 Smiling → 😟 Frowning |
| **Eye Size**   | Latency (p95)   | 😑 Calm → 😳 Wide open   |
| **Brow Angle** | Traffic anomaly | 😌 Relaxed → 😠 Angry    |
| **Head Color** | Health score    | 🟢 Green → 🔴 Red        |

Sweat drops appear when a service is critically unhealthy (< 30% health).
You can remap which normalized metric drives each facial feature from the in-app mapping modal (`?` button in the header).

### Architecture

```
Your Services → Prometheus-compatible backend → ChernoffOT → 🎭 Faces
```

ChernoffOT auto-discovers your services, classifies them by type (app, database, cache, queue, worker), and fetches type-appropriate metrics via PromQL. No manual service registration required.

ChernoffOT works with any PromQL-compatible backend. Just point `PROMETHEUS_URL` at it:

| Provider                  | `PROMETHEUS_URL`                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Amazon Managed Prometheus | `https://aps-workspaces.<region>.amazonaws.com/workspaces/<id>`                      |
| Google Managed Prometheus | `https://monitoring.googleapis.com/v1/projects/<project>/location/global/prometheus` |
| Azure Monitor Prometheus  | `https://<workspace>.prometheus.monitor.azure.com`                                   |
| Grafana Cloud             | `https://prometheus-prod-XX.grafana.net/api/prom`                                    |

> 🚧 **Coming soon: zero-config bundled Prometheus.**
> [**Join waitlist to get notified→**](https://tally.so/r/442kko)

ChernoffOT currently issues direct requests to `PROMETHEUS_URL` and does not add auth headers or cloud request signing. For secured endpoints, route through an authenticated proxy/gateway and point `PROMETHEUS_URL` to that proxy.

## Configuration

All configuration is via environment variables with sensible defaults:

### Core

| Variable           | Default                 | Description                           |
| ------------------ | ----------------------- | ------------------------------------- |
| `PROMETHEUS_URL`   | `http://localhost:9090` | PromQL-compatible endpoint            |
| `PORT`             | `3000`                  | Port the ChernoffOT server listens on |
| `REFRESH_INTERVAL` | `15`                    | Dashboard refresh interval in seconds |

### Service Discovery & Labels

| Variable                 | Default                                | Description                               |
| ------------------------ | -------------------------------------- | ----------------------------------------- |
| `LABEL_SERVICE`          | `service_name`                         | Primary label identifying services        |
| `SERVICE_LABEL_ALIASES`  | `service_name,service`                 | Comma-separated fallback label names      |
| `LABEL_STATUS`           | `http_response_status_code`            | Label used for HTTP status codes          |
| `METRIC_DURATION`        | `http_server_request_duration_seconds` | Primary request duration metric name      |
| `SERVICE_TYPE_OVERRIDES` | —                                      | Force service types: `svc1=db,svc2=cache` |

### Tuning

| Variable               | Default  | Description                                          |
| ---------------------- | -------- | ---------------------------------------------------- |
| `DISCOVERY_CACHE_MS`   | `60000`  | How often to re-discover services (ms)               |
| `CLASSIFIER_CACHE_MS`  | `600000` | How often to re-classify service types (ms)          |
| `METRICS_CACHE_MS`     | `15000`  | How often to re-fetch metrics (ms)                   |
| `ACTIVE_WINDOW_SEC`    | `300`    | Seconds before a service is considered missing       |
| `MISSING_RECENTLY_SEC` | `3600`   | Seconds before a missing service is considered stale |
| `CATALOG_TTL_SEC`      | `604800` | Seconds before a stale service is pruned (7 days)    |

---

## Service Classification

ChernoffOT automatically classifies services by inspecting which metrics they expose:

| Type            | Detection Signals                                             |
| --------------- | ------------------------------------------------------------- |
| **Application** | `http_server_*`, `http_requests_*`, `grpc_server_*`           |
| **Database**    | `postgres_*`, `mysql_*`, `mongodb_*`, lock/connection metrics |
| **Cache**       | `redis_*`, `memcached_*`, hit/miss, eviction metrics          |
| **Queue**       | `kafka_*`, `rabbitmq_*`, `nats_*`, lag/depth metrics          |
| **Worker**      | `job_*`, `task_*`, queue consumer metrics                     |

Each type uses **different PromQL queries** optimized for that workload. Override with `SERVICE_TYPE_OVERRIDES=my-redis=cache,my-pg=db`.

---

## Compatible Backends

Any backend that speaks PromQL:

- ✅ Prometheus / VictoriaMetrics / Thanos / Cortex / Grafana Mimir
- ✅ Amazon Managed Prometheus / Google Managed Prometheus / Azure Monitor
- ✅ Grafana Cloud / Coralogix / New Relic (Prometheus endpoint)
- ❌ Datadog (no PromQL support)

---

## Tech Stack

- **Runtime:** [Bun](https://bun.sh) — fast JavaScript/TypeScript runtime
- **Frontend:** Vanilla JS + SVG (no framework, no build step)
- **Backend:** Single TypeScript file, ~2200 lines
- **Dependencies:** Zero runtime dependencies
- **Container:** Alpine-based, < 100MB image

---

## Development

```bash
bun install
PROMETHEUS_URL=http://localhost:9090 bun run dev
```

---

## License

MIT
