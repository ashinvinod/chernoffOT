import { renderFace } from "./face.js";

// --- State ---
let config = { refreshInterval: 15 };
const physicsState = {
    nodes: new Map(), // Map<ServiceName, Node>
    bounds: { width: 0, height: 0, centerX: 0, centerY: 0 },
    zoom: 1
};

// --- Mapping Config ---
const STORAGE_KEY = "chernoffOT_mapping";

const METRICS = [
    { id: "errorNorm",      label: "Error Rate" },
    { id: "latencyNorm",    label: "Latency P95" },
    { id: "trafficNorm",    label: "Traffic Anomaly" },
    { id: "saturationNorm", label: "Saturation" },
];

const FEATURES = ["mouth", "eyeSize", "browAngle", "health"];

const DEFAULT_MAPPING = {
    mouth:    "errorNorm",
    eyeSize:  "latencyNorm",
    browAngle: "trafficNorm",
    health:   "saturationNorm",
};

// Active mapping (loaded from localStorage or defaults)
let featureMapping = loadMapping();

function loadMapping() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            // Validate: every feature key must exist and value must be a valid metric
            const validMetricIds = new Set(METRICS.map(m => m.id));
            for (const f of FEATURES) {
                if (!parsed[f] || !validMetricIds.has(parsed[f])) {
                    return { ...DEFAULT_MAPPING };
                }
            }
            return parsed;
        }
    } catch (e) {
        console.warn("Failed to load mapping from localStorage", e);
    }
    return { ...DEFAULT_MAPPING };
}

function saveMapping() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(featureMapping));
    } catch (e) {
        console.warn("Failed to save mapping to localStorage", e);
    }
}

// --- Physics Config ---
const MAX_LATENCY_MS = 2000; 
const MAX_RPS = 100;
const REPEL_RADIUS = 60; // Radius of repulsion (Diameter ~120)
const FORCE_CENTER = 0.002; // Weak Pull to center
const FORCE_REPEL = 0.2; // Strong Push away
const DAMPING = 0.9;
const MAX_VELOCITY = 2; // Slow movement for "standing" feel

// Cached latest service data for re-rendering on mapping change
let latestServiceData = {};

async function init() {
    try {
        const cfgRes = await fetch("/api/config");
        config = await cfgRes.json();
    } catch (e) { console.error("Config fetch failed", e); }

    // Setup Physics Container
    updateBounds();
    window.addEventListener('resize', () => {
        updateBounds();
        layout();
    });

    // Zoom Interaction
    const grid = document.getElementById("grid");
    if (grid) {
        grid.addEventListener("wheel", (e) => {
            e.preventDefault();
            const delta = e.deltaY;
            const sensitivity = 0.001;
            
            // Update Zoom
            let newZoom = physicsState.zoom - delta * sensitivity;
            newZoom = Math.max(0.1, Math.min(newZoom, 5)); // Clamp 0.1x to 5x
            physicsState.zoom = newZoom;
            
            // Re-render immediately (layout doesn't depend on zoom anymore)
            renderNodes(Array.from(physicsState.nodes.values()));
        }, { passive: false });
    }

    // Setup modal & mapping UI
    setupMappingModal();
    
    // Initial fetch
    await update();

    // Poll
    setInterval(update, config.refreshInterval * 1000);
}

function updateBounds() {
    const grid = document.getElementById("grid");
    if (!grid) return;
    physicsState.bounds.width = grid.clientWidth;
    physicsState.bounds.height = grid.clientHeight;
    // Target center
    physicsState.bounds.centerX = grid.clientWidth / 2;
    physicsState.bounds.centerY = grid.clientHeight / 2 + 100; 
}

function clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function formatSignedPercent(ratio) {
    const pct = ratio * 100;
    const prefix = pct > 0 ? "+" : "";
    return `${prefix}${pct.toFixed(1)}%`;
}

async function update() {
    const lastUpdated = document.getElementById("last-updated");

    try {
        if (lastUpdated) lastUpdated.textContent = "Updating...";

        const stateRes = await fetch("/api/dashboard/state?window=5m");
        if (!stateRes.ok) throw new Error(`Dashboard state fetch failed: ${stateRes.status}`);

        const dashboardState = await stateRes.json();
        const metricServices = dashboardState?.metrics?.services || [];
        const stale = !!dashboardState?.stale;

        if (lastUpdated) {
            const capturedAt = dashboardState?.metrics?.capturedAt || dashboardState?.capturedAt;
            const timestamp = capturedAt ? new Date(capturedAt).toLocaleTimeString() : new Date().toLocaleTimeString();
            lastUpdated.textContent = stale ? `${timestamp} (stale)` : timestamp;
        }

        // --- Process Data ---
        const data = {};
        metricServices.forEach((svc) => {
            if (!svc || !svc.serviceName) return;

            const raw = svc.raw || {};
            const normalized = svc.normalized || {};

            const errorRateRaw = raw.errorRateRaw ?? 0;
            const latencyP95MsRaw = raw.latencyP95MsRaw ?? 0;
            const trafficAnomalyRaw = raw.trafficAnomalyRaw ?? 0;
            const saturationRaw = raw.saturationRaw ?? 0;

            data[svc.serviceName] = {
                name: svc.serviceName,
                serviceType: svc.serviceType || "unknown",
                state: svc.state || "active",
                errorRate: errorRateRaw,
                latencyMs: latencyP95MsRaw,
                trafficAnomaly: trafficAnomalyRaw,
                saturation: saturationRaw,
                errorNorm: normalized.errorRateNorm ?? clamp01(Math.log10(errorRateRaw * 1000 + 1) / 2),
                latencyNorm: normalized.latencyNorm ?? clamp01(Math.log10(latencyP95MsRaw + 1) / 3),
                trafficNorm: normalized.trafficNorm ?? clamp01(Math.abs(trafficAnomalyRaw) / 2),
                saturationNorm: normalized.saturationNorm ?? clamp01(saturationRaw)
            };
        });

        // Cache for re-renders on mapping change
        latestServiceData = data;

        // Reconciliation & Render
        reconcileNodes(data);

    } catch (e) {
        console.error("Update failed", e);
        if (lastUpdated) lastUpdated.textContent = "Error";
    }
}

function reconcileNodes(data) {
    const grid = document.getElementById("grid");
    if (!grid) return;

    // Remove loading indicator if present
    const loading = grid.querySelector('.loading');
    if (loading) loading.remove();

    const incomingNames = new Set(Object.keys(data));
    
    // 1. Remove stale nodes
    for (const [name, node] of physicsState.nodes) {
        if (!incomingNames.has(name)) {
            if (node.element.parentNode) grid.removeChild(node.element);
            physicsState.nodes.delete(name);
        }
    }

    // 2. Add or Update nodes
    Object.values(data).forEach(svc => {
        let node = physicsState.nodes.get(svc.name);
        
        // Get or Generate Color
        let bodyColor;
        if (node && node.bodyColor) {
            bodyColor = node.bodyColor;
        } else {
            bodyColor = getTrafficUnrelatedColor();
        }

        // Compute Face Params using configurable mapping
        const scores = {
            errorNorm: clamp01(svc.errorNorm),
            latencyNorm: clamp01(svc.latencyNorm),
            trafficNorm: clamp01(svc.trafficNorm),
            saturationNorm: clamp01(svc.saturationNorm),
        };

        const mouthScore = scores[featureMapping.mouth] ?? 0;
        const mouth = 1 - mouthScore;
        const eyeSize = scores[featureMapping.eyeSize] ?? 0;
        const browScore = scores[featureMapping.browAngle] ?? 0;
        const browAngle = 1 - browScore;
        const healthMetricScore = scores[featureMapping.health] ?? 0;
        // Health is composite: dominant metric at 80%, others contribute small amounts
        const health = 1 - Math.max(healthMetricScore * 0.8, mouthScore * 0.15, eyeSize * 0.15);

        const svgContent = renderFace({ mouth, eyeSize, browAngle, health, bodyColor });
        
        // Update Stats Text (Labels) + Bubble Text
        const bubbleHTML = `<div class="chat-bubble bubble-v${Math.floor(Math.random() * 4) + 1}">
            <div><span class="label">ERR:</span> ${(svc.errorRate * 100).toFixed(2)}%</div>
            <div><span class="label">LAT:</span> ${svc.latencyMs.toFixed(0)}ms</div>
            <div><span class="label">ANOM:</span> ${formatSignedPercent(svc.trafficAnomaly)}</div>
            <div><span class="label">SAT:</span> ${(svc.saturation * 100).toFixed(0)}%</div>
            <div><span class="label">TYPE:</span> ${svc.serviceType}</div>
        </div>`;
        // Note: we recreate bubble HTML because stats change. 
        // Optimized: only update text inside bubble if needed? 
        // For now, full overwrite of bubble innerHTML is fine.

        // If new node
        if (!node) {
            const el = document.createElement("div");
            el.className = "card";
            // Random start position (scattered)
            const startX = Math.random() * physicsState.bounds.width;
            const startY = Math.random() * physicsState.bounds.height;

            el.innerHTML = `
                ${bubbleHTML}
                <div class="face">${svgContent}</div>
                <div class="info"><h2>${svc.name}</h2></div>
            `;
            
            grid.appendChild(el);
            
            // Add Mouse Interaction
            addInteraction(el);

            node = {
                name: svc.name,
                element: el,
                x: startX,
                y: startY,
                vx: 0, 
                vy: 0,
                width: 120, 
                height: 150, // Approx (Bubble + Face + Info)
                mass: 1,
                bodyColor: bodyColor
            };
            physicsState.nodes.set(svc.name, node);
        } else {
            // Update existing DOM content
            const faceEl = node.element.querySelector('.face');
            if (faceEl && faceEl.innerHTML !== svgContent) faceEl.innerHTML = svgContent;
            
            const bubbleEl = node.element.querySelector('.chat-bubble');
            if (bubbleEl) {
                 bubbleEl.innerHTML = `
                    <div><span class="label">ERR:</span> ${(svc.errorRate * 100).toFixed(2)}%</div>
                    <div><span class="label">LAT:</span> ${svc.latencyMs.toFixed(0)}ms</div>
                    <div><span class="label">ANOM:</span> ${formatSignedPercent(svc.trafficAnomaly)}</div>
                    <div><span class="label">SAT:</span> ${(svc.saturation * 100).toFixed(0)}%</div>
                    <div><span class="label">TYPE:</span> ${svc.serviceType}</div>
                 `;
            }
        }
    });

    // Re-run static layout after reconciliation
    layout();
}

function getTrafficUnrelatedColor() {
    // Avoid Green, Yellow, Red (Traffic lights)
    // Use Blue, Purple, Orange, Cyan, Indigo, Pink, Teal
    const colors = [
        "#60a5fa", // Blue 400
        "#c084fc", // Purple 400
        "#fb923c", // Orange 400
        "#22d3ee", // Cyan 400
        "#818cf8", // Indigo 400
        "#f472b6", // Pink 400
        "#2dd4bf", // Teal 400
        "#a78bfa", // Violet 400
    ];
    return colors[Math.floor(Math.random() * colors.length)];
}

/**
 * Runs a static simulation to settle nodes positions 
 * without continuous animation.
 */
function layout(ticks = 300) {
    const nodes = Array.from(physicsState.nodes.values());
    if (nodes.length === 0) return;

    const { centerX, centerY } = physicsState.bounds;
    const TICKS = ticks;
    const MIN_DIST = 200; // Fixed spacing (renderNodes handles visual scaling)
    
    // Simulation Loop (Synchronous)
    for (let i = 0; i < TICKS; i++) {
        const alpha = 1 - (i / TICKS); // Decay
        
        nodes.forEach(node => {
            // 1. Attraction to Center (variable strength based on alpha)
            const dx = centerX - node.x;
            const dy = centerY - node.y;
            
            // Stronger pull initially, weaker later
            const k = FORCE_CENTER * alpha;
            // Spread horizontally: weaker pull on X axis to use full width
            node.vx += dx * k * 0.4;
            node.vy += dy * k;

            // 2. Repulsion
            nodes.forEach(other => {
                if (node === other) return;
                const dx2 = node.x - other.x;
                const dy2 = node.y - other.y;
                let distSq = dx2 * dx2 + dy2 * dy2;
                
                if (distSq === 0) {
                    // Jitter if exactly overlapping
                    distSq = 0.1; 
                    node.vx += Math.random();
                    node.vy += Math.random();
                }

                if (distSq < MIN_DIST * MIN_DIST) {
                    const dist = Math.sqrt(distSq);
                    const force = (MIN_DIST - dist) / dist * FORCE_REPEL * alpha;
                    
                    const tx = (dx2 / dist) * force;
                    const ty = (dy2 / dist) * force;

                    node.vx += tx;
                    node.vy += ty;
                }
            });
        });

        // Update Positions
        nodes.forEach(node => {
            // Damping
            node.vx *= DAMPING;
            node.vy *= DAMPING;

            // Cap velocity (higher cap for static layout to allow fast settling)
            const maxV = MAX_VELOCITY * 5; 
            const v = Math.sqrt(node.vx*node.vx + node.vy*node.vy);
            if (v > maxV) {
                node.vx = (node.vx / v) * maxV;
                node.vy = (node.vy / v) * maxV;
            }

            node.x += node.vx;
            node.y += node.vy;
            
            // Keep in bounds (with margin for card size ~120px width)
            const marginX = 70; 
            const marginY = 100;
            
            if (node.x < marginX) { node.x = marginX; node.vx *= -0.5; }
            if (node.x > physicsState.bounds.width - marginX) { node.x = physicsState.bounds.width - marginX; node.vx *= -0.5; }
            if (node.y < marginY) { node.y = marginY; node.vy *= -0.5; }
            if (node.y > physicsState.bounds.height - marginY) { node.y = physicsState.bounds.height - marginY; node.vy *= -0.5; }
        });
    }

    // Apply final positions
    renderNodes(nodes);
}

function renderNodes(nodes) {
    // Sort logic: Higher Y (lower on screen) -> Front -> Higher Z-index
    nodes.sort((a, b) => a.y - b.y);
    
    nodes.forEach((node, index) => {
        // Update Z-index based on sorted order
        if (node.element.style.zIndex !== `${index + 10}`) {
            node.element.style.zIndex = index + 10;
        }

        // Center the element on coordinate
        // Apply Zoom to coordinate system (World -> Screen)
        const { centerX, centerY } = physicsState.bounds;
        const distX = node.x - centerX;
        const distY = node.y - centerY;
        
        const screenX = centerX + distX * physicsState.zoom;
        const screenY = centerY + distY * physicsState.zoom;

        const drawX = screenX - (120 / 2); 
        const drawY = screenY - (75); // Adjusted anchor (Face center approx)
        
        node.element.style.transform = `translate3d(${drawX}px, ${drawY}px, 0) scale(${physicsState.zoom})`;
    });
}

// ========================================
// Mapping Modal Logic
// ========================================

function setupMappingModal() {
    const overlay  = document.getElementById("mapping-overlay");
    const helpBtn  = document.getElementById("help-btn");
    const closeBtn = document.getElementById("modal-close");
    const resetBtn = document.getElementById("mapping-reset");

    if (!overlay || !helpBtn) return;

    // Populate dropdowns
    FEATURES.forEach(featureId => {
        const select = document.getElementById(`map-${featureId}`);
        if (!select) return;

        // Build options
        select.innerHTML = METRICS.map(m =>
            `<option value="${m.id}" ${featureMapping[featureId] === m.id ? "selected" : ""}>${m.label}</option>`
        ).join("");

        // On change → save + re-render
        select.addEventListener("change", () => {
            featureMapping[featureId] = select.value;
            saveMapping();
            // Re-render faces with new mapping
            if (Object.keys(latestServiceData).length > 0) {
                reconcileNodes(latestServiceData);
            }
        });
    });

    // Open
    helpBtn.addEventListener("click", () => {
        overlay.classList.add("open");
    });

    // Close
    closeBtn.addEventListener("click", () => {
        overlay.classList.remove("open");
    });

    // Close on overlay click (outside card)
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
            overlay.classList.remove("open");
        }
    });

    // Close on Escape
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && overlay.classList.contains("open")) {
            overlay.classList.remove("open");
        }
    });

    // Reset
    resetBtn.addEventListener("click", () => {
        featureMapping = { ...DEFAULT_MAPPING };
        saveMapping();
        // Update dropdown selections
        FEATURES.forEach(featureId => {
            const select = document.getElementById(`map-${featureId}`);
            if (select) select.value = featureMapping[featureId];
        });
        // Re-render
        if (Object.keys(latestServiceData).length > 0) {
            reconcileNodes(latestServiceData);
        }
    });
}

function addInteraction(div) {
    div.addEventListener('mouseenter', () => {
        const bubble = div.querySelector('.chat-bubble');
        if (!bubble) return;

        bubble.classList.remove('force-bottom', 'force-left', 'force-right');
        
        // Use timeout to let browser calculate layout if hidden? No, it's opacity 0 but layout exists.
        const bRect = bubble.getBoundingClientRect();
        const cRect = div.getBoundingClientRect();
        
        // Top Boundary
        if (cRect.top - bRect.height - 20 < 0) {
            bubble.classList.add('force-bottom');
        }
        
        // Right Boundary
        // If bubble goes off right edge
        if (cRect.left + (cRect.width/2) + (bRect.width/2) > window.innerWidth) {
             bubble.classList.add('force-left');
        }
        
        // Left Boundary
        if (cRect.left + (cRect.width/2) - (bRect.width/2) < 0) {
             bubble.classList.add('force-right');
        }
    });
}

// Start
init();
