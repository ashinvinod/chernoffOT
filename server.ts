import { serve } from "bun";

const APP_VERSION = "0.1.0";
const serverStartTime = Date.now();

console.log("Starting server...");

// Configuration from Env
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "15", 10);
const LABEL_SERVICE = sanitizeLabelName(process.env.LABEL_SERVICE || "service_name") || "service_name";
const METRIC_DURATION =
  sanitizeMetricName(process.env.METRIC_DURATION || "http_server_request_duration_seconds") ||
  "http_server_request_duration_seconds";
const LABEL_STATUS =
  sanitizeLabelName(process.env.LABEL_STATUS || "http_response_status_code") ||
  "http_response_status_code";

const DISCOVERY_CACHE_MS = parseInt(process.env.DISCOVERY_CACHE_MS || "60000", 10);
const CLASSIFIER_CACHE_MS = parseInt(process.env.CLASSIFIER_CACHE_MS || "600000", 10);
const METRICS_CACHE_MS = parseInt(process.env.METRICS_CACHE_MS || "15000", 10);

const DISCOVERY_LOOKBACK = process.env.DISCOVERY_LOOKBACK || "1h";
const CLASSIFIER_LOOKBACK = process.env.CLASSIFIER_LOOKBACK || "6h";
const BASELINE_WINDOW = process.env.BASELINE_WINDOW || "1h";
const BASELINE_STEP = process.env.BASELINE_STEP || "5m";

const ACTIVE_WINDOW_SEC = parseInt(process.env.ACTIVE_WINDOW_SEC || "300", 10);
const MISSING_RECENTLY_SEC = parseInt(process.env.MISSING_RECENTLY_SEC || "3600", 10);
const CATALOG_TTL_SEC = parseInt(process.env.CATALOG_TTL_SEC || "604800", 10);

const SERVICE_LABEL_ALIASES = buildLabelAliases(
  process.env.SERVICE_LABEL_ALIASES || `${LABEL_SERVICE},service`
);
const STATUS_LABEL_ALIASES = buildLabelAliases(
  process.env.STATUS_LABEL_ALIASES || `${LABEL_STATUS},status,status_code,code`
);

const SERVICE_TYPE_OVERRIDES = parseServiceTypeOverrides(
  process.env.SERVICE_TYPE_OVERRIDES || ""
);
const SERVER_PORT = Number.parseInt(process.env.PORT || "3000", 10) || 3000;

type ServiceType = "application" | "db" | "cache" | "queue" | "worker" | "unknown";
type ServiceState = "active" | "missing_recently" | "stale";

type PromVectorItem = {
  metric: Record<string, string>;
  value: [number | string, string];
};

type PromQueryContext = {
  serviceType: ServiceType | "catalog" | "classification";
  metricType: string;
  queryName: string;
  serviceLabel?: string;
};

type QueryDefinition = {
  name: string;
  query: (serviceLabel: string) => string;
  transform?: (value: number) => number;
};

type ServiceCatalogInternal = {
  serviceName: string;
  namespace: string;
  cluster: string;
  firstSeenEpoch: number;
  lastSeenEpoch: number | null;
  missingSinceEpoch: number | null;
};

type ServiceCatalogRecord = {
  serviceKey: string;
  serviceName: string;
  namespace: string;
  cluster: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  active: boolean;
  state: ServiceState;
  missingSince: string | null;
};

type ClassificationRecord = {
  serviceType: ServiceType;
  confidence: number;
  evidence: string[];
  overrideApplied: boolean;
};

type ServiceMetricsRecord = {
  serviceKey: string;
  serviceName: string;
  serviceType: ServiceType;
  state: ServiceState;
  capturedAt: string;
  raw: {
    errorRateRaw: number | null;
    latencyP95MsRaw: number | null;
    trafficAnomalyRaw: number | null;
    saturationRaw: number | null;
  };
  normalized: {
    errorRateNorm: number | null;
    latencyNorm: number | null;
    trafficNorm: number | null;
    saturationNorm: number | null;
  };
  dataQuality: {
    missingMetrics: string[];
    dataQualityScore: number;
  };
};

type ServiceCatalogSnapshot = {
  capturedAt: string;
  stale: boolean;
  services: ServiceCatalogRecord[];
};

type ClassificationSnapshot = {
  capturedAt: string;
  stale: boolean;
  byService: Map<string, ClassificationRecord>;
};

type ServiceMetricsSnapshot = {
  capturedAt: string;
  stale: boolean;
  window: string;
  services: ServiceMetricsRecord[];
};

const serviceCatalogStore = new Map<string, ServiceCatalogInternal>();
let serviceCatalogCache: ServiceCatalogSnapshot | null = null;
let serviceCatalogCacheAt = 0;

let classificationCache: ClassificationSnapshot | null = null;
let classificationCacheAt = 0;

const metricsCache = new Map<string, { at: number; snapshot: ServiceMetricsSnapshot }>();

// Parse comma-separated label aliases, sanitize them, and deduplicate.
function buildLabelAliases(input: string): string[] {
  const out = new Set<string>();
  input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((label) => {
      const valid = sanitizeLabelName(label);
      if (valid) out.add(valid);
    });
  return Array.from(out);
}

// Validate a Prometheus label identifier.
function sanitizeLabelName(label: string): string | null {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label) ? label : null;
}

// Validate a Prometheus metric identifier.
function sanitizeMetricName(metric: string): string | null {
  return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric) ? metric : null;
}

// Parse service-type overrides from JSON or comma-separated key=value pairs.
function parseServiceTypeOverrides(input: string): Record<string, ServiceType> {
  if (!input.trim()) return {};

  try {
    const parsed = JSON.parse(input) as Record<string, string>;
    const out: Record<string, ServiceType> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isServiceType(value)) out[key] = value;
    }
    return out;
  } catch {
    const out: Record<string, ServiceType> = {};
    input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const [svc, type] = pair.split("=").map((s) => s.trim());
        if (svc && type && isServiceType(type)) out[svc] = type;
      });
    return out;
  }
}

// Type guard for supported service categories.
function isServiceType(v: string): v is ServiceType {
  return v === "application" || v === "db" || v === "cache" || v === "queue" || v === "worker" || v === "unknown";
}

// Current epoch time in seconds.
function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Convert epoch seconds to ISO-8601 timestamp.
function toIso(epochSec: number | null): string | null {
  return epochSec == null ? null : new Date(epochSec * 1000).toISOString();
}

// Clamp numeric values into [0, 1].
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

// Build a stable service identity key.
function buildServiceKey(serviceName: string, namespace = "unknown", cluster = "unknown"): string {
  return `${serviceName}|${namespace}|${cluster}`;
}

// Parse a numeric value out of a Prometheus instant-vector sample.
function parseVectorValue(item: PromVectorItem): number | null {
  const raw = item?.value?.[1];
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// Extract service name from metric labels using preferred and fallback labels.
function parseServiceFromMetric(metric: Record<string, string>, serviceLabel: string): string | null {
  const value = metric[serviceLabel] || metric.service_name || metric.service;
  if (!value || !value.trim()) return null;
  return value.trim();
}

// Merge maps while preserving the value with the largest absolute magnitude per service.
function mergeByAbsMax(target: Map<string, number>, source: Map<string, number>) {
  for (const [svc, val] of source) {
    if (!Number.isFinite(val)) continue;
    const existing = target.get(svc);
    if (existing == null || Math.abs(val) > Math.abs(existing)) {
      target.set(svc, val);
    }
  }
}

// Sort catalog by lifecycle state first, then alphabetically by service name.
function sortCatalog(records: ServiceCatalogRecord[]): ServiceCatalogRecord[] {
  const rank: Record<ServiceState, number> = {
    active: 0,
    missing_recently: 1,
    stale: 2,
  };
  return records.sort((a, b) => {
    const stateDiff = rank[a.state] - rank[b.state];
    if (stateDiff !== 0) return stateDiff;
    return a.serviceName.localeCompare(b.serviceName);
  });
}

// Validate simple Prometheus range-window tokens (e.g. 5m, 1h).
function isWindowValid(window: string): boolean {
  return /^\d+[smhdw]$/.test(window);
}

// Normalize user-supplied window and fall back to default when invalid.
function withDefaultWindow(input: string | null): string {
  if (!input) return "5m";
  return isWindowValid(input) ? input : "5m";
}

// Compact and truncate PromQL for readable logs.
function compactPromql(query: string, maxLen = 280): string {
  const compact = query.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

// Render a short service:value sample preview for query logs.
function formatPromSample(results: PromVectorItem[], serviceLabel?: string): string {
  if (results.length === 0) return "(none)";

  return results
    .slice(0, 3)
    .map((item) => {
      const svc =
        parseServiceFromMetric(item.metric || {}, serviceLabel || LABEL_SERVICE) ||
        item.metric?.service_name ||
        item.metric?.service ||
        "n/a";
      const value = parseVectorValue(item);
      const rendered = value == null ? "n/a" : Number.isInteger(value) ? `${value}` : value.toFixed(4);
      return `${svc}:${rendered}`;
    })
    .join(" | ");
}

// Collect a small unique list of service names from query results.
function extractServiceNames(results: PromVectorItem[], serviceLabel?: string, max = 8): string[] {
  const names = new Set<string>();
  for (const item of results) {
    const serviceName =
      parseServiceFromMetric(item.metric || {}, serviceLabel || LABEL_SERVICE) ||
      item.metric?.service_name ||
      item.metric?.service;
    if (serviceName) names.add(serviceName);
    if (names.size >= max) break;
  }
  return Array.from(names);
}

// Format service name lists with truncation for log readability.
function formatServiceList(services?: string[]): string {
  if (!services || services.length === 0) return "(none)";
  if (services.length <= 6) return services.join(", ");
  return `${services.slice(0, 6).join(", ")} (+${services.length - 6} more)`;
}

// Emit consistently formatted logs for all Prometheus responses.
function logPrometheusResponse(
  context: PromQueryContext,
  details: {
    ok: boolean;
    httpStatus: number | string;
    statusText?: string;
    promStatus?: string;
    resultsCount?: number;
    query: string;
    sample?: string;
    services?: string[];
    error?: unknown;
  }
) {
  const timestamp = new Date().toISOString();
  const header = `[PROMETHEUS ${details.ok ? "SUCCESS" : "ERROR"}] ${timestamp}`;
  const serviceList = formatServiceList(details.services);

  const lines = [
    header,
    `  Context  : serviceType=${context.serviceType} metricType=${context.metricType} queryName=${context.queryName}`,
    `  Label    : ${context.serviceLabel || "-"}`,
    `  HTTP     : ${details.httpStatus}${details.statusText ? ` ${details.statusText}` : ""}`,
    `  Prom     : ${details.promStatus || "-"}`,
    `  Results  : ${details.resultsCount ?? "-"}`,
    `  Services : ${serviceList}`,
    `  Query    : ${compactPromql(details.query, 220)}`,
  ];

  if (details.sample) lines.push(`  Sample   : ${details.sample}`);
  if (details.error) lines.push(`  Error    : ${String(details.error)}`);
  lines.push("  ----");

  const formatted = lines.join("\n");
  // Per-query logging disabled — summary logged per-service after metrics computation.
}

// Helper: Query Prometheus
// Execute an instant PromQL query and log full response context.
async function queryPrometheus(query: string, context: PromQueryContext): Promise<PromVectorItem[] | null> {
  const u = new URL("/api/v1/query", PROMETHEUS_URL);
  u.searchParams.set("query", query);

  try {
    const res = await fetch(u.toString());
    if (!res.ok) {
      logPrometheusResponse(context, {
        ok: false,
        httpStatus: res.status,
        statusText: res.statusText,
        query,
      });
      return null;
    }

    const json = await res.json();
    const results = (json.data?.result || []) as PromVectorItem[];
    logPrometheusResponse(context, {
      ok: true,
      httpStatus: res.status,
      statusText: res.statusText,
      promStatus: json.status,
      resultsCount: results.length,
      query,
      services: extractServiceNames(results, context.serviceLabel),
      sample: formatPromSample(results, context.serviceLabel),
    });
    return results;
  } catch (err) {
    logPrometheusResponse(context, {
      ok: false,
      httpStatus: "network_error",
      query,
      error: err,
    });
    return null;
  }
}

// Fetch raw label values from Prometheus for service discovery.
async function fetchLabelValues(label: string): Promise<string[]> {
  const u = new URL(`/api/v1/label/${label}/values`, PROMETHEUS_URL);
  const query = `label_values(${label})`;
  const context: PromQueryContext = {
    serviceType: "catalog",
    metricType: "label_values",
    queryName: "catalog_label_values",
    serviceLabel: label,
  };

  try {
    const res = await fetch(u.toString());
    if (!res.ok) {
      logPrometheusResponse(context, {
        ok: false,
        httpStatus: res.status,
        statusText: res.statusText,
        query,
      });
      return [];
    }
    const json = await res.json();
    const values = Array.isArray(json.data) ? json.data : [];
    const filtered = values.filter((v: unknown) => typeof v === "string" && v.trim().length > 0);
    logPrometheusResponse(context, {
      ok: true,
      httpStatus: res.status,
      statusText: res.statusText,
      promStatus: json.status,
      resultsCount: filtered.length,
      query,
      services: filtered.slice(0, 8),
      sample: filtered.slice(0, 3).join(" | ") || "(none)",
    });
    return filtered;
  } catch (err) {
    logPrometheusResponse(context, {
      ok: false,
      httpStatus: "network_error",
      query,
      error: err,
    });
    return [];
  }
}

// Run the same logical query across service-label aliases and merge by service name.
async function queryAcrossAliases(
  queryFactory: (serviceLabel: string) => string,
  transform: ((value: number) => number) | undefined,
  context: Omit<PromQueryContext, "serviceLabel">
): Promise<Map<string, number>> {
  const out = new Map<string, number>();

  const results = await Promise.all(
    SERVICE_LABEL_ALIASES.map(async (serviceLabel) => {
      const data = await queryPrometheus(queryFactory(serviceLabel), {
        ...context,
        serviceLabel,
      });
      return { serviceLabel, data };
    })
  );

  for (const result of results) {
    const { serviceLabel, data } = result;
    if (!data) continue;

    for (const item of data) {
      const serviceName = parseServiceFromMetric(item.metric || {}, serviceLabel);
      if (!serviceName) continue;

      const rawValue = parseVectorValue(item);
      if (rawValue == null) continue;

      const value = transform ? transform(rawValue) : rawValue;
      if (!Number.isFinite(value)) continue;

      const existing = out.get(serviceName);
      if (existing == null || Math.abs(value) > Math.abs(existing)) {
        out.set(serviceName, value);
      }
    }
  }

  return out;
}

// Discover all known services from configured service-label aliases.
async function discoverAllServices(): Promise<Set<string>> {
  const all = new Set<string>();

  const valueSets = await Promise.all(SERVICE_LABEL_ALIASES.map((label) => fetchLabelValues(label)));
  for (const values of valueSets) {
    values.forEach((v) => all.add(v));
  }

  return all;
}

// Estimate per-service last-seen timestamps using prioritized activity signals.
async function queryLastSeenByService(discoveredCount: number): Promise<Map<string, number>> {
  const merged = new Map<string, number>();

  const upMap = await queryAcrossAliases(
    (serviceLabel) =>
      `max by (${serviceLabel}) (timestamp(max_over_time(up{${serviceLabel}!=""}[${DISCOVERY_LOOKBACK}])))`,
    undefined,
    {
      serviceType: "catalog",
      metricType: "activity_last_seen",
      queryName: "catalog_last_seen_up",
    }
  );
  mergeByAbsMax(merged, upMap);

  const durationMap = await queryAcrossAliases(
    (serviceLabel) =>
      `max by (${serviceLabel}) (timestamp(max_over_time(${METRIC_DURATION}_count{${serviceLabel}!=""}[${DISCOVERY_LOOKBACK}])))`,
    undefined,
    {
      serviceType: "catalog",
      metricType: "activity_last_seen",
      queryName: "catalog_last_seen_duration",
    }
  );
  mergeByAbsMax(merged, durationMap);

  if (merged.size === 0 || (discoveredCount > 0 && merged.size < Math.max(1, Math.floor(discoveredCount * 0.4)))) {
    const broadMap = await queryAcrossAliases(
      (serviceLabel) =>
        `max by (${serviceLabel}) (timestamp(max_over_time({${serviceLabel}!=""}[${DISCOVERY_LOOKBACK}])))`,
      undefined,
      {
        serviceType: "catalog",
        metricType: "activity_last_seen",
        queryName: "catalog_last_seen_broad_fallback",
      }
    );
    mergeByAbsMax(merged, broadMap);
  }

  return merged;
}

// Build and cache the full service catalog with lifecycle state transitions.
async function getServiceCatalogSnapshot(force = false): Promise<ServiceCatalogSnapshot> {
  const nowMs = Date.now();
  if (!force && serviceCatalogCache && nowMs - serviceCatalogCacheAt < DISCOVERY_CACHE_MS) {
    return serviceCatalogCache;
  }

  try {
    const discovered = await discoverAllServices();
    const lastSeenMap = await queryLastSeenByService(discovered.size);
    const now = nowEpochSec();

    const union = new Set<string>([
      ...discovered,
      ...Array.from(lastSeenMap.keys()),
      ...Array.from(serviceCatalogStore.keys()),
    ]);

    for (const serviceName of union) {
      let entry = serviceCatalogStore.get(serviceName);
      if (!entry) {
        entry = {
          serviceName,
          namespace: "unknown",
          cluster: "unknown",
          firstSeenEpoch: now,
          lastSeenEpoch: null,
          missingSinceEpoch: null,
        };
      }

      const lastSeen = lastSeenMap.get(serviceName);
      if (lastSeen != null && (entry.lastSeenEpoch == null || lastSeen > entry.lastSeenEpoch)) {
        entry.lastSeenEpoch = lastSeen;
      }

      const ageSec = entry.lastSeenEpoch == null ? Number.POSITIVE_INFINITY : now - entry.lastSeenEpoch;
      const isActive = ageSec <= ACTIVE_WINDOW_SEC;

      if (isActive) {
        entry.missingSinceEpoch = null;
      } else if (entry.lastSeenEpoch != null && entry.missingSinceEpoch == null) {
        entry.missingSinceEpoch = entry.lastSeenEpoch;
      }

      serviceCatalogStore.set(serviceName, entry);
    }

    for (const [serviceName, entry] of serviceCatalogStore) {
      const reference = entry.lastSeenEpoch ?? entry.firstSeenEpoch;
      if (now - reference > CATALOG_TTL_SEC) {
        serviceCatalogStore.delete(serviceName);
      }
    }

    const records: ServiceCatalogRecord[] = [];

    for (const entry of serviceCatalogStore.values()) {
      const ageSec = entry.lastSeenEpoch == null ? Number.POSITIVE_INFINITY : now - entry.lastSeenEpoch;
      const active = ageSec <= ACTIVE_WINDOW_SEC;
      const state: ServiceState = active
        ? "active"
        : ageSec <= MISSING_RECENTLY_SEC
          ? "missing_recently"
          : "stale";

      records.push({
        serviceKey: buildServiceKey(entry.serviceName, entry.namespace, entry.cluster),
        serviceName: entry.serviceName,
        namespace: entry.namespace,
        cluster: entry.cluster,
        firstSeenAt: toIso(entry.firstSeenEpoch)!,
        lastSeenAt: toIso(entry.lastSeenEpoch),
        active,
        state,
        missingSince: toIso(entry.missingSinceEpoch),
      });
    }

    const snapshot: ServiceCatalogSnapshot = {
      capturedAt: new Date().toISOString(),
      stale: false,
      services: sortCatalog(records),
    };

    serviceCatalogCache = snapshot;
    serviceCatalogCacheAt = nowMs;
    return snapshot;
  } catch (err) {
    console.error("Service catalog refresh failed", err);
    if (serviceCatalogCache) {
      return {
        ...serviceCatalogCache,
        stale: true,
      };
    }

    return {
      capturedAt: new Date().toISOString(),
      stale: true,
      services: [],
    };
  }
}

// Derive weak type hints from service-name tokens.
function serviceNameHintScore(serviceName: string, type: Exclude<ServiceType, "unknown">): number {
  const lower = serviceName.toLowerCase();
  const hints: Record<Exclude<ServiceType, "unknown">, string[]> = {
    application: ["api", "app", "svc", "frontend", "backend"],
    db: ["db", "postgres", "mysql", "mongo", "sql", "database"],
    cache: ["cache", "redis", "memcached"],
    queue: ["queue", "kafka", "rabbit", "nats", "broker"],
    worker: ["worker", "job", "consumer", "processor", "cron", "scheduler"],
  };

  return hints[type].some((token) => lower.includes(token)) ? 1 : 0;
}

// Find services that expose metric families matching a classifier regex.
async function queryPresenceSet(metricRegex: string, signalType: Exclude<ServiceType, "unknown">): Promise<Set<string>> {
  const presenceMap = await queryAcrossAliases(
    (serviceLabel) =>
      `sum by (${serviceLabel}) (count_over_time({${serviceLabel}!="",__name__=~"${metricRegex}"}[${CLASSIFIER_LOOKBACK}]))`,
    undefined,
    {
      serviceType: "classification",
      metricType: `signal_${signalType}`,
      queryName: `classification_presence_${signalType}`,
    }
  );

  const out = new Set<string>();
  for (const [serviceName, count] of presenceMap) {
    if (count > 0) out.add(serviceName);
  }
  return out;
}

// Classify services by type using metric-family evidence, hints, and overrides.
async function getClassificationSnapshot(
  catalogSnapshot: ServiceCatalogSnapshot,
  force = false
): Promise<ClassificationSnapshot> {
  const nowMs = Date.now();
  const serviceNames = catalogSnapshot.services.map((s) => s.serviceName);

  if (
    !force &&
    classificationCache &&
    nowMs - classificationCacheAt < CLASSIFIER_CACHE_MS &&
    serviceNames.every((name) => classificationCache.byService.has(name))
  ) {
    return classificationCache;
  }

  try {
    const [applicationSignals, dbSignals, cacheSignals, queueSignals, workerSignals] = await Promise.all([
      queryPresenceSet("http_server_.*|http_requests_.*|grpc_server_.*", "application"),
      queryPresenceSet("postgres_.*|mysql_.*|mongodb_.*|cassandra_.*|db_client_.*", "db"),
      queryPresenceSet("redis_.*|memcached_.*|cache_.*", "cache"),
      queryPresenceSet("kafka_.*|rabbitmq_.*|nats_.*|pulsar_.*|queue_.*", "queue"),
      queryPresenceSet("job_.*|task_.*|celery_.*|sidekiq_.*|worker_.*", "worker"),
    ]);

    const byService = new Map<string, ClassificationRecord>();

    for (const serviceName of serviceNames) {
      const override = SERVICE_TYPE_OVERRIDES[serviceName];
      if (override) {
        byService.set(serviceName, {
          serviceType: override,
          confidence: 1,
          evidence: [`override:${override}`],
          overrideApplied: true,
        });
        continue;
      }

      const scores: Record<Exclude<ServiceType, "unknown">, number> = {
        application: 0,
        db: 0,
        cache: 0,
        queue: 0,
        worker: 0,
      };

      const evidence: string[] = [];

      if (applicationSignals.has(serviceName)) {
        scores.application += 5;
        evidence.push("application signal: http/grpc metrics");
      }
      if (dbSignals.has(serviceName)) {
        scores.db += 5;
        evidence.push("db signal: database metric families");
      }
      if (cacheSignals.has(serviceName)) {
        scores.cache += 5;
        evidence.push("cache signal: redis/memcached/cache metrics");
      }
      if (queueSignals.has(serviceName)) {
        scores.queue += 5;
        evidence.push("queue signal: kafka/rabbitmq/queue metrics");
      }
      if (workerSignals.has(serviceName)) {
        scores.worker += 5;
        evidence.push("worker signal: job/task/worker metrics");
      }

      (Object.keys(scores) as Array<keyof typeof scores>).forEach((type) => {
        const hint = serviceNameHintScore(serviceName, type);
        if (hint > 0) {
          scores[type] += hint;
          evidence.push(`${type} hint: service name token`);
        }
      });

      if (applicationSignals.has(serviceName) && workerSignals.has(serviceName)) {
        scores.worker -= 2;
        evidence.push("contradiction: inbound traffic present lowers worker confidence");
      }
      if (cacheSignals.has(serviceName) && dbSignals.has(serviceName)) {
        scores.db -= 2;
        evidence.push("contradiction: cache signals lower db confidence");
      }

      const ranked = (Object.entries(scores) as Array<[Exclude<ServiceType, "unknown">, number]>).sort(
        (a, b) => b[1] - a[1]
      );

      const [topType, topScore] = ranked[0];
      const secondScore = ranked[1]?.[1] ?? 0;
      const margin = topScore - secondScore;
      const meetsThreshold = topScore >= 5 && margin >= 3;

      const serviceType: ServiceType = meetsThreshold ? topType : "unknown";
      const confidence = serviceType === "unknown" ? 0 : clamp01(margin / Math.max(topScore, 1));

      byService.set(serviceName, {
        serviceType,
        confidence,
        evidence,
        overrideApplied: false,
      });
    }

    const snapshot: ClassificationSnapshot = {
      capturedAt: new Date().toISOString(),
      stale: false,
      byService,
    };

    classificationCache = snapshot;
    classificationCacheAt = nowMs;
    return snapshot;
  } catch (err) {
    console.error("Classification refresh failed", err);

    if (classificationCache) {
      return {
        ...classificationCache,
        stale: true,
      };
    }

    const fallbackMap = new Map<string, ClassificationRecord>();
    for (const serviceName of serviceNames) {
      fallbackMap.set(serviceName, {
        serviceType: "unknown",
        confidence: 0,
        evidence: ["classification unavailable"],
        overrideApplied: false,
      });
    }

    return {
      capturedAt: new Date().toISOString(),
      stale: true,
      byService: fallbackMap,
    };
  }
}

// Resolve metric fallbacks in order and keep first available value per service.
async function resolveFallbackMetric(
  definitions: QueryDefinition[],
  serviceType: ServiceType,
  metricType: "error_rate" | "latency_p95" | "traffic_current" | "traffic_baseline" | "saturation"
): Promise<Map<string, number>> {
  const maps = await Promise.all(
    definitions.map((definition) =>
      queryAcrossAliases(definition.query, definition.transform, {
        serviceType,
        metricType,
        queryName: definition.name,
      })
    )
  );

  const merged = new Map<string, number>();
  for (const map of maps) {
    for (const [serviceName, value] of map) {
      if (!merged.has(serviceName)) merged.set(serviceName, value);
    }
  }

  return merged;
}

// Wrap a current-value query into a baseline avg_over_time query.
function wrapBaseline(definition: QueryDefinition): QueryDefinition {
  return {
    ...definition,
    name: `${definition.name}:baseline`,
    query: (serviceLabel) =>
      `avg_over_time((${definition.query(serviceLabel)})[${BASELINE_WINDOW}:${BASELINE_STEP}])`,
  };
}

// Clamp all values in a metric map to provided bounds.
function clampMetricMap(map: Map<string, number>, min = 0, max = Number.POSITIVE_INFINITY): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of map) {
    if (!Number.isFinite(v)) continue;
    if (v < min) {
      out.set(k, min);
    } else if (v > max) {
      out.set(k, max);
    } else {
      out.set(k, v);
    }
  }
  return out;
}

// Compute relative traffic deviation from baseline per service.
function computeTrafficAnomaly(
  currentMap: Map<string, number>,
  baselineMap: Map<string, number>
): Map<string, number> {
  const out = new Map<string, number>();
  const keys = new Set<string>([...currentMap.keys(), ...baselineMap.keys()]);

  for (const serviceName of keys) {
    const current = currentMap.get(serviceName);
    const baseline = baselineMap.get(serviceName);
    if (current == null || baseline == null) continue;
    const denominator = Math.max(Math.abs(baseline), 0.001);
    out.set(serviceName, (current - baseline) / denominator);
  }

  return out;
}

// PromQL templates for application services across required outage metrics.
function getApplicationDefinitions(window: string): {
  error: QueryDefinition[];
  latencyMs: QueryDefinition[];
  trafficCurrent: QueryDefinition[];
  saturation: QueryDefinition[];
} {
  const safeStatusLabels = STATUS_LABEL_ALIASES;

  const errorDefs: QueryDefinition[] = safeStatusLabels.map((statusLabel) => ({
    name: `app_error_${statusLabel}`,
    query: (serviceLabel) =>
      `sum by (${serviceLabel}) (rate(${METRIC_DURATION}_count{${serviceLabel}!="",${statusLabel}=~"5..|ERROR|error"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(${METRIC_DURATION}_count{${serviceLabel}!=""}[${window}])), 0.000001)`,
  }));

  // OTel stable (v1.20): http_server_duration_seconds
  safeStatusLabels.forEach((statusLabel) => {
    errorDefs.push({
      name: `app_error_http_server_duration_s_${statusLabel}`,
      query: (serviceLabel) =>
        `sum by (${serviceLabel}) (rate(http_server_duration_seconds_count{${serviceLabel}!="",${statusLabel}=~"5..|ERROR|error"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(http_server_duration_seconds_count{${serviceLabel}!=""}[${window}])), 0.000001)`,
    });
  });

  // OTel older SDKs: http_server_duration_milliseconds
  safeStatusLabels.forEach((statusLabel) => {
    errorDefs.push({
      name: `app_error_http_server_duration_ms_${statusLabel}`,
      query: (serviceLabel) =>
        `sum by (${serviceLabel}) (rate(http_server_duration_milliseconds_count{${serviceLabel}!="",${statusLabel}=~"5..|ERROR|error"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(http_server_duration_milliseconds_count{${serviceLabel}!=""}[${window}])), 0.000001)`,
    });
  });

  errorDefs.push(
    // Classic Prometheus: http_requests_total
    {
      name: "app_error_http_requests_total",
      query: (serviceLabel) =>
        `sum by (${serviceLabel}) (rate(http_requests_total{${serviceLabel}!="",status=~"5.."}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(http_requests_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
    },
    // Classic Prometheus: http_server_requests_total
    {
      name: "app_error_http_server_requests_total",
      query: (serviceLabel) =>
        `sum by (${serviceLabel}) (rate(http_server_requests_total{${serviceLabel}!="",status=~"5.."}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(http_server_requests_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
    },
    // Classic gRPC: grpc_server_handled_total
    {
      name: "app_error_grpc",
      query: (serviceLabel) =>
        `sum by (${serviceLabel}) (rate(grpc_server_handled_total{${serviceLabel}!="",grpc_code!="OK"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(grpc_server_handled_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
    },
    // OTel RPC current: rpc_server_call_duration_seconds (uses rpc_response_status_code)
    {
      name: "app_error_rpc_server_call_duration",
      query: (serviceLabel) =>
        `sum by (${serviceLabel}) (rate(rpc_server_call_duration_seconds_count{${serviceLabel}!="",rpc_response_status_code!~"0|OK|ok"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(rpc_server_call_duration_seconds_count{${serviceLabel}!=""}[${window}])), 0.000001)`,
    },
    // OTel RPC older: rpc_server_duration_milliseconds (uses rpc_grpc_status_code)
    {
      name: "app_error_rpc_server_duration_ms",
      query: (serviceLabel) =>
        `sum by (${serviceLabel}) (rate(rpc_server_duration_milliseconds_count{${serviceLabel}!="",rpc_grpc_status_code!~"0|OK|ok"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(rpc_server_duration_milliseconds_count{${serviceLabel}!=""}[${window}])), 0.000001)`,
    }
  );

  return {
    error: errorDefs,
    latencyMs: [
      // OTel v1.24+ (current): http_server_request_duration_seconds (= METRIC_DURATION)
      {
        name: "app_latency_primary",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(${METRIC_DURATION}_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      // Explicit fallback for http_server_request_duration_seconds if METRIC_DURATION is overridden
      {
        name: "app_latency_http_server_request_duration",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(http_server_request_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      // OTel stable (v1.20): http_server_duration_seconds
      {
        name: "app_latency_http_server_duration_s",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(http_server_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      // OTel older SDKs: http_server_duration_milliseconds (already in ms)
      {
        name: "app_latency_http_server_duration_ms",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(http_server_duration_milliseconds_bucket{${serviceLabel}!=""}[${window}])))`,
        // No * 1000 — values already in milliseconds
      },
      // OTel RPC current: rpc_server_call_duration_seconds
      {
        name: "app_latency_rpc_server_call_duration",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(rpc_server_call_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      // OTel RPC older: rpc_server_duration_milliseconds (already in ms)
      {
        name: "app_latency_rpc_server_duration_ms",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(rpc_server_duration_milliseconds_bucket{${serviceLabel}!=""}[${window}])))`,
        // No * 1000 — values already in milliseconds
      },
      // Classic Prometheus: http_request_duration_seconds
      {
        name: "app_latency_http_request_duration",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(http_request_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      // Classic Prometheus summary
      {
        name: "app_latency_summary",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (http_request_duration_seconds{${serviceLabel}!="",quantile="0.95"})`,
        transform: (v) => v * 1000,
      },
    ],
    trafficCurrent: [
      // OTel v1.24+ (current): METRIC_DURATION _count
      {
        name: "app_rps_primary",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(${METRIC_DURATION}_count{${serviceLabel}!=""}[${window}]))`,
      },
      // OTel stable (v1.20): http_server_duration_seconds _count
      {
        name: "app_rps_http_server_duration_s",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(http_server_duration_seconds_count{${serviceLabel}!=""}[${window}]))`,
      },
      // OTel older SDKs: http_server_duration_milliseconds _count
      {
        name: "app_rps_http_server_duration_ms",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(http_server_duration_milliseconds_count{${serviceLabel}!=""}[${window}]))`,
      },
      // OTel RPC current: rpc_server_call_duration_seconds _count
      {
        name: "app_rps_rpc_server_call_duration",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(rpc_server_call_duration_seconds_count{${serviceLabel}!=""}[${window}]))`,
      },
      // OTel RPC older: rpc_server_duration_milliseconds _count
      {
        name: "app_rps_rpc_server_duration_ms",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(rpc_server_duration_milliseconds_count{${serviceLabel}!=""}[${window}]))`,
      },
      // Classic Prometheus: http_requests_total
      {
        name: "app_rps_http_requests_total",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(http_requests_total{${serviceLabel}!=""}[${window}]))`,
      },
      // Classic Prometheus: http_server_requests_total
      {
        name: "app_rps_http_server_requests_total",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(http_server_requests_total{${serviceLabel}!=""}[${window}]))`,
      },
      // Classic gRPC: grpc_server_handled_total
      {
        name: "app_rps_grpc",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(grpc_server_handled_total{${serviceLabel}!=""}[${window}]))`,
      },
    ],
    saturation: [
      {
        name: "app_saturation_process_cpu",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (rate(process_cpu_seconds_total{${serviceLabel}!=""}[${window}]))`,
      },
      // OTel .NET: dotnet_process_cpu_time_seconds_total
      {
        name: "app_saturation_dotnet_cpu",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (rate(dotnet_process_cpu_time_seconds_total{${serviceLabel}!=""}[${window}]))`,
      },
      {
        name: "app_saturation_container_cpu",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (rate(container_cpu_usage_seconds_total{${serviceLabel}!="",container!=""}[${window}]))`,
      },
      {
        name: "app_saturation_goroutines",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (go_goroutines{${serviceLabel}!=""} / 1000)`,
      },
      // JVM thread count as saturation signal
      {
        name: "app_saturation_jvm_threads",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (jvm_thread_count{${serviceLabel}!=""} / 1000)`,
      },
    ],
  };
}

// PromQL templates for database services across required outage metrics.
function getDbDefinitions(window: string): {
  error: QueryDefinition[];
  latencyMs: QueryDefinition[];
  trafficCurrent: QueryDefinition[];
  saturation: QueryDefinition[];
} {
  return {
    error: [
      {
        name: "db_error_otel",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(db_client_operation_duration_seconds_count{${serviceLabel}!="",status_code=~"ERROR|error"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(db_client_operation_duration_seconds_count{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
      {
        name: "db_error_postgres_rollback",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(pg_stat_database_xact_rollback{${serviceLabel}!=""}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(pg_stat_database_xact_commit{${serviceLabel}!=""}[${window}]) + rate(pg_stat_database_xact_rollback{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
    ],
    latencyMs: [
      {
        name: "db_latency_otel_hist",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(db_client_operation_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      {
        name: "db_latency_otel_summary",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (db_client_operation_duration_seconds{${serviceLabel}!="",quantile="0.95"})`,
        transform: (v) => v * 1000,
      },
      {
        name: "db_latency_ms_hist",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(db_client_operation_duration_milliseconds_bucket{${serviceLabel}!=""}[${window}])))`,
      },
    ],
    trafficCurrent: [
      {
        name: "db_traffic_otel",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(db_client_operation_duration_seconds_count{${serviceLabel}!=""}[${window}]))`,
      },
      {
        name: "db_traffic_postgres",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(pg_stat_database_xact_commit{${serviceLabel}!=""}[${window}])) + sum by (${serviceLabel}) (rate(pg_stat_database_xact_rollback{${serviceLabel}!=""}[${window}]))`,
      },
    ],
    saturation: [
      {
        name: "db_saturation_postgres_conn",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (postgresql_connections{${serviceLabel}!=""} / clamp_min(postgresql_max_connections{${serviceLabel}!=""}, 1))`,
      },
      {
        name: "db_saturation_mysql_conn",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (mysql_global_status_threads_connected{${serviceLabel}!=""} / clamp_min(mysql_global_variables_max_connections{${serviceLabel}!=""}, 1))`,
      },
      {
        name: "db_saturation_cpu_fallback",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (rate(process_cpu_seconds_total{${serviceLabel}!=""}[${window}]))`,
      },
    ],
  };
}

// PromQL templates for cache services across required outage metrics.
function getCacheDefinitions(window: string): {
  error: QueryDefinition[];
  latencyMs: QueryDefinition[];
  trafficCurrent: QueryDefinition[];
  saturation: QueryDefinition[];
} {
  return {
    error: [
      {
        name: "cache_error_redis_rejected",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(redis_rejected_connections_total{${serviceLabel}!=""}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(redis_connections_received_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
      {
        name: "cache_error_otel",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(cache_operation_total{${serviceLabel}!="",status=~"error|failed"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(cache_operation_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
    ],
    latencyMs: [
      {
        name: "cache_latency_redis",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(redis_commands_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      {
        name: "cache_latency_otel",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(cache_operation_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
    ],
    trafficCurrent: [
      {
        name: "cache_traffic_redis",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(redis_commands_processed_total{${serviceLabel}!=""}[${window}]))`,
      },
      {
        name: "cache_traffic_otel",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(cache_requests_total{${serviceLabel}!=""}[${window}]))`,
      },
    ],
    saturation: [
      {
        name: "cache_saturation_memory",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (redis_memory_used_bytes{${serviceLabel}!=""} / clamp_min(redis_memory_max_bytes{${serviceLabel}!=""}, 1))`,
      },
      {
        name: "cache_saturation_memcached",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (memcached_current_bytes{${serviceLabel}!=""} / clamp_min(memcached_limit_maxbytes{${serviceLabel}!=""}, 1))`,
      },
      {
        name: "cache_saturation_evictions",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (rate(redis_evicted_keys_total{${serviceLabel}!=""}[${window}]))`,
      },
    ],
  };
}

// PromQL templates for queue/broker services across required outage metrics.
function getQueueDefinitions(window: string): {
  error: QueryDefinition[];
  latencyMs: QueryDefinition[];
  trafficCurrent: QueryDefinition[];
  saturation: QueryDefinition[];
} {
  return {
    error: [
      {
        name: "queue_error_generic",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(queue_messages_failed_total{${serviceLabel}!=""}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(queue_messages_processed_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
      {
        name: "queue_error_rabbitmq",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(rabbitmq_channel_messages_unroutable_returned_total{${serviceLabel}!=""}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(rabbitmq_channel_messages_published_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
    ],
    latencyMs: [
      {
        name: "queue_latency_generic",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(queue_message_processing_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      {
        name: "queue_latency_kafka",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (kafka_consumer_fetch_manager_fetch_latency_avg{${serviceLabel}!=""})`,
      },
    ],
    trafficCurrent: [
      {
        name: "queue_traffic_generic",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(queue_messages_processed_total{${serviceLabel}!=""}[${window}]))`,
      },
      {
        name: "queue_traffic_rabbitmq",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(rabbitmq_queue_messages_published_total{${serviceLabel}!=""}[${window}]))`,
      },
      {
        name: "queue_traffic_kafka",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(kafka_server_brokertopicmetrics_messagesin_total{${serviceLabel}!=""}[${window}]))`,
      },
    ],
    saturation: [
      {
        name: "queue_saturation_kafka_lag",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (kafka_consumer_lag{${serviceLabel}!=""} / 10000)`,
      },
      {
        name: "queue_saturation_rabbitmq_depth",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (rabbitmq_queue_messages_ready{${serviceLabel}!=""} / 10000)`,
      },
      {
        name: "queue_saturation_generic_depth",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (queue_depth{${serviceLabel}!=""} / 10000)`,
      },
    ],
  };
}

// PromQL templates for worker services across required outage metrics.
function getWorkerDefinitions(window: string): {
  error: QueryDefinition[];
  latencyMs: QueryDefinition[];
  trafficCurrent: QueryDefinition[];
  saturation: QueryDefinition[];
} {
  return {
    error: [
      {
        name: "worker_error_jobs",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(job_executions_total{${serviceLabel}!="",status=~"failed|error"}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(job_executions_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
      {
        name: "worker_error_tasks",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(task_failures_total{${serviceLabel}!=""}[${window}])) / clamp_min(sum by (${serviceLabel}) (rate(task_processed_total{${serviceLabel}!=""}[${window}])), 0.000001)`,
      },
    ],
    latencyMs: [
      {
        name: "worker_latency_job",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(job_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
      {
        name: "worker_latency_task",
        query: (serviceLabel) =>
          `histogram_quantile(0.95, sum by (le, ${serviceLabel}) (rate(task_duration_seconds_bucket{${serviceLabel}!=""}[${window}])))`,
        transform: (v) => v * 1000,
      },
    ],
    trafficCurrent: [
      {
        name: "worker_traffic_jobs",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(job_executions_total{${serviceLabel}!=""}[${window}]))`,
      },
      {
        name: "worker_traffic_tasks",
        query: (serviceLabel) =>
          `sum by (${serviceLabel}) (rate(task_processed_total{${serviceLabel}!=""}[${window}]))`,
      },
    ],
    saturation: [
      {
        name: "worker_saturation_concurrency",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (worker_active_jobs{${serviceLabel}!=""} / clamp_min(worker_concurrency_limit{${serviceLabel}!=""}, 1))`,
      },
      {
        name: "worker_saturation_backlog_age",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (job_queue_oldest_age_seconds{${serviceLabel}!=""} / 300)`,
      },
      {
        name: "worker_saturation_cpu",
        query: (serviceLabel) =>
          `max by (${serviceLabel}) (rate(process_cpu_seconds_total{${serviceLabel}!=""}[${window}]))`,
      },
    ],
  };
}

// Dispatch to type-specific query templates.
function getTypeDefinitions(type: ServiceType, window: string) {
  if (type === "application" || type === "unknown") return getApplicationDefinitions(window);
  if (type === "db") return getDbDefinitions(window);
  if (type === "cache") return getCacheDefinitions(window);
  if (type === "queue") return getQueueDefinitions(window);
  return getWorkerDefinitions(window);
}

// Fetch raw error/latency/traffic/saturation maps for a given service type.
async function fetchTypeMetricMaps(type: ServiceType, window: string): Promise<{
  errorRateRaw: Map<string, number>;
  latencyP95MsRaw: Map<string, number>;
  trafficAnomalyRaw: Map<string, number>;
  saturationRaw: Map<string, number>;
}> {
  const defs = getTypeDefinitions(type, window);

  const [errorRateRaw, latencyP95MsRaw, trafficCurrent, trafficBaseline, saturationRaw] = await Promise.all([
    resolveFallbackMetric(defs.error, type, "error_rate"),
    resolveFallbackMetric(defs.latencyMs, type, "latency_p95"),
    resolveFallbackMetric(defs.trafficCurrent, type, "traffic_current"),
    resolveFallbackMetric(defs.trafficCurrent.map((d) => wrapBaseline(d)), type, "traffic_baseline"),
    resolveFallbackMetric(defs.saturation, type, "saturation"),
  ]);

  const trafficAnomalyRaw = computeTrafficAnomaly(trafficCurrent, trafficBaseline);

  return {
    errorRateRaw: clampMetricMap(errorRateRaw, 0),
    latencyP95MsRaw: clampMetricMap(latencyP95MsRaw, 0),
    trafficAnomalyRaw,
    saturationRaw: clampMetricMap(saturationRaw, 0),
  };
}

// Convert raw metrics into normalized visualization-friendly scores.
function normalizeMetrics(raw: {
  errorRateRaw: number | null;
  latencyP95MsRaw: number | null;
  trafficAnomalyRaw: number | null;
  saturationRaw: number | null;
}): {
  errorRateNorm: number | null;
  latencyNorm: number | null;
  trafficNorm: number | null;
  saturationNorm: number | null;
} {
  const errorRateNorm = raw.errorRateRaw == null ? null : clamp01(Math.log10(raw.errorRateRaw * 1000 + 1) / 2);

  // 100ms ~ 0.4, 1000ms ~ 1.0 on this curve
  const latencyNorm =
    raw.latencyP95MsRaw == null ? null : clamp01(Math.log10(raw.latencyP95MsRaw + 1) / 3);

  // Absolute anomaly: 0 = baseline, 1 = +/-200% change
  const trafficNorm =
    raw.trafficAnomalyRaw == null ? null : clamp01(Math.abs(raw.trafficAnomalyRaw) / 2);

  // Saturation should already be mostly ratio-like; clamp to [0,1]
  const saturationNorm = raw.saturationRaw == null ? null : clamp01(raw.saturationRaw);

  return {
    errorRateNorm,
    latencyNorm,
    trafficNorm,
    saturationNorm,
  };
}

// Compute missing-metric list and completeness score for a service.
function mapDataQuality(raw: {
  errorRateRaw: number | null;
  latencyP95MsRaw: number | null;
  trafficAnomalyRaw: number | null;
  saturationRaw: number | null;
}) {
  const missingMetrics: string[] = [];

  if (raw.errorRateRaw == null) missingMetrics.push("error_rate");
  if (raw.latencyP95MsRaw == null) missingMetrics.push("latency_p95");
  if (raw.trafficAnomalyRaw == null) missingMetrics.push("traffic_anomaly");
  if (raw.saturationRaw == null) missingMetrics.push("saturation");

  const present = 4 - missingMetrics.length;

  return {
    missingMetrics,
    dataQualityScore: present / 4,
  };
}

// Build and cache the per-service metrics snapshot for dashboard consumption.
async function getServiceMetricsSnapshot(
  window: string,
  catalogSnapshot?: ServiceCatalogSnapshot,
  classSnapshot?: ClassificationSnapshot,
  force = false
): Promise<ServiceMetricsSnapshot> {
  const nowMs = Date.now();
  const cacheKey = window;
  const cached = metricsCache.get(cacheKey);

  if (!force && cached && nowMs - cached.at < METRICS_CACHE_MS) {
    return cached.snapshot;
  }

  const catalog = catalogSnapshot || (await getServiceCatalogSnapshot());
  const classifications = classSnapshot || (await getClassificationSnapshot(catalog));

  try {
    const typesNeeded = new Set<ServiceType>();
    for (const service of catalog.services) {
      const classified = classifications.byService.get(service.serviceName)?.serviceType || "unknown";
      typesNeeded.add(classified);
    }

    const typeMaps = new Map<
      ServiceType,
      {
        errorRateRaw: Map<string, number>;
        latencyP95MsRaw: Map<string, number>;
        trafficAnomalyRaw: Map<string, number>;
        saturationRaw: Map<string, number>;
      }
    >();

    const fetchResults = await Promise.all(
      Array.from(typesNeeded).map(async (type) => {
        const maps = await fetchTypeMetricMaps(type, window);
        return { type, maps };
      })
    );

    for (const result of fetchResults) {
      typeMaps.set(result.type, result.maps);
    }

    const capturedAt = new Date().toISOString();
    const services: ServiceMetricsRecord[] = catalog.services.map((service) => {
      const classification = classifications.byService.get(service.serviceName) || {
        serviceType: "unknown" as ServiceType,
      };

      const maps = typeMaps.get(classification.serviceType) || {
        errorRateRaw: new Map<string, number>(),
        latencyP95MsRaw: new Map<string, number>(),
        trafficAnomalyRaw: new Map<string, number>(),
        saturationRaw: new Map<string, number>(),
      };

      const raw = {
        errorRateRaw: maps.errorRateRaw.get(service.serviceName) ?? null,
        latencyP95MsRaw: maps.latencyP95MsRaw.get(service.serviceName) ?? null,
        trafficAnomalyRaw: maps.trafficAnomalyRaw.get(service.serviceName) ?? null,
        saturationRaw: maps.saturationRaw.get(service.serviceName) ?? null,
      };

      const normalized = normalizeMetrics(raw);
      const dataQuality = mapDataQuality(raw);

      return {
        serviceKey: service.serviceKey,
        serviceName: service.serviceName,
        serviceType: classification.serviceType,
        state: service.state,
        capturedAt,
        raw,
        normalized,
        dataQuality,
      };
    });

    // Log per-service metrics summary
    for (const s of services) {
      const n = s.normalized;
      const fmt = (v: number | null) => v == null ? "n/a" : v.toFixed(2);
      console.log(
        `[METRICS] ${s.serviceName} | ${s.serviceType} | err=${fmt(n.errorRateNorm)} lat=${fmt(n.latencyNorm)} trf=${fmt(n.trafficNorm)} sat=${fmt(n.saturationNorm)} qual=${s.dataQuality.dataQualityScore.toFixed(2)}`
      );
    }

    const snapshot: ServiceMetricsSnapshot = {
      capturedAt,
      stale: false,
      window,
      services,
    };

    metricsCache.set(cacheKey, {
      at: nowMs,
      snapshot,
    });

    return snapshot;
  } catch (err) {
    console.error("Service metrics refresh failed", err);

    if (cached) {
      return {
        ...cached.snapshot,
        stale: true,
      };
    }

    return {
      capturedAt: new Date().toISOString(),
      stale: true,
      window,
      services: [],
    };
  }
}

// Health check: probe Prometheus connectivity.
async function checkHealth(): Promise<{
  status: "ok" | "degraded";
  prometheus: boolean;
  prometheusUrl: string;
  version: string;
  uptime: number;
}> {
  let prometheusOk = false;

  try {
    const res = await fetch(
      new URL("/api/v1/status/buildinfo", PROMETHEUS_URL).toString(),
      { signal: AbortSignal.timeout(3000) }
    );
    prometheusOk = res.ok;
  } catch {
    // Also try a basic query — some backends don't expose /buildinfo
    try {
      const u = new URL("/api/v1/query", PROMETHEUS_URL);
      u.searchParams.set("query", "up");
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(3000) });
      prometheusOk = res.ok;
    } catch {
      prometheusOk = false;
    }
  }

  return {
    status: prometheusOk ? "ok" : "degraded",
    prometheus: prometheusOk,
    prometheusUrl: PROMETHEUS_URL,
    version: APP_VERSION,
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
  };
}

// Bun Server
const server = serve({
  port: SERVER_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 0. Health check
    if (url.pathname === "/api/healthz") {
      const health = await checkHealth();
      const status = health.prometheus ? 200 : 503;
      return Response.json(health, { status });
    }

    // 1. Config
    if (url.pathname === "/api/config") {
      return Response.json({ refreshInterval: REFRESH_INTERVAL });
    }

    // 2. Service Catalog endpoint
    if (url.pathname === "/api/services/catalog") {
      const catalog = await getServiceCatalogSnapshot();
      const classifications = await getClassificationSnapshot(catalog);

      const byService = classifications.byService;
      const services = catalog.services.map((s) => {
        const c = byService.get(s.serviceName) || {
          serviceType: "unknown" as ServiceType,
          confidence: 0,
          evidence: ["classification unavailable"],
          overrideApplied: false,
        };

        return {
          ...s,
          serviceType: c.serviceType,
          confidence: c.confidence,
          evidence: c.evidence,
          overrideApplied: c.overrideApplied,
        };
      });

      return Response.json({
        capturedAt: catalog.capturedAt,
        stale: catalog.stale || classifications.stale,
        services,
      });
    }

    // 3. Service Metrics endpoint
    if (url.pathname === "/api/services/metrics") {
      const window = withDefaultWindow(url.searchParams.get("window"));
      const catalog = await getServiceCatalogSnapshot();
      const classifications = await getClassificationSnapshot(catalog);
      const metrics = await getServiceMetricsSnapshot(window, catalog, classifications);

      return Response.json({
        capturedAt: metrics.capturedAt,
        window: metrics.window,
        stale: catalog.stale || classifications.stale || metrics.stale,
        services: metrics.services,
      });
    }

    // 4. Combined endpoint
    if (url.pathname === "/api/dashboard/state") {
      const window = withDefaultWindow(url.searchParams.get("window"));
      const catalog = await getServiceCatalogSnapshot();
      const classifications = await getClassificationSnapshot(catalog);
      const metrics = await getServiceMetricsSnapshot(window, catalog, classifications);

      const classByService = classifications.byService;

      const catalogWithType = catalog.services.map((s) => {
        const c = classByService.get(s.serviceName) || {
          serviceType: "unknown" as ServiceType,
          confidence: 0,
          evidence: ["classification unavailable"],
          overrideApplied: false,
        };

        return {
          ...s,
          serviceType: c.serviceType,
          confidence: c.confidence,
          evidence: c.evidence,
          overrideApplied: c.overrideApplied,
        };
      });

      return Response.json({
        capturedAt: new Date().toISOString(),
        window,
        stale: catalog.stale || classifications.stale || metrics.stale,
        catalog: {
          capturedAt: catalog.capturedAt,
          services: catalogWithType,
        },
        metrics,
      });
    }

    // --- Static Files & SPA Routing ---

    // Root -> Index
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const main = Bun.file("public/index.html");
      if (await main.exists()) return new Response(main);
      return new Response(Bun.file("public/test_face.html"));
    }

    // Generic Static File Server for public/
    // Maps /foo.js -> public/foo.js
    // Maps /public/foo.js -> public/foo.js
    let filePath = url.pathname.replace(/^\//, "");
    if (filePath.startsWith("public/")) {
      filePath = filePath.replace(/^public\//, "");
    }

    // Security: No directory traversal
    if (filePath.includes("..")) return new Response("Forbidden", { status: 403 });

    const file = Bun.file(`public/${filePath}`);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
});

const labelPreview = SERVICE_LABEL_ALIASES.slice(0, 3).join(", ");
console.log(`
┌─────────────────────────────────────────────┐
│          chernoffOT v${APP_VERSION}                    │
├─────────────────────────────────────────────┤
│  Dashboard  : http://localhost:${String(server.port).padEnd(13)}│
│  Prometheus : ${PROMETHEUS_URL.slice(0, 29).padEnd(29)}│
│  Refresh    : ${String(REFRESH_INTERVAL).padEnd(1)}s                            │
│  Labels     : ${labelPreview.slice(0, 29).padEnd(29)}│
│  Health     : /api/healthz                  │
└─────────────────────────────────────────────┘
`);

// Probe Prometheus on startup
checkHealth().then((h) => {
  if (h.prometheus) {
    console.log("✅ Prometheus connection verified");
  } else {
    console.warn("⚠️  Cannot reach Prometheus at " + PROMETHEUS_URL);
    console.warn("   Set PROMETHEUS_URL env var to your Prometheus-compatible endpoint.");
    console.warn("   Docs: https://github.com/your-org/chernoff#configuration");
  }
});
