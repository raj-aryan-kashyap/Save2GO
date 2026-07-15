// map.js — production build, no mock/debug overrides

function setupV4TwoFingerRotationListeners() {
    if (!ENABLE_MAP_ROTATION) return;
    const targetElement = document.getElementById('map-render-element');
    if (!targetElement) return;

    let initialTouchAngle = 0;
    let baseBearingAngleOnTouchStart = 0;
    let processingRotationActive = false;

    targetElement.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            processingRotationActive = true;
            baseBearingAngleOnTouchStart = currentMapBearingAngle;
            initialTouchAngle = Math.atan2(
                e.touches[1].pageY - e.touches[0].pageY,
                e.touches[1].pageX - e.touches[0].pageX
            ) * 180 / Math.PI;
        }
    }, { passive: true });

    targetElement.addEventListener('touchmove', (e) => {
        if (processingRotationActive && e.touches.length === 2) {
            const currentTouchAngle = Math.atan2(
                e.touches[1].pageY - e.touches[0].pageY,
                e.touches[1].pageX - e.touches[0].pageX
            ) * 180 / Math.PI;
            
            const angleDelta = currentTouchAngle - initialTouchAngle;
            currentMapBearingAngle = (baseBearingAngleOnTouchStart + angleDelta) % 360;
            
            const pane = document.querySelector('.leaflet-map-pane');
            if (pane) {
                pane.style.transform = `rotate(${currentMapBearingAngle}deg)`;
            }

            const innerCompassIcon = document.getElementById('innerCompassEmojiSpinnerSpan');
            if (innerCompassIcon) {
                innerCompassIcon.style.transform = `rotate(${-currentMapBearingAngle}deg)`;
            }
        }
    }, { passive: true });

    targetElement.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
            processingRotationActive = false;
        }
    }, { passive: true });
}

// ── City-centre geocode fallback ─────────────────────────────────────────────
// Spots with missing lat/lon are placed at their city centre so they still
// appear on the map and are included in bounds-fitting.  The spot's own data
// is never mutated — the fallback coord lives only in this cache.
//
// API: OpenStreetMap Nominatim — free, no key required, 1 req/s rate limit.
// Cache is persisted to localStorage so offline sessions never re-fetch.
// ─────────────────────────────────────────────────────────────────────────────

const cityCenterCache = new Map(
    Object.entries(JSON.parse(localStorage.getItem('compass_city_centers') || '{}'))
);

// Hardcoded city-centre coordinates for common travel destinations.
// These seed the cache synchronously at parse time so spots with missing
// coordinates in these cities resolve immediately on the first render —
// no network request required.  Nominatim still handles cities not listed here.
const _CITY_CENTER_DEFAULTS = {
    'paris':           { lat:  48.8566, lon:   2.3522 },
    'london':          { lat:  51.5074, lon:  -0.1278 },
    'new york':        { lat:  40.7128, lon: -74.0060 },
    'new york city':   { lat:  40.7128, lon: -74.0060 },
    'nyc':             { lat:  40.7128, lon: -74.0060 },
    'los angeles':     { lat:  34.0522, lon:-118.2437 },
    'chicago':         { lat:  41.8781, lon: -87.6298 },
    'san francisco':   { lat:  37.7749, lon:-122.4194 },
    'miami':           { lat:  25.7617, lon: -80.1918 },
    'las vegas':       { lat:  36.1699, lon:-115.1398 },
    'boston':          { lat:  42.3601, lon: -71.0589 },
    'seattle':         { lat:  47.6062, lon:-122.3321 },
    'washington':      { lat:  38.9072, lon: -77.0369 },
    'washington dc':   { lat:  38.9072, lon: -77.0369 },
    'toronto':         { lat:  43.6532, lon: -79.3832 },
    'vancouver':       { lat:  49.2827, lon:-123.1207 },
    'montreal':        { lat:  45.5017, lon: -73.5673 },
    'mexico city':     { lat:  19.4326, lon: -99.1332 },
    'buenos aires':    { lat: -34.6037, lon: -58.3816 },
    'rio de janeiro':  { lat: -22.9068, lon: -43.1729 },
    'sao paulo':       { lat: -23.5505, lon: -46.6333 },
    'lima':            { lat: -12.0464, lon: -77.0428 },
    'bogota':          { lat:   4.7110, lon: -74.0721 },
    'rome':            { lat:  41.9028, lon:  12.4964 },
    'milan':           { lat:  45.4654, lon:   9.1859 },
    'florence':        { lat:  43.7696, lon:  11.2558 },
    'venice':          { lat:  45.4408, lon:  12.3155 },
    'naples':          { lat:  40.8518, lon:  14.2681 },
    'barcelona':       { lat:  41.3851, lon:   2.1734 },
    'madrid':          { lat:  40.4168, lon:  -3.7038 },
    'seville':         { lat:  37.3891, lon:  -5.9845 },
    'berlin':          { lat:  52.5200, lon:  13.4050 },
    'munich':          { lat:  48.1351, lon:  11.5820 },
    'hamburg':         { lat:  53.5753, lon:   9.9954 },
    'amsterdam':       { lat:  52.3676, lon:   4.9041 },
    'brussels':        { lat:  50.8503, lon:   4.3517 },
    'zurich':          { lat:  47.3769, lon:   8.5417 },
    'geneva':          { lat:  46.2044, lon:   6.1432 },
    'vienna':          { lat:  48.2082, lon:  16.3738 },
    'prague':          { lat:  50.0755, lon:  14.4378 },
    'budapest':        { lat:  47.4979, lon:  19.0402 },
    'warsaw':          { lat:  52.2297, lon:  21.0122 },
    'lisbon':          { lat:  38.7223, lon:  -9.1393 },
    'porto':           { lat:  41.1579, lon:  -8.6291 },
    'athens':          { lat:  37.9838, lon:  23.7275 },
    'stockholm':       { lat:  59.3293, lon:  18.0686 },
    'oslo':            { lat:  59.9139, lon:  10.7522 },
    'copenhagen':      { lat:  55.6761, lon:  12.5683 },
    'helsinki':        { lat:  60.1699, lon:  24.9384 },
    'reykjavik':       { lat:  64.1466, lon: -21.9426 },
    'moscow':          { lat:  55.7558, lon:  37.6173 },
    'istanbul':        { lat:  41.0082, lon:  28.9784 },
    'dubai':           { lat:  25.2048, lon:  55.2708 },
    'abu dhabi':       { lat:  24.4539, lon:  54.3773 },
    'doha':            { lat:  25.2854, lon:  51.5310 },
    'riyadh':          { lat:  24.7136, lon:  46.6753 },
    'tel aviv':        { lat:  32.0853, lon:  34.7818 },
    'jerusalem':       { lat:  31.7683, lon:  35.2137 },
    'cairo':           { lat:  30.0444, lon:  31.2357 },
    'marrakech':       { lat:  31.6295, lon:  -7.9811 },
    'casablanca':      { lat:  33.5731, lon:  -7.5898 },
    'nairobi':         { lat:  -1.2921, lon:  36.8219 },
    'cape town':       { lat: -33.9249, lon:  18.4241 },
    'johannesburg':    { lat: -26.2041, lon:  28.0473 },
    'mumbai':          { lat:  19.0760, lon:  72.8777 },
    'delhi':           { lat:  28.7041, lon:  77.1025 },
    'new delhi':       { lat:  28.6139, lon:  77.2090 },
    'bangalore':       { lat:  12.9716, lon:  77.5946 },
    'kolkata':         { lat:  22.5726, lon:  88.3639 },
    'chennai':         { lat:  13.0827, lon:  80.2707 },
    'beijing':         { lat:  39.9042, lon: 116.4074 },
    'shanghai':        { lat:  31.2304, lon: 121.4737 },
    'hong kong':       { lat:  22.3193, lon: 114.1694 },
    'tokyo':           { lat:  35.6762, lon: 139.6503 },
    'osaka':           { lat:  34.6937, lon: 135.5023 },
    'kyoto':           { lat:  35.0116, lon: 135.7681 },
    'seoul':           { lat:  37.5665, lon: 126.9780 },
    'taipei':          { lat:  25.0330, lon: 121.5654 },
    'singapore':       { lat:   1.3521, lon: 103.8198 },
    'kuala lumpur':    { lat:   3.1390, lon: 101.6869 },
    'bangkok':         { lat:  13.7563, lon: 100.5018 },
    'bali':            { lat:  -8.4095, lon: 115.1889 },
    'jakarta':         { lat:  -6.2088, lon: 106.8456 },
    'ho chi minh':     { lat:  10.8231, lon: 106.6297 },
    'ho chi minh city':{ lat:  10.8231, lon: 106.6297 },
    'hanoi':           { lat:  21.0285, lon: 105.8542 },
    'phnom penh':      { lat:  11.5564, lon: 104.9282 },
    'yangon':          { lat:  16.8661, lon:  96.1951 },
    'colombo':         { lat:   6.9271, lon:  79.8612 },
    'kathmandu':       { lat:  27.7172, lon:  85.3240 },
    'sydney':          { lat: -33.8688, lon: 151.2093 },
    'melbourne':       { lat: -37.8136, lon: 144.9631 },
    'brisbane':        { lat: -27.4698, lon: 153.0251 },
    'auckland':        { lat: -36.8509, lon: 174.7645 },
};
// Pre-seed the cache from defaults so common cities resolve synchronously
// on the very first render — entries already in localStorage take priority
// (they may have been refined by a prior Nominatim fetch).
Object.entries(_CITY_CENTER_DEFAULTS).forEach(([key, coords]) => {
    if (!cityCenterCache.has(key)) cityCenterCache.set(key, coords);
});

/**
 * Returns { lat, lon } for a spot using real coordinates if valid,
 * or the cached city-centre if not.  Returns null if neither is available.
 * The spot object is never mutated.
 */
function _resolveSpotCoords(spot) {
    const rawLat = String(spot.latitude  || '').trim();
    const rawLon = String(spot.longitude || '').trim();
    const lat    = parseFloat(rawLat);
    const lon    = parseFloat(rawLon);
    const isReal = rawLat !== '' && rawLat !== '0' &&
                   !isNaN(lat) && !isNaN(lon) && !(lat === 0 && lon === 0);
    if (isReal) return { lat, lon };

    // Fallback: city-centre from cache
    if (spot.city && spot.city.trim()) {
        const cc = cityCenterCache.get(spot.city.trim().toLowerCase());
        if (cc) return { lat: cc.lat, lon: cc.lon };
    }
    return null;
}

/**
 * Fetch the geographic centre of a city via Nominatim and cache the result.
 * Safe to call concurrently — duplicate in-flight requests for the same city
 * are deduplicated by checking the cache before and after the await.
 */
async function fetchAndCacheCityCenter(city) {
    if (!city || !city.trim()) return null;
    const key = city.trim().toLowerCase();
    if (cityCenterCache.has(key)) return cityCenterCache.get(key);
    try {
        const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Save2Go/5.0 travel-app (raj.aryan@miniclip.com)' } });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data.length) return null;
        const coords = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
        if (isNaN(coords.lat) || isNaN(coords.lon)) return null;
        cityCenterCache.set(key, coords);
        // Persist so the next session skips the network call.
        const stored = {};
        cityCenterCache.forEach((v, k) => { stored[k] = v; });
        localStorage.setItem('compass_city_centers', JSON.stringify(stored));
        return coords;
    } catch (_) { return null; }
}

/**
 * Collect every city that has at least one spot with missing coordinates
 * and whose centre isn't cached yet, then fetch them one-by-one respecting
 * Nominatim's 1-request-per-second policy.
 * Re-renders map markers once all fetches are done (only if anything was fetched).
 */
let _prefetchRunning = false;
// True while the map detail tray is open — suppresses all programmatic
// viewport changes (fitBounds / setView) so the user's zoom level is preserved.
let _mapDetailTrayVisible = false;
// Snapshot of { center: LatLng, zoom: number } taken when the tray opens.
// Restored exactly on dismiss so async callbacks can never shift the viewport.
let _savedMapViewForTray = null;
async function prefetchMissingCityCenters() {
    if (_prefetchRunning) return;
    if (typeof travelSpots === 'undefined') return;

    const needsGeocode = new Set();
    travelSpots.forEach(spot => {
        // Use the same validity test as _resolveSpotCoords so the two are always in sync.
        const rawLat = String(spot.latitude  || '').trim();
        const rawLon = String(spot.longitude || '').trim();
        const lat    = parseFloat(rawLat);
        const lon    = parseFloat(rawLon);
        const isReal = rawLat !== '' && rawLat !== '0' &&
                       !isNaN(lat) && !isNaN(lon) && !(lat === 0 && lon === 0);
        if (!isReal && spot.city && spot.city.trim()) {
            const key = spot.city.trim().toLowerCase();
            if (!cityCenterCache.has(key)) needsGeocode.add(spot.city.trim());
        }
    });
    if (needsGeocode.size === 0) return;

    _prefetchRunning = true;
    const _cityList = [...needsGeocode];
    for (let _i = 0; _i < _cityList.length; _i++) {
        await fetchAndCacheCityCenter(_cityList[_i]);
        // Respect Nominatim's 1 req/s limit — but skip the wait after the last request
        // so the re-render fires immediately once all cities are resolved.
        if (_i < _cityList.length - 1) {
            await new Promise(r => setTimeout(r, 1100));
        }
    }
    _prefetchRunning = false;

    // Re-render markers with the newly cached city-centre coordinates.
    if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();

    // If the user is already on the map tab with a city filter active, re-fit the
    // viewport so the fallback-coord pins are actually visible on screen.
    // Skip if the detail tray is open — a programmatic zoom while the tray is
    // visible would jar the user and lose their hand-chosen zoom level.
    if (!_mapDetailTrayVisible &&
        typeof activeTabID !== 'undefined' && activeTabID === 'map' &&
        typeof checkedCitiesStateArray !== 'undefined' && checkedCitiesStateArray.length > 0 &&
        typeof snapMapViewportToSelectedCityBounds === 'function') {
        snapMapViewportToSelectedCityBounds(null);
    }
}

function calculateDefaultMapCenterCity() {
    if (!travelSpots || travelSpots.length === 0) return null;

    let cityDensityCounterMap = {};
    let highestFrequencyFound = 0;
    let candidatePoolList = [];

    travelSpots.forEach(spot => {
        if (!spot.city || !spot.latitude || String(spot.latitude).trim() === "0") return;
        const nameKey = spot.city.trim();
        cityDensityCounterMap[nameKey] = (cityDensityCounterMap[nameKey] || 0) + 1;
        
        if (cityDensityCounterMap[nameKey] > highestFrequencyFound) {
            highestFrequencyFound = cityDensityCounterMap[nameKey];
        }
    });

    for (let cityName in cityDensityCounterMap) {
        if (cityDensityCounterMap[cityName] === highestFrequencyFound) {
            candidatePoolList.push(cityName);
        }
    }

    if (candidatePoolList.length === 0) return null;
    
    const pickedCityName = candidatePoolList[Math.floor(Math.random() * candidatePoolList.length)];
    // Return the first spot of the chosen city that has valid non-zero coordinates.
    // travelSpots.find (without this guard) would return the first row for the city,
    // which may have latitude/longitude "0" (Google Sheets default) — that resolves
    // to Null Island [0, 0] in the Gulf of Guinea and corrupts the initial viewport.
    return travelSpots.find(s =>
        s.city === pickedCityName &&
        s.latitude  && String(s.latitude).trim()  !== "0" &&
        s.longitude && String(s.longitude).trim() !== "0"
    );
}

// ── Map Viewport Priority Resolver ───────────────────────────────────────────
// Priority 1: Last active saved view (localStorage)
// Priority 2: Most-frequent city in the database
// Priority 3: Lisbon city-centre cold-boot fallback
function resolveInitialMapViewState() {
    const rawLat  = localStorage.getItem('compass_map_state_lat');
    const rawLng  = localStorage.getItem('compass_map_state_lng');
    const rawZoom = localStorage.getItem('compass_map_state_zoom');

    if (rawLat && rawLng && rawZoom) {
        const lat = parseFloat(rawLat), lng = parseFloat(rawLng), zoom = parseInt(rawZoom, 10);
        // Also reject [0, 0] — Null Island can be written to localStorage if a spot
        // with missing coordinates was previously used as the default view.
        const isNullIsland = (lat === 0 && lng === 0);
        if (!isNaN(lat) && !isNaN(lng) && !isNaN(zoom) && zoom >= 1 && zoom <= 20 && !isNullIsland) {
            return { lat, lng, zoom };
        }
    }

    const cityRecord = calculateDefaultMapCenterCity();
    if (cityRecord) {
        const lat = parseFloat(cityRecord.latitude), lng = parseFloat(cityRecord.longitude);
        // Guard: calculateDefaultMapCenterCity now guarantees non-zero coords on the
        // returned spot, but validate here as a belt-and-suspenders check.
        if (!isNaN(lat) && !isNaN(lng) && !(lat === 0 && lng === 0)) {
            return { lat, lng, zoom: 12 };
        }
    }

    // Global fallback: Lisbon city centre
    return { lat: 38.7223, lng: -9.1393, zoom: 12 };
}

function triggerOptimalLandingViewportRecalculation() {
    if (!leafletMapInstance) return;
    const view = resolveInitialMapViewState();
    leafletMapInstance.setView([view.lat, view.lng], view.zoom, { reset: true });
}

function initLeafletMapEngineCanvas() {
    if (leafletMapInstance) return;

    // Resolve correct starting view BEFORE creating the map so tiles load at
    // the right location immediately — no viewport flash or wasted tile fetches
    const initialView = resolveInitialMapViewState();

    leafletMapInstance = L.map('map-render-element', {
        zoomControl: false,
        attributionControl: false,
        touchRotate: true,
        rotate: true,
        bounceAtZoomLimits: false,
        fadeAnimation: false
    }).setView([initialView.lat, initialView.lng], initialView.zoom);

    setMapBaseLayerProviderSource(currentMapStyleKey);
    mapMarkersLayerGroup = L.layerGroup().addTo(leafletMapInstance);

    // Ensure the map fills its container from the first rendered frame
    window.requestAnimationFrame(() => leafletMapInstance.invalidateSize({ animate: false }));

    leafletMapInstance.on('movestart zoomstart dragstart', () => {
        document.getElementById('mapLayerStyleDropdownDeck')?.classList.add('hidden');
    });

    // Break camera-follow lock the moment the user starts a manual drag.
    // Uses dragstart (not movestart) so programmatic setView/panTo calls — which
    // also fire movestart — never accidentally unlock the camera.
    leafletMapInstance.on('dragstart', () => {
        if (isCameraLocked) {
            isCameraLocked = false;
            syncCameraLockVisualUIState();
        }
    });

    leafletMapInstance.on('moveend zoomend viewreset animationend', () => {
        if (!leafletMapInstance) return;
        const zoom   = leafletMapInstance.getZoom();
        const center = leafletMapInstance.getCenter();
        const debugNode = document.getElementById('mapZoomDebugHUD');
        if (debugNode) debugNode.innerText = `Zoom: ${zoom}`;

        // Continuously persist the active view so the next launch resumes here
        localStorage.setItem('compass_map_state_lat',  center.lat);
        localStorage.setItem('compass_map_state_lng',  center.lng);
        localStorage.setItem('compass_map_state_zoom', String(zoom));

        if (travelSpots.length > 0) {
            window.requestAnimationFrame(() => plotDynamicMarkersOnCanvasMap());
        }

        if (mapTileCleanupTimerId) clearTimeout(mapTileCleanupTimerId);
        mapTileCleanupTimerId = setTimeout(() => {
            if (activeBaseTileLayer?._pruneTiles) activeBaseTileLayer._pruneTiles();
        }, 10000);

    });

    // Initial weather fetch — resolves GPS / localStorage / fallback
    // Width sync runs slightly after so the style button has fully rendered
    setTimeout(() => { _syncWeatherWidgetWidth(); refreshMapWeatherWidget(); }, 600);

    // Restore any route that was active before the last page refresh.
    // Uses a short delay so Leaflet panes and layers are fully initialized.
    setTimeout(_rteRestoreFromStorage, 900);

    // ── Calibration canvas dismiss ────────────────────────────────────────────
    // Waits for the tile layer's load event (all current-viewport tiles ready),
    // then holds a 350 ms settle buffer so the user sees a fully-rendered map
    // when the curtain lifts — not a half-loaded canvas.
    // Hard maximum: 3 s in case tiles are slow or the device is offline.
    let calibrationDismissed = false;
    const dismissCalibrationScreen = () => {
        if (calibrationDismissed) return;
        calibrationDismissed = true;

        // 350 ms tile-settle buffer
        setTimeout(() => {
            const el = document.getElementById('mapCanvasWarmupLoader');
            if (!el || el.style.display === 'none') return;
            el.style.pointerEvents = 'none';
            el.style.touchAction   = 'auto';
            el.style.transition    = 'opacity 0.5s ease';
            el.style.opacity       = '0';
            setTimeout(() => {
                el.style.display       = 'none';
                el.style.pointerEvents = 'none';
            }, 550);
        }, 350);
    };

    if (activeBaseTileLayer) activeBaseTileLayer.once('load', dismissCalibrationScreen);
    setTimeout(dismissCalibrationScreen, 3000); // hard max safety net

    const debugNode = document.getElementById('mapZoomDebugHUD');
    if (debugNode) debugNode.innerText = `Zoom: ${leafletMapInstance.getZoom()}`;
}

function setMapBaseLayerProviderSource(styleKey) {
    if(!leafletMapInstance) return;
    if(activeBaseTileLayer) leafletMapInstance.removeLayer(activeBaseTileLayer);

    let providerUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    
    let attributionMeta = { 
        maxZoom: 20,
        preload: true,
        keepBuffer: 4, 
        updateWhenIdle: false, 
        updateWhenZooming: false
    };
    let visibleLabel = "Style: Dark";

    if(styleKey === 'light') {
        providerUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
        visibleLabel = "Style: Light";
    } else if(styleKey === 'terrain') {
        providerUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        visibleLabel = "Style: Terrain";
    } else if(styleKey === 'satellite') {
        providerUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
        attributionMeta.maxZoom = 18;
        visibleLabel = "Style: Sat";
    }

    activeBaseTileLayer = L.tileLayer(providerUrl, attributionMeta).addTo(leafletMapInstance);
    currentMapStyleKey = styleKey;
    localStorage.setItem('compass_map_style', styleKey);

    // Match the map container background to the incoming tile palette so that
    // any tiles still loading (including after recenter) show a colour-matched
    // placeholder rather than the default dark background — eliminating the
    // stark black-patch artefact that is most visible on the Light style.
    const mapEl = document.getElementById('map-render-element');
    if (mapEl) {
        const bgColour = styleKey === 'light'   ? '#f2f2f0'  // CartoCDN light_all land colour
                       : styleKey === 'terrain' ? '#e0d7c7'  // CartoCDN Voyager land colour
                       : styleKey === 'satellite' ? '#000000' // satellite imagery is black
                       :                           '#1a1a2e'; // dark_all
        mapEl.style.backgroundColor = bgColour;
    }

    const displayLabelNode = document.getElementById('activeLayerDisplayLabel');
    if(displayLabelNode) displayLabelNode.innerText = visibleLabel;

    ['dark', 'light', 'terrain', 'satellite'].forEach(k => {
        const card = document.getElementById(`styleCard-${k}`);
        if(card) {
            if(k === styleKey) {
                card.className = "flex flex-col items-center gap-1 p-1 bg-slate-900 rounded-xl border-2 border-pink-500 shadow-lg scale-105 transform duration-150";
            } else {
                card.className = "flex flex-col items-center gap-1 p-1 bg-slate-950 rounded-xl border border-slate-800/80 hover:bg-slate-900 transition-all duration-150 opacity-70";
            }
        }
    });

    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if(deck) deck.classList.add('hidden');

    if (mapMarkersLayerGroup && travelSpots.length > 0) {
        plotDynamicMarkersOnCanvasMap();
    }

    // Re-sync weather widget width in case new label changed button width
    requestAnimationFrame(_syncWeatherWidgetWidth);
}

function updateGpsHudStatus(statusKey, labelText) {
    const btn       = document.getElementById('gpsBadgeButton');
    const iconFrame = document.getElementById('gpsIconFrame');
    const textFrame = document.getElementById('gpsBadgeText');
    if (!btn || !iconFrame || !textFrame) return;

    // Use the provided label; fall back to sensible defaults per state
    textFrame.innerText = labelText
        || (statusKey === 'active'  ? 'GPS Active'
          : statusKey === 'syncing' ? 'GPS Syncing...'
          :                           'GPS Off');

    // ── Compact inline style (fits inside the 16 px HUD cycle slot) ──────────
    // Colours are applied on the button element so they inherit to both children.
    // The 'emerald' token is used by _hudCanCycle() in aap.js to detect
    // GPS-active state — do not remove it without updating that check.
    // Base chrome classes shared across all states (pill chip feel)
    const _btnBase = "flex items-center gap-1.5 cursor-pointer rounded px-1.5 py-px bg-slate-800/60 border transition-colors active:bg-slate-700/80";
    if (statusKey === 'active') {
        btn.className   = `${_btnBase} text-emerald-400 border-emerald-900/40`;
        iconFrame.innerHTML = '<i class="fa-solid fa-location-crosshairs text-[9px]"></i>';
    } else if (statusKey === 'syncing') {
        btn.className   = `${_btnBase} text-amber-400 border-amber-900/40`;
        iconFrame.innerHTML = '<i class="fa-solid fa-location-crosshairs text-[9px] subtle-gps-pulse"></i>';
    } else {
        btn.className   = `${_btnBase} text-red-400 border-red-900/40`;
        iconFrame.innerHTML = '<i class="fa-solid fa-location-crosshairs text-[9px]"></i>';
    }

    // Notify the HUD cycle controller so it can persist or resume cycling
    if (typeof onHudGpsStateChange === 'function') onHudGpsStateChange();
}

/**
 * Populates and opens the GPS error modal with content appropriate for the
 * given error type:
 *   'permission_denied' — user blocked location; needs to change OS/browser settings
 *   'signal_timeout'    — GPS fix timed out; Retry button re-pings
 *   'unavailable'       — position unavailable (indoor, no satellite); Retry button
 */
function _showGpsErrorModal(errorType) {
    const modal = document.getElementById('gpsInstructionsOverlayModal');
    if (!modal) return;

    const iconEl  = document.getElementById('gpsModalIcon');
    const titleEl = document.getElementById('gpsModalTitle');
    const msgEl   = document.getElementById('gpsModalMessage');
    const btnEl   = document.getElementById('gpsModalPrimaryBtn');

    // Graceful fallback: if injectable slots are missing just show the modal as-is
    if (!iconEl || !titleEl || !msgEl || !btnEl) {
        modal.classList.remove('hidden');
        return;
    }

    if (errorType === 'permission_denied') {
        iconEl.className      = 'text-3xl text-red-500';
        iconEl.innerHTML      = '<i class="fa-solid fa-ban"></i>';
        titleEl.textContent   = 'Location Access Blocked';
        msgEl.textContent     = 'Location permission denied. Please enable it in your device settings and try again.';
        btnEl.textContent     = 'Got It';
        btnEl.onclick         = () => modal.classList.add('hidden');
    } else if (errorType === 'signal_timeout') {
        iconEl.className      = 'text-3xl text-amber-400';
        iconEl.innerHTML      = '<i class="fa-solid fa-satellite-dish"></i>';
        titleEl.textContent   = 'GPS Signal Timeout';
        msgEl.textContent     = 'Could not get a GPS signal. Tap Retry.';
        btnEl.textContent     = 'Retry';
        btnEl.onclick         = () => { modal.classList.add('hidden'); startLiveHardwareGPSTracking(); };
    } else {
        // 'unavailable' or any unknown type
        iconEl.className      = 'text-3xl text-red-500';
        iconEl.innerHTML      = '<i class="fa-solid fa-location-crosshairs"></i>';
        titleEl.textContent   = 'Location Unavailable';
        msgEl.textContent     = 'Could not determine your location. Check that location services are enabled, then tap Retry.';
        btnEl.textContent     = 'Retry';
        btnEl.onclick         = () => { modal.classList.add('hidden'); startLiveHardwareGPSTracking(); };
    }

    modal.classList.remove('hidden');
}

function handleGpsBadgeClickAction(event) {
    if (event) event.stopPropagation();

    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    // Debounce: ignore taps while a GPS request is already in-flight
    if (_gpsSyncingInProgress) return;

    // Pause the HUD cycle on tap — resumes when the GPS modal closes (or after 4 s)
    if (typeof hudCyclePauseForGpsTap === 'function') hudCyclePauseForGpsTap();

    startLiveHardwareGPSTracking();
}

function monitorNativeGpsPermissions() {
    if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(status => {
            const checkState = () => {
                if (status.state === 'denied') { 
                    gpsStatusCachedBool = false; 
                    updateGpsHudStatus('off', "GPS Off"); 
                }
            };
            status.onchange = checkState; checkState();
        });
    }
}

function startLiveHardwareGPSTracking() {
    if (!navigator.geolocation) {
        gpsStatusCachedBool = false;
        updateGpsHudStatus('off', 'Unsupported');
        return;
    }

    // ── Debounce: ignore calls while a GPS request is already in-flight ────────
    // Prevents duplicate pings from rapid taps on the GPS badge or recenter button.
    if (_gpsSyncingInProgress) return;
    _gpsSyncingInProgress = true;

    // Clear any previous watch before starting a fresh one
    if (liveGpsWatchId !== null) {
        navigator.geolocation.clearWatch(liveGpsWatchId);
        liveGpsWatchId = null;
    }

    // Clear any previous hard-timeout
    if (_gpsSyncTimeoutId !== null) {
        clearTimeout(_gpsSyncTimeoutId);
        _gpsSyncTimeoutId = null;
    }

    updateGpsHudStatus('syncing', 'GPS Syncing...');

    // ── Hard timeout: resolve to GPS Off if no callback arrives within 20 s ────
    // Prevents the HUD from being permanently stuck on "Syncing…" in edge cases
    // where the Geolocation API hangs without calling success or error.
    _gpsSyncTimeoutId = setTimeout(() => {
        _gpsSyncTimeoutId = null;
        if (!gpsStatusCachedBool) {
            _gpsSyncingInProgress = false;
            if (liveGpsWatchId !== null) {
                navigator.geolocation.clearWatch(liveGpsWatchId);
                liveGpsWatchId = null;
            }
            gpsStatusCachedBool = false;
            isCameraLocked      = false;
            syncCameraLockVisualUIState();
            updateGpsHudStatus('off', 'GPS Off');
            _showGpsErrorModal('signal_timeout');
        }
    }, 20000);

    liveGpsWatchId = navigator.geolocation.watchPosition(
        // ── Success: GPS fix received ─────────────────────────────────────────
        (pos) => {
            // Clear the hard timeout — a fix arrived, no need to force GPS Off
            if (_gpsSyncTimeoutId !== null) { clearTimeout(_gpsSyncTimeoutId); _gpsSyncTimeoutId = null; }
            _gpsSyncingInProgress = false;

            gpsStatusCachedBool  = true;
            gpsLastKnownDenied   = false;
            lastGpsSuccessTime   = Date.now();
            userLat              = pos.coords.latitude;
            userLon              = pos.coords.longitude;
            cachedUserCoords     = { lat: userLat, lon: userLon };

            // Persist live telemetry so next launch has fresh cached coords
            localStorage.setItem('compass_user_live_lat', userLat);
            localStorage.setItem('compass_user_live_lng', userLon);
            localStorage.setItem('compass_user_live_ts',  Date.now());

            if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
            updateProximityRippleState();
            refreshMapWeatherWidget();
            // Notify the proximity-sort engine — triggers a background re-sort if
            // the user has moved ≥200 m since the last sort and isn't on the list tab.
            if (typeof notifyGpsPositionForListSort === 'function') {
                notifyGpsPositionForListSort(userLat, userLon);
            }

            updateGpsHudStatus('active', 'GPS Active');
            // NOTE: do NOT forcefully set isCameraLocked = true here.
            // Camera lock is an intentional user action (recenter tap / auto-start).
            // If the user navigated away manually the lock is false — honour that.
            syncCameraLockVisualUIState();

            if (leafletMapInstance) {
                if (userPositionPulseCircle) {
                    userPositionPulseCircle.setLatLng([userLat, userLon]);
                } else {
                    userPositionPulseCircle = L.circleMarker([userLat, userLon], {
                        radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2
                    }).addTo(leafletMapInstance);
                }

                const accuracy = pos.coords.accuracy || 0;
                if (userAccuracyRadiusCircle) {
                    userAccuracyRadiusCircle.setLatLng([userLat, userLon]).setRadius(accuracy);
                } else {
                    userAccuracyRadiusCircle = L.circle([userLat, userLon], {
                        radius: accuracy, fillColor: '#3b82f6', fillOpacity: 0.12,
                        stroke: false, pointerEvents: 'none'
                    }).addTo(leafletMapInstance);
                }

                if (isCameraLocked) {
                    leafletMapInstance.setView([userLat, userLon], leafletMapInstance.getZoom());
                }
            }
        },
        // ── Error: GPS could not get a fix ────────────────────────────────────
        (err) => {
            // Clear hard timeout — error callback resolves the state definitively
            if (_gpsSyncTimeoutId !== null) { clearTimeout(_gpsSyncTimeoutId); _gpsSyncTimeoutId = null; }
            _gpsSyncingInProgress = false;

            if (err.code === err.PERMISSION_DENIED) {
                // User explicitly denied location — cannot recover without OS/browser settings change
                gpsLastKnownDenied  = true;
                gpsStatusCachedBool = false;
                isCameraLocked      = false;
                syncCameraLockVisualUIState();
                updateGpsHudStatus('off', 'GPS Off');
                _showGpsErrorModal('permission_denied');
                if (liveGpsWatchId !== null) {
                    navigator.geolocation.clearWatch(liveGpsWatchId);
                    liveGpsWatchId = null;
                }
            } else if (err.code === err.TIMEOUT) {
                // Fix timed out — signal weak or absent; clear stream, show retry popup
                gpsStatusCachedBool = false;
                isCameraLocked      = false;
                syncCameraLockVisualUIState();
                if (liveGpsWatchId !== null) {
                    navigator.geolocation.clearWatch(liveGpsWatchId);
                    liveGpsWatchId = null;
                }
                updateGpsHudStatus('off', 'GPS Off');
                _showGpsErrorModal('signal_timeout');
            } else {
                // POSITION_UNAVAILABLE or unknown — device cannot determine position
                gpsStatusCachedBool = false;
                isCameraLocked      = false;
                syncCameraLockVisualUIState();
                if (liveGpsWatchId !== null) {
                    navigator.geolocation.clearWatch(liveGpsWatchId);
                    liveGpsWatchId = null;
                }
                updateGpsHudStatus('off', 'GPS Off');
                _showGpsErrorModal('unavailable');
            }
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

// ── Recenter: instant snap to cached coords + silent background micro-adjust ──
function _executeInstantRecenterSnap() {
    if (!cachedUserCoords || !leafletMapInstance) return;

    const snapLat = cachedUserCoords.lat;
    const snapLon = cachedUserCoords.lon;

    // Instant viewport snap — zero hardware latency, user sees their location
    // the same millisecond they tap the button
    leafletMapInstance.setView([snapLat, snapLon], 18);
    isCameraLocked = true;
    syncCameraLockVisualUIState();

    // Place / update the user position marker at the cached location immediately
    if (userPositionPulseCircle) {
        userPositionPulseCircle.setLatLng([snapLat, snapLon]);
    } else {
        userPositionPulseCircle = L.circleMarker([snapLat, snapLon], {
            radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2
        }).addTo(leafletMapInstance);
    }

    // Silent background micro-adjustment — only when the live stream is already
    // running (otherwise starting the stream handles the authoritative position)
    if (liveGpsWatchId !== null && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const freshLat = pos.coords.latitude;
                const freshLon = pos.coords.longitude;

                // Update global telemetry cache
                userLat          = freshLat;
                userLon          = freshLon;
                cachedUserCoords = { lat: freshLat, lon: freshLon };
                gpsStatusCachedBool = true;
                lastGpsSuccessTime  = Date.now();
                localStorage.setItem('compass_user_live_lat', freshLat);
                localStorage.setItem('compass_user_live_lng', freshLon);
                localStorage.setItem('compass_user_live_ts',  Date.now());

                // Only pan if the user has physically moved more than ~5 metres
                // (0.00005° ≈ 5.5 m) — filters GPS noise, prevents jarring micro-snaps
                const moved = Math.abs(freshLat - snapLat) > 0.00005 ||
                              Math.abs(freshLon - snapLon) > 0.00005;

                if (moved) {
                    if (userPositionPulseCircle) userPositionPulseCircle.setLatLng([freshLat, freshLon]);
                    if (userAccuracyRadiusCircle) {
                        userAccuracyRadiusCircle.setLatLng([freshLat, freshLon])
                                                .setRadius(pos.coords.accuracy || 0);
                    }
                    if (leafletMapInstance && isCameraLocked) {
                        leafletMapInstance.panTo([freshLat, freshLon], { animate: true, duration: 0.5 });
                    }
                }
            },
            () => { /* silent — cached snap coordinates are still valid */ },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
        );
    }

    // If the live stream isn't running, start it — it will take over continuous tracking
    if (liveGpsWatchId === null) {
        startLiveHardwareGPSTracking();
    }
}

// ── Recovery poll: verify hardware state when GPS modal is already open ────────
// Fires a single getCurrentPosition to check if the user re-enabled GPS in Settings.
// Success: dismiss modal, lock camera, snap to confirmed position, start stream.
// Failure: keep modal open, keep HUD red, map stays exactly as-is.
function _pollGpsForModalRecovery() {
    if (!navigator.geolocation) return;

    // Debounce: ignore if already polling
    if (_gpsSyncingInProgress) return;
    _gpsSyncingInProgress = true;

    updateGpsHudStatus('syncing', 'GPS Syncing...');

    // Hard timeout — if the poll hangs, reset to GPS Off and keep modal visible
    const recoveryTimeoutId = setTimeout(() => {
        if (!gpsStatusCachedBool) {
            _gpsSyncingInProgress = false;
            gpsStatusCachedBool   = false;
            updateGpsHudStatus('off', 'GPS Off');
            // Keep modal open — user still needs to fix their settings
        }
    }, 12000);

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            clearTimeout(recoveryTimeoutId);
            _gpsSyncingInProgress = false;

            gpsLastKnownDenied  = false;
            gpsStatusCachedBool = true;
            lastGpsSuccessTime  = Date.now();
            userLat             = pos.coords.latitude;
            userLon             = pos.coords.longitude;
            cachedUserCoords    = { lat: userLat, lon: userLon };

            localStorage.setItem('compass_user_live_lat', userLat);
            localStorage.setItem('compass_user_live_lng', userLon);
            localStorage.setItem('compass_user_live_ts',  Date.now());

            // Dismiss the error modal
            const modal = document.getElementById('gpsInstructionsOverlayModal');
            if (modal) modal.classList.add('hidden');

            updateGpsHudStatus('active', 'GPS Active');
            isCameraLocked = true;
            syncCameraLockVisualUIState();

            if (leafletMapInstance) {
                leafletMapInstance.setView([userLat, userLon], 18);
                if (userPositionPulseCircle) {
                    userPositionPulseCircle.setLatLng([userLat, userLon]);
                } else {
                    userPositionPulseCircle = L.circleMarker([userLat, userLon], {
                        radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2
                    }).addTo(leafletMapInstance);
                }
            }

            // Start continuous stream now that permission is confirmed
            startLiveHardwareGPSTracking();
        },
        (err) => {
            clearTimeout(recoveryTimeoutId);
            _gpsSyncingInProgress = false;

            if (err.code === err.PERMISSION_DENIED) gpsLastKnownDenied = true;
            gpsStatusCachedBool = false;
            updateGpsHudStatus('off', 'GPS Off');
            // Modal stays visible — user still needs to change their settings
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// ── Main recenter entry-point ─────────────────────────────────────────────────
// Design contract:
//   1. Button animation   — always fires, zero delay, every tap.
//   2. Instant map snap   — always fires when cached coords exist, NO debounce.
//      cachedUserCoords is seeded from localStorage on startup so this works
//      even before the GPS stream delivers its first fix this session.
//   3. Background refresh — micro-adjust if stream is running; start stream only
//      if it is stopped AND not already syncing (_gpsSyncingInProgress).
// The debounce only gates the stream-start call — never the snap.
function triggerRecenterToGpsHardwareAction(event) {
    if (event) event.stopPropagation();

    const compassBtn  = document.getElementById('hardwareCompassRecenterButtonNode');
    const compassIcon = document.getElementById('innerCompassEmojiSpinnerSpan');
    const modal       = document.getElementById('gpsInstructionsOverlayModal');
    const isModalOpen = modal && !modal.classList.contains('hidden');

    // ── 1. Button press animation (always, every tap) ─────────────────────────
    if (compassBtn) {
        compassBtn.classList.remove('recenter-button-press');
        void compassBtn.offsetWidth;
        compassBtn.classList.add('recenter-button-press');
        setTimeout(() => compassBtn.classList.remove('recenter-button-press'), 420);
    }

    // ── State D: Error modal is open — attempt recovery poll ─────────────────
    if (isModalOpen) {
        _pollGpsForModalRecovery();
        return;
    }

    // ── State C: GPS known denied — show correct modal, no map changes ────────
    if (!navigator.geolocation || gpsLastKnownDenied) {
        _showGpsErrorModal('permission_denied');
        updateGpsHudStatus('off', 'GPS Off');
        return;
    }

    // Snapshot lock state BEFORE the snap mutates isCameraLocked below
    const wasAlreadyCentered = isCameraLocked;

    // ── 2. Instant snap to cached coords (synchronous, zero hardware latency) ──
    // No GPS wait, no debounce — this block always runs when coords are available.
    if (cachedUserCoords && leafletMapInstance) {
        leafletMapInstance.setView([cachedUserCoords.lat, cachedUserCoords.lon], 18);
        isCameraLocked = true;
        syncCameraLockVisualUIState();

        if (userPositionPulseCircle) {
            userPositionPulseCircle.setLatLng([cachedUserCoords.lat, cachedUserCoords.lon]);
        } else {
            userPositionPulseCircle = L.circleMarker([cachedUserCoords.lat, cachedUserCoords.lon], {
                radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2
            }).addTo(leafletMapInstance);
        }
    }

    // ── Compass animation: spin (repositioning) or pink glow (re-locking) ─────
    if (wasAlreadyCentered) {
        if (compassBtn) {
            compassBtn.classList.remove('thematic-pink-glow');
            void compassBtn.offsetWidth;
            compassBtn.classList.add('thematic-pink-glow');
        }
    } else {
        if (compassIcon) {
            compassIcon.style.transition = 'none';
            compassIcon.style.transform  = '';
            compassIcon.classList.remove('compass-spin-active');
            void compassIcon.offsetWidth;
            compassIcon.classList.add('compass-spin-active');
            setTimeout(() => {
                compassIcon.classList.remove('compass-spin-active');
                compassIcon.style.transition = '';
            }, 700);
        }
    }

    // ── 3. Background GPS refresh ─────────────────────────────────────────────
    if (liveGpsWatchId !== null && navigator.geolocation) {
        // Stream is running — fire a silent getCurrentPosition to fine-tune.
        // Only pans the map if the user has physically moved more than ~5 m
        // (0.00005° ≈ 5.5 m) to filter GPS noise and prevent jarring micro-snaps.
        const snapLat = cachedUserCoords ? cachedUserCoords.lat : null;
        const snapLon = cachedUserCoords ? cachedUserCoords.lon : null;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const freshLat = pos.coords.latitude;
                const freshLon = pos.coords.longitude;

                userLat             = freshLat;
                userLon             = freshLon;
                cachedUserCoords    = { lat: freshLat, lon: freshLon };
                gpsStatusCachedBool = true;
                lastGpsSuccessTime  = Date.now();
                localStorage.setItem('compass_user_live_lat', freshLat);
                localStorage.setItem('compass_user_live_lng', freshLon);
                localStorage.setItem('compass_user_live_ts',  Date.now());

                const moved = snapLat !== null && (
                    Math.abs(freshLat - snapLat) > 0.00005 ||
                    Math.abs(freshLon - snapLon) > 0.00005
                );
                if (moved) {
                    if (userPositionPulseCircle) userPositionPulseCircle.setLatLng([freshLat, freshLon]);
                    if (userAccuracyRadiusCircle) {
                        userAccuracyRadiusCircle.setLatLng([freshLat, freshLon])
                                                .setRadius(pos.coords.accuracy || 0);
                    }
                    if (leafletMapInstance && isCameraLocked) {
                        leafletMapInstance.panTo([freshLat, freshLon], { animate: true, duration: 0.5 });
                    }
                }
            },
            () => { /* silent — cached snap coords are still valid */ },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
        );
    } else if (!_gpsSyncingInProgress) {
        // Stream is not running and nothing is syncing — start it.
        // Debounce only applies here: the snap above always ran regardless.
        startLiveHardwareGPSTracking();
    }
    // If _gpsSyncingInProgress: a stream is already starting (e.g. from app load
    // or GPS badge tap). Its success callback will update the marker shortly.
    // The cached snap already gave the user zero-latency visual feedback.
}

function syncCameraLockVisualUIState() {
    const compassBtn = document.getElementById('hardwareCompassRecenterButtonNode');
    if (!compassBtn) return;

    // Snapshot animation classes that are mid-flight so className reset doesn't
    // cancel or restart them — they expire on their own via setTimeout cleanup
    const liveAnimClasses = ['thematic-pink-glow', 'recenter-button-press']
        .filter(cls => compassBtn.classList.contains(cls));

    // GPS is considered "live" whenever the watch stream is running
    const gpsLive = liveGpsWatchId !== null;

    if (isCameraLocked) {
        // ── State: Following — original grey/black, no extra indicator ────────
        compassBtn.className = "w-12 h-12 bg-slate-900/95 border border-slate-800 rounded-full shadow-2xl flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px]";
    } else if (gpsLive) {
        // ── State: Free explore — default look + pink border breathe ─────────
        compassBtn.className = "w-12 h-12 bg-slate-900/95 border border-slate-800 rounded-full shadow-2xl flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px]";
        compassBtn.classList.add('compass-explore-glow');
    } else {
        // ── State: GPS off — original default styling, no indicator ──────────
        compassBtn.className = "w-12 h-12 bg-slate-900/95 border border-slate-800 rounded-full shadow-2xl flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px]";
    }

    // Restore mid-flight animation classes
    liveAnimClasses.forEach(cls => compassBtn.classList.add(cls));
}

function snapMapViewportToSelectedCityBounds(event) {
    if(event) event.stopPropagation();
    if(typeof killLiveSpeechBubbleHUDState === 'function') killLiveSpeechBubbleHUDState();
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    const magnifyingButton = document.getElementById('shortcutMagnifyingButton');

    if (!leafletMapInstance || travelSpots.length === 0) return;

    // ── Itinerary day filter active → zoom to day pins at level 15 ───────────
    // Takes priority over the normal city-fit path so the button always focuses
    // on what the user is actually looking at when a day filter is applied.
    if (typeof activeItineraryFilter !== 'undefined' && activeItineraryFilter) {
        if (magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow', 'lens-zoom-animation');
            void magnifyingButton.offsetWidth;
            magnifyingButton.classList.add('lens-zoom-animation');
        }
        const _itin = (typeof savedItineraries !== 'undefined')
            ? savedItineraries.find(i => i.id === activeItineraryFilter.itineraryId) : null;
        const _day  = _itin ? _itin.days[activeItineraryFilter.dayIndex] : null;
        if (_day?.timeline?.length) {
            const _rowIds     = new Set(_day.timeline.map(s => String(s.rowid)));
            const _itinSpots  = travelSpots.filter(s =>
                _rowIds.has(String(s.rowid)) && _resolveSpotCoords(s) !== null
            );
            if (_itinSpots.length > 0) {
                isCameraLocked = false;
                syncCameraLockVisualUIState();
                if (_itinSpots.length === 1) {
                    const _c = _resolveSpotCoords(_itinSpots[0]);
                    leafletMapInstance.setView([_c.lat, _c.lon], 15, { animate: true });
                } else {
                    const _b = L.latLngBounds();
                    _itinSpots.forEach(s => { const _c = _resolveSpotCoords(s); if (_c) _b.extend([_c.lat, _c.lon]); });
                    leafletMapInstance.fitBounds(_b, { padding: [50, 50], maxZoom: 15, animate: true, duration: 0.6 });
                }
                return;
            }
        }
        // Day exists but has no mappable spots — surface a helpful bubble
        if (typeof triggerCuteSpeechBubbleHUD === 'function')
            triggerCuteSpeechBubbleHUD('No map pins found for this day!', magnifyingButton, event);
        return;
    }

    if (checkedCitiesStateArray.length === 0) {
        if(magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow');
            void magnifyingButton.offsetWidth; 
            magnifyingButton.classList.add('thematic-pink-glow');
        }
        if(typeof triggerCuteSpeechBubbleHUD === 'function') triggerCuteSpeechBubbleHUD("Select a city filter first!", magnifyingButton, event);
        return;
    }

    // Include spots that have real coords OR a cached city-centre fallback.
    let activeCityPins = travelSpots.filter(spot =>
        checkedCitiesStateArray.includes(spot.city) && _resolveSpotCoords(spot) !== null
    );

    if (activeCityPins.length === 0) {
        if(magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow');
            void magnifyingButton.offsetWidth;
            magnifyingButton.classList.add('thematic-pink-glow');
        }
        if(typeof triggerCuteSpeechBubbleHUD === 'function') triggerCuteSpeechBubbleHUD("No pins found for this city!", magnifyingButton, event);
        return;
    }

    // If the starred filter is active, the map only renders starred pins.
    // Fitting bounds to all city pins would be misleading — snap only to
    // the visible starred subset.  If none exist in the selected city,
    // show a contextual bubble instead of silently doing nothing.
    const _starredPriorities = ['high', '🔥', 'must do', 'starred'];
    const _isStarredFilterOn = typeof showStarredOnly !== 'undefined' && showStarredOnly;
    if (_isStarredFilterOn) {
        const starredCityPins = activeCityPins.filter(s =>
            _starredPriorities.includes((s.priority || '').toLowerCase())
        );
        if (starredCityPins.length === 0) {
            if (magnifyingButton) {
                magnifyingButton.classList.remove('thematic-pink-glow');
                void magnifyingButton.offsetWidth;
                magnifyingButton.classList.add('thematic-pink-glow');
            }
            if (typeof triggerCuteSpeechBubbleHUD === 'function') {
                const _cityName = checkedCitiesStateArray.length === 1
                    ? checkedCitiesStateArray[0]
                    : 'this city';
                triggerCuteSpeechBubbleHUD(
                    `"Starred" filter is on — no starred spots in ${_cityName}!`,
                    magnifyingButton, event
                );
            }
            return;
        }
        // Replace the pin set so bounds-fitting only covers what's visible on map.
        activeCityPins = starredCityPins;
    }

    let targetBounds = L.latLngBounds();
    activeCityPins.forEach(spot => {
        const _c = _resolveSpotCoords(spot);
        if (_c) targetBounds.extend([_c.lat, _c.lon]);
    });

    // ── Already-fitted check ──────────────────────────────────────────────────
    // Detect "user tapped again while already at the city view" so we can pulse
    // pink instead of silently re-running fitBounds with no visible change.
    //
    // Strategy: compare current zoom to the zoom fitBounds would choose for the
    // same target.  An area-ratio check fails for tightly-clustered pins because
    // padding dominates and the viewport can be 8–10× wider than the cluster —
    // the ratio is always "too big" and wasAlreadyFitted is never set.
    //
    // A ±1.5 zoom tolerance handles Leaflet's integer snap, device-pixel-ratio
    // rounding, and slight user pan/zoom without re-triggering after a city-
    // filter change (which would leave the map at a much lower zoom).
    let wasAlreadyFitted = false;
    const _tbIsPoint = (targetBounds.getNorth() === targetBounds.getSouth() &&
                        targetBounds.getEast()  === targetBounds.getWest());

    if (leafletMapInstance.getBounds().contains(targetBounds)) {
        if (activeCityPins.length === 1 || _tbIsPoint) {
            // Single location: fitted = zoomed in ≥ 16 and centre within ~250 m
            const _c0 = _resolveSpotCoords(activeCityPins[0]);
            if (_c0) {
                const _dist = leafletMapInstance.distance(
                    leafletMapInstance.getCenter(), L.latLng(_c0.lat, _c0.lon)
                );
                wasAlreadyFitted = leafletMapInstance.getZoom() >= 16 && _dist < 250;
            }
        } else {
            // Multiple locations: compare current zoom to the zoom fitBounds
            // would use.  fitBounds passes paddingTL+paddingBR = [100,100] to
            // getBoundsZoom internally, so we mirror that here.
            const _expectedZoom = leafletMapInstance.getBoundsZoom(
                targetBounds, false, L.point(100, 100)
            );
            wasAlreadyFitted = Math.abs(leafletMapInstance.getZoom() - _expectedZoom) <= 1.5;
        }
    }

    if (wasAlreadyFitted) {
        // Already at the city view — pulse pink to signal "you're already here"
        if (magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow', 'lens-zoom-animation');
            void magnifyingButton.offsetWidth;
            magnifyingButton.classList.add('thematic-pink-glow');
        }
        return;
    }

    // Not yet fitted — zoom/fit to the pins
    if (magnifyingButton) {
        magnifyingButton.classList.remove('thematic-pink-glow', 'lens-zoom-animation');
        void magnifyingButton.offsetWidth;
        magnifyingButton.classList.add('lens-zoom-animation');
    }

    isCameraLocked = false;
    syncCameraLockVisualUIState();

    if (activeCityPins.length === 1) {
        const _c0 = _resolveSpotCoords(activeCityPins[0]);
        leafletMapInstance.setView([_c0.lat, _c0.lon], 18, { animate: true });
    } else {
        leafletMapInstance.fitBounds(targetBounds, {
            padding: [50, 50],
            animate: true,
            duration: 0.6
        });
    }
}

/**
 * Auto-pan and zoom the map to the spots belonging to the currently active
 * itinerary day filter.  Called automatically after applyItineraryDayFilter
 * and after the Type Filter dropdown is closed while a day filter is active.
 *
 * Behaviour mirrors the city magnifying-glass focus function:
 *  - Single spot → setView at zoom 16
 *  - Multiple spots → fitBounds with 50 px padding
 *  - Spots without coordinates are skipped silently
 *  - If zero valid spots exist, the function exits without touching the camera
 */
function autoFitMapToItineraryDaySpots() {
    if (!leafletMapInstance) return;
    // Don't auto-pan/zoom while the detail tray is open — it would reset the
    // user's zoom and create visible jitter behind the open tray.
    if (_mapDetailTrayVisible) return;
    if (typeof activeItineraryFilter === 'undefined' || !activeItineraryFilter) return;
    if (typeof savedItineraries === 'undefined') return;

    const itin = savedItineraries.find(i => i.id === activeItineraryFilter.itineraryId);
    if (!itin) return;
    const day = itin.days[activeItineraryFilter.dayIndex];
    if (!day?.timeline?.length) return;

    const dayRowIds = new Set(day.timeline.map(s => String(s.rowid)));
    const validSpots = (typeof travelSpots !== 'undefined' ? travelSpots : []).filter(spot => {
        if (!dayRowIds.has(String(spot.rowid))) return false;
        return _resolveSpotCoords(spot) !== null;
    });

    if (validSpots.length === 0) return;

    isCameraLocked = false;
    syncCameraLockVisualUIState();

    if (validSpots.length === 1) {
        const _c = _resolveSpotCoords(validSpots[0]);
        leafletMapInstance.setView([_c.lat, _c.lon], 16, { animate: true });
    } else {
        const bounds = L.latLngBounds();
        validSpots.forEach(s => {
            const _c = _resolveSpotCoords(s);
            if (_c) bounds.extend([_c.lat, _c.lon]);
        });
        leafletMapInstance.fitBounds(bounds, { padding: [50, 50], animate: true, duration: 0.6 });
    }
}

/**
 * Nearest-neighbour TSP heuristic for the itinerary path line.
 * Starts from the first timeline entry and greedily visits the closest
 * unvisited pin each step.  Works well for the small pin counts (~5-15)
 * typical of a single itinerary day.
 *
 * @param  {{ lat:number, lng:number }[]} pts  — ordered timeline coordinates
 * @returns {{ lat:number, lng:number }[]}      — reordered for shortest route
 */
function _itinNearestNeighborPath(pts) {
    if (pts.length <= 2) return pts;
    const visited = new Array(pts.length).fill(false);
    const result  = [pts[0]];
    visited[0]    = true;
    for (let step = 1; step < pts.length; step++) {
        const last = result[result.length - 1];
        let bestIdx = -1, bestD2 = Infinity;
        for (let j = 0; j < pts.length; j++) {
            if (visited[j]) continue;
            const dlat = pts[j].lat - last.lat;
            const dlng = pts[j].lng - last.lng;
            const d2   = dlat * dlat + dlng * dlng;
            if (d2 < bestD2) { bestD2 = d2; bestIdx = j; }
        }
        result.push(pts[bestIdx]);
        visited[bestIdx] = true;
    }
    return result;
}

function plotDynamicMarkersOnCanvasMap() {
    if(!mapMarkersLayerGroup || !leafletMapInstance) return;
    mapMarkersLayerGroup.clearLayers();

    if(typeof getFilteredDatasetRows !== 'function') return;
    const dataset = getFilteredDatasetRows();
    const currentZoom = leafletMapInstance.getZoom();

    // Fire-and-forget: geocode cities for spots with missing coords.
    // Re-renders automatically when fetches complete.
    prefetchMissingCityCenters();

    let overlapPixelRadiusThreshold = 28;
    if (currentZoom >= 14 && currentZoom <= 15) {
        overlapPixelRadiusThreshold = 14;
    } else if (currentZoom >= 16) {
        overlapPixelRadiusThreshold = 6;
    }

    let structuredClustersArray = [];

    dataset.forEach(spot => {
        const _coords = _resolveSpotCoords(spot);
        if (!_coords) return;

        const latLngObj = L.latLng(_coords.lat, _coords.lon);
        const screenPoint = leafletMapInstance.latLngToLayerPoint(latLngObj);
        
        let assignedToCluster = false;
        
        for (let i = 0; i < structuredClustersArray.length; i++) {
            let cluster = structuredClustersArray[i];
            const isCoordinatesExactMatch = (cluster.leadLatLng.lat === latLngObj.lat && cluster.leadLatLng.lng === latLngObj.lng);
            
            let dx = screenPoint.x - cluster.centerPx.x;
            let dy = screenPoint.y - cluster.centerPx.y;
            let pixelDistance = Math.sqrt(dx * dx + dy * dy);
            
            if (isCoordinatesExactMatch || (pixelDistance <= overlapPixelRadiusThreshold)) {
                cluster.spots.push(spot);
                assignedToCluster = true;
                break;
            }
        }
        
        if (!assignedToCluster) {
            structuredClustersArray.push({
                centerPx: screenPoint,
                leadLatLng: latLngObj,
                spots: [spot]
            });
        }
    });

    // ── Itinerary day overlay — badge map ────────────────────────────────────
    // _itinBadgeMap: rowid → { num, isDone }  (used by renderSingleMarkerElement)
    // _itinPathPts:  rowid → [lat, lng] | null (filled during cluster rendering
    //                so the path anchors to the EXACT position each marker renders
    //                at, including fan-out offsets and cluster-centre fallbacks)
    // _itinTimeline: ordered timeline array kept for drawing the path afterwards
    const _itinBadgeMap = new Map();
    const _itinPathPts  = new Map(); // rowid → [lat, lng] once rendered
    let   _itinTimeline = [];

    if (typeof activeItineraryFilter !== 'undefined' && activeItineraryFilter) {
        const _itins = (typeof savedItineraries !== 'undefined') ? savedItineraries : [];
        const _itin  = _itins.find(i => i.id === activeItineraryFilter.itineraryId);
        const _day   = _itin?.days?.[activeItineraryFilter.dayIndex];
        _itinTimeline = _day?.timeline || [];

        // Build badge map — check both itinerary isDone flag AND travelSpots.status
        // so a "Mark Done" tap on the tray is reflected without a full itin re-save.
        const _tsr = (typeof travelSpots !== 'undefined') ? travelSpots : [];
        _itinTimeline.forEach((s, idx) => {
            const _ts   = _tsr.find(ts => String(ts.rowid) === String(s.rowid));
            const _done = !!s.isDone || ((_ts?.status || '').toLowerCase().trim() === 'done');
            _itinBadgeMap.set(String(s.rowid), { num: idx + 1, isDone: _done });
            _itinPathPts.set(String(s.rowid), null); // placeholder; filled below
        });
    }
    // ── End badge map setup ───────────────────────────────────────────────────

    structuredClustersArray.forEach(cluster => {
        const clusterSize = cluster.spots.length;

        if (clusterSize === 1) {
            const _spot = cluster.spots[0];
            renderSingleMarkerElement(_spot, 0, 0,
                _itinBadgeMap.get(String(_spot.rowid)) || null);
            // Record the exact rendered position for the path
            if (_itinPathPts.has(String(_spot.rowid))) {
                const _c = _resolveSpotCoords(_spot);
                if (_c) _itinPathPts.set(String(_spot.rowid), [_c.lat, _c.lon]);
            }
        } else {
            if (currentZoom >= 15) {
                cluster.spots.forEach((spot, index) => {
                    const angle     = (index / clusterSize) * Math.PI * 2;
                    const latOffset = Math.sin(angle) * 0.00018;
                    const lonOffset = Math.cos(angle) * 0.00022;
                    renderSingleMarkerElement(spot, latOffset, lonOffset,
                        _itinBadgeMap.get(String(spot.rowid)) || null);
                    // Record the fanned-out position so the path ends where the pin is
                    if (_itinPathPts.has(String(spot.rowid))) {
                        const _c = _resolveSpotCoords(spot);
                        if (_c) _itinPathPts.set(String(spot.rowid), [_c.lat + latOffset, _c.lon + lonOffset]);
                    }
                });
            } else {
                // Spots collapsed into a cluster marker — use cluster centre for path
                cluster.spots.forEach(spot => {
                    if (_itinPathPts.has(String(spot.rowid))) {
                        _itinPathPts.set(String(spot.rowid),
                            [cluster.leadLatLng.lat, cluster.leadLatLng.lng]);
                    }
                });
                const clusterHTML = `<div class="cluster-map-cube">${clusterSize}</div>`;
                const clusterIcon = L.divIcon({ html: clusterHTML, className: '', iconSize: [40, 40], iconAnchor: [20, 20] });
                const clusterMarker = L.marker([cluster.leadLatLng.lat, cluster.leadLatLng.lng], { icon: clusterIcon });
                clusterMarker.on('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    const maxZoomPossible = leafletMapInstance.getMaxZoom();
                    const targetZoomLevel = Math.min(leafletMapInstance.getZoom() + 2, maxZoomPossible);
                    leafletMapInstance.setView([cluster.leadLatLng.lat, cluster.leadLatLng.lng], targetZoomLevel, { animate: true });
                });
                mapMarkersLayerGroup.addLayer(clusterMarker);
            }
        }
    });

    // ── Draw itinerary path (after markers so coord collection is complete) ───
    // Single polyline in timeline order → one continuous dash rhythm, no
    // inter-segment gaps.  Anchored to actual rendered positions (incl. fan-out).
    if (_itinTimeline.length >= 2) {
        const _pathCoords = [];
        _itinTimeline.forEach(s => {
            const pt = _itinPathPts.get(String(s.rowid));
            if (pt) _pathCoords.push(pt);
        });
        if (_pathCoords.length >= 2) {
            L.polyline(_pathCoords, {
                color:     '#c026d3',   // fuchsia-600 — midpoint of pink→violet
                weight:    2.5,
                opacity:   0.75,
                dashArray: '6, 8',
                lineCap:   'round',
                lineJoin:  'round'
            }).addTo(mapMarkersLayerGroup);
        }
    }
    // ── End itinerary path ────────────────────────────────────────────────────
}

function renderSingleMarkerElement(spot, latOffset, lonOffset, itinBadge = null) {
    const isStarred = ['high', '🔥', 'must do', 'starred'].includes((spot.priority || "").toLowerCase());
    const isDone = (spot.status || "").toLowerCase().trim() === 'done';

    let categoryIconClass = "fa-location-dot text-slate-400";
    const catStr = (spot.category || "").toLowerCase();
    if(catStr.includes("photo")) categoryIconClass = "fa-camera-retro text-pink-500";
    else if(catStr.includes("food")) categoryIconClass = "fa-utensils text-orange-500";
    else if(catStr.includes("viewpoint")) categoryIconClass = "fa-binoculars text-sky-500";
    else if(catStr.includes("landmark")) categoryIconClass = "fa-landmark text-yellow-500";
    else if(catStr.includes("nature")) categoryIconClass = "fa-leaf text-emerald-500";
    else if(catStr.includes("culture")) categoryIconClass = "fa-landmark text-violet-500";
    else if(catStr.includes("shopping") || catStr.includes("shop")) categoryIconClass = "fa-bag-shopping text-rose-500";
    else if(catStr.includes("activity")) categoryIconClass = "fa-person-running text-amber-500";
    else if(catStr.includes("relax")) categoryIconClass = "fa-spa text-teal-500";
    else if(catStr.includes("nightlife") || catStr.includes("bar") || catStr.includes("drink")) categoryIconClass = "fa-martini-glass text-indigo-500";

    let baseThemeClasses = "";
    if (currentMapStyleKey === 'dark') {
        baseThemeClasses = "bg-slate-900 border-slate-700 shadow-lg shadow-black/60";
    } else if (currentMapStyleKey === 'light') {
        baseThemeClasses = "bg-white border-slate-200 shadow-lg shadow-slate-300/60";
    } else if (currentMapStyleKey === 'terrain') {
        baseThemeClasses = "bg-slate-50 border-slate-300 shadow-md shadow-slate-400/50";
    } else if (currentMapStyleKey === 'satellite') {
        baseThemeClasses = "bg-slate-950/70 border-white/20 shadow-lg shadow-black/80 backdrop-blur-md";
    }

    let stateClasses = "";
    if (isStarred) {
        if (currentMapStyleKey === 'light' || currentMapStyleKey === 'terrain') {
            stateClasses = "!border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.5)] ring-2 ring-amber-400/30";
        } else {
            stateClasses = "!border-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.7)]";
        }
    }
    if (isDone) {
        stateClasses += " opacity-40 grayscale";
    }

    // Build optional itinerary order badge (number or green check for done spots)
    let _badgeHTML = '';
    if (itinBadge) {
        if (itinBadge.isDone) {
            _badgeHTML = `<div class="itin-map-badge itin-map-badge-done"><i class="fa-solid fa-check" style="font-size:6px;"></i></div>`;
        } else {
            _badgeHTML = `<div class="itin-map-badge">${itinBadge.num}</div>`;
        }
    }
    const iconHTML = `<div style="position:relative;display:inline-block;width:36px;height:36px;">` +
        `<div class="custom-map-cube ${baseThemeClasses} ${stateClasses}"><i class="fa-solid ${categoryIconClass}"></i></div>` +
        `${_badgeHTML}</div>`;
    const customMarkerIcon = L.divIcon({ html: iconHTML, className: '', iconSize: [36, 36], iconAnchor: [18, 18] });
    
    // Use _resolveSpotCoords so spots with missing database coordinates fall back
    // to the cached city-centre.  parseFloat(spot.latitude) would produce NaN for
    // missing coords, causing Leaflet to silently drop the marker.
    const _base = _resolveSpotCoords(spot);
    if (!_base) return;
    const finalLat = _base.lat + latOffset;
    const finalLon = _base.lon + lonOffset;
    // Starred pins get a large zIndexOffset so they always render on top of
    // non-starred pins when spots overlap or are fanned out from a cluster.
    const leafMarker = L.marker([finalLat, finalLon], { icon: customMarkerIcon, zIndexOffset: isStarred ? 1000 : 0 });

    leafMarker.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        revealMapItemDetailTrayHUD(spot, isStarred);
    });
    mapMarkersLayerGroup.addLayer(leafMarker);
}

function revealMapItemDetailTrayHUD(spotObj, isStarredBool) {
    _mapDetailTrayVisible = true;   // freeze programmatic viewport changes
    // Snapshot current viewport so dismiss can restore it exactly, regardless
    // of any async callbacks (geocode, autoFit) that fire while the tray is up.
    if (leafletMapInstance) {
        _savedMapViewForTray = {
            center: leafletMapInstance.getCenter(),
            zoom:   leafletMapInstance.getZoom()
        };
    }
    const tray = document.getElementById('mapDetailTrayHUD');
    // Use the dedicated tray backdrop (z-488) so it sits below the bottom nav
    // (z-490) — nav tabs stay interactive — while blocking the map and top HUD.
    const blurBg = document.getElementById('trayBlurBackdrop');
    const plusBtn = document.getElementById('globalFloatingActionPlusButton');

    tray.classList.remove('flipped');

    const isDone = (spotObj.status || "").toLowerCase().trim() === 'done';
    const ticketLink = spotObj.ticket_url || "";

    if (plusBtn) plusBtn.classList.add('hidden');
    if (blurBg) blurBg.classList.remove('hidden');

    const titleWidget = document.getElementById('traySpotTitle');
    const notesWidget = document.getElementById('traySpotNotes');
    
    titleWidget.innerText = spotObj.spot_name || "Unnamed Destination";
    notesWidget.innerText = spotObj.notes || "No custom notes assigned.";
    // Badge: [icon] category • city  — uses the same icon helper as list cards and drawer rows
    const trayBadgeCatIcon = (typeof getCategoryIconClass === 'function')
        ? getCategoryIconClass(spotObj.category)
        : 'fa-location-dot text-slate-400';
    const trayBadgeCat  = spotObj.category || 'General';
    const trayBadgeCity = spotObj.city     || 'Global';
    document.getElementById('trayCityBadge').innerHTML =
        `<i class="fa-solid ${trayBadgeCatIcon} text-[8px] shrink-0"></i>` +
        `<span class="uppercase tracking-wider">${trayBadgeCat}</span>` +
        `<span class="text-slate-700 font-normal">•</span>` +
        `<span class="uppercase tracking-wider text-slate-500">${trayBadgeCity}</span>`;

    if (isDone) {
        titleWidget.className = "text-base font-black text-slate-500 line-through mt-2 truncate";
        notesWidget.className = "text-xs text-slate-500 leading-relaxed overflow-y-auto subtle-scrollbar max-h-[220px] line-through pr-1 select-none";
    } else {
        titleWidget.className = "text-base font-black text-slate-200 mt-2 truncate";
        notesWidget.className = "text-xs text-slate-400 leading-relaxed overflow-y-auto subtle-scrollbar max-h-[220px] pr-1 select-none";
    }
    
    const distHUD = document.getElementById('trayDistanceBadge');
    distHUD.innerHTML = spotObj.distStr;
    
    if(spotObj.distStr.includes("Missing Location")) {
        distHUD.className = "text-xs font-mono font-bold bg-amber-500/10 text-amber-400 px-2 py-1 rounded-lg border border-amber-500/20 shrink-0 h-fit";
    } else {
        distHUD.className = "text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-pink-500/10 text-pink-400";
    }

    // ── Weather badge ─────────────────────────────────────────────────────────
    const trayWeatherBadge = document.getElementById('trayWeatherBadge');
    if (trayWeatherBadge) {
        const wLat = spotObj.latitude  ? String(spotObj.latitude).trim()  : '';
        const wLng = spotObj.longitude ? String(spotObj.longitude).trim() : '';
        const trayHasCoords = wLat !== '' && wLat !== '0' && wLng !== '' && wLng !== '0';
        if (!trayHasCoords) {
            // No coordinates — show disabled (cloud + slash)
            trayWeatherBadge.className = 'inline-flex items-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-slate-900/50 text-slate-600';
            trayWeatherBadge.innerHTML = '<i class="fa-solid fa-cloud text-[10px]" style="opacity:0.35"></i><i class="fa-solid fa-slash text-[7px]" style="margin-left:-0.55em;opacity:0.35"></i>';
        } else {
            // Has coordinates — show loading placeholder, then update async
            trayWeatherBadge.className = 'inline-flex items-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-sky-500/10 text-sky-300';
            trayWeatherBadge.innerHTML = '<i class="fa-solid fa-cloud text-[10px] opacity-40"></i>';
            if (typeof fetchWeatherForCoords === 'function') {
                fetchWeatherForCoords(parseFloat(wLat), parseFloat(wLng)).then(w => {
                    const badge = document.getElementById('trayWeatherBadge');
                    if (w && badge) {
                        badge.innerHTML = `<i class="fa-solid ${w.iconClass} text-[10px]"></i><span>${w.temp}°</span>`;
                    }
                });
            }
        }
    }

    document.getElementById('trayOpenReferenceBtn').href = spotObj.instagram_url || "#";
    
    const actionBtn = document.getElementById('trayActionBtn');
    actionBtn.setAttribute('data-row-id', spotObj.rowid);
    
    const directMapsUrl = spotObj.maps_url ? String(spotObj.maps_url).trim() : "";
    const rawLat = spotObj.latitude ? String(spotObj.latitude).trim() : "";
    const rawLng = spotObj.longitude ? String(spotObj.longitude).trim() : "";
    const hasValidMapDestination = (directMapsUrl !== "" && directMapsUrl !== "N/A") || (rawLat !== "" && rawLat !== "0" && rawLng !== "" && rawLng !== "0");

    if (!hasValidMapDestination) {
        actionBtn.innerHTML = "<i class='fa-solid fa-triangle-exclamation'></i>"; 
        actionBtn.className = "px-6 bg-slate-950 border border-slate-800 text-amber-400 flex items-center justify-center rounded-xl text-sm font-black h-12 whitespace-nowrap";
    } else {
        actionBtn.innerHTML = "<i class='fa-solid fa-map mr-1.5 text-sm'></i> Directions";
        actionBtn.className = "px-4 bg-slate-950 border border-slate-800 text-slate-300 flex items-center justify-center rounded-xl text-xs font-bold h-12 whitespace-nowrap";
    }

    const ticketRow = document.getElementById('trayTicketRow');
    const ticketBtn = document.getElementById('trayTicketBtn');
    if (ticketLink.trim() !== "") {
        ticketRow.classList.remove('hidden'); ticketBtn.href = ticketLink;
    } else {
        ticketRow.classList.add('hidden');
    }

    // Apply / remove golden glow on both tray faces to match the list card treatment
    const trayFaces = document.querySelectorAll('#mapDetailTrayHUD .flip-card-front-face, #mapDetailTrayHUD .flip-card-back-face');
    trayFaces.forEach(face => {
        if (isStarredBool) face.classList.add('starred-gold-glow');
        else face.classList.remove('starred-gold-glow');
    });

    const doneBtn = document.getElementById('trayDoneToggleBtn');
    const starBtn = document.getElementById('trayStarToggleBtn');

    doneBtn.innerHTML = isDone ? '<i class="fa-solid fa-arrow-rotate-left mr-1"></i> Undo' : '<i class="fa-solid fa-check mr-1"></i> Mark Done';
    doneBtn.onclick = function() {
        if(typeof updateCloudAction === 'function') updateCloudAction(spotObj.rowid, 'update_status', isDone ? 'Pending' : 'Done');
        dismissMapDetailTrayHUDCard();
    };

    starBtn.innerHTML = isStarredBool ? '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar' : '<i class="fa-solid fa-star mr-1"></i> Star';
    starBtn.onclick = function() {
        const nowStarred  = !isStarredBool;
        const newPriority = nowStarred ? 'Starred' : 'Normal';
        isStarredBool     = nowStarred;  // keep closure in sync for repeated taps

        // ── Phase 1 (sync): button label + glow — committed to DOM before
        // any compositing layer is created.  iOS will rasterise the GPU layer
        // for .flip-card-front-face with this already-updated content.
        starBtn.innerHTML = nowStarred
            ? '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar'
            : '<i class="fa-solid fa-star mr-1"></i> Star';

        trayFaces.forEach(face => {
            if (nowStarred) face.classList.add('starred-gold-glow');
            else            face.classList.remove('starred-gold-glow');
        });

        // ── Phase 2 (rAF 1): start amber-burst animation AFTER the label
        // change is committed.  iOS composites .flip-card-front-face with the
        // updated "Unstar" label already baked in — no stale-texture freeze.
        requestAnimationFrame(() => {
            if (nowStarred) {
                const _trayEl = document.getElementById('mapDetailTrayHUD');
                if (_trayEl) {
                    _trayEl.classList.add('card-flash-star');
                    const _frontFace = _trayEl.querySelector('.flip-card-front-face');
                    (_frontFace || _trayEl).addEventListener('animationend',
                        () => _trayEl.classList.remove('card-flash-star'), { once: true });
                }
            }

            // ── Phase 3 (rAF 2): heavy data work — renderListAnimated,
            // plotMarkers, cloud POST.  Runs after animation frame 0 can paint,
            // so it never blocks the visual response.
            requestAnimationFrame(() => {
                if (typeof updateCloudAction === 'function') {
                    updateCloudAction(spotObj.rowid, 'toggle_priority', newPriority);
                }
            });
        });
    };

    const backDesc = document.getElementById('trayBackLongDescription');
    backDesc.innerText = (spotObj.long_description && spotObj.long_description !== "N/A") ? spotObj.long_description : "Disclaimer: Detailed background information unavailable.";

    const hoursGrid = document.getElementById('trayBackHoursGrid');
    hoursGrid.innerHTML = '';
    const staticHoursString = spotObj.opening_hours || "";
    if (staticHoursString.trim() !== "" && staticHoursString !== "N/A") {
        const daysTokens = staticHoursString.split(/[\n;]+/);
        daysTokens.forEach(token => {
            if(!token.trim()) return;
            const rowDiv = document.createElement('div');
            rowDiv.className = "flex justify-between items-center py-0.5 border-b border-slate-900/40 last:border-0";
            rowDiv.innerHTML = `<span>${token.trim()}</span>`;
            hoursGrid.appendChild(rowDiv);
        });
    } else {
        hoursGrid.innerHTML = `<div class="text-slate-500 italic text-[10px] p-1">Disclaimer: Schedule data unavailable.</div>`;
    }

    const warningCard = document.getElementById('trayBackBookingWarningCard');
    const warningText = document.getElementById('trayBackBookingValueText');
    const bookingString = (spotObj.booking_requirement || "").trim();
    if (bookingString !== "" && bookingString !== "N/A" && bookingString.toLowerCase() !== "none") {
        warningText.innerText = bookingString;
        warningCard.classList.remove('hidden');
    } else {
        warningCard.classList.add('hidden');
    }

    // ── Done-state treatment ──────────────────────────────────────────────────
    // Every interactive element is dimmed/greyed individually — no parent filter,
    // which would also dim the Undo button.  Only Undo stays fully active.
    // Mirrors the done-card approach used in the expanded itinerary timeline.
    const _frontFace = tray.querySelector('.flip-card-front-face');
    const _refBtn    = document.getElementById('trayOpenReferenceBtn');
    const _flipBtn   = document.getElementById('trayFlipToBackBtn');
    const _distBadge = document.getElementById('trayDistanceBadge');

    if (isDone) {
        // Tray card — subtle grey bg (same values as itin-done-card CSS rule)
        if (_frontFace) {
            _frontFace.style.backgroundColor = 'rgba(15,23,42,0.60)';
            _frontFace.style.borderColor     = 'rgba(100,116,139,0.18)';
        }

        // Badges — wash out
        ['trayCityBadge','trayStarredBadge','trayBookedBadge'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.opacity = '0.35';
        });
        if (trayWeatherBadge) trayWeatherBadge.style.opacity = '0.30';

        // Distance badge — strip pink/amber, go grey
        if (_distBadge) _distBadge.className =
            'text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-slate-800/20 text-slate-600 opacity-40';

        // Open Reference — strip gradient, grey + no-click
        if (_refBtn) _refBtn.className =
            'flex-1 bg-slate-800/40 border border-slate-700/30 text-slate-600 text-center text-xs font-bold py-3.5 rounded-xl flex items-center justify-center opacity-40 pointer-events-none';

        // Directions — grey + no-click
        actionBtn.className =
            'px-4 bg-slate-800/30 border border-slate-700/20 text-slate-600 flex items-center justify-center rounded-xl text-xs font-bold h-12 whitespace-nowrap opacity-40 pointer-events-none';

        // Ticket row — hide when done
        const _ticketRow = document.getElementById('trayTicketRow');
        if (_ticketRow) _ticketRow.classList.add('hidden');

        // Extra Info flip button — grey + no-click
        if (_flipBtn) _flipBtn.className =
            'text-slate-600 bg-slate-950/50 border border-slate-800/30 px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto opacity-40 pointer-events-none';

        // Star toggle — grey + no-click
        starBtn.className =
            'text-xs px-3 py-2 font-black rounded-lg bg-slate-950/50 border border-slate-800/30 text-slate-600 opacity-40 pointer-events-none';

        // Undo — muted pink, fully active (matches itinerary card done-state Undo)
        doneBtn.className =
            'text-xs px-3 py-2 font-bold rounded-lg bg-pink-600/10 border border-pink-600/20 text-pink-400 active:bg-pink-600/20';

    } else {
        // Normal state — restore all defaults
        if (_frontFace) {
            _frontFace.style.backgroundColor = '';
            _frontFace.style.borderColor     = '';
        }
        ['trayCityBadge','trayStarredBadge','trayBookedBadge'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.opacity = '';
        });
        if (trayWeatherBadge) trayWeatherBadge.style.opacity = '';

        // distBadge already set to its correct class (pink/amber) above

        if (_refBtn) _refBtn.className =
            'flex-1 bg-gradient-to-r from-pink-600 to-purple-600 text-center text-xs font-bold py-3.5 rounded-xl text-white flex items-center justify-center shadow-lg';

        // actionBtn class already set correctly above (Directions / warning branch)

        if (_flipBtn) _flipBtn.className =
            'text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto active:bg-sky-500/20';

        starBtn.className =
            'text-xs px-3 py-2 font-black rounded-lg bg-slate-950 border border-slate-800 text-amber-400 active:bg-slate-800';

        doneBtn.className =
            'text-xs px-3 py-2 font-bold rounded-lg bg-slate-950 border border-slate-800 text-slate-300 active:bg-slate-800';
    }

    tray.classList.remove('hidden');

    // ── Opening spring animation ──────────────────────────────────────────────
    // Remove then re-add so the animation re-fires on every open.
    // Cleaned up on animationend so transform-style:preserve-3d is unaffected.
    tray.classList.remove('tray-spring-in');
    void tray.offsetWidth;  // force reflow
    tray.classList.add('tray-spring-in');
    tray.addEventListener('animationend',
        () => tray.classList.remove('tray-spring-in'), { once: true });

    // ── Closed-today bubble ───────────────────────────────────────────────────
    // Only fires when: the spot has opening hours, today's entry says Closed,
    // and the spot is not already marked Done (done = user has been there).
    if (!isDone) {
        var _closedCheck = _checkSpotClosedToday(spotObj.opening_hours || '');
        if (_closedCheck && _closedCheck.isClosed) {
            var _extraInfoBtn = document.getElementById('trayFlipToBackBtn');
            if (_extraInfoBtn) {
                // Short delay so the tray finishes its slide-in before the bubble appears
                setTimeout(function() { triggerTrayClosedStatusBubble(_extraInfoBtn); }, 480);
            }
        }
    }
}

function dismissMapDetailTrayHUDCard() {
    _mapDetailTrayVisible = false;  // unfreeze programmatic viewport changes immediately

    // Restore the exact viewport the user had when they opened the tray.
    // Done immediately (non-visual) so map interactions resume at once.
    if (_savedMapViewForTray && leafletMapInstance) {
        leafletMapInstance.setView(
            [_savedMapViewForTray.center.lat, _savedMapViewForTray.center.lng],
            _savedMapViewForTray.zoom,
            { animate: false }
        );
        _savedMapViewForTray = null;
    }

    const mapDetailTray = document.getElementById('mapDetailTrayHUD');
    const trayBg        = document.getElementById('trayBlurBackdrop');
    const sharedBg      = document.getElementById('dropdownBlurBackdrop');
    const plusBtn       = document.getElementById('globalFloatingActionPlusButton');

    // ── Closing spring-out animation ──────────────────────────────────────
    // Visual teardown runs after the 240 ms animation; everything else
    // (viewport, _mapDetailTrayVisible) is already cleaned up above.
    if (mapDetailTray) {
        mapDetailTray.classList.remove('tray-spring-in');
        mapDetailTray.classList.add('tray-spring-out');
        mapDetailTray.addEventListener('animationend', () => {
            mapDetailTray.classList.add('hidden');
            mapDetailTray.classList.remove('flipped', 'tray-spring-out');
            if (trayBg)   trayBg.classList.add('hidden');
            if (sharedBg) sharedBg.classList.add('hidden');
            if (plusBtn)  plusBtn.classList.remove('hidden');
        }, { once: true });
    } else {
        // Fallback if element is missing — clean up immediately
        if (trayBg)   trayBg.classList.add('hidden');
        if (sharedBg) sharedBg.classList.add('hidden');
        if (plusBtn)  plusBtn.classList.remove('hidden');
    }
}

// ── Closed-today detection + speech bubble ────────────────────────────────────
// Parses the opening_hours string for today's day entry and returns whether
// the spot is explicitly closed today.  Returns null when data is absent or
// the day cannot be found (so we never show a false-positive).
// ─────────────────────────────────────────────────────────────────────────────
function _checkSpotClosedToday(hoursString) {
    if (!hoursString || hoursString.trim() === '' || hoursString === 'N/A') return null;
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const todayName = dayNames[new Date().getDay()];
    // Split on newlines or semicolons (covers both preferred and fallback formats)
    const tokens = hoursString.split(/[\n;]+/);
    for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i].trim();
        if (!token) continue;
        if (token.toLowerCase().startsWith(todayName.toLowerCase())) {
            return { isClosed: /closed/i.test(token), entry: token };
        }
    }
    return null; // Day not found — insufficient data, no bubble
}

// Shows the "closed today" speech bubble anchored to the Extra Info button.
// Unlike the standard triggerCuteSpeechBubbleHUD, this has NO auto-dismiss —
// it persists until the user taps anywhere on screen.
function triggerTrayClosedStatusBubble(anchorElement) {
    var hud      = document.getElementById('globalToastSpeechBubbleHUD');
    var textNode = document.getElementById('speechBubbleTextContainer');
    var pointer  = document.getElementById('bubblePointerNode');
    if (!hud || !textNode) return;

    // Kill any bubble currently on screen (including pending auto-dismiss timer)
    if (typeof killLiveSpeechBubbleHUDState === 'function') killLiveSpeechBubbleHUDState();

    textNode.textContent = 'Closed today — tap Extra Info for the full schedule.';

    if (anchorElement) {
        var rect         = anchorElement.getBoundingClientRect();
        var anchorCenterX = rect.left + rect.width / 2;
        var bubbleWidth  = 240;
        var margin       = 8;
        var leftPos      = anchorCenterX - bubbleWidth / 2;
        leftPos = Math.max(margin, Math.min(window.innerWidth - bubbleWidth - margin, leftPos));
        hud.style.left = leftPos + 'px';
        hud.style.top  = rect.top  + 'px';
        if (pointer) {
            var pLeft = Math.max(8, Math.min(bubbleWidth - 20, Math.round(anchorCenterX - leftPos - 6)));
            pointer.style.left  = pLeft + 'px';
            pointer.style.right = 'auto';
        }
    }

    hud.classList.remove('hidden');
    hud.classList.remove('bubble-popup-anim');
    void hud.offsetWidth;
    hud.classList.add('bubble-popup-anim');

    // No auto-dismiss — click anywhere to close
    document.addEventListener('click', function _closedBubbleDismiss() {
        if (typeof killLiveSpeechBubbleHUDState === 'function') killLiveSpeechBubbleHUDState();
        document.removeEventListener('click', _closedBubbleDismiss, true);
    }, { capture: true, once: true });
}

// ── Proximity Ripple ─────────────────────────────────────────────────────────
// Pink ring halos on the user's GPS dot when within 100 m of any saved spot.
// Called from the watchPosition callback every time the GPS position updates.
// ─────────────────────────────────────────────────────────────────────────────

function updateProximityRippleState() {
    if (!gpsStatusCachedBool ||
        typeof userLat === 'undefined' || typeof userLon === 'undefined' ||
        typeof travelSpots === 'undefined' || !leafletMapInstance) {
        if (proximityRippleActive) {
            proximityRippleActive = false;
            removeProximityRippleMarker();
        }
        return;
    }

    const isNearNow = travelSpots.some(spot => {
        const lat = parseFloat(spot.latitude);
        const lon = parseFloat(spot.longitude);
        if (!lat || !lon) return false;
        return typeof calculateDistance === 'function' &&
               calculateDistance(userLat, userLon, lat, lon) <= 0.1; // 100 m
    });

    if (isNearNow && !proximityRippleActive) {
        // Just entered the 100 m proximity zone
        proximityRippleActive = true;
        placeProximityRippleMarker();
    } else if (!isNearNow && proximityRippleActive) {
        // Just left the 100 m proximity zone
        proximityRippleActive = false;
        removeProximityRippleMarker();
    } else if (isNearNow && proximityRippleMarker) {
        // Still nearby — keep the marker centred on the current position
        proximityRippleMarker.setLatLng([userLat, userLon]);
    }
}

function placeProximityRippleMarker() {
    const rippleIcon = L.divIcon({
        html: `<div class="proximity-ripple-container">
                   <div class="proximity-ripple-ring r1"></div>
                   <div class="proximity-ripple-ring r2"></div>
                   <div class="proximity-ripple-ring r3"></div>
               </div>`,
        className:  '',
        iconSize:   [100, 100],
        iconAnchor: [50, 50]   // centre of the 100×100 container sits on the LatLng
    });

    if (proximityRippleMarker) {
        // Reuse existing marker — just move it and refresh the icon
        proximityRippleMarker.setLatLng([userLat, userLon]);
        proximityRippleMarker.setIcon(rippleIcon);
    } else {
        proximityRippleMarker = L.marker([userLat, userLon], {
            icon:         rippleIcon,
            zIndexOffset: -1000,   // render behind map pins and the blue user dot
            interactive:  false
        }).addTo(leafletMapInstance);
    }
}

function removeProximityRippleMarker() {
    if (proximityRippleMarker && leafletMapInstance) {
        leafletMapInstance.removeLayer(proximityRippleMarker);
        proximityRippleMarker = null;
    }
}

// ── Weather widget width sync ────────────────────────────────────────────────
// Measures the rendered width of the Style Drawer toggle button and applies
// the same width to the weather widget so both components are visually aligned.
// Called after map init, after every style change, and after weather data loads.
function _syncWeatherWidgetWidth() {
    const widget    = document.getElementById('mapWeatherWidget');
    const currency  = document.getElementById('mapCurrencyWidget');
    if (!widget) return;
    const container = widget.parentElement;
    if (!container) return;
    const styleBtn = container.querySelector('button[onclick*="mapLayerStyleDropdownDeck"]');
    if (!styleBtn) return;
    const bw = styleBtn.getBoundingClientRect().width;
    if (bw > 0) {
        widget.style.width = Math.round(bw) + 'px';
        if (currency) currency.style.width = Math.round(bw) + 'px';
    }
}

// ── Map Weather Widget ───────────────────────────────────────────────────────
//
// Quota strategy (OWM free tier = 1,000 calls / day):
//   • Hard throttle: one real API call per 15 minutes at most  → ≤ 96 calls/day
//   • The shared weatherCache adds a 30-min layer on top, so cache hits cost 0
//   • GPS fires every few seconds but almost always hits the cache
//
// Coordinate resolution priority:
//   1. Live GPS   (gpsStatusCachedBool + userLat/userLon)
//   2. localStorage cache  (compass_user_live_lat / _lng written by watchPosition)
//   3. No data → animated three-icon fallback

const MAP_WEATHER_USER_MIN_INTERVAL = 10 * 60 * 1000; // 10 min between real API calls
let   _mapWeatherLastFetchTime  = 0;
let   _mapWeatherFallbackActive = false; // true while the animated fallback is showing

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _setMapWeatherWidgetContent(html) {
    const w = document.getElementById('mapWeatherWidget');
    if (w) w.innerHTML = html;
}

// Shows the animated three-icon state when no location data is available.
// Icons are spread evenly across the full w-full widget width.
function _showMapWeatherAnimatedFallback() {
    if (_mapWeatherFallbackActive) return; // already showing
    _mapWeatherFallbackActive = true;
    _setMapWeatherWidgetContent(
        `<div class="flex items-center justify-around w-full">` +
            `<i class="fa-solid fa-sun        text-yellow-400 text-[12px] weather-wave-icon wave-1"></i>` +
            `<i class="fa-solid fa-cloud      text-slate-400  text-[12px] weather-wave-icon wave-2"></i>` +
            `<i class="fa-solid fa-cloud-rain text-blue-400   text-[12px] weather-wave-icon wave-3"></i>` +
        `</div>`
    );
}

// Renders real weather data: icon · temp · divider · scrolling feels-like ticker
function _applyMapWeatherData(w) {
    _mapWeatherFallbackActive = false;
    _setMapWeatherWidgetContent(
        `<i class="fa-solid ${w.iconClass} text-[12px] shrink-0"></i>` +
        `<span class="text-[10px] font-black uppercase tracking-wider text-slate-300 shrink-0 leading-none">${w.temp}°C</span>` +
        `<div class="w-px h-3 bg-slate-700 shrink-0"></div>` +
        `<div class="flex-1 overflow-hidden relative" style="height:1.1em">` +
            `<div class="absolute weather-ticker-anim" style="top:0;left:0">` +
                `<span class="whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-slate-500" style="padding-right:2.5rem">Feels Like: ${w.feelsLike ?? w.temp}°C</span>` +
                `<span class="whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-slate-500" style="padding-right:2.5rem">Feels Like: ${w.feelsLike ?? w.temp}°C</span>` +
            `</div>` +
        `</div>`
    );
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Called on:  map init · every GPS watchPosition success · map tab switch
function refreshMapWeatherWidget() {
    // Ensure width is synced first (no-op if already set)
    requestAnimationFrame(_syncWeatherWidgetWidth);
    if (typeof fetchWeatherForCoords !== 'function') return;

    // ── Step 1: resolve coordinates ──────────────────────────────────────────
    let lat = null, lon = null;

    if (typeof gpsStatusCachedBool !== 'undefined' && gpsStatusCachedBool &&
        typeof userLat !== 'undefined' && userLat) {
        // Live GPS available
        lat = userLat; lon = userLon;
    } else {
        // Fall back to last-known coords written by watchPosition
        const cLat = localStorage.getItem('compass_user_live_lat');
        const cLon = localStorage.getItem('compass_user_live_lng');
        if (cLat && cLon && parseFloat(cLat) !== 0) {
            lat = parseFloat(cLat); lon = parseFloat(cLon);
        }
    }

    // ── Step 2: no coords at all → animated fallback ─────────────────────────
    if (lat === null || lon === null) {
        _showMapWeatherAnimatedFallback();
        return;
    }

    // ── Step 3: check weatherCache before hitting the network ─────────────────
    const key = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
    if (typeof weatherCache !== 'undefined' && typeof WEATHER_CACHE_TTL !== 'undefined') {
        const hit = weatherCache.get(key);
        if (hit && (Date.now() - hit.fetchedAt) < WEATHER_CACHE_TTL) {
            _applyMapWeatherData(hit); // instant — no network call
            // Keep currency capsule in sync even on cache hits
            if (typeof notifyWeatherCountryForCurrency === 'function' && hit.country) {
                const cityLabel = hit.city ? `${hit.city}, ${hit.country}` : hit.country;
                notifyWeatherCountryForCurrency(hit.country, cityLabel);
            }
            return;
        }
    }

    // ── Step 4: throttle guard (15-min minimum between real API calls) ────────
    // Exception: if the fallback was active, fetch immediately so real data
    // replaces the animated placeholder the moment GPS comes back online.
    const now = Date.now();
    if (!_mapWeatherFallbackActive && (now - _mapWeatherLastFetchTime) < MAP_WEATHER_USER_MIN_INTERVAL) {
        return; // too soon — skip without showing fallback
    }

    // ── Step 5: fire the API call ─────────────────────────────────────────────
    _mapWeatherLastFetchTime = now;
    fetchWeatherForCoords(lat, lon).then(w => {
        if (!w) return;
        _applyMapWeatherData(w);
        // Notify currency system of the resolved country code
        if (typeof notifyWeatherCountryForCurrency === 'function' && w.country) {
            const cityLabel = w.city ? `${w.city}, ${w.country}` : w.country;
            notifyWeatherCountryForCurrency(w.country, cityLabel);
        }
    });
}



// ================================================================
//  STARGAZING HEATMAP OVERLAY
//  ─────────────────────────
//  • Light-pollution tile layer  (djlorenz.github.io, z-index 350)
//  • Cloud/seeing canvas overlay (z-index 400, mix-blend-mode:screen)
//  • Fibonacci spiral sampling   (adaptive point count by radius)
//  • Open-Meteo current weather  (1 fetch per grid point)
// ================================================================

// ── Globals ──────────────────────────────────────────────────────
let _sgOverlayEnabled   = false;
let _sgLpTileLayer      = null;   // Leaflet light-pollution tile layer
let _sgHeatCanvas       = null;   // <canvas> element over the map
let _sgHeatSamples      = [];     // [{ lat, lon, score }] last drawn set
let _sgOverlayRadiusKm  = 150;    // current radius (km)
let _sgFetchController  = null;   // AbortController for in-flight grid fetch
let _sgDrawPending      = false;  // rAF guard
let _sgShowLabels       = false;  // draw score % on each blob point
let _sgLabelHitboxes    = [];     // [{x,y,lat,lon,score,r}] for click-to-zoom
let _sgLpTileFetchMap    = new Map(); // session cache: tileUrl → Promise<ImageData>
let _sgCenterAodMod      = 1.0;  // aerosol optical depth modifier (1.0 = clean air)
let _sgCenter7TimerMod   = 1.0;  // 7Timer ASTRO cross-calibration modifier (0.7–1.0)
let _sgCenterSolarAlt    = -90;  // current solar altitude at grid centre (degrees)
let _sgCenterDarknessMod = 1.0;  // 0.05 (day) → 1.0 (astronomical night)
let _sgTonightIndices    = [];   // [{index, timeStr}] — tonight's astronomical night hours in the 48-h hourly forecast
let _sgSpotDetailData    = null; // last hitbox tapped for bottom HUD

// ── Public: activate overlay ─────────────────────────────────────
function sgActivateOverlay(radiusKm) {
    if (!leafletMapInstance) return;
    radiusKm = radiusKm || _sgOverlayRadiusKm;
    _sgOverlayRadiusKm = radiusKm;
    _sgOverlayEnabled  = true;

    // 1. Light-pollution tile layer
    if (!_sgLpTileLayer) {
        _sgLpTileLayer = L.tileLayer(
            'https://djlorenz.github.io/astronomy/lp2022/overlay/tiles/{z}/{x}/{y}.png',
            {
                attribution: '© <a href="https://djlorenz.github.io/astronomy/lp2022/" target="_blank">Falchi LP 2022</a>',
                opacity:  0.55,
                maxZoom:  12,
                minZoom:  3,
                zIndex:   350
            }
        );
    }
    if (!leafletMapInstance.hasLayer(_sgLpTileLayer)) {
        _sgLpTileLayer.addTo(leafletMapInstance);
    }

    // 2. Canvas overlay
    _sgEnsureCanvas();

    // 3. Map event listeners for redraw
    leafletMapInstance.off('moveend zoomend', _sgOnMapMove);
    leafletMapInstance.on ('moveend zoomend', _sgOnMapMove);

    // 4. Initial fetch + draw
    _sgRefresh();
}

// ── Public: deactivate overlay ───────────────────────────────────
function sgDeactivateOverlay() {
    _sgOverlayEnabled = false;

    // Abort any pending fetch
    if (_sgFetchController) {
        _sgFetchController.abort();
        _sgFetchController = null;
    }

    // Remove tile layer
    if (_sgLpTileLayer && leafletMapInstance && leafletMapInstance.hasLayer(_sgLpTileLayer)) {
        leafletMapInstance.removeLayer(_sgLpTileLayer);
    }

    // Remove event listener
    if (leafletMapInstance) {
        leafletMapInstance.off('moveend zoomend', _sgOnMapMove);
    }

    // Clear canvas
    if (_sgHeatCanvas) {
        const ctx = _sgHeatCanvas.getContext('2d');
        ctx.clearRect(0, 0, _sgHeatCanvas.width, _sgHeatCanvas.height);
        _sgHeatCanvas.style.display = 'none';
    }

    _sgHeatSamples = [];
    sgHideSpotDetail();
}

// ── Public: update radius and refresh ────────────────────────────
function sgUpdateOverlayRadius(km) {
    _sgOverlayRadiusKm = km;
    if (_sgOverlayEnabled) _sgRefresh();
}

// ── Internal: ensure canvas exists as a direct child of .leaflet-container
//
//  WHY NOT createPane():
//    createPane() adds the element inside .leaflet-map-pane which (a) has
//    no explicit CSS width/height so width:100% resolves to 0, and (b)
//    receives Leaflet's pan transform so the canvas scrolls with the tiles.
//
//  CORRECT APPROACH:
//    Append the canvas directly to .leaflet-container (position:relative,
//    overflow:hidden).  The canvas is position:absolute top/left 0 and its
//    drawing-surface size equals the container's pixel dimensions.
//    latLngToContainerPoint() already returns coords relative to this same
//    container so the mapping is exact, no transforms needed.
// ────────────────────────────────────────────────────────────────────────
function _sgEnsureCanvas() {
    if (!leafletMapInstance) return;
    const lc = leafletMapInstance.getContainer();  // .leaflet-container
    if (!lc) return;

    if (!_sgHeatCanvas) {
        _sgHeatCanvas = document.createElement('canvas');
        _sgHeatCanvas.id = 'sg-heat-canvas';
        // Positioned over the map; NO CSS width/height — the drawing
        // surface (set by .width/.height attrs) controls display size.
        _sgHeatCanvas.style.cssText =
            'position:absolute;top:0;left:0;z-index:450;' +
            'pointer-events:none;display:block;opacity:0.82;';
        lc.appendChild(_sgHeatCanvas);

        // Click handler: tap a score label → zoom to that point at z15
        _sgHeatCanvas.addEventListener('click', (e) => {
            if (!_sgShowLabels || _sgLabelHitboxes.length === 0) return;
            const rect = _sgHeatCanvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            let closest = null, minDist = Infinity;
            _sgLabelHitboxes.forEach(h => {
                const d = Math.hypot(cx - h.x, cy - h.y);
                if (d < minDist && d <= h.r) { minDist = d; closest = h; }
            });
            if (closest && leafletMapInstance) {
                leafletMapInstance.setView(
                    L.latLng(closest.lat, closest.lon), 15, { animate: true }
                );
                // Show bottom HUD with tonight's detail for this spot
                sgShowSpotDetail(closest);
            }
        });
    }
    _sgHeatCanvas.style.display = 'block';
    _sgSyncCanvasSize();
}

// Set canvas drawing-surface dimensions to match the map container.
// Because there is no CSS width/height override, the canvas will
// visually display at exactly canvas.width × canvas.height pixels.
function _sgSyncCanvasSize() {
    if (!_sgHeatCanvas || !leafletMapInstance) return;
    const lc = leafletMapInstance.getContainer();
    if (!lc) return;
    const w = lc.offsetWidth  || lc.clientWidth  || 375;
    const h = lc.offsetHeight || lc.clientHeight || 600;
    // Only reset when size changed — resetting clears the drawing surface
    if (_sgHeatCanvas.width  !== w) _sgHeatCanvas.width  = w;
    if (_sgHeatCanvas.height !== h) _sgHeatCanvas.height = h;
}

// ── Internal: map move/zoom handler ──────────────────────────────
function _sgOnMapMove() {
    if (!_sgOverlayEnabled) return;
    // Redraw existing samples instantly on pan/zoom (screen coords change)
    if (_sgHeatSamples.length > 0) {
        _sgDrawHeatCanvas();
    } else {
        // Still fetching — redraw the loading ring at new screen position
        const { lat, lon } = _sgGetGpsCenter();
        _sgDrawLoadingRing(lat, lon);
    }
    // Debounced refresh only if user actually changes view significantly
    clearTimeout(_sgOnMapMove._t);
    _sgOnMapMove._t = setTimeout(_sgRefresh, 800);
}

// ── Internal: resolve best-available coords (GPS > cache > map centre)
function _sgGetGpsCenter() {
    // userLat/userLon and cachedUserCoords are globals from aap.js
    if (typeof userLat !== 'undefined' && userLat && typeof userLon !== 'undefined' && userLon) {
        return { lat: userLat, lon: userLon };
    }
    if (typeof cachedUserCoords !== 'undefined' && cachedUserCoords &&
        cachedUserCoords.lat && cachedUserCoords.lon) {
        return { lat: cachedUserCoords.lat, lon: cachedUserCoords.lon };
    }
    const c = leafletMapInstance.getCenter();
    return { lat: c.lat, lon: c.lng };
}

// ═══════════════════════════════════════════════════════════════════
//  LIGHT POLLUTION TILE SAMPLING (Falchi 2022 via djlorenz.github.io)
//  ─────────────────────────────────────────────────────────────────
//  Reads the pixel colour at a lat/lon from the LP overlay tiles and
//  maps it to a Bortle-scale value (1–9).  Uses a session-scoped
//  ImageData cache (_sgLpTileFetchMap) so nearby points that fall on
//  the same tile share a single fetch.
//
//  CORS: GitHub Pages sends Access-Control-Allow-Origin:* for public
//  repos.  We use img.crossOrigin='anonymous' so the canvas stays
//  uncontaminated and getImageData() succeeds.
// ═══════════════════════════════════════════════════════════════════

// Slippy-map tile coordinates for a lat/lon at a given zoom
function _sgLatLonToTileXY(lat, lon, zoom) {
    const n  = Math.pow(2, zoom);
    const x  = Math.floor((lon + 180) / 360 * n);
    const lr = lat * Math.PI / 180;
    const y  = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
    return { x, y };
}

// Pixel offset (0–255) within the 256×256 tile for a given lat/lon
function _sgLatLonToTilePixel(lat, lon, zoom) {
    const n              = Math.pow(2, zoom);
    const { x: tx, y: ty } = _sgLatLonToTileXY(lat, lon, zoom);
    const pixX  = Math.floor((lon + 180) / 360 * n * 256) - tx * 256;
    const lr    = lat * Math.PI / 180;
    const pixY  = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n * 256) - ty * 256;
    return {
        tileX: tx, tileY: ty,
        pixX:  Math.max(0, Math.min(255, pixX)),
        pixY:  Math.max(0, Math.min(255, pixY))
    };
}

// Fetch a tile and cache the full ImageData for the session.
// Returns null on error (treat as Bortle 1 = pristine dark sky).
function _sgFetchLpTileImageData(tileX, tileY, zoom, signal) {
    const url = `https://djlorenz.github.io/astronomy/lp2022/overlay/tiles/${zoom}/${tileX}/${tileY}.png`;
    if (_sgLpTileFetchMap.has(url)) return _sgLpTileFetchMap.get(url);

    const promise = fetch(url, { signal })
        .then(r => r.ok ? r.blob() : null)
        .then(blob => {
            if (!blob) return null;
            // Use createImageBitmap so we never need a blob URL or crossOrigin attribute.
            // Blob URLs are same-origin by definition — setting crossOrigin on them
            // confuses the browser and can silently prevent getImageData from working.
            return createImageBitmap(blob).then(bitmap => {
                const c   = document.createElement('canvas');
                c.width   = c.height = 256;
                const ctx = c.getContext('2d');
                ctx.drawImage(bitmap, 0, 0);
                try { return ctx.getImageData(0, 0, 256, 256); }
                catch (_) { return null; }
            }).catch(() => null);
        })
        .catch(err => { if (err.name === 'AbortError') throw err; return null; });

    _sgLpTileFetchMap.set(url, promise);
    return promise;
}

// Sample one point → Bortle 1–9 (null on any failure)
// Tries zoom 11 (~78 m/px) first for best accuracy, falls back to 9 then 7
// in case the high-zoom tile doesn't exist for the requested location.
async function _sgSampleBortle(lat, lon, signal) {
    try {
        for (const zoom of [11, 9, 7]) {
            const { tileX, tileY, pixX, pixY } = _sgLatLonToTilePixel(lat, lon, zoom);
            const imageData = await _sgFetchLpTileImageData(tileX, tileY, zoom, signal);
            if (!imageData) continue;  // 404 or decode failure — try next zoom
            const i = (pixY * 256 + pixX) * 4;
            return _sgRgbToBortle(
                imageData.data[i], imageData.data[i+1],
                imageData.data[i+2], imageData.data[i+3]
            );
        }
        return null;  // all zoom levels failed — fall back to atmospheric score
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        return null;
    }
}

// Map djlorenz Falchi 2022 tile pixel colour → Bortle scale 1–9.
// The overlay uses a hue-progression palette (empirically matched to
// the colorbar at djlorenz.github.io/astronomy/lp/colors.html):
//   near-transparent / black → 1 (pristine)
//   indigo / violet (260–300°) → 2
//   blue   (200–260°)          → 2–3
//   cyan   (160–200°)          → 3
//   green  (110–160°)          → 3–4
//   yellow-green (75–110°)     → 4
//   yellow (55–75°)            → 5
//   orange (40–55°)            → 6
//   orange-red (20–40°)        → 7
//   red    (0–20° / 340–360°)  → 8
//   bright white               → 9
function _sgRgbToBortle(r, g, b, a) {
    if (a < 20 || (r < 20 && g < 20 && b < 20)) return 1;   // transparent / black

    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf);
    const min = Math.min(rf, gf, bf);
    const lum = rf * 0.299 + gf * 0.587 + bf * 0.114;       // perceived brightness

    if (lum > 0.80 && (max - min) < 0.25) return 9;         // near-white = city centre

    let hue = 0;
    if (max !== min) {
        const d = max - min;
        if      (max === rf) hue = 60 * (((gf - bf) / d) % 6);
        else if (max === gf) hue = 60 *  ((bf - rf) / d + 2);
        else                 hue = 60 *  ((rf - gf) / d + 4);
        if (hue < 0) hue += 360;
    }

    if (hue <  20 || hue >= 340) return 8;   // red
    if (hue <  40)               return 7;   // orange-red
    if (hue <  55)               return 6;   // orange
    if (hue <  75)               return 5;   // yellow
    if (hue < 110)               return 4;   // yellow-green
    if (hue < 160)               return 3;   // green → cyan
    if (hue < 260)               return 2;   // blue
    return 2;                                // indigo / violet
}

// Bortle 1–9 → quality score 0–100 (linear: 1=100, 9=0)
function _sgBortleToScore(bortle) {
    return Math.max(0, Math.min(100, (9 - bortle) / 8 * 100));
}

// ─────────────────────────────────────────────────────────────────
//  MOON ILLUMINATION  (simple synodic approximation, no deps)
//  Returns 0 (new moon) → 1 (full moon)
// ─────────────────────────────────────────────────────────────────
function _sgMoonIllumination() {
    // Known new moon: 2000-01-06T18:14:00Z
    const epoch   = 946_727_640_000;   // ms
    const synodic =  29.53058867 * 86_400_000;
    const phase   = ((Date.now() - epoch) % synodic + synodic) % synodic / synodic;
    return (1 - Math.cos(phase * 2 * Math.PI)) / 2;
}

// ─────────────────────────────────────────────────────────────────
//  AEROSOL OPTICAL DEPTH  (fetched once at grid centre)
//  air-quality-api.open-meteo.com — free, no key needed.
//  Updates _sgCenterAodMod (global multiplier 0.65–1.0).
// ─────────────────────────────────────────────────────────────────
async function _sgFetchCenterAod(lat, lon, signal) {
    try {
        const url  = `https://air-quality-api.open-meteo.com/v1/air-quality` +
                     `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
                     `&current=aerosol_optical_depth,dust&timezone=auto`;
        const resp = await fetch(url, { signal });
        if (!resp.ok) return;
        const json = await resp.json();
        const aod  = json?.current?.aerosol_optical_depth ?? 0.1;
        const dust = json?.current?.dust                  ?? 0;   // µg/m³

        // AOD penalty: 0.1=clean, 0.3=slight haze, 0.6=moderate, 1.0+=heavy smoke
        const aodMod = aod <= 0.10 ? 1.00
                     : aod <= 0.30 ? 1.00 - (aod - 0.10) * 0.50   // → 0.90
                     : aod <= 0.60 ? 0.90 - (aod - 0.30) * 0.33   // → 0.80
                     : aod <= 1.00 ? 0.80 - (aod - 0.60) * 0.375  // → 0.65
                     : 0.65;
        // Surface dust (Saharan events etc.)
        const dustMod = dust > 100 ? 0.80 : dust > 50 ? 0.90 : dust > 20 ? 0.95 : 1.00;
        _sgCenterAodMod = aodMod * dustMod;
        console.log(`[SG-Heatmap] AOD=${aod.toFixed(3)} dust=${dust} → aodMod=${_sgCenterAodMod.toFixed(3)}`);
    } catch (e) {
        if (e.name !== 'AbortError') _sgCenterAodMod = 1.0;   // assume clean on error
    }
}

// ═══════════════════════════════════════════════════════════════════
//  SOLAR ALTITUDE  (determines astronomical darkness, no API needed)
//  ─────────────────────────────────────────────────────────────────
//  Accurate to ±0.5° — sufficient for twilight classification.
//  Based on: Astronomical Algorithms, Jean Meeus (simplified).
// ═══════════════════════════════════════════════════════════════════
function _sgComputeSolarAltitude(lat, lon, dateObj) {
    const now  = (dateObj instanceof Date) ? dateObj : new Date();
    // Julian date
    const JD   = now.getTime() / 86400000 + 2440587.5;
    const n    = JD - 2451545.0;
    // Mean longitude and mean anomaly (degrees)
    const L    = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
    const g    = ((357.528 + 0.9856003 * n) % 360 + 360) % 360;
    const gr   = g * Math.PI / 180;
    // Ecliptic longitude (degrees → radians)
    const lam  = (L + 1.915 * Math.sin(gr) + 0.020 * Math.sin(2 * gr)) * Math.PI / 180;
    // Obliquity of ecliptic (radians)
    const eps  = (23.439 - 0.0000004 * n) * Math.PI / 180;
    // Declination
    const sinDec = Math.sin(eps) * Math.sin(lam);
    const dec    = Math.asin(sinDec);
    // Greenwich Mean Sidereal Time (degrees) then Local Hour Angle
    const GMST = ((6.697375 + 0.0657098242 * n) % 24 + 24) % 24;
    const LST  = ((GMST + now.getUTCHours() + now.getUTCMinutes() / 60 +
                   now.getUTCSeconds() / 3600) % 24 * 15 + lon + 360) % 360;
    const RA   = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * 180 / Math.PI;
    const HA   = ((LST - ((RA % 360) + 360) % 360 + 360) % 360) * Math.PI / 180;
    const latr = lat * Math.PI / 180;
    const sinAlt = Math.sin(dec) * Math.sin(latr) +
                   Math.cos(dec) * Math.cos(latr) * Math.cos(HA);
    return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180 / Math.PI;
}

// Darkness fraction: 0.05 (midday) → 1.0 (true astronomical night)
function _sgDarknessModifier(altDeg) {
    if (altDeg >   0) return 0.05;   // daytime — sky completely washed out
    if (altDeg > - 6) return 0.25;   // civil twilight
    if (altDeg > -12) return 0.60;   // nautical twilight
    if (altDeg > -18) return 0.85;   // astronomical twilight
    return 1.0;                       // full astronomical night
}

// Human-readable darkness label + colour class — used to update the legend pill.
// lat/lon are optional; when provided the sun's direction (rising vs setting)
// is used to distinguish Sunrise from Sunset and Dawn from Dusk.
function _sgDarknessLabel(altDeg, lat, lon) {
    // Determine if sun is moving up (rising) or down (setting)
    let rising = false;
    if (lat !== undefined && lon !== undefined && altDeg > -18 && altDeg <= 0) {
        const prevAlt = _sgComputeSolarAltitude(lat, lon,
            new Date(Date.now() - 30 * 60000));   // 30 min ago
        rising = altDeg > prevAlt;
    }

    if (altDeg >   0) return { text: 'Daytime', cls: 'text-amber-400' };

    // Civil twilight  (0° → -6°)
    if (altDeg > -6) return rising
        ? { text: 'Sunrise', cls: 'text-orange-300' }
        : { text: 'Sunset',  cls: 'text-orange-400' };

    // Nautical + astronomical twilight  (-6° → -18°)
    if (altDeg > -18) return rising
        ? { text: 'Dawn', cls: 'text-violet-300' }
        : { text: 'Dusk', cls: 'text-violet-300' };

    // True astronomical night
    const hr = new Date().getHours();   // device local hour
    if (hr >= 23 || hr < 3) return { text: 'Midnight', cls: 'text-violet-200' };
    return                           { text: 'Night',    cls: 'text-violet-200' };
}

// ─────────────────────────────────────────────────────────────────
//  TONIGHT'S ASTRONOMICAL NIGHT WINDOW  (pure math, no API)
//  Finds which hourly-forecast indices (0-47, UTC midnight base)
//  correspond to solar altitude < -18° and are still in the future.
//  Returns [{index, timeStr}] used by _sgFetchGridScores.
// ─────────────────────────────────────────────────────────────────
function _sgComputeTonightHourIndices(lat, lon) {
    const now    = new Date();
    const base   = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    ));
    const result = [];
    for (let i = 0; i < 48; i++) {
        const t = new Date(base.getTime() + i * 3600000);
        if (t.getTime() <= now.getTime()) continue;   // skip past hours
        if (result.length >= 14) break;                // cap at 14 dark hours
        const alt = _sgComputeSolarAltitude(lat, lon, t);
        if (alt < -18) {
            const y  = t.getUTCFullYear();
            const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
            const d  = String(t.getUTCDate()).padStart(2, '0');
            const h  = String(t.getUTCHours()).padStart(2, '0');
            result.push({ index: i, timeStr: `${y}-${mo}-${d}T${h}:00` });
        }
    }
    return result;
}

// "2026-06-25T23:00" → "23:00"
function _sgFormatHourStr(timeStr) {
    if (!timeStr) return '--';
    return timeStr.slice(11, 16);
}

// Returns the best consecutive 2-hour window from an hourlyScores array
function _sgComputeTonightBestWindow(hourlyScores) {
    if (!hourlyScores || hourlyScores.length === 0) return null;
    if (hourlyScores.length === 1) {
        return { start: hourlyScores[0].timeStr, end: hourlyScores[0].timeStr, startIdx: 0,
                 label: _sgFormatHourStr(hourlyScores[0].timeStr) };
    }
    let bestSum = -1, bestIdx = 0;
    for (let i = 0; i < hourlyScores.length - 1; i++) {
        const sum = (hourlyScores[i].score || 0) + (hourlyScores[i + 1]?.score || 0);
        if (sum > bestSum) { bestSum = sum; bestIdx = i; }
    }
    const endIdx = Math.min(bestIdx + 2, hourlyScores.length - 1);
    return {
        start:    hourlyScores[bestIdx].timeStr,
        end:      hourlyScores[endIdx].timeStr,
        startIdx: bestIdx,
        label:    `${_sgFormatHourStr(hourlyScores[bestIdx].timeStr)}–${_sgFormatHourStr(hourlyScores[endIdx].timeStr)}`
    };
}

// Moon phase name + FA icon class + illumination %
function _sgMoonPhaseName() {
    const epoch   = 946_727_640_000;
    const synodic = 29.53058867 * 86_400_000;
    const phase   = ((Date.now() - epoch) % synodic + synodic) % synodic / synodic;
    const pct     = Math.round(_sgMoonIllumination() * 100);
    let name, faIcon;
    if      (phase < 0.03 || phase >= 0.97) { name = 'New Moon';      faIcon = 'fa-circle text-slate-600'; }
    else if (phase < 0.22)                   { name = 'Wax Crescent';  faIcon = 'fa-moon text-slate-300'; }
    else if (phase < 0.28)                   { name = '1st Quarter';   faIcon = 'fa-moon text-slate-200'; }
    else if (phase < 0.47)                   { name = 'Wax Gibbous';   faIcon = 'fa-moon text-yellow-200'; }
    else if (phase < 0.53)                   { name = 'Full Moon';     faIcon = 'fa-circle text-yellow-300'; }
    else if (phase < 0.72)                   { name = 'Wan Gibbous';   faIcon = 'fa-moon text-yellow-200'; }
    else if (phase < 0.78)                   { name = 'Last Quarter';  faIcon = 'fa-moon text-slate-200'; }
    else                                      { name = 'Wan Crescent'; faIcon = 'fa-moon text-slate-300'; }
    return { name, faIcon, pct };
}

// Update legend pill with moon phase + best window (called after grid fetch)
function _sgUpdateLegendPillInfo(centerHourlyScores) {
    const { faIcon, pct, name } = _sgMoonPhaseName();
    const moonEl = document.getElementById('sgMoonPhaseInfo');
    if (moonEl) {
        moonEl.innerHTML = `<i class="fa-solid ${faIcon.replace('text-','text-').split(' ').join(' ')} text-[8px]"></i>` +
                           `<span class="text-[8px] font-bold text-yellow-200">${pct}%</span>`;
        moonEl.title = name;
    }
    const win   = _sgComputeTonightBestWindow(centerHourlyScores);
    const winEl = document.getElementById('sgBestWindowInfo');
    if (winEl) winEl.textContent = win ? win.label : '--';
}

// ═══════════════════════════════════════════════════════════════════
//  7Timer! ASTRO CENTRE CALIBRATION
//  ─────────────────────────────────────────────────────────────────
//  Fetches 7Timer ASTRO for the grid centre (one request per refresh).
//  The seeing + transparency values cross-calibrate the Open-Meteo
//  atmospheric model against a purpose-built astronomical seeing model.
//  Result stored in _sgCenter7TimerMod (0.70–1.00).
// ═══════════════════════════════════════════════════════════════════
async function _sgFetch7TimerCalibration(lat, lon, signal) {
    try {
        const url  = `https://www.7timer.info/bin/astro.php` +
                     `?lon=${lon.toFixed(4)}&lat=${lat.toFixed(4)}` +
                     `&ac=0&lang=en&unit=metric&output=json&tzshift=0`;
        const resp = await fetch(url, { signal });
        if (!resp.ok) return;
        const json = await resp.json();
        if (!json?.dataseries?.length || !json.init) return;

        // Parse model init time and find the dataseries entry closest to now
        const init = String(json.init);
        const initDate = new Date(Date.UTC(
            parseInt(init.slice(0, 4)), parseInt(init.slice(4, 6)) - 1,
            parseInt(init.slice(6, 8)), parseInt(init.slice(8, 10))
        ));
        const hoursFromInit = (Date.now() - initDate.getTime()) / 3600000;
        const entry = json.dataseries.reduce((best, ds) =>
            Math.abs(ds.timepoint - hoursFromInit) < Math.abs(best.timepoint - hoursFromInit)
                ? ds : best
        );

        // seeing 1–7: 1=<0.5" (excellent) → 7=>2.5" (terrible) — lower is better
        const seeMods  = [1.0, 1.00, 0.95, 0.88, 0.78, 0.65, 0.50, 0.35];
        // transparency 1–7: 1=best → 7=worst
        const transMods = [1.0, 1.00, 0.95, 0.88, 0.78, 0.65, 0.50, 0.35];
        const seeM  = seeMods[ Math.max(1, Math.min(7, entry.seeing  ?? 4))] ?? 0.78;
        const traM  = transMods[Math.max(1, Math.min(7, entry.transparency ?? 4))] ?? 0.78;
        const calibMod = 0.5 * seeM + 0.5 * traM;

        // Blend: 7Timer contributes 30% of the calibration weight
        // (0.70 + 0.30 × calibMod) → range 0.805–1.00 for worst–best 7Timer conditions
        _sgCenter7TimerMod = 0.70 + 0.30 * calibMod;
        console.log(`[SG-Heatmap] 7Timer seeing=${entry.seeing} trans=${entry.transparency} → 7TimerMod=${_sgCenter7TimerMod.toFixed(3)}`);
    } catch (e) {
        if (e.name !== 'AbortError') _sgCenter7TimerMod = 1.0;  // neutral on error
    }
}

// ── Internal: full refresh (fetch + draw) ────────────────────────
function _sgRefresh() {
    if (!_sgOverlayEnabled || !leafletMapInstance) return;

    const { lat, lon } = _sgGetGpsCenter();

    if (_sgFetchController) _sgFetchController.abort();
    _sgFetchController = new AbortController();
    const signal = _sgFetchController.signal;

    // ① Compute solar altitude synchronously (no network, no latency)
    _sgCenterSolarAlt    = _sgComputeSolarAltitude(lat, lon);
    _sgCenterDarknessMod = _sgDarknessModifier(_sgCenterSolarAlt);
    // Update the darkness status chip in the legend pill immediately
    const darknessEl = document.getElementById('sgDarknessStatus');
    if (darknessEl) {
        const { text, cls } = _sgDarknessLabel(_sgCenterSolarAlt, lat, lon);
        darknessEl.textContent = text;
        darknessEl.className   = `text-[8px] font-bold uppercase tracking-widest text-center mt-0.5 ${cls}`;
    }

    // ② Compute tonight's astronomical night window (pure math, no API needed)
    _sgTonightIndices = _sgComputeTonightHourIndices(lat, lon);

    // ③ Clear session-scoped LP tile cache for fresh results
    _sgLpTileFetchMap.clear();

    const points = _sgSampleGrid(lat, lon, _sgOverlayRadiusKm);
    _sgSyncCanvasSize();
    _sgDrawLoadingRing(lat, lon);

    // ④ Run all three centre-calibration fetches in parallel with the grid:
    //    • AOD (aerosol optical depth)
    //    • 7Timer ASTRO seeing/transparency
    //    • Grid weather + LP tile scores
    // AOD and 7Timer write globals consumed by _sgPointScore.
    Promise.all([
        _sgFetchCenterAod(lat, lon, signal),
        _sgFetch7TimerCalibration(lat, lon, signal),
        _sgFetchGridScores(points, signal)
    ]).then(([,, samples]) => {
        if (!_sgOverlayEnabled) return;
        _sgHeatSamples = samples;
        // Update legend pill: moon phase + best window (centre point is always index 0)
        if (samples.length > 0 && samples[0].hourlyScores?.length > 0) {
            _sgUpdateLegendPillInfo(samples[0].hourlyScores);
        } else {
            _sgUpdateLegendPillInfo([]);
        }
        _sgDrawHeatCanvas();
    }).catch(err => {
        if (err.name !== 'AbortError') console.warn('[SG-Heatmap] fetch error:', err);
    });
}

// ── Internal: instant loading ring before fetch completes ────────
function _sgDrawLoadingRing(lat, lon) {
    if (!_sgHeatCanvas || !leafletMapInstance) return;
    const ctx = _sgHeatCanvas.getContext('2d');
    ctx.clearRect(0, 0, _sgHeatCanvas.width, _sgHeatCanvas.height);
    const pt = leafletMapInstance.latLngToContainerPoint(L.latLng(lat, lon));
    const rPx = _sgKmToPixels(leafletMapInstance, lat, lon, _sgOverlayRadiusKm);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(167,139,250,0.45)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
}

// ── Internal: Fibonacci spiral sampling ──────────────────────────
// Returns array of { lat, lon } covering a circle of radiusKm
function _sgSampleGrid(centerLat, centerLon, radiusKm) {
    // Adaptive point count
    let n;
    if      (radiusKm <= 50)  n = 13;
    else if (radiusKm <= 100) n = 19;
    else if (radiusKm <= 200) n = 27;
    else if (radiusKm <= 400) n = 37;
    else                      n = 49;

    const golden = Math.PI * (3 - Math.sqrt(5)); // golden angle
    const R_EARTH = 6371;
    const points  = [];

    // Always include centre
    points.push({ lat: centerLat, lon: centerLon });

    for (let i = 1; i < n; i++) {
        const r     = radiusKm * Math.sqrt(i / (n - 1));
        const theta = i * golden;

        // Convert polar (r, theta) on the sphere to lat/lon offset
        const dLat = (r / R_EARTH) * (180 / Math.PI) * Math.cos(theta);
        const dLon = (r / R_EARTH) * (180 / Math.PI) * Math.sin(theta)
                     / Math.cos(centerLat * Math.PI / 180);

        points.push({
            lat: Math.max(-85, Math.min(85, centerLat + dLat)),
            lon: ((centerLon + dLon + 540) % 360) - 180
        });
    }
    return points;
}

// ── Internal: extract one hour's weather object from hourly arrays ───────────
function _sgExtractHourlySlot(hourly, index) {
    if (!hourly) return null;
    const idx = Math.max(0, Math.min(index, (hourly.time?.length ?? 1) - 1));
    return {
        cloud_cover:          hourly.cloud_cover?.[idx]          ?? 50,
        precipitation:        hourly.precipitation?.[idx]        ?? 0,
        relative_humidity_2m: hourly.relative_humidity_2m?.[idx] ?? 70,
        temperature_2m:       hourly.temperature_2m?.[idx]       ?? 15,
        dew_point_2m:         hourly.dew_point_2m?.[idx]         ?? 10,
        wind_speed_10m:       hourly.wind_speed_10m?.[idx]       ?? 5,
        wind_speed_80m:       hourly.wind_speed_80m?.[idx]       ?? 10,
        wind_speed_180m:      hourly.wind_speed_180m?.[idx]      ?? 12,
        weather_code:         hourly.weather_code?.[idx]         ?? 0,
    };
}

// ── Internal: fetch tonight's hourly forecast for each grid point ─────────────
// Replaces current-conditions mode with a 48-h hourly forecast.
// If no tonight hours are available (polar summer / early morning), falls back
// to the current UTC hour in the hourly data.
async function _sgFetchGridScores(points, signal) {
    const FIELDS = 'cloud_cover,precipitation,relative_humidity_2m,' +
                   'temperature_2m,dew_point_2m,' +
                   'wind_speed_10m,wind_speed_80m,wind_speed_180m,weather_code';

    const nightIndices = _sgTonightIndices;   // [{index, timeStr}] set in _sgRefresh
    const hasNight     = nightIndices.length > 0;

    // Fallback index when no astronomical night is found (polar summer / daytime)
    const now          = new Date();
    const base         = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const fallbackIdx  = Math.min(47, Math.floor((now.getTime() - base.getTime()) / 3600000));

    // Kick off ALL LP tile fetches immediately — they run in parallel
    const bortleJobs = points.map(pt =>
        _sgSampleBortle(pt.lat, pt.lon, signal).catch(() => null)
    );

    const results = [];
    const CHUNK   = 5;

    for (let i = 0; i < points.length; i += CHUNK) {
        const slice = points.slice(i, i + CHUNK);

        const [weatherBatch, bortleSlice] = await Promise.all([
            Promise.allSettled(
                slice.map(pt =>
                    fetch(
                        `https://api.open-meteo.com/v1/forecast` +
                        `?latitude=${pt.lat.toFixed(4)}&longitude=${pt.lon.toFixed(4)}` +
                        `&hourly=${FIELDS}&forecast_days=2&wind_speed_unit=ms&timezone=UTC`,
                        { signal }
                    )
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null)
                )
            ),
            Promise.all(bortleJobs.slice(i, i + CHUNK))
        ]);

        slice.forEach((pt, j) => {
            const json   = weatherBatch[j].status === 'fulfilled' ? weatherBatch[j].value : null;
            const bortle = bortleSlice[j] ?? null;
            const elev   = json?.elevation ?? 0;
            const hourly = json?.hourly   || null;

            const hourlyScores = [];
            let score;

            if (hasNight && hourly) {
                // Score every tonight hour — darkness mod forced to 1.0 (it IS night)
                nightIndices.forEach(({ index: idx, timeStr }) => {
                    const h = _sgExtractHourlySlot(hourly, idx);
                    hourlyScores.push({
                        timeStr,
                        score:    _sgPointScore(h, bortle, elev, 1.0),
                        cloud:    h?.cloud_cover          ?? null,
                        humidity: h?.relative_humidity_2m ?? null,
                    });
                });
                score = hourlyScores.reduce((a, b) => a + b.score, 0) / hourlyScores.length;
            } else {
                // Fallback: use current hour (daytime or polar summer)
                const h = hourly ? _sgExtractHourlySlot(hourly, fallbackIdx) : null;
                score = _sgPointScore(h, bortle, elev);
            }

            results.push({
                lat:   pt.lat,
                lon:   pt.lon,
                score: Math.max(0, Math.min(100, score)),
                bortle,
                hourlyScores
            });
        });

        if (i + CHUNK < points.length) await new Promise(res => setTimeout(res, 80));
    }
    return results;
}

// ── Internal: full multi-modal point score ───────────────────────
//
//  DATA SOURCES (7 signals per point + 4 centre-calibration globals):
//    Per-point (Open-Meteo):  cloud, precip, humidity, dew point,
//                             wind @10m/80m/180m, weather code, elevation
//    Per-point (LP tile):     Bortle 1–9 from djlorenz Falchi 2022
//    Centre globals (shared): _sgCenterAodMod     – aerosol/smoke (Open-Meteo AQ)
//                             _sgCenter7TimerMod  – ASTRO seeing/transparency (7Timer)
//                             _sgCenterDarknessMod – solar altitude twilight gate
//                             _sgMoonIllumination() – synodic moon phase
//
//  SCORE FORMULA:
//    atmosphericScore = cloud(50%) + precip(20%) + hum(15%) + dewDep(15%) + elevBonus
//    atmosphericScore ×= (0.70 + 0.30 × _sgCenter7TimerMod)   ← 7Timer calibration
//    lpScore          = Bortle → 0–100
//    baseScore        = atmosphericScore × 0.60 + lpScore × 0.40
//    finalScore       = baseScore × seeingMod × wcPenalty × moonMod × aodMod × darknessMod
//
// forceDarkMod: optional — pass 1.0 when scoring tonight's hours (sun is below -18°)
function _sgPointScore(current, bortle, elev, forceDarkMod) {
    const cloud   = current?.cloud_cover          ?? 50;   // 0–100 %
    const precip  = current?.precipitation        ?? 0;    // mm/h
    const hum     = current?.relative_humidity_2m ?? 70;   // %
    const wind10  = current?.wind_speed_10m       ?? 5;    // m/s  surface
    const wind80  = current?.wind_speed_80m       ?? 10;   // m/s  upper boundary layer
    const wind180 = current?.wind_speed_180m      ?? 12;   // m/s  near jet-stream
    const wcode   = current?.weather_code         ?? 0;
    const temp    = current?.temperature_2m       ?? 15;   // °C
    const dew     = current?.dew_point_2m         ?? 10;   // °C
    const elevM   = elev                          ?? 0;    // metres ASL

    // ── Atmospheric transparency (per-point weather) ──────────────
    const cloudScore  = Math.max(0, 100 - cloud);

    const humScore    = hum <= 50 ? 100
                      : hum <= 70 ? 100 - (hum - 50) * 2.5
                      : hum <= 90 ? 50  - (hum - 70) * 2.0
                      : 10;

    const precipScore = precip === 0 ? 100
                      : precip < 0.1  ? 75
                      : precip < 0.5  ? 40
                      : 5;

    // Dew point depression: temp − dew < 3°C = fog / dew on optics imminent
    const dewDep   = temp - dew;
    const dewScore = dewDep >= 10 ? 100
                   : dewDep >=  5 ? 60 + (dewDep - 5)  * 8
                   : dewDep >=  3 ? 30 + (dewDep - 3) * 15
                   : 10;

    // Elevation: less atmosphere, drier air (max +6 pts at ≥1000 m)
    const elevBonus = Math.min(6, elevM / 167);

    let atmosphericScore = Math.min(100,
        cloudScore * 0.50 + precipScore * 0.20 + humScore * 0.15 + dewScore * 0.15 + elevBonus
    );

    // ── 7Timer ASTRO cross-calibration ───────────────────────────
    // Blends 30% of 7Timer's independent seeing/transparency model
    // into the atmospheric score.  Range: 0.70–1.00.
    atmosphericScore = atmosphericScore * (0.70 + 0.30 * _sgCenter7TimerMod);

    // ── Light pollution (per-point LP tile) ───────────────────────
    const lpScore   = (bortle !== null) ? _sgBortleToScore(bortle) : atmosphericScore;
    const baseScore = (bortle !== null)
        ? atmosphericScore * 0.60 + lpScore * 0.40
        : atmosphericScore;

    // ── Multipliers ───────────────────────────────────────────────
    // Seeing: worst of three wind levels wins.
    // 10m = surface shear, 80m = boundary layer, 180m = jet-stream proximity.
    const s10  = wind10  <=  3 ? 1.0 : wind10  <=  7 ? 1.0 - (wind10  -  3) * 0.040 : 0.84;
    const s80  = wind80  <= 10 ? 1.0 : wind80  <= 25 ? 1.0 - (wind80  - 10) * 0.012 : 0.82;
    const s180 = wind180 <= 20 ? 1.0 : wind180 <= 40 ? 1.0 - (wind180 - 20) * 0.010 : 0.80;
    const seeingMod = Math.min(s10, s80, s180);

    // Weather code hard penalties
    const wcPenalty = wcode >= 95 ? 0.30
                    : wcode >= 80 ? 0.60
                    : wcode >= 61 ? 0.75
                    : wcode >= 51 ? 0.88
                    : 1.0;

    // Moon: full moon reduces effective sky darkness by up to 30%
    const moonMod = 1 - _sgMoonIllumination() * 0.30;

    // Aerosol modifier (wildfire smoke, Saharan dust — regional, set at centre)
    const aodMod = _sgCenterAodMod;

    // Darkness gate: use forced value when scoring known-night hours, otherwise current state
    const darkMod = (forceDarkMod !== undefined) ? forceDarkMod : _sgCenterDarknessMod;

    return Math.max(0, Math.min(100,
        baseScore * seeingMod * wcPenalty * moonMod * aodMod * darkMod
    ));
}

// ── Internal: draw gradient blobs on canvas ───────────────────────
function _sgDrawHeatCanvas() {
    if (!_sgHeatCanvas || !leafletMapInstance) return;
    if (_sgDrawPending) return;
    _sgDrawPending = true;
    requestAnimationFrame(() => {
        _sgDrawPending = false;
        _sgSyncCanvasSize();

        const ctx = _sgHeatCanvas.getContext('2d');
        const W   = _sgHeatCanvas.width;
        const H   = _sgHeatCanvas.height;
        ctx.clearRect(0, 0, W, H);

        if (_sgHeatSamples.length === 0) return;

        // Use GPS center for blob radius so scale is anchored to the user's location
        const { lat: gLat, lon: gLon } = _sgGetGpsCenter();
        const blobKm = _sgOverlayRadiusKm / Math.sqrt(_sgHeatSamples.length) * 2.2;
        const blobRadiusPx = Math.max(40, _sgKmToPixels(leafletMapInstance, gLat, gLon, blobKm));

        _sgHeatSamples.forEach(sample => {
            const pt = leafletMapInstance.latLngToContainerPoint(
                L.latLng(sample.lat, sample.lon)
            );
            const { r, g, b } = _sgScoreToRgb(sample.score);
            const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, blobRadiusPx);
            // Solid core fading out — no mix-blend-mode, pure alpha transparency
            grad.addColorStop(0,    `rgba(${r},${g},${b},0.82)`);
            grad.addColorStop(0.45, `rgba(${r},${g},${b},0.45)`);
            grad.addColorStop(1,    `rgba(${r},${g},${b},0.00)`);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, blobRadiusPx, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
        });

        // ── Score labels (only when _sgShowLabels is on) ─────────────────────
        _sgLabelHitboxes = [];
        if (_sgShowLabels) {
            const fontSize = Math.max(10, Math.min(14, blobRadiusPx / 4));
            const hitR     = Math.max(fontSize * 2.5, 22);  // tap target radius (px)
            ctx.font = `bold ${fontSize}px system-ui,sans-serif`;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';

            _sgHeatSamples.forEach(sample => {
                const pt = leafletMapInstance.latLngToContainerPoint(
                    L.latLng(sample.lat, sample.lon)
                );
                const { r, g, b } = _sgScoreToRgb(sample.score);
                const label = Math.round(sample.score) + '%';
                // Dark halo for legibility
                ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                ctx.lineWidth   = fontSize * 0.35;
                ctx.lineJoin    = 'round';
                ctx.strokeText(label, pt.x, pt.y);
                // Coloured fill matching the blob
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillText(label, pt.x, pt.y);
                // Store hitbox for click detection (also carries data for bottom HUD)
                _sgLabelHitboxes.push({
                    x: pt.x, y: pt.y,
                    lat: sample.lat, lon: sample.lon,
                    score:        sample.score,
                    bortle:       sample.bortle       ?? null,
                    hourlyScores: sample.hourlyScores ?? [],
                    r: hitR
                });
            });
            // Enable pointer events so clicks are received
            _sgHeatCanvas.style.pointerEvents = 'auto';
        } else {
            // No labels → pass all touch/click events through to the map
            _sgHeatCanvas.style.pointerEvents = 'none';
        }
    });
}

// ── Public: show/hide canvas (called from aap.js layer toggle) ───────────────
function sgSetCanvasVisible(visible) {
    if (_sgHeatCanvas) {
        _sgHeatCanvas.style.display = visible ? 'block' : 'none';
    }
    if (_sgLpTileLayer && leafletMapInstance) {
        if (visible) {
            if (!leafletMapInstance.hasLayer(_sgLpTileLayer)) {
                leafletMapInstance.addLayer(_sgLpTileLayer);
            }
        } else {
            leafletMapInstance.removeLayer(_sgLpTileLayer);
        }
    }
}

// ── Public: toggle score labels (called from aap.js labels toggle) ──────────
function sgSetShowLabels(on) {
    _sgShowLabels = !!on;
    if (_sgHeatSamples.length > 0) _sgDrawHeatCanvas();
}

// ── Internal: score → RGB (screen-blend palette) ─────────────────
// score 0 = deep red, 30 = orange, 50 = amber, 70 = emerald, 90+ = violet
function _sgScoreToRgb(score) {
    const stops = [
        { t: 0,   r: 220, g: 38,  b: 38  },   // red
        { t: 30,  r: 234, g: 88,  b: 12  },   // orange
        { t: 50,  r: 217, g: 119, b: 6   },   // amber
        { t: 70,  r: 16,  g: 185, b: 129 },   // emerald
        { t: 90,  r: 124, g: 58,  b: 237 },   // violet
        { t: 100, r: 167, g: 139, b: 250 },   // light violet
    ];
    const s = Math.max(0, Math.min(100, score));
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (s >= stops[i].t && s <= stops[i + 1].t) {
            lo = stops[i]; hi = stops[i + 1]; break;
        }
    }
    const t = lo.t === hi.t ? 0 : (s - lo.t) / (hi.t - lo.t);
    return {
        r: Math.round(lo.r + (hi.r - lo.r) * t),
        g: Math.round(lo.g + (hi.g - lo.g) * t),
        b: Math.round(lo.b + (hi.b - lo.b) * t),
    };
}

// ── Internal: Bortle class → plain-English label for the spot HUD ─
function _sgBortleLabel(bortle) {
    if (bortle === null || bortle === undefined)
        return { short: 'Unknown', icon: 'fa-question', color: '#64748b' };
    if (bortle <= 2) return { short: 'Dark Sky',  icon: 'fa-moon',     color: '#a78bfa' };
    if (bortle <= 4) return { short: 'Rural',     icon: 'fa-tree',     color: '#34d399' };
    if (bortle <= 5) return { short: 'Suburban',  icon: 'fa-house',    color: '#fbbf24' };
    if (bortle <= 7) return { short: 'Town',      icon: 'fa-building', color: '#f97316' };
                     return { short: 'City',      icon: 'fa-city',     color: '#f87171' };
}

// ── Public: show bottom HUD compact pill for a tapped score label ─
//  Only the compact bar is shown initially. Details expand on "More".
function sgShowSpotDetail(hitbox) {
    const hud = document.getElementById('sgSpotHUD');
    if (!hud) return;
    _sgSpotDetailData = hitbox;

    const sc = Math.round(hitbox.score || 0);
    const { r, g, b } = _sgScoreToRgb(sc);

    // Score chip in compact bar
    const scoreNumEl = document.getElementById('sgSpotScoreNum');
    if (scoreNumEl) { scoreNumEl.textContent = sc + '%'; scoreNumEl.style.color = `rgb(${r},${g},${b})`; }
    const scoreBadgeEl = document.getElementById('sgSpotScoreBadge');
    if (scoreBadgeEl) {
        scoreBadgeEl.style.background  = `rgba(${r},${g},${b},0.15)`;
        scoreBadgeEl.style.borderColor = `rgba(${r},${g},${b},0.4)`;
    }

    // Best window label (compact bar)
    const hrs   = hitbox.hourlyScores || [];
    const win   = _sgComputeTonightBestWindow(hrs);
    const winEl = document.getElementById('sgSpotBestWindowLabel');
    if (winEl) winEl.textContent = win ? win.label : '--';

    // Pre-populate hidden details so they're ready when expanded
    const moonPct  = Math.round(_sgMoonIllumination() * 100);
    const moonEl   = document.getElementById('sgSpotMoon');
    if (moonEl) moonEl.textContent = moonPct + '%';

    const bortleEl   = document.getElementById('sgSpotBortle');
    const bortleIcon = document.getElementById('sgSpotBortleIcon');
    const bl = _sgBortleLabel(hitbox.bortle);
    if (bortleEl)   { bortleEl.textContent = bl.short; bortleEl.style.color = bl.color; }
    if (bortleIcon) { bortleIcon.className = `fa-solid ${bl.icon} text-[11px] block mb-1`; bortleIcon.style.color = bl.color; }

    const bestHour = win ? hrs[win.startIdx] : (hrs[0] || null);
    const cloudEl  = document.getElementById('sgSpotCloud');
    if (cloudEl) cloudEl.textContent = (bestHour?.cloud !== null && bestHour?.cloud !== undefined)
        ? Math.round(bestHour.cloud) + '%' : '--%';
    const humEl = document.getElementById('sgSpotHumidity');
    if (humEl) humEl.textContent = (bestHour?.humidity !== null && bestHour?.humidity !== undefined)
        ? Math.round(bestHour.humidity) + '%' : '--%';

    // Hourly strip
    const strip = document.getElementById('sgSpotHourlyStrip');
    if (strip) {
        if (hrs.length > 0) {
            const bestStartIdx = win ? win.startIdx : 0;
            strip.innerHTML = hrs.map((h, i) => {
                const { r: hr, g: hg, b: hb } = _sgScoreToRgb(h.score);
                const label  = h.timeStr ? h.timeStr.slice(11, 16) : ('H' + i);
                const isBest = (i === bestStartIdx || i === bestStartIdx + 1);
                const bg     = isBest ? 'rgba(124,58,237,0.28)' : 'rgba(30,27,46,0.9)';
                const border = isBest ? '1px solid rgba(139,92,246,0.55)' : '1px solid transparent';
                return `<div style="display:flex;flex-direction:column;align-items:center;` +
                       `min-width:46px;border-radius:10px;padding:6px 4px;background:${bg};border:${border};">` +
                       `<span style="font-size:9px;color:#64748b;line-height:1.2">${label}</span>` +
                       `<span style="font-size:13px;font-weight:900;color:rgb(${hr},${hg},${hb});line-height:1.3">${Math.round(h.score)}%</span>` +
                       `</div>`;
            }).join('');
        } else {
            strip.innerHTML = '<span style="font-size:11px;color:#64748b;padding:6px 0">No night hours in range</span>';
        }
    }

    // Ensure details panel is collapsed and chevron points up (ready for expand)
    const detailsPanel = document.getElementById('sgSpotDetailsPanel');
    const chevron      = document.getElementById('sgSpotMoreChevron');
    if (detailsPanel) detailsPanel.classList.add('hidden');
    if (chevron)      chevron.style.transform = 'rotate(0deg)';

    // Slide up (compact pill only)
    hud.classList.remove('hidden');
    hud.style.transform  = 'translateY(100%)';
    hud.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { hud.style.transform = 'translateY(0)'; });
    });
}

// ── Public: toggle the expanded details panel ─────────────────────
//  Called by the "More / Less" button inside the compact pill bar.
function sgToggleSpotDetail() {
    const panel   = document.getElementById('sgSpotDetailsPanel');
    const chevron = document.getElementById('sgSpotMoreChevron');
    const btn     = document.getElementById('sgSpotMoreBtn');
    if (!panel) return;

    const isExpanded = !panel.classList.contains('hidden');

    if (isExpanded) {
        // Collapse
        panel.classList.add('hidden');
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        if (btn)     btn.querySelector('span').textContent = 'More';
    } else {
        // Expand
        panel.classList.remove('hidden');
        if (chevron) chevron.style.transform = 'rotate(180deg)';
        if (btn)     btn.querySelector('span').textContent = 'Less';
    }
}

// ── Public: dismiss spot detail HUD completely ────────────────────
function sgHideSpotDetail() {
    const hud = document.getElementById('sgSpotHUD');
    if (!hud || hud.classList.contains('hidden')) return;
    hud.style.transition = 'transform 0.18s cubic-bezier(0.4,0,0.2,1)';
    hud.style.transform  = 'translateY(100%)';
    setTimeout(() => {
        hud.classList.add('hidden');
        hud.style.transform = '';
        // Reset expanded state for next open
        const panel   = document.getElementById('sgSpotDetailsPanel');
        const chevron = document.getElementById('sgSpotMoreChevron');
        const btn     = document.getElementById('sgSpotMoreBtn');
        if (panel)   panel.classList.add('hidden');
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        if (btn)     { const sp = btn.querySelector('span'); if (sp) sp.textContent = 'More'; }
        _sgSpotDetailData = null;
    }, 200);
}

// ── Internal: convert km to pixels at given lat/lon ───────────────
function _sgKmToPixels(map, lat, lon, km) {
    if (!map || km <= 0) return 80;
    try {
        const p1 = map.latLngToContainerPoint(L.latLng(lat, lon));
        const p2 = map.latLngToContainerPoint(
            L.latLng(lat + (km / 111.32), lon)
        );
        return Math.max(20, Math.abs(p2.y - p1.y));
    } catch (_) { return 80; }
}


// ═══════════════════════════════════════════════════════════════════════════
//  ROUTE PLANNER — OSRM  (Open Source Routing Machine)
//
//  Uses the FREE public OSRM demo server: router.project-osrm.org
//  • No API key required
//  • Powered by OpenStreetMap data
//  • Supports driving and foot (walking) profiles
//  • Returns up to 3 alternative routes with full GeoJSON geometry
//
//  Public entry points (called from aap.js settings wiring):
//    sgActivateRoute({ start:[lat,lon], end:[lat,lon], mode:'car'|'foot' })
//    sgClearRoute()
// ═══════════════════════════════════════════════════════════════════════════

let _rteLayers = [];    // L.polyline instances currently on the map
let _rteAbort  = null;  // AbortController for the in-flight OSRM request

// ── Coordinate helpers ────────────────────────────────────────────────────

/**
 * Parse a "lat, lon" string → [lat, lon] number array, or null on failure.
 * Accepts both comma and whitespace as separator.
 */
/**
 * Parse a coordinate string → [lat, lon] or null.
 *
 * Accepts two formats:
 *  • Decimal:  "41.4863, 2.0351"
 *  • DMS:      "41°29'10.7"N 2°02'06.5"E"
 *              (degree/minute/second symbols + N/S/E/W hemisphere letter)
 */
function _rteParseLatLon(str) {
    if (!str) return null;
    const s = String(str).trim();

    // ── Format A: decimal "lat, lon" ──────────────────────────────────
    const decM = s.match(/^([-\d.]+)\s*[,\s]\s*([-\d.]+)$/);
    if (decM) {
        const lat = parseFloat(decM[1]);
        const lon = parseFloat(decM[2]);
        if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)
            return [lat, lon];
    }

    // ── Format B: DMS "41°29'10.7"N 2°02'06.5"E" ─────────────────────
    // Handles degree (°º), minute (' ′), second (" ″ or omitted), N/S/E/W
    const dmsRx = /(\d+)\s*[°º]\s*(\d+)\s*['′']\s*(\d+(?:\.\d+)?)\s*["″]?\s*([NSEWnsew])/g;
    const parts = [...s.matchAll(dmsRx)];
    if (parts.length >= 2) {
        const toDecimal = (d, m, sec, dir) => {
            const v = +d + +m / 60 + +sec / 3600;
            return (dir.toUpperCase() === 'S' || dir.toUpperCase() === 'W') ? -v : v;
        };
        let lat = null, lon = null;
        for (const p of parts) {
            const dir = p[4].toUpperCase();
            const val = toDecimal(p[1], p[2], p[3], dir);
            if (dir === 'N' || dir === 'S') lat = val;
            else lon = val;
        }
        if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)
            return [lat, lon];
    }

    return null;
}

/**
 * Try to extract start/end coords from a Google Maps direction URL.
 * Returns { start:[lat,lon], end:[lat,lon] } or null.
 *
 * Priority for resolving place-name waypoints:
 *  1. Coords already in the path segment (numeric)
 *  2. Coords encoded in Google's data blob (!1d{lon}!2d{lat} pairs)  ← new
 *  3. Nominatim geocoding as last-resort fallback
 *
 * Formats handled:
 *  A. /maps/dir/lat,lon/lat,lon/         → numeric coords in path
 *  B. /maps/dir/Place+Name/Other/        → resolved via blob then Nominatim
 *  C. ?saddr=lat,lon&daddr=lat,lon       → legacy query-param format
 */
async function _rteParseGoogleMapsUrl(url) {
    let parsed;
    try { parsed = new URL(url.trim()); } catch (_) { return null; }

    const path   = parsed.pathname;
    const params = parsed.searchParams;

    // ── Format C: legacy ?saddr / ?daddr ──────────────────────────────
    if (params.get('saddr') && params.get('daddr')) {
        const s = _rteParseLatLon(params.get('saddr'));
        const e = _rteParseLatLon(params.get('daddr'));
        if (s && e) return { start: s, end: e };
    }

    // ── Formats A & B: /maps/dir/{A}/{B}/... ──────────────────────────
    const dirMatch = path.match(/\/maps\/dir\/([^/]+)\/([^/]+)/);
    if (dirMatch) {
        const decode = raw => decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
        const a = decode(dirMatch[1]);
        const b = decode(dirMatch[2]);

        const coordA = _rteParseLatLon(a);
        const coordB = _rteParseLatLon(b);

        // Both already numeric — done immediately, no network needed
        if (coordA && coordB) return { start: coordA, end: coordB };

        // Extract encoded waypoint coords from Google's embedded data blob.
        // Google stores !1d{lon}!2d{lat} in the data path segment for every
        // geocoded waypoint, in the same order as the /dir/ path segments.
        const blobCoords = [...path.matchAll(/!1d([-\d.]+)!2d([-\d.]+)/g)]
            .map(m => [parseFloat(m[2]), parseFloat(m[1])]);  // → [lat, lon]

        let blobIdx = 0;
        const fromBlob = coord => coord || (blobCoords[blobIdx++] ?? null);

        const resolvedA = fromBlob(coordA);
        const resolvedB = fromBlob(coordB);

        // Got both from blob (or original coords) — no Nominatim call needed
        if (resolvedA && resolvedB) return { start: resolvedA, end: resolvedB };

        // Last resort: Nominatim geocoding for any still-missing place name
        const geocodePlace = async name => {
            try {
                const r = await fetch(
                    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1`,
                    { headers: { 'Accept-Language': 'en' } }
                );
                const j = await r.json();
                if (!j.length) return null;
                return [parseFloat(j[0].lat), parseFloat(j[0].lon)];
            } catch (_) { return null; }
        };

        const [finalA, finalB] = await Promise.all([
            resolvedA || geocodePlace(a),
            resolvedB || geocodePlace(b),
        ]);
        if (finalA && finalB) return { start: finalA, end: finalB };
    }

    return null;
}

// ── Formatting helpers ────────────────────────────────────────────────────

/** Format metres → "1.2 km" or "800 m". */
function _rteFormatDistance(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

/** Format seconds → "12 min" or "1 h 5 min". */
function _rteFormatDuration(s) {
    const h   = Math.floor(s / 3600);
    const min = Math.round((s % 3600) / 60);
    return h > 0 ? `${h} h ${min} min` : `${min} min`;
}

// ── OSRM fetch ────────────────────────────────────────────────────────────

/**
 * Fetch up to 3 routes from the OSRM public demo server.
 * @param {[number,number]} startLL  [lat, lon]
 * @param {[number,number]} endLL    [lat, lon]
 * @param {'driving'|'foot'} profile
 * @param {AbortSignal} signal
 * @returns {Array<{geometry, distance, duration}>}  GeoJSON geometry + stats
 */
async function _rteFetchOSRM(startLL, endLL, profile, signal) {
    // OSRM uses lon,lat order (NOT lat,lon)!
    const coords = `${startLL[1]},${startLL[0]};${endLL[1]},${endLL[0]}`;
    // alternatives=3 is the safe maximum the public OSRM demo server accepts.
    // Requesting higher values (4, 5…) causes HTTP 400 Bad Request.
    const url = `https://router.project-osrm.org/route/v1/${profile}/${coords}`
              + `?alternatives=3&overview=full&geometries=geojson`;

    const resp = await fetch(url, { signal });
    if (!resp.ok) {
        // Try to include the server's own error message for easier debugging
        let detail = '';
        try {
            const errBody = await resp.clone().json();
            detail = errBody.message || errBody.code || '';
        } catch (_) {}
        throw new Error(`OSRM error ${resp.status}${detail ? ': ' + detail : ''}`);
    }

    const data = await resp.json();
    if (data.code !== 'Ok' || !data.routes?.length) {
        throw new Error(data.message || 'No route found between those points');
    }

    return data.routes.map(r => ({
        geometry: r.geometry,   // GeoJSON LineString {type, coordinates}
        distance: r.distance,   // metres
        duration: r.duration,   // seconds
    }));
}

// ── Map drawing ───────────────────────────────────────────────────────────

// Pink app-theme colour per travel mode (all routes use the same colour)
const _RTE_COLORS = {
    car:  '#ec4899',   // pink-500
    foot: '#f472b6',   // pink-400
};

/**
 * Draw route polylines on the Leaflet map.
 * Uses a dedicated 'routePane' at z-350 so routes sit BELOW Leaflet's
 * overlayPane (z-400) and markerPane (z-600) — keeping all map pins visible.
 * All routes (best + alternatives) use identical styling.
 */
function _rteDraw(routes, mode) {
    if (!leafletMapInstance) return;
    _rteClearLayers();

    // Create a dedicated pane below overlayPane (z-400) so routes never
    // cover markers, canvas overlays, or any other map elements
    if (!leafletMapInstance.getPane('routePane')) {
        const pane = leafletMapInstance.createPane('routePane');
        pane.style.zIndex      = '350';
        pane.style.pointerEvents = 'none';
    }

    const color = _RTE_COLORS[mode] || _RTE_COLORS.car;

    routes.forEach((route) => {
        // OSRM GeoJSON coords are [lon, lat]; Leaflet wants [lat, lon]
        const latlngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

        // Dark outline behind every route for contrast against light map tiles
        const shadow = L.polyline(latlngs, {
            color: '#1e1b2e', weight: 10, opacity: 0.32,
            lineJoin: 'round', lineCap: 'round',
            interactive: false, pane: 'routePane',
        }).addTo(leafletMapInstance);
        _rteLayers.push(shadow);

        const line = L.polyline(latlngs, {
            color,
            weight:  6,
            opacity: 0.90,
            lineJoin:  'round',
            lineCap:   'round',
            interactive: false,
            pane: 'routePane',
        }).addTo(leafletMapInstance);
        _rteLayers.push(line);
    });

    // Fit the viewport to the full extent of all drawn routes
    if (_rteLayers.length) {
        try {
            // Every route pushes [shadow, line] — only the coloured lines carry meaningful bounds.
            // Shadow lines are always at even indices (0, 2, 4…); coloured at odd (1, 3, 5…).
            const colourLines = _rteLayers.filter((_, i) => i % 2 === 1);
            const allBounds   = colourLines.map(l => l.getBounds());
            const combined    = allBounds.reduce((acc, b) => acc.extend(b), allBounds[0]);
            leafletMapInstance.fitBounds(combined, { padding: [56, 56] });
        } catch (_) {}
    }
}

/** Remove every route polyline from the map and clear the array. */
function _rteClearLayers() {
    if (!leafletMapInstance) return;
    _rteLayers.forEach(l => { try { leafletMapInstance.removeLayer(l); } catch (_) {} });
    _rteLayers = [];
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch routes from OSRM and render them on the map.
 * Called by aap.js rteShowRoute() after parsing the user's input.
 *
 * @param {{ start:[lat,lon], end:[lat,lon], mode:'car'|'foot' }} opts
 * @returns {{ ok:boolean, routeCount?:number, reason?:string }}
 */
async function sgActivateRoute(opts) {
    const { start, end, mode = 'car' } = opts;
    const profile = (mode === 'foot') ? 'foot' : 'driving';

    // Cancel any previous in-flight request
    if (_rteAbort) { _rteAbort.abort(); }
    _rteAbort = new AbortController();

    _rteClearLayers();
    _rteSetHUD(false);

    try {
        const routes = await _rteFetchOSRM(start, end, profile, _rteAbort.signal);
        _rteDraw(routes, mode);

        const best = routes[0];
        _rteSetHUD(true, {
            distance: _rteFormatDistance(best.distance),
            duration: _rteFormatDuration(best.duration),
            altCount: routes.length - 1,
        });

        _rteToggleSettingsClearBtn(true);

        // Persist the active route so a normal page refresh restores it.
        // A hard refresh or explicit localStorage clear simply starts fresh.
        try {
            localStorage.setItem('save2go_rte_v1', JSON.stringify({
                start, end, mode,
                routes,
                savedAt: Date.now(),
            }));
        } catch (_) { /* quota exceeded or private-browsing — silently skip */ }

        return { ok: true, routeCount: routes.length };

    } catch (err) {
        if (err.name === 'AbortError') return { ok: false, reason: 'cancelled' };
        console.warn('[Route] OSRM error:', err.message);
        return { ok: false, reason: err.message };
    }
}

/**
 * Remove all route layers from the map and hide the route HUD.
 * Safe to call when no route is active.
 */
function sgClearRoute() {
    if (_rteAbort) { _rteAbort.abort(); _rteAbort = null; }
    _rteClearLayers();
    _rteSetHUD(false);
    _rteToggleSettingsClearBtn(false);
    // Remove the persisted route so it does not restore on next page load
    try { localStorage.removeItem('save2go_rte_v1'); } catch (_) {}
}

// ── Route persistence ─────────────────────────────────────────────────────

/**
 * On page load, check localStorage for a previously saved route and re-draw it.
 * The geometry is stored in full, so no network round-trip is needed.
 * Called once from initMap() after the Leaflet instance is ready.
 */
function _rteRestoreFromStorage() {
    try {
        const raw = localStorage.getItem('save2go_rte_v1');
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.routes) || !data.routes.length) return;

        // Re-draw the geometry immediately (no network call required)
        _rteDraw(data.routes, data.mode || 'car');

        const best = data.routes[0];
        _rteSetHUD(true, {
            distance: _rteFormatDistance(best.distance),
            duration: _rteFormatDuration(best.duration),
            altCount: data.routes.length - 1,
        });
        _rteToggleSettingsClearBtn(true);
        console.log('[Route] Restored from localStorage —', data.routes.length, 'route(s)');
    } catch (err) {
        // Corrupt or incompatible data — silently discard
        console.warn('[Route] Could not restore saved route:', err.message);
        try { localStorage.removeItem('save2go_rte_v1'); } catch (_) {}
    }
}

// ── HUD helpers ───────────────────────────────────────────────────────────

/** Show or hide the floating route info pill (top-left of the map). */
function _rteSetHUD(visible, info) {
    const hud = document.getElementById('rteInfoHUD');
    if (!hud) return;
    if (!visible) { hud.classList.add('hidden'); return; }

    const distEl = document.getElementById('rteHudDistance');
    const durEl  = document.getElementById('rteHudDuration');
    const altBdg = document.getElementById('rteHudAltBadge');
    const altCnt = document.getElementById('rteHudAltCount');

    if (distEl) distEl.textContent = info.distance || '--';
    if (durEl)  durEl.textContent  = info.duration  || '--';
    if (altBdg && altCnt) {
        const hasAlt = (info.altCount || 0) > 0;
        altBdg.classList.toggle('hidden', !hasAlt);
        if (hasAlt) altCnt.textContent = `+${info.altCount} alt`;
    }
    hud.classList.remove('hidden');
}

/**
 * Toggle "Clear Route" / "Show Route" button visibility in the settings drawer.
 * show=true  → route is active   → hide Show Route, reveal Clear Route
 * show=false → no active route   → reveal Show Route, hide Clear Route
 */
function _rteToggleSettingsClearBtn(show) {
    const clearBtn = document.getElementById('rteClearBtnSettings');
    const showBtn  = document.getElementById('rteShowBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !show);
    if (showBtn)  showBtn.classList.toggle('hidden',   show);
    // Re-evaluate whether Show Route should be enabled (input might still be populated)
    if (!show && typeof rteOnInputChange === 'function') rteOnInputChange();
}
