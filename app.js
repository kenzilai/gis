// Apple Park web map demo: Mapbox GL JS v3 + Standard style
// Public (pk.) tokens are meant to be exposed, but restrict this one to your Vercel domain
// in the Mapbox dashboard (URL restrictions).
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const CENTER = [-122.0090, 37.3349];

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/standard',
    center: CENTER,
    zoom: 16,
    pitch: 45,
    bearing: -17.6,
    antialias: false,
    config: { basemap: { lightPreset: 'night' } }
});

// ===========================================================================
// Tunable knobs
// ===========================================================================
const VEHICLE_SCALE = 1.35;       // cartographic exaggeration so vehicles read at zoom 16 (1 = true size)
const CARS_PER_200M = 1;          // traffic density per lane
const MAX_CARS_PER_LANE = 12;     // night (and base) traffic per lane
const DAY_TRAFFIC_MULT = 2.2;     // light mode = daytime rush: this many times more cars than night
const LANE_OFFSET_M = 2.6;        // distance from road centerline to lane centre (right-hand traffic)
const NIGHT_BODY_EMISSIVE = 0.6;  // raise if night colours look too dark, lower if they look washed out
const LIMITS_MPS = [11.2, 15.6, 11.2, 15.6]; // per route: 25 mph, 35 mph, ...
const SIGNAL_FRACTIONS = [0.38, 0.72];       // where signals sit along each route (0..1), move onto real intersections
const SIGNAL_CYCLE = { green: 14, yellow: 3, red: 14 };

// Rough endpoints near Apple Park; the Directions API snaps them to real roads.
const ROUTE_WAYPOINTS = [
    [[-122.0215, 37.3349], [-121.9990, 37.3349]],
    [[-122.0090, 37.3270], [-122.0090, 37.3430]],
    [[-122.0215, 37.3300], [-121.9990, 37.3400]],
    [[-122.0150, 37.3420], [-122.0010, 37.3290]]
];

// Vehicle variants: dimensions in metres, performance, and colour palettes.
const VEHICLE_TYPES = [
    { name: 'sedan',      weight: 45, len: 4.6,  wid: 1.9, hgt: 1.5, accel: 2.0, speedFactor: 0.95,
      colors: ['#f5f5f7', '#1d1d1f', '#8e8e93', '#0a84ff', '#ff453a', '#c7c7cc', '#30d158'] },
    { name: 'suv',        weight: 25, len: 4.9,  wid: 2.0, hgt: 1.8, accel: 1.8, speedFactor: 0.95,
      colors: ['#1d1d1f', '#f5f5f7', '#636366', '#5e5ce6', '#8e8e93', '#a2845e'] },
    { name: 'pickup',     weight: 10, len: 5.4,  wid: 2.0, hgt: 1.9, accel: 1.7, speedFactor: 0.95,
      colors: ['#ff9f0a', '#0a84ff', '#f5f5f7', '#1d1d1f', '#ff453a'] },
    { name: 'van',        weight: 8,  len: 6.0,  wid: 2.1, hgt: 2.5, accel: 1.4, speedFactor: 0.9,
      colors: ['#f5f5f7', '#ffd60a', '#8b5a2b', '#c7c7cc'] },
    { name: 'shuttle',    weight: 5,  len: 11.5, wid: 2.5, hgt: 3.2, accel: 1.1, speedFactor: 0.85,
      colors: ['#f2f2f7'] },
    { name: 'motorcycle', weight: 7,  len: 2.1,  wid: 0.8, hgt: 1.2, accel: 3.0, speedFactor: 1.0,
      colors: ['#ff453a', '#1d1d1f', '#0a84ff', '#ffd60a'] }
];

const HEADLIGHT_COLOR = '#fff4c8';
const TAILLIGHT_COLOR = '#ff2d1f';
const SIGNAL_COLORS = { green: '#30d158', yellow: '#ffd60a', red: '#ff453a' };

// ===========================================================================
// Time of day: Mapbox Standard's four light presets. The slider steps through them;
// traffic density, vehicle lights and weather tones follow along.
// ===========================================================================
const PHASE_ORDER = ['dawn', 'day', 'dusk', 'night'];
const PHASES = {
    dawn:  { label: 'Dawn',  body: 0.2, lights: true,  traffic: 1.3 },
    day:   { label: 'Day',   body: 0,   lights: false, traffic: DAY_TRAFFIC_MULT },
    dusk:  { label: 'Dusk',  body: 0.3, lights: true,  traffic: 1.8 }, // evening rush
    night: { label: 'Night', body: NIGHT_BODY_EMISSIVE, lights: true, traffic: 1 }
};
let phase = 'night';
let compareMap = null;   // second map used by the before/after view (created on demand)
let cycleTimer = null;

// Vehicle body colours never change; darker phases add self-illumination so the real
// paint colour stays readable, plus headlight beams.
function applyTheme() {
    const p = PHASES[phase];
    if (map.getLayer('vehicles')) {
        map.setPaintProperty('vehicles', 'fill-extrusion-emissive-strength', p.body);
    }
    if (map.getLayer('vehicle-lights')) {
        map.setPaintProperty('vehicle-lights', 'fill-extrusion-emissive-strength', lightsOn() ? 1 : 0.25);
    }
    if (map.getLayer('beams')) {
        map.setPaintProperty('beams', 'fill-opacity', lightsOn() ? 0.28 : 0);
    }
}

function setTimeOfDay(name, byUser = false) {
    if (!PHASES[name]) return;
    if (byUser) stopCycle();
    phase = name;
    map.setConfigProperty('basemap', 'lightPreset', name);
    if (compareMap) {
        try { compareMap.setConfigProperty('basemap', 'lightPreset', name); } catch (err) { /* style still loading */ }
    }
    applyWeather(); // haze/fog tones and headlights depend on the phase (also calls applyTheme)

    document.getElementById('btn-light').classList.toggle('active', name === 'day');
    document.getElementById('btn-dark').classList.toggle('active', name === 'night');
    const slider = document.getElementById('time-slider');
    slider.value = PHASE_ORDER.indexOf(name);
    slider.setAttribute('aria-valuetext', PHASES[name].label);
    document.getElementById('time-label').textContent = PHASES[name].label;
}

function startCycle() {
    const btn = document.getElementById('btn-cycle');
    btn.classList.add('active');
    btn.textContent = 'Pause day cycle';
    clearInterval(cycleTimer);
    cycleTimer = setInterval(() => {
        setTimeOfDay(PHASE_ORDER[(PHASE_ORDER.indexOf(phase) + 1) % PHASE_ORDER.length]);
    }, 3500);
}

function stopCycle() {
    if (cycleTimer === null) return;
    clearInterval(cycleTimer);
    cycleTimer = null;
    const btn = document.getElementById('btn-cycle');
    btn.classList.remove('active');
    btn.textContent = 'Play day cycle';
}

document.getElementById('btn-light').addEventListener('click', () => setTimeOfDay('day', true));
document.getElementById('btn-dark').addEventListener('click', () => setTimeOfDay('night', true));
document.getElementById('time-slider').addEventListener('input', e =>
    setTimeOfDay(PHASE_ORDER[Number(e.target.value)], true));
document.getElementById('btn-cycle').addEventListener('click', () => {
    if (cycleTimer === null) startCycle(); else stopCycle();
});

// ===========================================================================
// Seasons and weather
// Requires Mapbox GL JS >= 3.17 (basemap colour overrides, show3dBuildings).
// ===========================================================================
const SEASONS = {
    spring: { greenspace: '#86d66b', water: '#6cc3ea', land: '#eef1e4', particles: 'petal' }, // blossom petals
    summer: { greenspace: '#3aa655', water: '#2fa9de', land: '#f1eee4' },
    autumn: { greenspace: '#d08a32', water: '#6aa7b2', land: '#efe3d0', particles: 'leaf' },  // falling leaves
    winter: { greenspace: '#e3ecf0', water: '#8db6cc', land: '#f5f8fb' }                      // snow-covered ground
};

// speed: multiplier on speed limits. headway: multiplier on following gap. lights: headlights on in daytime.
// look: saturation/brightness of the map. haze: [colour, opacity] tint, strongest toward the horizon.
const WEATHERS = {
    clear:  { speed: 1.0,  headway: 1.0, lights: false, look: { sat: 1, bright: 1 } },
    cloudy: { speed: 0.95, headway: 1.0, lights: false, look: { sat: 0.5, bright: 0.96 },
              haze: { day: ['#8d949c', 0.38], night: ['#0f1116', 0.3] } },
    fog:    { speed: 0.8,  headway: 1.4, lights: true,  look: { sat: 0.7, bright: 1 },
              fog: { range: [0.1, 1.5],
                     day:   { color: '#d5dbe1', high: '#e3e8ec' },
                     night: { color: '#2a2e36', high: '#1c1f26' } },
              haze: { day: ['#d5dbe1', 0.8], night: ['#262a31', 0.75] } },
    rain:   { speed: 0.8,  headway: 1.3, lights: true,  look: { sat: 0.65, bright: 0.9 }, fx: 'rain',
              haze: { day: ['#9aa2ab', 0.36], night: ['#0f1218', 0.3] } },
    snow:   { speed: 0.6,  headway: 1.6, lights: true,  look: { sat: 0.8, bright: 1.03 }, fx: 'snow',
              haze: { day: ['#e6ecf1', 0.3], night: ['#2a303a', 0.25] } },
    storm:  { speed: 0.65, headway: 1.5, lights: true,  look: { sat: 0.45, bright: 0.78 }, fx: 'storm',
              lightning: true,
              haze: { day: ['#3d434c', 0.55], night: ['#05070a', 0.45] } }
};

let season = 'spring';
let weather = 'clear';

const lightsOn = () => PHASES[phase].lights || WEATHERS[weather].lights;
const weatherSpeed = () => WEATHERS[weather].speed;
const weatherHeadway = () => WEATHERS[weather].headway;

// ---------------------------------------------------------------------------
// Particle engine: a 2D canvas over the map for petals, leaves, snow, rain and storm.
// Every particle has a depth d. Screen scale is 1/d, so deeper = farther = smaller,
// slower and fainter. FX_DEPTH = [nearest, farthest]: raise both numbers to push ALL
// particles farther from the camera, or lower them to bring them closer.
// ---------------------------------------------------------------------------
const FX_DEPTH = [2.2, 6.0];
const FX_SMAX = 1 / FX_DEPTH[0];

// count is for a 1920x1080 window and scales with screen area.
// size: px at depth 1. fall/drift: px per second. len: streak length at depth 1.
// alpha/width: per depth bucket, nearest to farthest.
const FX = {
    petal: { shape: 'flutter', count: 120, size: 17, fall: 55, drift: 30, spin: 2.0, wind: 22,
             colors: ['#ffc7dc', '#ffb3d0', '#ffd9e8', '#f7a6c6', '#ffe3ee'] },
    leaf:  { shape: 'flutter', count: 100, size: 15, fall: 75, drift: 38, spin: 2.6, wind: 26,
             colors: ['#d9731a', '#c2410c', '#e8a020', '#a63d12', '#b8860b', '#8c4a12'] },
    snow:  { shape: 'dot', count: 400, size: 12, fall: 70, drift: 20, wind: 8,
             color: '#ffffff', alpha: [0.95, 0.75, 0.5] },
    rain:  { shape: 'streak', count: 500, fall: 1250, slant: 0.14, len: 90,
             color: '#b8c2d6', alpha: [0.5, 0.34, 0.2], width: [1.3, 0.9, 0.6] },
    storm: { shape: 'streak', count: 1000, fall: 1750, slant: 0.42, len: 125,
             color: '#c9d3e6', alpha: [0.65, 0.45, 0.28], width: [1.7, 1.1, 0.7] }
};

const fxCanvas = document.createElement('canvas');
fxCanvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:4;';
document.body.appendChild(fxCanvas);
const fxCtx = fxCanvas.getContext('2d');
let fxW = 0, fxH = 0, fxDpr = 1;
let fxKind = null, fxParts = [], fxRunning = false, fxLast = 0;

function fxResize() {
    fxDpr = 1;
    fxW = window.innerWidth;
    fxH = window.innerHeight;
    fxCanvas.width = Math.round(fxW * fxDpr);
    fxCanvas.height = Math.round(fxH * fxDpr);
    fxCanvas.style.width = fxW + 'px';
    fxCanvas.style.height = fxH + 'px';
}
fxResize();
window.addEventListener('resize', () => { fxResize(); if (fxKind) fxStart(fxKind); });

function fxSpawn(cfg, anywhere) {
    const d = FX_DEPTH[0] + Math.random() * (FX_DEPTH[1] - FX_DEPTH[0]);
    const slant = cfg.slant || 0;
    return {
        d, s: 1 / d,
        b: Math.min(2, Math.floor((d - FX_DEPTH[0]) / (FX_DEPTH[1] - FX_DEPTH[0]) * 3)), // 0 = nearest bucket
        x: -fxH * slant + Math.random() * (fxW + fxH * slant),
        y: anywhere ? Math.random() * fxH : -Math.random() * 60,
        ph: Math.random() * Math.PI * 2,
        rot: Math.random() * Math.PI * 2,
        spd: 0.75 + Math.random() * 0.5,
        col: cfg.colors ? cfg.colors[Math.floor(Math.random() * cfg.colors.length)] : null,
        maple: Math.random() < 0.55
    };
}

function fxStart(kind) {
    fxKind = kind;
    fxParts = [];
    if (!kind) { fxCtx.setTransform(1, 0, 0, 1, 0, 0); fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height); return; }
    const cfg = FX[kind];
    const area = Math.min(1.6, Math.max(0.5, (fxW * fxH) / (1920 * 1080)));
    const n = Math.round(cfg.count * area);
    for (let i = 0; i < n; i++) fxParts.push(fxSpawn(cfg, true));
    if (!fxRunning) {
        fxRunning = true;
        fxLast = performance.now();
        requestAnimationFrame(fxFrame);
    }
}

// Petal: teardrop with a notch at the tip. Unit coordinates, length 1.
function pathPetal(c) {
    c.moveTo(0, 0.5);
    c.bezierCurveTo(0.55, 0.2, 0.45, -0.45, 0.1, -0.5);
    c.quadraticCurveTo(0, -0.36, -0.1, -0.5);
    c.bezierCurveTo(-0.45, -0.45, -0.55, 0.2, 0, 0.5);
    c.closePath();
}

// Maple leaf outline (right half, mirrored) plus a short stem.
const MAPLE_R = [[0, -0.55], [0.08, -0.32], [0.2, -0.4], [0.17, -0.15], [0.4, -0.24],
                 [0.3, 0.0], [0.5, 0.08], [0.2, 0.16], [0.15, 0.3], [0.03, 0.27]];
function pathMaple(c) {
    c.moveTo(MAPLE_R[0][0], MAPLE_R[0][1]);
    for (let i = 1; i < MAPLE_R.length; i++) c.lineTo(MAPLE_R[i][0], MAPLE_R[i][1]);
    c.lineTo(0, 0.52);
    for (let i = MAPLE_R.length - 1; i >= 1; i--) c.lineTo(-MAPLE_R[i][0], MAPLE_R[i][1]);
    c.closePath();
}

// Plain pointed leaf with a stem.
function pathLeaf(c) {
    c.moveTo(0, -0.5);
    c.bezierCurveTo(0.42, -0.25, 0.38, 0.22, 0.02, 0.38);
    c.lineTo(0.02, 0.58);
    c.lineTo(-0.02, 0.58);
    c.lineTo(-0.02, 0.38);
    c.bezierCurveTo(-0.38, 0.22, -0.42, -0.25, 0, -0.5);
    c.closePath();
}

function fxDepthFactor(p) { return 0.45 + 0.55 * (p.s / FX_SMAX); }

function fxFrame(now) {
    if (!fxKind) { fxRunning = false; return; }
    const dt = Math.min((now - fxLast) / 1000, 0.05);
    fxLast = now;
    const cfg = FX[fxKind];
    const c = fxCtx;
    c.setTransform(fxDpr, 0, 0, fxDpr, 0, 0);
    c.clearRect(0, 0, fxW, fxH);

    if (cfg.shape === 'streak') drawStreaks(c, cfg, dt);
    else if (cfg.shape === 'dot') drawDots(c, cfg, dt);
    else drawFlutter(c, cfg, dt);

    if (fxKind === 'storm') drawBolt(c, now);
    requestAnimationFrame(fxFrame);
}

function drawFlutter(c, cfg, dt) {
    for (const p of fxParts) {
        const df = fxDepthFactor(p);
        p.ph += dt * cfg.spin * p.spd;
        p.y += cfg.fall * p.spd * df * dt;
        p.x += (cfg.drift * Math.sin(p.ph * 0.7 + p.rot) + cfg.wind) * df * dt;
        if (p.y > fxH + 30) Object.assign(p, fxSpawn(cfg, false));
        if (p.x > fxW + 30) p.x = -30; else if (p.x < -30) p.x = fxW + 30;

        const size = cfg.size * p.s;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot + Math.sin(p.ph) * 0.6);
        c.scale(size * (0.35 + 0.65 * Math.abs(Math.cos(p.ph * 1.3))), size); // tumbling flip
        c.globalAlpha = 0.4 + 0.55 * (p.s / FX_SMAX);
        c.fillStyle = p.col;
        c.beginPath();
        if (fxKind === 'petal') pathPetal(c);
        else if (p.maple) pathMaple(c);
        else pathLeaf(c);
        c.fill();
        c.restore();
    }
}

function drawDots(c, cfg, dt) {
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (const p of fxParts) {
        const df = fxDepthFactor(p);
        p.ph += dt * 1.5 * p.spd;
        p.y += cfg.fall * p.spd * df * dt;
        p.x += (cfg.drift * Math.sin(p.ph + p.rot) + cfg.wind) * df * dt;
        if (p.y > fxH + 10) Object.assign(p, fxSpawn(cfg, false));
        if (p.x > fxW + 10) p.x = -10; else if (p.x < -10) p.x = fxW + 10;
        const r = Math.max(0.6, cfg.size * p.s * 0.5);
        paths[p.b].moveTo(p.x + r, p.y);
        paths[p.b].arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    c.fillStyle = cfg.color;
    for (let b = 0; b < 3; b++) { c.globalAlpha = cfg.alpha[b]; c.fill(paths[b]); }
    c.globalAlpha = 1;
}

function drawStreaks(c, cfg, dt) {
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (const p of fxParts) {
        const df = fxDepthFactor(p);
        const v = cfg.fall * p.spd * df * dt;
        p.y += v;
        p.x += v * cfg.slant;
        if (p.y > fxH + 40) Object.assign(p, fxSpawn(cfg, false));
        const L = cfg.len * p.s;
        paths[p.b].moveTo(p.x, p.y);
        paths[p.b].lineTo(p.x - cfg.slant * L, p.y - L);
    }
    c.strokeStyle = cfg.color;
    c.lineCap = 'round';
    for (let b = 0; b < 3; b++) {
        c.globalAlpha = cfg.alpha[b];
        c.lineWidth = cfg.width[b];
        c.stroke(paths[b]);
    }
    c.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Lightning: a jagged bolt in the distance plus a full-screen flash
// ---------------------------------------------------------------------------
let bolt = null;

function makeBolt() {
    const x0 = fxW * (0.15 + Math.random() * 0.7);
    const y1 = fxH * (0.35 + Math.random() * 0.3);
    const steps = 14;
    const pts = [[x0, 0]];
    let x = x0, y = 0;
    for (let i = 0; i < steps; i++) {
        y += y1 / steps;
        x += (Math.random() - 0.5) * fxW * 0.05;
        pts.push([x, y]);
    }
    const branches = [];
    for (let k = 0; k < 2; k++) {
        const i = 3 + Math.floor(Math.random() * 8);
        const dir = Math.random() < 0.5 ? -1 : 1;
        let bx = pts[i][0], by = pts[i][1];
        const br = [[bx, by]];
        for (let j = 0; j < 4; j++) {
            bx += dir * (8 + Math.random() * 20);
            by += y1 / steps * (0.8 + Math.random() * 0.5);
            br.push([bx, by]);
        }
        branches.push(br);
    }
    return { pts, branches, t0: performance.now(), dur: 420 };
}

function drawBolt(c, now) {
    if (!bolt) return;
    const age = now - bolt.t0;
    if (age > bolt.dur) { bolt = null; return; }
    const flicker = age < 90 ? 1 : 0.55 + Math.random() * 0.45;
    c.save();
    c.globalAlpha = (1 - age / bolt.dur) * flicker;
    c.strokeStyle = '#eaf1ff';
    c.shadowColor = '#9db8ff';
    c.shadowBlur = 18;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const trace = pts => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); };
    c.lineWidth = 2.4; trace(bolt.pts);
    c.lineWidth = 1.2; bolt.branches.forEach(trace);
    c.restore();
}

let lightningTimer = null;
function stopLightning() { clearTimeout(lightningTimer); lightningTimer = null; bolt = null; }
function startLightning() {
    stopLightning();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const flash = document.getElementById('lightning');
    const strike = () => {
        bolt = makeBolt();
        // Two pulses, kept under about 3 flashes per second
        flash.animate([
            { opacity: 0, offset: 0 }, { opacity: 0.85, offset: 0.12 }, { opacity: 0.08, offset: 0.28 },
            { opacity: 0.5, offset: 0.55 }, { opacity: 0, offset: 1 }
        ], { duration: 900, easing: 'linear' });
        lightningTimer = setTimeout(strike, 2500 + Math.random() * 4500);
    };
    strike();
}

// ---------------------------------------------------------------------------
// Applying season + weather
// ---------------------------------------------------------------------------
function applyWeather() {
    const w = WEATHERS[weather];
    const tone = phase === 'night' ? 'night' : 'day';

    // Particles: the weather wins. Clear/cloudy days get seasonal petals or leaves.
    let kind = w.fx || null;
    if (!kind && (weather === 'clear' || weather === 'cloudy')) kind = SEASONS[season].particles || null;
    if (kind !== fxKind) fxStart(kind);

    try {
        map.setFog(w.fog ? {
            range: w.fog.range,
            color: w.fog[tone].color,
            'high-color': w.fog[tone].high,
            'horizon-blend': 0.12,
            'space-color': w.fog[tone].high,
            'star-intensity': 0
        } : null);
    } catch (err) {
        console.warn('Fog unavailable in this GL JS version', err);
    }

    // CSS haze tint, strongest toward the horizon
    const overlay = document.getElementById('weather-overlay');
    if (w.haze) {
        overlay.style.setProperty('--haze', w.haze[tone][0]);
        overlay.style.opacity = w.haze[tone][1];
    } else {
        overlay.style.opacity = 0;
    }

    // Grayer, flatter map for overcast weather
    const mapEl = document.getElementById('map');
    mapEl.style.transition = 'filter 1.2s ease';
    mapEl.style.filter = (w.look.sat === 1 && w.look.bright === 1)
        ? 'none' : `saturate(${w.look.sat}) brightness(${w.look.bright})`;

    if (w.lightning) startLightning(); else stopLightning();
    applyTheme(); // headlights and beams follow the weather
}

function setSeason(name) {
    season = name;
    const p = SEASONS[name];
    map.setConfigProperty('basemap', 'colorGreenspace', p.greenspace);
    map.setConfigProperty('basemap', 'colorWater', p.water);
    map.setConfigProperty('basemap', 'colorLand', p.land);
    document.querySelectorAll('[data-season]').forEach(b =>
        b.classList.toggle('active', b.dataset.season === name));
    applyWeather(); // seasonal particles depend on the current weather
}

function setWeather(name) {
    weather = name;
    document.querySelectorAll('[data-weather]').forEach(b =>
        b.classList.toggle('active', b.dataset.weather === name));
    applyWeather();
}

document.querySelectorAll('[data-season]').forEach(b =>
    b.addEventListener('click', () => setSeason(b.dataset.season)));
document.querySelectorAll('[data-weather]').forEach(b =>
    b.addEventListener('click', () => setWeather(b.dataset.weather)));

// 3D toggle: buildings and trees on/off, with the camera easing between 3D and top-down
let show3d = true;
document.getElementById('btn-3d').addEventListener('click', e => {
    show3d = !show3d;
    map.setConfigProperty('basemap', 'show3dBuildings', show3d);
    map.setConfigProperty('basemap', 'show3dTrees', show3d);
    e.currentTarget.textContent = show3d ? '3D Buildings On' : '3D Buildings Off';
    e.currentTarget.classList.toggle('active', show3d);
    map.easeTo({ pitch: show3d ? 45 : 0, duration: 800 });
});

// ===========================================================================
// Geometry helpers (local metres <-> degrees)
// ===========================================================================
const M_LAT = 111320;
const M_LNG = 111320 * Math.cos(CENTER[1] * Math.PI / 180);

function haversine(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

// Shift a polyline to the RIGHT of its direction of travel (US right-hand traffic).
function offsetPolyline(coords, offsetM) {
    const pts = coords.filter((c, i) => i === 0 || c[0] !== coords[i - 1][0] || c[1] !== coords[i - 1][1]);
    const n = pts.length;
    const normals = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = (pts[i + 1][0] - pts[i][0]) * M_LNG;
        const dy = (pts[i + 1][1] - pts[i][1]) * M_LAT;
        const len = Math.hypot(dx, dy) || 1;
        normals.push([dy / len, -dx / len]); // right-hand normal (east, north)
    }
    return pts.map((p, i) => {
        const a = normals[Math.max(0, i - 1)];
        const b = normals[Math.min(n - 2, i)];
        let nx = a[0] + b[0], ny = a[1] + b[1];
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        const k = offsetM / Math.max(nx * b[0] + ny * b[1], 0.5); // miter, clamped
        return [p[0] + nx * k / M_LNG, p[1] + ny * k / M_LAT];
    });
}

function buildLane(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    return { coords, cum, length: cum[cum.length - 1], cars: [], signals: [] };
}

// Position at distance s along a lane; extrapolates slightly past either end.
function pointAt(lane, s) {
    const { coords, cum } = lane;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid; else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const t = (s - cum[lo]) / seg;
    return [
        coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
        coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t
    ];
}

// Centre + unit heading (east, north) from a front/rear sample, so vehicles bend through curves.
function pose(lane, s, halfSpan) {
    const a = pointAt(lane, s - halfSpan), b = pointAt(lane, s + halfSpan);
    let fx = (b[0] - a[0]) * M_LNG, fy = (b[1] - a[1]) * M_LAT;
    const l = Math.hypot(fx, fy);
    if (l < 1e-6) { fx = 1; fy = 0; } else { fx /= l; fy /= l; }
    return { c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], fx, fy };
}

// Closed rectangle in vehicle space: a = forward metres, b = right metres.
function quad(c, fx, fy, a0, a1, b0, b1) {
    const rx = fy, ry = -fx;
    const pt = (a, b) => [c[0] + (a * fx + b * rx) / M_LNG, c[1] + (a * fy + b * ry) / M_LAT];
    const ring = [pt(a0, b0), pt(a1, b0), pt(a1, b1), pt(a0, b1)];
    ring.push(ring[0]);
    return [ring];
}

// ===========================================================================
// Traffic signals
// ===========================================================================
const CYCLE_TOTAL = SIGNAL_CYCLE.green + SIGNAL_CYCLE.yellow + SIGNAL_CYCLE.red;

function signalState(sig, tSec) {
    const t = (tSec + sig.phase) % CYCLE_TOTAL;
    if (t < SIGNAL_CYCLE.green) return 'green';
    if (t < SIGNAL_CYCLE.green + SIGNAL_CYCLE.yellow) return 'yellow';
    return 'red';
}

// ===========================================================================
// Traffic model
// ===========================================================================
function pickType() {
    const total = VEHICLE_TYPES.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const t of VEHICLE_TYPES) { if ((r -= t.weight) <= 0) return t; }
    return VEHICLE_TYPES[0];
}

function makeCar(lane, s) {
    const base = pickType();
    const type = { ...base, len: base.len * VEHICLE_SCALE, wid: base.wid * VEHICLE_SCALE };
    const v0 = lane.limit * base.speedFactor * (0.9 + Math.random() * 0.1); // never above the limit
    return {
        type, s, v: v0 * 0.8, v0,
        color: base.colors[Math.floor(Math.random() * base.colors.length)],
        runSig: null
    };
}

async function fetchRoute([a, b]) {
    try {
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.join(',')};${b.join(',')}` +
            `?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`;
        const res = await fetch(url);
        const json = await res.json();
        return json.routes[0].geometry.coordinates;
    } catch (err) {
        console.warn('Directions failed, using straight line', err);
        return [a, b];
    }
}

const EMPTY = { type: 'FeatureCollection', features: [] };
let lanes = [];
let signalFeatures = [];
let lastSignalKey = '';

// Creates a criss-cross pattern covering the current camera viewport
function getViewportWaypoints() {
    const b = map.getBounds();
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const latSpan = ne.lat - sw.lat, lngSpan = ne.lng - sw.lng;
    
    return [
        [[sw.lng, sw.lat + latSpan * 0.3], [ne.lng, sw.lat + latSpan * 0.3]],
        [[sw.lng, sw.lat + latSpan * 0.7], [ne.lng, sw.lat + latSpan * 0.7]],
        [[sw.lng + lngSpan * 0.3, sw.lat], [sw.lng + lngSpan * 0.3, ne.lat]],
        [[sw.lng + lngSpan * 0.7, sw.lat], [sw.lng + lngSpan * 0.7, ne.lat]]
    ];
}

let fetchingTraffic = false;

async function setupTraffic() {
    if (fetchingTraffic) return;
    fetchingTraffic = true;

    // 1. Fetch routes based on current viewport instead of ROUTE_WAYPOINTS
    const waypoints = getViewportWaypoints();
    const routeCoords = await Promise.all(waypoints.map(fetchRoute));

    // Clear old lanes and signals before generating new ones
    lanes = [];
    signalFeatures = [];
    lastSignalKey = '';

    routeCoords.forEach((coords, ri) => {
        [false, true].forEach(reverse => {
            const lane = buildLane(offsetPolyline(reverse ? coords.slice().reverse() : coords, LANE_OFFSET_M));
            lane.limit = LIMITS_MPS[ri % LIMITS_MPS.length];

            SIGNAL_FRACTIONS.forEach((f, k) => {
                const s = (reverse ? 1 - f : f) * lane.length;
                const p = pose(lane, s, 3);
                const rx = p.fy, ry = -p.fx;
                lane.signals.push({
                    s,
                    phase: ri * 7 + k * 11,
                    pos: [p.c[0] + (rx * 3.4) / M_LNG, p.c[1] + (ry * 3.4) / M_LAT]
                });
            });
            lane.signals.sort((a, b) => a.s - b.s);

            lane.baseCount = Math.min(MAX_CARS_PER_LANE, Math.max(3, Math.round(lane.length / 200 * CARS_PER_200M)));
            lane.lastSpawn = 0;
            const count = targetCount(lane);
            const spacing = lane.length / count;
            for (let i = 0; i < count; i++) {
                lane.cars.push(makeCar(lane, i * spacing + Math.random() * spacing * 0.3));
            }
            lanes.push(lane);
        });
    });

    signalFeatures = lanes.flatMap(l => l.signals.map(sig => ({
        type: 'Feature', properties: { color: SIGNAL_COLORS.green },
        geometry: { type: 'Point', coordinates: sig.pos }, sig
    })));

    // 2. Add sources and layers ONLY if they don't exist yet
    if (!map.getSource('vehicles')) {
        map.addSource('beams', { type: 'geojson', data: EMPTY });
        map.addSource('vehicles', { type: 'geojson', data: EMPTY });
        map.addSource('vehicle-lights', { type: 'geojson', data: EMPTY });
        map.addSource('signals', { type: 'geojson', data: EMPTY });

        map.addLayer({
            id: 'beams', type: 'fill', source: 'beams', slot: 'middle',
            paint: { 'fill-color': HEADLIGHT_COLOR, 'fill-opacity': 0, 'fill-emissive-strength': 1 }
        });
        map.addLayer({
            id: 'vehicles', type: 'fill-extrusion', source: 'vehicles', slot: 'middle',
            paint: {
                'fill-extrusion-color': ['get', 'color'],
                'fill-extrusion-base': 0.25,
                'fill-extrusion-height': ['get', 'height'],
                'fill-extrusion-opacity': 0.97,
                'fill-extrusion-emissive-strength': 0
            }
        });
        map.addLayer({
            id: 'vehicle-lights', type: 'fill-extrusion', source: 'vehicle-lights', slot: 'middle',
            paint: {
                'fill-extrusion-color': ['get', 'color'],
                'fill-extrusion-base': 0.45,
                'fill-extrusion-height': 0.85,
                'fill-extrusion-emissive-strength': 0.25
            }
        });
        map.addLayer({
            id: 'signals', type: 'circle', source: 'signals', slot: 'middle',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 18, 6],
                'circle-color': ['get', 'color'],
                'circle-stroke-color': '#1d1d1f',
                'circle-stroke-width': 1,
                'circle-pitch-alignment': 'map',
                'circle-emissive-strength': 1
            }
        });

        applyTheme();
        requestAnimationFrame(frame);
    }

    fetchingTraffic = false;
}

// Intelligent Driver Model: keeps a safe gap, respects the speed limit, brakes smoothly.
const B_COMFORT = 3.0, S0 = 2.0, HEADWAY = 1.5;

function stepLane(lane, dt, tSec) {
    lane.cars.sort((a, b) => b.s - a.s); // leader first

    for (let i = 0; i < lane.cars.length; i++) {
        const car = lane.cars[i];
        const leader = i > 0 ? lane.cars[i - 1] : null;
        let gap = Infinity, dv = 0;

        if (leader) {
            gap = leader.s - car.s - (leader.type.len + car.type.len) / 2;
            dv = car.v - leader.v;
        }

        // Nearest signal still ahead of the front bumper
        const front = car.s + car.type.len / 2;
        const sig = lane.signals.find(sg => sg.s >= front - 0.5);
        if (car.runSig && car.runSig !== sig) car.runSig = null;
        if (sig && car.runSig !== sig) {
            const state = signalState(sig, tSec);
            if (state !== 'green') {
                const dist = sig.s - front;
                const brakeDist = (car.v * car.v) / (2 * (state === 'yellow' ? 3 : 6));
                if (dist >= brakeDist * 0.9) {
                    if (dist < gap) { gap = dist; dv = car.v; } // red light = stationary wall at the stop line
                } else {
                    car.runSig = sig; // too close to stop safely: clear the intersection
                }
            }
        }

        const A = car.type.accel;
        const v0 = car.v0 * weatherSpeed(); // drive slower in rain, snow and fog
        let acc = A * (1 - Math.pow(car.v / v0, 4));
        if (isFinite(gap)) {
            const sStar = S0 + Math.max(0, car.v * HEADWAY * weatherHeadway() + (car.v * dv) / (2 * Math.sqrt(A * B_COMFORT)));
            acc -= A * Math.pow(sStar / Math.max(gap, 0.1), 2);
        }
        acc = Math.max(-9, Math.min(A, acc));
        car.v = Math.max(0, car.v + acc * dt);
        car.s += car.v * dt;
    }

    // Traffic volume follows the theme: cars past the far end either re-enter at the start,
    // or (when there are more cars than the target) leave for good. When there are too few,
    // new cars enter at the start. No pop-in or pop-out happens on screen.
    const target = targetCount(lane);
    for (const car of lane.cars.slice()) {
        if (car.s - car.type.len / 2 > lane.length) {
            if (lane.cars.length > target) {
                lane.cars.splice(lane.cars.indexOf(car), 1);
            } else if (startClearance(lane, car) > car.type.len + 10) {
                car.s = car.type.len / 2;
                car.runSig = null;
            } else {
                car.s = lane.length + car.type.len / 2 + 0.01;
                car.v = 0;
            }
        }
    }

    if (lane.cars.length < target && tSec - lane.lastSpawn > 1.0) {
        const car = makeCar(lane, 0);
        if (startClearance(lane, null) > car.type.len + 16) {
            car.s = car.type.len / 2;
            car.v = car.v0;
            lane.cars.push(car);
            lane.lastSpawn = tSec;
        }
    }
}

// Traffic volume follows the time of day (rush hours busiest, night quietest).
function targetCount(lane) {
    return Math.round(lane.baseCount * PHASES[phase].traffic);
}

// Free road at the lane start: distance from the start to the rear of the nearest car.
function startClearance(lane, exclude) {
    let min = Infinity;
    for (const c of lane.cars) {
        if (c !== exclude && c.s < lane.length) min = Math.min(min, c.s - c.type.len / 2);
    }
    return min;
}

let lastTime = performance.now();

function frame(now) {
    if (!map.getSource('vehicles')) return;
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const tSec = now / 1000;

    const bodies = [], lights = [], beams = [];

    for (const lane of lanes) {
        stepLane(lane, dt, tSec);
        for (const car of lane.cars) {
            if (car.s < 0) continue;
            const { len, wid } = car.type;
            const { c, fx, fy } = pose(lane, car.s, len * 0.35);

            bodies.push({
                type: 'Feature',
                properties: { color: car.color, height: car.type.hgt * 1.15 },
                geometry: { type: 'Polygon', coordinates: quad(c, fx, fy, -len / 2, len / 2, -wid / 2, wid / 2) }
            });

            const hw = wid / 2;
            const lw = Math.min(0.45 * VEHICLE_SCALE, hw * 0.8);
            const isBike = car.type.name === 'motorcycle';
            const sides = isBike ? [[-0.12, 0.12]] : [[hw - lw - 0.05, hw - 0.05], [-(hw - 0.05), -(hw - lw - 0.05)]];
            for (const [b0, b1] of sides) {
                lights.push({
                    type: 'Feature', properties: { color: HEADLIGHT_COLOR },
                    geometry: { type: 'Polygon', coordinates: quad(c, fx, fy, len / 2 - 0.05, len / 2 + 0.2, b0, b1) }
                });
                lights.push({
                    type: 'Feature', properties: { color: TAILLIGHT_COLOR },
                    geometry: { type: 'Polygon', coordinates: quad(c, fx, fy, -len / 2 - 0.2, -len / 2 + 0.05, b0, b1) }
                });
            }

            if (lightsOn()) {
                // Trapezoid beam on the road ahead
                const rx = fy, ry = -fx;
                const pt = (a, b) => [c[0] + (a * fx + b * rx) / M_LNG, c[1] + (a * fy + b * ry) / M_LAT];
                const nearA = len / 2 + 0.2, farA = len / 2 + 12;
                const nearW = Math.max(hw * 0.7, 0.3), farW = isBike ? 2 : 3;
                const ring = [pt(nearA, -nearW), pt(farA, -farW), pt(farA, farW), pt(nearA, nearW)];
                ring.push(ring[0]);
                beams.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
            }
        }
    }

    map.getSource('vehicles').setData({ type: 'FeatureCollection', features: bodies });
    map.getSource('vehicle-lights').setData({ type: 'FeatureCollection', features: lights });
    map.getSource('beams').setData({ type: 'FeatureCollection', features: beams });

    // Signal lamps only need updating when a phase changes
    const states = signalFeatures.map(f => signalState(f.sig, tSec));
    const key = states.join(',');
    if (key !== lastSignalKey) {
        lastSignalKey = key;
        signalFeatures.forEach((f, i) => { f.properties.color = SIGNAL_COLORS[states[i]]; });
        map.getSource('signals').setData({
            type: 'FeatureCollection',
            features: signalFeatures.map(f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry }))
        });
    }

    requestAnimationFrame(frame);
}

// ===========================================================================
// Before / after compare
// A second, default Mapbox Standard map sits on top of the main map and is clipped to the
// left of a draggable divider. Its camera mirrors the main map, so panning, zooming and the
// tour all reveal the same place in both styles. It is created on demand and destroyed
// again when hidden, so it costs nothing while off.
// ===========================================================================
const cmpLayer = document.getElementById('compare-layer');
const cmpDivider = document.getElementById('compare-divider');
const cmpTagRight = document.getElementById('compare-tag-right');
const cmpBtn = document.getElementById('btn-compare');
let split = 50; // percent of the screen width shown as "default"

function setSplit(pct) {
    split = Math.max(4, Math.min(96, pct));
    document.documentElement.style.setProperty('--split', split + '%');
    cmpDivider.setAttribute('aria-valuenow', String(Math.round(split)));
}

function syncCompare() {
    if (!compareMap) return;
    compareMap.jumpTo({
        center: map.getCenter(), zoom: map.getZoom(),
        bearing: map.getBearing(), pitch: map.getPitch()
    });
}
map.on('move', syncCompare);

function setCompare(on) {
    if (on === (compareMap !== null)) return;
    cmpBtn.classList.toggle('active', on);
    cmpBtn.textContent = on ? 'Hide comparison' : 'Compare with default style';
    cmpLayer.hidden = !on;
    cmpDivider.hidden = !on;
    cmpTagRight.hidden = !on;

    if (on) {
        setSplit(split);
        compareMap = new mapboxgl.Map({
            container: 'compare-map',
            style: 'mapbox://styles/mapbox/standard',
            center: map.getCenter(), zoom: map.getZoom(),
            bearing: map.getBearing(), pitch: map.getPitch(),
            interactive: false,
            antialias: false,
            config: { basemap: { lightPreset: phase } } // same time of day, so only the design differs
        });
    } else {
        compareMap.remove();
        compareMap = null;
    }
}

cmpBtn.addEventListener('click', () => setCompare(compareMap === null));

let draggingSplit = false;
cmpDivider.addEventListener('pointerdown', e => {
    draggingSplit = true;
    cmpDivider.setPointerCapture(e.pointerId);
    e.preventDefault();
});
cmpDivider.addEventListener('pointermove', e => {
    if (draggingSplit) setSplit((e.clientX / window.innerWidth) * 100);
});
['pointerup', 'pointercancel'].forEach(type =>
    cmpDivider.addEventListener(type, () => { draggingSplit = false; }));
cmpDivider.addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') setSplit(split - step);
    else if (e.key === 'ArrowRight') setSplit(split + step);
    else if (e.key === 'Home') setSplit(4);
    else if (e.key === 'End') setSplit(96);
    else return;
    e.preventDefault();
});

// ===========================================================================
// Guided tour
// Each stop flies the camera, sets the time of day and shows a caption. The tour advances on
// its own (fly time + dwell time); Back, Next, Pause and End take over. Dragging, rotating or
// scrolling the map ends it, and the time of day you started with is restored.
// ===========================================================================
const HOME = { center: CENTER, zoom: 16, pitch: 45, bearing: -17.6 };

const TOUR = [
    { title: 'The Ring', time: 'day', flight: 5000, dwell: 6000,
      cam: { center: CENTER, zoom: 16.3, pitch: 58, bearing: -17.6 },
      text: 'A circular building is a good stress test for a basemap: curved footprints, dense tree cover and a clear road hierarchy around it. Seasons recolor the greenspace, water and land.' },
    { title: 'Plan view', time: 'day', flight: 4500, dwell: 5500,
      cam: { center: CENTER, zoom: 17, pitch: 0, bearing: 0 },
      text: 'Straight down, the map reads as a plan drawing. Road widths, tree texture and building tone separate the campus from its surroundings.' },
    { title: 'Steve Jobs Theater', time: 'dusk', flight: 6000, dwell: 6000,
      cam: { center: [-122.007599, 37.330853], zoom: 17.7, pitch: 62, bearing: -35 },
      text: 'A glass cylinder under a thin carbon-fiber roof, opened in 2017. At dusk the lighting preset warms the scene and vehicles switch their headlights on.' },
    { title: 'After dark', time: 'night', flight: 5500, dwell: 7000,
      cam: { center: CENTER, zoom: 17, pitch: 68, bearing: 120 },
      text: 'Night lighting with emissive windows, headlight beams and vehicles that keep their true paint colors. Traffic keeps right, follows the speed limit and stops at red signals.' },
    { title: 'Infinite Loop', time: 'dawn', flight: 7500, dwell: 6000,
      cam: { center: [-122.03118, 37.33182], zoom: 16.5, pitch: 50, bearing: 20 },
      text: 'Apple\u2019s headquarters from 1997 until Apple Park opened in 2017, about 2 km west of the Ring. The camera ends in soft dawn light.' }
];

const tourCard = document.getElementById('tour-card');
const tourBtn = document.getElementById('btn-tour');
const tourBar = document.getElementById('tour-bar');
const tourPrev = document.getElementById('tour-prev');
const tourNext = document.getElementById('tour-next');
const tourPause = document.getElementById('tour-pause');
const tourDots = document.getElementById('tour-dots');
const tour = { active: false, i: 0, timer: null, paused: false, restore: null };

TOUR.forEach(() => tourDots.appendChild(document.createElement('i')));

function tourRestartBar(ms) {
    tourBar.style.animation = 'none';
    void tourBar.offsetWidth; // force reflow so the animation restarts
    tourBar.style.animation = `tour-bar ${ms}ms linear forwards`;
    tourBar.style.animationPlayState = tour.paused ? 'paused' : 'running';
}

function tourSchedule(ms) {
    clearTimeout(tour.timer);
    tour.timer = setTimeout(() => {
        if (tour.i >= TOUR.length - 1) tourEnd(true); else tourGo(tour.i + 1);
    }, ms);
}

function tourGo(i) {
    tour.i = Math.max(0, Math.min(TOUR.length - 1, i));
    const s = TOUR[tour.i];
    const last = tour.i === TOUR.length - 1;

    document.getElementById('tour-count').textContent = `${tour.i + 1} / ${TOUR.length}`;
    document.getElementById('tour-title').textContent = s.title;
    document.getElementById('tour-text').textContent = s.text;
    [...tourDots.children].forEach((d, k) => d.classList.toggle('on', k === tour.i));
    tourPrev.disabled = tour.i === 0;
    tourNext.textContent = last ? 'Finish' : 'Next';

    setTimeOfDay(s.time);
    // essential:false means people who prefer reduced motion get a jump instead of a flight
    map.flyTo({ ...s.cam, duration: s.flight, curve: 1.6, essential: false });

    const total = s.flight + s.dwell;
    tourRestartBar(total);
    if (!tour.paused) tourSchedule(total);
}

function tourStart() {
    if (tour.active) return;
    tour.active = true;
    tour.paused = false;
    tour.restore = phase;
    stopCycle();
    tourPause.textContent = 'Pause';
    tourCard.hidden = false;
    tourBtn.classList.add('active');
    tourBtn.textContent = 'End tour';
    tourGo(0);
}

function tourEnd(returnHome) {
    if (!tour.active) return;
    clearTimeout(tour.timer);
    tour.active = false;
    tourCard.hidden = true;
    tourBtn.classList.remove('active');
    tourBtn.textContent = 'Start guided tour';
    setTimeOfDay(tour.restore);
    if (returnHome) map.flyTo({ ...HOME, duration: 4000, essential: false });
}

tourBtn.addEventListener('click', () => (tour.active ? tourEnd(false) : tourStart()));
tourPrev.addEventListener('click', () => tourGo(tour.i - 1));
tourNext.addEventListener('click', () => {
    if (tour.i >= TOUR.length - 1) tourEnd(true); else tourGo(tour.i + 1);
});
document.getElementById('tour-close').addEventListener('click', () => tourEnd(false));
tourPause.addEventListener('click', () => {
    tour.paused = !tour.paused;
    tourPause.textContent = tour.paused ? 'Resume' : 'Pause';
    if (tour.paused) {
        clearTimeout(tour.timer);
        tourBar.style.animationPlayState = 'paused';
    } else {
        const dwell = TOUR[tour.i].dwell;
        tourRestartBar(dwell);
        tourSchedule(dwell);
    }
});

// Programmatic camera moves also emit these events, but only real input carries originalEvent.
['dragstart', 'rotatestart', 'pitchstart', 'zoomstart'].forEach(type =>
    map.on(type, e => { if (tour.active && e.originalEvent) tourEnd(false); }));
map.on('wheel', () => { if (tour.active) tourEnd(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') tourEnd(false); });

let moveTimer = null;

map.on('moveend', () => {
    // Optional: Only spawn traffic if zoomed in close enough to see the cars
    if (map.getZoom() < 14) return;

    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
        // Fade out existing geojson to prevent ghost cars flashing
        if (map.getSource('vehicles')) {
            map.getSource('vehicles').setData(EMPTY);
            map.getSource('vehicle-lights').setData(EMPTY);
            map.getSource('beams').setData(EMPTY);
            map.getSource('signals').setData(EMPTY);
        }
        setupTraffic();
    }, 800);
});

map.once('style.load', () => {
    setTimeOfDay('night');
    setSeason(season);
    setWeather(weather);
    setupTraffic();
});