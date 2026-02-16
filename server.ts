import { serve } from "bun";

console.log("Starting server...");

// Configuration from Env
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "15");
const LABEL_SERVICE = process.env.LABEL_SERVICE || "service_name";
const METRIC_DURATION = process.env.METRIC_DURATION || "http_server_request_duration_seconds";
const LABEL_STATUS = process.env.LABEL_STATUS || "http_response_status_code";

// Helper: Query Prometheus
async function queryPrometheus(query: string) {
  const u = new URL("/api/v1/query", PROMETHEUS_URL);
  u.searchParams.set("query", query);
  
  try {
    const res = await fetch(u.toString());
    if (!res.ok) {
        console.error(`Prometheus Error ${res.status}: ${res.statusText}`);
        return null;
    }
    const json = await res.json();
    return json.data?.result || [];
  } catch (err) {
    console.error(`Query failed: ${query}`, err);
    return null;
  }
}

// Bun Server
const server = serve({
  port: process.env.PORT || 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // --- API Endpoints (Phase 2) ---

    // 1. Config
    if (url.pathname === "/api/config") {
      return Response.json({ refreshInterval: REFRESH_INTERVAL });
    }

    // 2. Services (Discovery)
    if (url.pathname === "/api/services") {
       const u = new URL(`/api/v1/label/${LABEL_SERVICE}/values`, PROMETHEUS_URL);
       try {
         const res = await fetch(u.toString());
         const json = await res.json();
         // Handle standard Prometheus response or Thanos/Mimir variants
         return Response.json(json.data || []);
       } catch (e) {
         console.error("Service discovery failed", e);
         return Response.json([], { status: 500 });
       }
    }

    // 3. Metrics (Aggregated)
    if (url.pathname === "/api/metrics") {
        // Query A: Error Rate (5xx / Total)
        // Note: Using 'sum by' to aggregate across instances/pods
        const qErrors = `sum by (${LABEL_SERVICE}) (rate(${METRIC_DURATION}_count{${LABEL_STATUS}=~"5.."}[5m])) / sum by (${LABEL_SERVICE}) (rate(${METRIC_DURATION}_count[5m]))`;
        
        // Query B: Latency P95
        const qLatency = `histogram_quantile(0.95, sum by (le, ${LABEL_SERVICE}) (rate(${METRIC_DURATION}_bucket[5m])))`;
        
        // Query C: Request Rate (RPS)
        const qRPS = `sum by (${LABEL_SERVICE}) (rate(${METRIC_DURATION}_count[5m]))`;

        const [errors, latency, rps] = await Promise.all([
            queryPrometheus(qErrors),
            queryPrometheus(qLatency),
            queryPrometheus(qRPS)
        ]);

        return Response.json({
            errors: errors || [],
            latency: latency || [],
            rps: rps || []
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
    let filePath = url.pathname.replace(/^\//, ""); // strip leading slash
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

console.log(`Listening on http://localhost:${server.port}`);
console.log(`Connected to Prometheus at ${PROMETHEUS_URL}`);
