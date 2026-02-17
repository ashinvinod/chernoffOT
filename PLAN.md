# Chernoff Monitor — Outage Metrics Plan

Detailed plan to evolve the current dashboard into a type-aware outage visualization system that outputs four cross-cutting metrics per running service:

1. Error rate
2. Latency p95
3. Traffic anomaly
4. Saturation

---

## Goal

Provide a single, near-real-time view where operators can immediately spot which service is "off" during an incident, even across mixed workloads (HTTP services, databases, caches, queues, and workers).

---

## Operating Assumptions

- Data source is Prometheus-compatible (`/api/v1/query` and label APIs).
- Services expose heterogeneous metrics depending on service type.
- Service type classification must be inferred and cached, with manual overrides available.
- UI should receive both raw and normalized values.

---

## Target Architecture

```
Browser (public/app.js)
   |
   | GET /api/dashboard/state
   v
Bun Server (server.ts)
   |- Service Discovery Engine
   |- Heuristic Type Classifier
   |- Type-Aware Metric Adapters
   |- Normalization + Data Quality Layer
   v
Prometheus-compatible backend
```

Backend remains non-generic: it executes fixed query templates, not arbitrary user-supplied PromQL.

---

## Phase 1 — Service Identity and Discovery

### 1.1 Identity contract

Define stable service identity:

- Preferred key: `service_key = service_name|namespace|cluster`
- Label aliases to support heterogeneous telemetry:
  - service: `service_name`, `service`
  - status: `http_response_status_code`, `status_code`, `code`

### 1.2 All-service discovery with activity state

Discover all known services, then compute live activity state:

- Primary source:
  - label values API for service label aliases (global known service set)
- Activity overlay:
  - recency query (for example `up` and key service metrics) to compute service liveness windows

Store `ServiceCatalog` entries:

- `serviceKey`
- `serviceName`
- `namespace`
- `cluster`
- `firstSeenAt`
- `active`
- `lastSeenAt`
- `state`
- `missingSince`

State model:

- `active`: seen in recent window
- `missing_recently`: seen before but absent now
- `stale`: absent beyond retention window

Refresh cadence: every 60 seconds for state recompute.
Catalog entries persist across refreshes (TTL-based pruning only).

---

## Phase 2 — Heuristic Service Type Classification

### 2.1 Type set

- `application`
- `db`
- `cache`
- `queue`
- `worker`
- `unknown`

### 2.2 Scoring model

Compute weighted scores per service from metric-family and metadata evidence:

- Strong evidence: `+5`
- Medium evidence: `+2`
- Metadata hint: `+1`
- Contradictory evidence: `-2`

Decision rule:

- Choose top type only if:
  - `topScore >= 5`
  - `topScore - secondScore >= 3`
- Else classify as `unknown`.

Confidence:

- `confidence = clamp((topScore - secondScore) / max(topScore, 1), 0, 1)`

Evidence is retained for explainability in API response.

### 2.3 Signal families

- `application` signals:
  - `http_server_*`, `http_requests_*`, `grpc_server_*`
- `db` signals:
  - `postgres_*`, `mysql_*`, `mongodb_*`, lock/connection metrics
- `cache` signals:
  - `redis_*`, `memcached_*`, hit/miss, evictions, keyspace/connection metrics
- `queue` signals:
  - `kafka_*`, `rabbitmq_*`, `nats_*`, lag/depth metrics
- `worker` signals:
  - `job_*`, `task_*`, queue consume/process metrics with weak/absent inbound server metrics

Metadata hints:

- `job`, `pod`, `container`, component/app label naming patterns

### 2.4 Overrides

Support explicit overrides for critical services:

- map `serviceKey -> serviceType`
- override wins over heuristic score

Classification cadence: every 10 minutes and on newly discovered services.

---

## Phase 3 — Type-Aware Metric Adapter Layer

For each type, define prioritized query templates for four required metrics with fallbacks.

### 3.1 Application

- Error rate:
  - `5xx + non-OK gRPC / total requests`
- Latency p95:
  - histogram p95 over request duration
- Traffic anomaly:
  - `(currentRPS - baselineRPS) / clamp_min(baselineRPS, epsilon)`
- Saturation:
  - max of CPU pressure, memory pressure, pool/thread pressure

### 3.2 Database

- Error rate:
  - failed/timeout/deadlock operations / total operations
- Latency p95:
  - query latency p95
- Traffic anomaly:
  - current QPS vs baseline QPS
- Saturation:
  - max of connection usage, lock wait pressure, CPU/IO pressure

### 3.3 Cache

- Error rate:
  - failed cache operations / total cache operations (or backend unavailability signal)
- Latency p95:
  - command/get-set latency p95
- Traffic anomaly:
  - ops/sec anomaly vs baseline
- Saturation:
  - max of memory pressure, eviction pressure, connection pressure

### 3.4 Queue/Broker

- Error rate:
  - publish/consume failures and DLQ activity / total ops
- Latency p95:
  - processing latency or message age p95
- Traffic anomaly:
  - consumer throughput anomaly vs baseline
- Saturation:
  - max of lag ratio, depth growth pressure, broker resource pressure

### 3.5 Worker

- Error rate:
  - failed jobs / total jobs
- Latency p95:
  - job runtime p95
- Traffic anomaly:
  - processed jobs anomaly vs baseline
- Saturation:
  - max of concurrency utilization, backlog age, compute pressure

### 3.6 Query execution strategy

- Batch by type and label to minimize query volume.
- Use `Promise.all` per metric family where possible.
- Timebox queries and return partial data on failures.

---

## Phase 4 — Normalization and Data Quality

For each service metric:

- Provide raw fields:
  - `errorRateRaw`
  - `latencyP95MsRaw`
  - `trafficAnomalyRaw`
  - `saturationRaw`
- Provide normalized fields in `[0,1]` for visualization:
  - `errorRateNorm`
  - `latencyNorm`
  - `trafficNorm`
  - `saturationNorm`

Missing data behavior:

- Keep missing raw values as `null`
- Use neutral normalized values for rendering fallback
- Emit per-service data quality:
  - `missingMetrics[]`
  - `dataQualityScore`

---

## Phase 5 — API Contract for UI

### 5.1 `GET /api/services/catalog`

Returns all known services and type/state metadata:

- `serviceKey`
- `serviceName`
- `serviceType`
- `active`
- `state`
- `lastSeenAt`
- `missingSince`
- `confidence`
- `evidence[]`
- `overrideApplied`

### 5.2 `GET /api/services/metrics?window=5m`

Returns four required metrics per service:

- raw values
- normalized values
- `capturedAt`
- missing flags/data quality

### 5.3 `GET /api/dashboard/state`

Convenience endpoint that combines catalog and metrics for one UI fetch cycle.

---

## Phase 6 — Caching and Refresh Cadence

- Discovery cache: 60s
- Type classification cache: 10m
- Metrics cache: 15s
- Serve stale-last-good response with `stale=true` flag on upstream failure

---

## Phase 7 — Validation and Rollout

### 7.1 Quality gates

- Active service discovery coverage >= 95%
- Non-unknown classification rate >= 85% (before overrides)
- Four-metric availability >= 80% across active services

### 7.2 Rollout steps

1. Ship service catalog + classifier metadata only
2. Add type-aware metric adapters with fallback chains
3. Switch UI to unified `/api/dashboard/state`
4. Tune heuristics and overrides using production feedback

---

## Observability of the Observability Layer

Instrument backend self-metrics:

- query latency
- query failure count
- classifier unknown count
- per-metric missingness rate
- cache hit ratio

These metrics are required to trust outage visuals during real incidents.
