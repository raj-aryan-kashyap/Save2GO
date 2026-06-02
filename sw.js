// ================================================================
//  sw.js  —  Save2Go V5 Service Worker
//
//  CACHING STRATEGY
//  ─────────────────
//  • App shell (HTML/JS/CSS/icons) → Cache-first, refresh in background
//  • POST requests                 → Network-only (never cache mutations)
//  • External APIs (GAS, OWM,      → Network-only (never cache live data)
//    Gemini, googleapis, etc.)
//  • Static assets from CDNs       → Cache-first (Leaflet, FA, Tailwind)
// ================================================================

const CACHE_VERSION  = 'save2go-v5-r5';
const SHELL_CACHE    = CACHE_VERSION + '-shell';
const CDN_CACHE      = CACHE_VERSION + '-cdn';

// App-shell assets to pre-cache on install
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/aap.js',
    '/map.js',
    '/itinerary.js',
    '/smart_search.js',
    '/notification.js',
    '/ai_assist.js',
    '/manifest.json',
];

// Hostname patterns that must ALWAYS go to the network (never cached)
const NETWORK_ONLY_HOSTS = [
    'script.google.com',        // GAS web-app endpoint
    'script.googleusercontent.com',
    'generativelanguage.googleapis.com',  // Gemini API
    'api.openweathermap.org',   // weather (preserved, not currently called)
    'openweathermap.org',
    'api.open-meteo.com',                 // Open-Meteo weather forecast
    'air-quality-api.open-meteo.com',     // Open-Meteo air quality
    'nominatim.openstreetmap.org',        // geocoding
    'latest.currency-api.pages.dev',      // FX rates — primary   (fawazahmed0, daily)
    'cdn.jsdelivr.net',                   // FX rates — CDN fallback (fawazahmed0, daily)
];


// ──────────────────────────────────────────────────────────────
//  INSTALL  — pre-cache app shell
// ──────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(SHELL_ASSETS))
            .catch(() => {
                // Non-fatal: shell pre-cache failure should not block SW install.
                // Assets will be cached on first use instead.
            })
            .then(() => self.skipWaiting())  // activate immediately, don't wait for old tab to close
    );
});


// ──────────────────────────────────────────────────────────────
//  ACTIVATE  — delete stale caches from previous SW versions
// ──────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== SHELL_CACHE && key !== CDN_CACHE)
                    .map(key => {
                        console.log('[SW] Deleting stale cache:', key);
                        return caches.delete(key);
                    })
            )
        ).then(() => self.clients.claim())  // take control of all open tabs immediately
    );
});


// ──────────────────────────────────────────────────────────────
//  FETCH  — route every request through the right strategy
// ──────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // ── Rule 1: POST / non-GET → always network, never cache ──────────────────
    // This covers ALL GAS mutations (update_status, ai_assist_process,
    // smart_search_process, sync_itinerary, etc.).
    if (req.method !== 'GET') {
        event.respondWith(fetch(req));
        return;
    }

    // ── Rule 2: Network-only hosts → live data, no cache ──────────────────────
    if (NETWORK_ONLY_HOSTS.some(host => url.hostname.includes(host))) {
        event.respondWith(fetch(req));
        return;
    }

    // ── Rule 3: CDN assets (Leaflet, FontAwesome, Tailwind) → cache-first ─────
    if (url.hostname === 'cdn.tailwindcss.com'
     || url.hostname === 'unpkg.com'
     || url.hostname === 'cdnjs.cloudflare.com') {
        event.respondWith(
            caches.open(CDN_CACHE).then(cache =>
                cache.match(req).then(cached => {
                    if (cached) return cached;
                    return fetch(req).then(resp => {
                        if (resp.ok) cache.put(req, resp.clone());
                        return resp;
                    });
                })
            )
        );
        return;
    }

    // ── Rule 4: App-shell assets (same origin) → cache-first + background refresh
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.open(SHELL_CACHE).then(cache =>
                cache.match(req).then(cached => {
                    // Always kick off a network fetch to refresh the cache
                    const networkFetch = fetch(req).then(resp => {
                        if (resp.ok) cache.put(req, resp.clone());
                        return resp;
                    }).catch(() => null);

                    // Return cached version immediately if available;
                    // otherwise wait for network (first visit / cold start)
                    return cached || networkFetch;
                })
            )
        );
        return;
    }

    // ── Rule 5: Everything else → plain network pass-through ──────────────────
    event.respondWith(fetch(req));
});
