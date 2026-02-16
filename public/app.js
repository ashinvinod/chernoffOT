import { renderFace } from "./face.js";

// --- State ---
let config = { refreshInterval: 15 };
const physicsState = {
    nodes: new Map(), // Map<ServiceName, Node>
    bounds: { width: 0, height: 0, centerX: 0, centerY: 0 },
    zoom: 1
};

// --- Config ---
const MAX_LATENCY_MS = 2000; 
const MAX_RPS = 100;
const REPEL_RADIUS = 60; // Radius of repulsion (Diameter ~120)
const FORCE_CENTER = 0.002; // Weak Pull to center
const FORCE_REPEL = 0.2; // Strong Push away
const DAMPING = 0.9;
const MAX_VELOCITY = 2; // Slow movement for "standing" feel

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
            
            // Re-run layout (fewer ticks for responsiveness)
            layout(30); 
        }, { passive: false });
    }
    
    // Start Animation Loop (Removed, now static)
    // requestAnimationFrame(physicsLoop);

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

async function update() {
    const lastUpdated = document.getElementById("last-updated");

    try {
        if (lastUpdated) lastUpdated.textContent = "Updating...";
        
        // Parallel fetch
        const [svcRes, metricRes] = await Promise.all([
            fetch("/api/services"),
            fetch("/api/metrics")
        ]);

        const serviceList = await svcRes.json(); 
        const metrics = await metricRes.json();

        if (lastUpdated) lastUpdated.textContent = new Date().toLocaleTimeString();

        // --- Process Data ---
        const data = {};
        serviceList.forEach(svc => {
            data[svc] = { 
                name: svc,
                errorRate: 0,
                latency: 0,
                rps: 0 
            };
        });

        const mapMetrics = (list, key) => {
            if (!list) return;
            list.forEach(item => {
                const svc = item.metric.service_name || item.metric.service;
                const val = parseFloat(item.value[1]);
                if (data[svc]) {
                    data[svc][key] = val;
                } else if (svc) {
                    data[svc] = { name: svc, errorRate: 0, latency: 0, rps: 0 };
                    data[svc][key] = val;
                }
            });
        };

        mapMetrics(metrics.errors, 'errorRate');
        mapMetrics(metrics.latency, 'latency');
        mapMetrics(metrics.rps, 'rps');

        // Calculate Cohort Max
        const maxRPS = Math.max(...Object.values(data).map(d => d.rps), 10);
        const maxLat = Math.max(...Object.values(data).map(d => d.latency), 0.1); 

        // Reconciliation & Render
        reconcileNodes(data, maxLat, maxRPS);

    } catch (e) {
        console.error("Update failed", e);
        if (lastUpdated) lastUpdated.textContent = "Error";
    }
}

function reconcileNodes(data, maxLat, maxRPS) {
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

        // Compute Face Params
        const errScore = Math.min(1, Math.log10(svc.errorRate * 1000 + 1) / 2);
        const mouth = 1 - errScore;
        const latScore = Math.min(1, Math.log10(svc.latency * 1000 + 1) / Math.log10(maxLat * 1000 + 1));
        const eyeSize = latScore; 
        const loadScore = Math.min(1, Math.log10(svc.rps + 1) / Math.log10(maxRPS + 1));
        const browAngle = 1 - loadScore;
        const health = 1 - Math.max(errScore, latScore * 0.3);

        const svgContent = renderFace({ mouth, eyeSize, browAngle, health, bodyColor });
        
        // Update Stats Text (Labels) + Bubble Text
        const bubbleHTML = `<div class="chat-bubble bubble-v${Math.floor(Math.random() * 4) + 1}">
            <div><span class="label">ERR:</span> ${(svc.errorRate * 100).toFixed(2)}%</div>
            <div><span class="label">LAT:</span> ${(svc.latency * 1000).toFixed(0)}ms</div>
            <div><span class="label">RPS:</span> ${svc.rps.toFixed(1)}</div>
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
                    <div><span class="label">LAT:</span> ${(svc.latency * 1000).toFixed(0)}ms</div>
                    <div><span class="label">RPS:</span> ${svc.rps.toFixed(1)}</div>
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
    const MIN_DIST = 200 * physicsState.zoom; // Scale spacing with zoom
    
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
        // SVG is now smaller (height 120px)
        const drawX = node.x - (120 / 2); 
        const drawY = node.y - (75); // Adjusted anchor (Face center approx)
        
        node.element.style.transform = `translate3d(${drawX}px, ${drawY}px, 0) scale(${physicsState.zoom})`;
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
