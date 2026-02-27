# 🎭 ChernoffOT

**Real-time service monitoring with Chernoff faces.**
Spot outages at a glance — happy faces mean healthy services, angry faces mean something's wrong.

ChernoffOT queries any **Prometheus-compatible** endpoint and turns your services into expressive cartoon faces. Point it at your existing Prometheus, Amazon Managed Prometheus, Google Managed Prometheus, Grafana Cloud, or any other PromQL-compatible backend.

> 🚧 **Coming soon: zero-config bundled Prometheus.**
> [**Join waitlist to get notified→**](https://tally.so/r/442kko)

---

## Quick Start

### Docker

```bash
docker run \
  -e PROMETHEUS_URL=https://your-prometheus-endpoint \
  -p 3000:3000 \
  ghcr.io/your-org/chernoff
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
git clone https://github.com/your-org/chernoff.git && cd chernoff
bun install
PROMETHEUS_URL=https://your-prometheus-endpoint bun run dev
```

> **Prerequisite:** [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)

---

## How It Works

Each service in your infrastructure becomes a **face**. Facial features encode the four key outage signals:

| Feature        | Metric          | Good → Bad               |
| -------------- | --------------- | ------------------------ |
| **Mouth**      | Error rate      | 😊 Smiling → 😟 Frowning |
| **Eye Size**   | Latency (p95)   | 😑 Calm → 😳 Wide open   |
| **Brow Angle** | Traffic anomaly | 😌 Relaxed → 😠 Angry    |
| **Head Color** | Saturation      | 🟢 Green → 🔴 Red        |

Sweat drops appear when a service is critically unhealthy (< 30% health).

### Architecture

```
Your Services → Prometheus-compatible backend → ChernoffOT → 🎭 Faces
```

ChernoffOT auto-discovers your services, classifies them by type (app, database, cache, queue, worker), and fetches type-appropriate metrics via PromQL. No manual service registration required.

### How metrics get into your backend

ChernoffOT works with any PromQL-compatible endpoint — self-hosted Prometheus, Amazon Managed Prometheus, Google Managed Prometheus, Grafana Cloud, VictoriaMetrics, Thanos, and more. If you use **OpenTelemetry**, the OTel Collector can export metrics in Prometheus format for scraping.

```
Your App → OTel Collector → /metrics endpoint → Prometheus-compatible backend → ChernoffOT
```

---

## Deployment

### Kubernetes

```bash
helm install chernoff oci://ghcr.io/your-org/chernoff-chart
```

When `prometheus.url` is not set, ChernoffOT auto-discovers common in-cluster endpoints (kube-prometheus-stack, Prometheus Operator, VictoriaMetrics, Thanos, Mimir).

To specify manually:

```bash
helm install chernoff oci://ghcr.io/your-org/chernoff-chart \
  --set prometheus.url=http://prometheus-server.monitoring.svc:80
```

### Already using a managed Prometheus?

ChernoffOT works with any PromQL-compatible backend. Just point `PROMETHEUS_URL` at it:

| Provider                  | `PROMETHEUS_URL`                                                                     | `PROMETHEUS_AUTH` |
| ------------------------- | ------------------------------------------------------------------------------------ | ----------------- |
| Amazon Managed Prometheus | `https://aps-workspaces.<region>.amazonaws.com/workspaces/<id>`                      | `sigv4`           |
| Google Managed Prometheus | `https://monitoring.googleapis.com/v1/projects/<project>/location/global/prometheus` | `gcp`             |
| Azure Monitor Prometheus  | `https://<workspace>.prometheus.monitor.azure.com`                                   | `azure`           |
| Grafana Cloud             | `https://prometheus-prod-XX.grafana.net/api/prom`                                    | `bearer`          |

Set `PROMETHEUS_URL` to any of these endpoints and ChernoffOT will connect automatically. Bearer token and basic auth are also supported via `PROMETHEUS_AUTH`.

---

## Configuration

All configuration is via environment variables with sensible defaults:

### Core

| Variable           | Default                 | Description                           |
| ------------------ | ----------------------- | ------------------------------------- |
| `PROMETHEUS_URL`   | `http://localhost:9090` | PromQL-compatible endpoint            |
| `PORT`             | `3000`                  | Port the ChernoffOT server listens on |
| `REFRESH_INTERVAL` | `15`                    | Dashboard refresh interval in seconds |

### Authentication

| Variable              | Default | Description                                                     |
| --------------------- | ------- | --------------------------------------------------------------- |
| `PROMETHEUS_AUTH`     | `none`  | Auth method: `none`, `bearer`, `basic`, `sigv4`, `gcp`, `azure` |
| `PROMETHEUS_TOKEN`    | —       | Bearer token (when `PROMETHEUS_AUTH=bearer`)                    |
| `PROMETHEUS_USER`     | —       | Username (when `PROMETHEUS_AUTH=basic`)                         |
| `PROMETHEUS_PASSWORD` | —       | Password (when `PROMETHEUS_AUTH=basic`)                         |

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

## API Endpoints

| Endpoint                              | Description                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/healthz`                    | Health check — returns `200` if the metrics backend is reachable, `503` if not |
| `GET /api/config`                     | Current refresh interval                                                       |
| `GET /api/services/catalog`           | All discovered services with type classification                               |
| `GET /api/services/metrics?window=5m` | Metrics for all services (raw + normalized)                                    |
| `GET /api/dashboard/state?window=5m`  | Combined catalog + metrics (used by the UI)                                    |

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
- **Backend:** Single TypeScript file, ~1700 lines
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
