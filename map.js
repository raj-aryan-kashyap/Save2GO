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
        msgEl.textContent     = 'Location permission has been denied. Please enable it in your device or browser Settings, then tap the GPS button to try again.';
        btnEl.textContent     = 'Got It';
        btnEl.onclick         = () => modal.classList.add('hidden');
    } else if (errorType === 'signal_timeout') {
        iconEl.className      = 'text-3xl text-amber-400';
        iconEl.innerHTML      = '<i class="fa-solid fa-satellite-dish"></i>';
        titleEl.textContent   = 'GPS Signal Timeout';
        msgEl.textContent     = 'Could not get a GPS fix in time. Try moving to an open area with a clear view of the sky, then tap Retry.';
        btnEl.textContent     = 'Retry';
        btnEl.onclick         = () => { modal.classList.add('hidden'); startLiveHardwareGPSTracking(); };
    } else {
        // 'unavailable' or any unknown type
        iconEl.className      = 'text-3xl text-red-500';
        iconEl.innerHTML      = '<i class="fa-solid fa-location-crosshairs"></i>';
        titleEl.textContent   = 'Location Unavailable';
        msgEl.textContent     = 'Your device could not determine its location. Check that Location Services are enabled, then tap Retry.';
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

    if (isCameraLocked) {
        compassBtn.className = "w-12 h-12 bg-slate-900 rounded-full flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px]";
    } else {
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

    // Always snap to the filtered pins — never silently no-op.
    // The previous "pinsAreAlreadyWhollyVisible" guard caused a stuck-view bug:
    // when the user narrowed the city filter from multiple cities to one, the map
    // was still zoomed out to the old multi-city extent, so the remaining city's
    // pins were technically inside currentMapBounds and the function returned
    // without re-centering.  The magnifying glass is an explicit "take me there"
    // action and should always fit/zoom regardless of the current viewport.
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
        titleWidget.className = "text-base font-black text-slate-500 line-through mt-2 truncate max-w-[220px]";
        notesWidget.className = "text-xs text-slate-500 leading-relaxed overflow-y-auto subtle-scrollbar max-h-[220px] line-through pr-1 select-none";
    } else {
        titleWidget.className = "text-base font-black text-slate-200 mt-2 truncate max-w-[220px]";
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
    backDesc.innerText = (spotObj.long_description && spotObj.long_description !== "N/A") ? spotObj.long_description : "Disclaimer: Deep background details unpopulated.";

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
    _mapDetailTrayVisible = false;  // unfreeze programmatic viewport changes
    // Restore the exact viewport the user had when they opened the tray.
    // This cancels any zoom/pan that snuck through (geocode callbacks, autoFit)
    // and ensures dismiss never changes the user's position or zoom level.
    if (_savedMapViewForTray && leafletMapInstance) {
        leafletMapInstance.setView(
            [_savedMapViewForTray.center.lat, _savedMapViewForTray.center.lng],
            _savedMapViewForTray.zoom,
            { animate: false }
        );
        _savedMapViewForTray = null;
    }
    const mapDetailTray = document.getElementById('mapDetailTrayHUD');
    if (mapDetailTray) {
        mapDetailTray.classList.add('hidden');
        mapDetailTray.classList.remove('flipped');
    }
    // Hide the dedicated tray backdrop
    const trayBg = document.getElementById('trayBlurBackdrop');
    if (trayBg) trayBg.classList.add('hidden');
    // Safety net: also clear the shared backdrop in case it was shown by an older call path
    const sharedBg = document.getElementById('dropdownBlurBackdrop');
    if (sharedBg) sharedBg.classList.add('hidden');
    const plusBtn = document.getElementById('globalFloatingActionPlusButton');
    if (plusBtn) plusBtn.classList.remove('hidden');
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
    const widget = document.getElementById('mapWeatherWidget');
    if (!widget) return;
    // The style button is a sibling inside the same flex-col items-end container
    const container = widget.parentElement;
    if (!container) return;
    const styleBtn = container.querySelector('button[onclick*="mapLayerStyleDropdownDeck"]');
    if (!styleBtn) return;
    const bw = styleBtn.getBoundingClientRect().width;
    if (bw > 0) widget.style.width = Math.round(bw) + 'px';
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

const MAP_WEATHER_USER_MIN_INTERVAL = 15 * 60 * 1000; // 15 min between real API calls
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
        if (w) _applyMapWeatherData(w);
    });
}

