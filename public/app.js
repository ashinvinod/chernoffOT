import { renderFace } from "./face.js";

// --- State ---
let config = { refreshInterval: 15 };
let services = [];

// --- Config ---
const MAX_LATENCY_MS = 2000; // 2s = 100% eyes
const MAX_RPS = 100;         // 100rps = 100% stressed brows (adjust dynamically?)
// Dynamic maxes are better, but let's start with static or cohort-based.
// Plan says: "Logarithmic relative to max" (cohort max).

async function init() {
    try {
        const cfgRes = await fetch("/api/config");
        config = await cfgRes.json();
    } catch (e) { console.error("Config fetch failed", e); }

    // Initial fetch
    await update();

    // Poll
    setInterval(update, config.refreshInterval * 1000);
}

async function update() {
    const grid = document.getElementById("grid");
    const lastUpdated = document.getElementById("last-updated");

    try {
        lastUpdated.textContent = "Updating...";
        
        // Parallel fetch
        const [svcRes, metricRes] = await Promise.all([
            fetch("/api/services"),
            fetch("/api/metrics")
        ]);

        const serviceList = await svcRes.json(); // ["svc-a", "svc-b"]
        const metrics = await metricRes.json();  // { errors:[], latency:[], rps:[] }

        lastUpdated.textContent = new Date().toLocaleTimeString();

        // --- Process Data ---
        // Map everything by service name
        const data = {};
        serviceList.forEach(svc => {
            data[svc] = { 
                name: svc,
                errorRate: 0,
                latency: 0,
                rps: 0 
            };
        });

        // Helper to extract value from Prom result
        const mapMetrics = (list, key) => {
            if (!list) return;
            list.forEach(item => {
                const svc = item.metric.service_name || item.metric.service; // Flexible label
                const val = parseFloat(item.value[1]);
                if (data[svc]) {
                    data[svc][key] = val;
                } else if (svc) {
                    // Auto-discovery if not in service list (optional)
                    data[svc] = { name: svc, errorRate: 0, latency: 0, rps: 0 };
                    data[svc][key] = val;
                }
            });
        };

        mapMetrics(metrics.errors, 'errorRate');
        mapMetrics(metrics.latency, 'latency');
        mapMetrics(metrics.rps, 'rps');

        // Calculate Cohort Max for Normalization
        const maxRPS = Math.max(...Object.values(data).map(d => d.rps), 10); // Min 10 to avoid div/0
        const maxLat = Math.max(...Object.values(data).map(d => d.latency), 0.1); 

        // Render
        grid.innerHTML = "";
        Object.values(data).sort((a,b) => a.name.localeCompare(b.name)).forEach(svc => {
            const card = createCard(svc, maxLat, maxRPS);
            grid.appendChild(card);
        });

    } catch (e) {
        console.error("Update failed", e);
        lastUpdated.textContent = "Error";
    }
}

function createCard(svc, maxLat, maxRPS) {
    // 1. Normalize
    
    // Error Rate: Non-linear. 
    // 0.1% (0.001) -> Happy. 
    // 5% (0.05) -> Sad.
    // Formula: log10(err * 1000 + 1) / log10(50 + 1) roughly
    // Let's use the Plan's formula:
    // log10(error_rate * 1000 + 1) / log10(50 + 1)
    // 0 -> log(1) -> 0
    // 0.05 (5%) -> log(51) ~ 1.7 -> Clamp to 1.
    // Wait, log10(51) is 1.7. So it saturates early.
    // Let's divide by log10(100)? 
    // If we want 5% to be max sad (1.0).
    // range 0..1
    const errScore = Math.min(1, Math.log10(svc.errorRate * 1000 + 1) / 2); // log10(100) = 2. So 10% error = 1.0
    const mouth = 1 - errScore;

    // Latency: Log relative to cohort max
    // If svc.latency is small, score -> 0.
    const latScore = Math.min(1, Math.log10(svc.latency * 1000 + 1) / Math.log10(maxLat * 1000 + 1));
    const eyeSize = latScore; 

    // Load: Log relative to cohort max
    const loadScore = Math.min(1, Math.log10(svc.rps + 1) / Math.log10(maxRPS + 1));
    const browAngle = 1 - loadScore;

    // Health: Composite
    // If errors exist, health drops fast. 
    // If latency is high, health drops slightly.
    const health = 1 - Math.max(errScore, latScore * 0.3);

    // 2. Render SVG
    const svg = renderFace({
        mouth,
        eyeSize,
        browAngle,
        health
    });

    // Randomize bubble type (1-4)
    const bubbleType = Math.floor(Math.random() * 4) + 1;
    
    // 3. Build DOM
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
        <div class="chat-bubble bubble-v${bubbleType}">
            <div><span class="label">ERR:</span> ${(svc.errorRate * 100).toFixed(2)}%</div>
            <div><span class="label">LAT:</span> ${(svc.latency * 1000).toFixed(0)}ms</div>
            <div><span class="label">RPS:</span> ${svc.rps.toFixed(1)}</div>
        </div>
        <div class="face">${svg}</div>
        <div class="info">
            <h2>${svc.name}</h2>
        </div>
    `;

    // 4. Collision Detection (Viewpoint Boundary Check)
    div.addEventListener('mouseenter', () => {
        const bubble = div.querySelector('.chat-bubble');
        if (!bubble) return;

        // Reset
        bubble.classList.remove('force-bottom', 'force-left', 'force-right');
        
        // Measure
        const bWidth = bubble.offsetWidth || 220; // fallback width
        const bHeight = bubble.offsetHeight || 100; // fallback height
        const cRect = div.getBoundingClientRect();
        
        // Check Top
        // Default position is "Top" (bottom: 100%). 
        // Visual top is roughly: CardTop - BubbleHeight - 20px buffer
        const projectedTop = cRect.top - bHeight - 20;

        if (projectedTop < 0) {
            bubble.classList.add('force-bottom');
            // If we force bottom, we also need to check horizontal bounds
            // But usually bottom is enough to solve the "off screen top" issue.
        }

        // Check Horizontal
        // Default is centered: left: 50%, translateX(-50%)
        const center = cRect.left + (cRect.width / 2);
        const projectedLeft = center - (bWidth / 2);
        const projectedRight = center + (bWidth / 2);

        // We only apply side forces if we aren't already forcing bottom? 
        // Or can we combine? 
        // If we force bottom, it's still centered horizontally, so we might still need left/right.
        // Let's allow combination or separate checks.
        // However, the requested logic is "change position to left/right/below".
        // Usually, if it's off the top, we want below.
        // If it's off the side, we want the OTHER side.
        
        // It's possible to be off top AND off left (top-left corner).
        // Then we might want "bottom-right" or just "bottom".
        
        // Let's prioritize Bottom if off-top.
        // Then check horizontal.
        
        if (projectedLeft < 0) {
             bubble.classList.add('force-right');
        } else if (projectedRight > window.innerWidth) {
             bubble.classList.add('force-left');
        }
    });

    return div;
}

// Start
init();
