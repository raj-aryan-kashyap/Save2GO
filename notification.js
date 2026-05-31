/**
 * notification.js — Save2Go PWA Notification Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles three types of local browser notifications without any backend or
 * paid services.  Notifications only fire when the app is minimised / in the
 * background (document.visibilityState === 'hidden').  If the user kills the
 * app completely, no JS is running so no notifications can be sent — this is
 * the desired behaviour.
 *
 * NOTIFICATION TYPES
 *   1. Proximity Alert    — N saved spots within radius of current GPS fix
 *   2. Schedule Reminder  — 5 h / 3 h / 1 h / 30 min warnings before sch_start
 *   3. Tardiness Warning  — booking time (parsed from notes) has passed
 *
 * HOW TO HOOK IN (add to your main init after the user is logged in)
 * ─────────────────────────────────────────────────────────────────────────────
 *   // In aap.js → initializeSessionDashboard() or equivalent:
 *   if (typeof initNotifications === 'function') initNotifications();
 *
 *   // On logout / profile switch:
 *   if (typeof stopNotificationLoop === 'function') stopNotificationLoop();
 *
 * SERVICE WORKER ACTION BUTTONS
 * ─────────────────────────────────────────────────────────────────────────────
 *   Rich notifications (View Details / Navigate buttons) require the SW snippet
 *   at the very bottom of this file to be appended to your existing sw.js.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// ── 1. CONFIGURATION — change thresholds here, nowhere else ────────────────
// ═══════════════════════════════════════════════════════════════════════════

const _NOTIF_CONFIG = Object.freeze({

    /** Main polling cadence.  60 s is a good balance between responsiveness
     *  and battery life.  Do not go below 30 s on mobile. */
    pollIntervalMs: 60_000,

    /** Proximity: radius in metres around the user's GPS position. */
    proximityRadiusM: 500,

    /** Schedule: lead-time thresholds in minutes before sch_start.
     *  Each threshold fires exactly once per spot per day. */
    scheduleLeadTimesMin: [300, 180, 60, 30],

    /** Tardiness: grace period in minutes before flagging "you're late". */
    tardinessGraceMin: 5,

    /** Per-type deduplication TTLs (milliseconds).
     *  A notification with the same key will not fire again until its TTL expires. */
    dedupTtl: {
        proximity:  2  * 60 * 60 * 1000,   // 2 h
        schedule:   23 * 60 * 60 * 1000,    // 23 h  (once per day per threshold)
        tardiness:  30 * 60 * 1000,         // 30 min (you're STILL late — repeat)
    },

    /** GPS fix is considered stale after this many ms; skip proximity check. */
    gpsStaleThresholdMs: 15 * 60 * 1000,   // 15 min

    /** localStorage key map.  Keep in sync with map.js / aap.js. */
    keys: {
        spots:       'compass_cache',             // travelSpots JSON array
        itineraries: 'compass_saved_itineraries', // savedItineraries JSON array
        userLat:     'compass_user_live_lat',     // float string
        userLng:     'compass_user_live_lng',     // float string
        userGpsTs:   'compass_user_live_ts',      // epoch ms string
        dedupStore:  'compass_notif_dedup',       // { key: expiresAt } map
    },
});

// ═══════════════════════════════════════════════════════════════════════════
// ── 2. NOTIFICATION ICONS & BANNERS ────────────────────────────────────────
//
//  Web notifications are rendered natively by the OS — no custom HTML/CSS is
//  possible.  The three levers we DO control are:
//
//    icon   – the small app icon shown next to the notification title.
//             We generate per-type coloured rounded-square icons at init time
//             (pink = proximity, purple = schedule, red = tardiness).
//
//    badge  – monochrome icon shown in the Android status bar.
//             White map-pin on transparent — unchanged.
//
//    image  – a LARGE banner image shown inside the notification body on
//             Android Chrome.  We generate a dark-slate themed canvas banner
//             per notification type.  Silently ignored on other platforms.
//
//  All assets are built once via <canvas> at initNotifications() time and
//  cached in _icons / _banners below.  No external files required.
// ═══════════════════════════════════════════════════════════════════════════

/** White map-pin on transparent — used when rendering onto coloured backgrounds. */
const _WHITE_PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path fill="white" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75
    7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5
    2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
</svg>`;

/** Monochrome badge SVG for Android notification bar (must be white on transparent). */
const _BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path fill="white" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75
    7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5
    2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
</svg>`;

/**
 * Per-type icon and banner PNG data-URLs.
 * Populated by _buildNotifAssets() during initNotifications().
 */
const _icons = {
    proximity: null,   // pink rounded-square + white pin
    schedule:  null,   // purple rounded-square + white pin
    tardiness: null,   // red rounded-square + white pin
    default:   null,   // fallback: gradient pin on transparent
};

const _banners = {
    proximity: null,   // 512×160 dark-slate banner, pink accent
    schedule:  null,   // 512×160 dark-slate banner, purple accent
    tardiness: null,   // 512×160 dark-slate banner, red accent
};

/** Cached badge PNG (generated once). */
let _badgeDataUrl = 'data:image/svg+xml,' + encodeURIComponent(_BADGE_SVG);

// ── Theme palette  ──────────────────────────────────────────────────────────
const _THEME = {
    proximity: { from: '#ec4899', to: '#db2777', label: '📍  SPOTS NEARBY',        desc: 'Saved spots are near your location'   },
    schedule:  { from: '#8b5cf6', to: '#7c3aed', label: '📅  SCHEDULE REMINDER',   desc: 'Upcoming activity on your itinerary'  },
    tardiness: { from: '#ef4444', to: '#dc2626', label: '🚨  LATE ALERT',           desc: 'You may be running late for a booking' },
};

// ── Canvas helpers ──────────────────────────────────────────────────────────

/** Cross-browser rounded-rectangle path helper (ctx.roundRect added in Chrome 99). */
function _canvasRoundRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}

/** Load an SVG string into an Image element, resolving when loaded. */
function _loadSvgAsImage(svgString) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = 'data:image/svg+xml,' + encodeURIComponent(svgString);
    });
}

/**
 * Generate a 192×192 notification icon for the given type.
 *
 * Design:  coloured gradient rounded-square background + centred white map-pin.
 *
 * @param {'proximity'|'schedule'|'tardiness'} type
 * @returns {Promise<string>}  PNG data-URL
 */
async function _generateNotifIcon(type) {
    const size = 192;
    try {
        const { from, to } = _THEME[type];
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');

        // ── Rounded-square gradient background
        const pad = Math.round(size * 0.06);
        const bg  = ctx.createLinearGradient(pad, pad, size - pad, size - pad);
        bg.addColorStop(0, from);
        bg.addColorStop(1, to);
        ctx.fillStyle = bg;
        ctx.beginPath();
        _canvasRoundRect(ctx, pad, pad, size - pad * 2, size - pad * 2, Math.round(size * 0.22));
        ctx.fill();

        // ── Subtle inner highlight (top-left gloss)
        const gloss = ctx.createLinearGradient(pad, pad, pad, size * 0.55);
        gloss.addColorStop(0, 'rgba(255,255,255,0.18)');
        gloss.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gloss;
        ctx.beginPath();
        _canvasRoundRect(ctx, pad, pad, size - pad * 2, size - pad * 2, Math.round(size * 0.22));
        ctx.fill();

        // ── White map-pin centred
        const pinImg = await _loadSvgAsImage(_WHITE_PIN_SVG);
        if (pinImg) {
            const pinSize = Math.round(size * 0.58);
            const pinOff  = Math.round((size - pinSize) / 2);
            ctx.drawImage(pinImg, pinOff, pinOff, pinSize, pinSize);
        }

        return canvas.toDataURL('image/png');
    } catch (_) {
        // Fallback: white pin SVG data-URL
        return 'data:image/svg+xml,' + encodeURIComponent(_WHITE_PIN_SVG);
    }
}

/**
 * Generate a 512×160 themed banner image for use in the notification `image` field.
 *
 * Design (left → right):
 *   • Dark slate (#0f172a → #1e1b4b) background
 *   • 4 px pink→purple gradient top stripe
 *   • Left column: type-colour radial glow + white map-pin icon
 *   • Thin 1 px vertical divider
 *   • Right column: "SAVE2GO" micro-label, type label, short descriptor text
 *
 * The `image` field is shown as a large preview on Android Chrome.
 * On desktop or Firefox it is silently ignored.
 *
 * @param {'proximity'|'schedule'|'tardiness'} type
 * @param {string} iconDataUrl  pre-generated PNG for the coloured icon (re-used for scale)
 * @returns {Promise<string>}  PNG data-URL
 */
async function _generateBannerImage(type, iconDataUrl) {
    const W = 512, H = 160;
    try {
        const { from, label, desc } = _THEME[type];
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');

        // ── Background gradient (dark slate → dark indigo)
        const bg = ctx.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, '#0f172a');
        bg.addColorStop(1, '#1e1b4b');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        // ── Top accent stripe (pink→purple, 4 px)
        const stripe = ctx.createLinearGradient(0, 0, W, 0);
        stripe.addColorStop(0, '#ec4899');
        stripe.addColorStop(1, '#8b5cf6');
        ctx.fillStyle = stripe;
        ctx.fillRect(0, 0, W, 4);

        // ── Radial glow behind the icon (left column)
        const cx = 76, cy = H / 2;
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 58);
        glow.addColorStop(0, from + '44');
        glow.addColorStop(1, from + '00');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 4, 150, H - 4);

        // ── Coloured app icon (64×64, centred in left column)
        if (iconDataUrl) {
            const iconImg = await _loadSvgAsImage(iconDataUrl);
            if (iconImg) {
                const iSize = 64, iX = cx - iSize / 2, iY = cy - iSize / 2;
                // Soft shadow behind icon
                ctx.shadowColor = from + '88';
                ctx.shadowBlur  = 18;
                ctx.drawImage(iconImg, iX, iY, iSize, iSize);
                ctx.shadowBlur = 0;
            }
        }

        // ── Vertical divider line
        ctx.strokeStyle = from + '33';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(142, 22);
        ctx.lineTo(142, H - 22);
        ctx.stroke();

        // ── Text — SAVE2GO micro-label
        ctx.fillStyle = '#475569'; // slate-600
        ctx.font = `bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif`;
        ctx.fillText('SAVE2GO', 160, 40);

        // ── Text — type label (coloured)
        ctx.fillStyle = from;
        ctx.font = `bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif`;
        ctx.fillText(label, 160, 64);

        // ── Text — descriptor (muted slate)
        ctx.fillStyle = '#94a3b8'; // slate-400
        ctx.font = `13px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif`;
        ctx.fillText(desc, 160, 86);

        // ── Bottom fade (subtle vignette)
        const fade = ctx.createLinearGradient(0, H - 28, 0, H);
        fade.addColorStop(0, 'rgba(15,23,42,0)');
        fade.addColorStop(1, 'rgba(15,23,42,0.55)');
        ctx.fillStyle = fade;
        ctx.fillRect(0, H - 28, W, 28);

        return canvas.toDataURL('image/png');
    } catch (_) {
        return null; // image field is optional — skip silently
    }
}

/**
 * Build all notification assets (icons + banners) once at init time.
 * Results are stored in _icons / _banners / _badgeDataUrl.
 */
async function _buildNotifAssets() {
    // Step 1 — Generate per-type icons in parallel.
    [_icons.proximity, _icons.schedule, _icons.tardiness, _badgeDataUrl] = await Promise.all([
        _generateNotifIcon('proximity'),
        _generateNotifIcon('schedule'),
        _generateNotifIcon('tardiness'),
        (async () => {
            // Badge: rasterise the white-pin SVG to PNG for Android status bar.
            try {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 96;
                const ctx = canvas.getContext('2d');
                const img = await _loadSvgAsImage(_BADGE_SVG);
                if (img) ctx.drawImage(img, 0, 0, 96, 96);
                return canvas.toDataURL('image/png');
            } catch (_) {
                return 'data:image/svg+xml,' + encodeURIComponent(_BADGE_SVG);
            }
        })(),
    ]);

    // Fallback default icon — gradient pin used when type is unknown.
    _icons.default = _icons.proximity;

    // Step 2 — Generate banners using the per-type icons (must come after step 1).
    [_banners.proximity, _banners.schedule, _banners.tardiness] = await Promise.all([
        _generateBannerImage('proximity', _icons.proximity),
        _generateBannerImage('schedule',  _icons.schedule),
        _generateBannerImage('tardiness', _icons.tardiness),
    ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 3. PERMISSION ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Request notification permission.
 * Returns true if permission is (or becomes) granted, false otherwise.
 * Must be called from a user-gesture context on first run.
 */
async function requestNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted')  return true;
    if (Notification.permission === 'denied')   return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 4. DEDUPLICATION ENGINE ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/** In-memory mirror of the localStorage dedup store (reduces parse overhead). */
let _dedupCache = null;

function _loadDedup() {
    if (_dedupCache) return _dedupCache;
    try {
        _dedupCache = JSON.parse(localStorage.getItem(_NOTIF_CONFIG.keys.dedupStore) || '{}');
    } catch (_) { _dedupCache = {}; }
    return _dedupCache;
}

function _saveDedup() {
    try { localStorage.setItem(_NOTIF_CONFIG.keys.dedupStore, JSON.stringify(_dedupCache)); }
    catch (_) { /* storage full — not critical */ }
}

/** Prune expired keys so the dedup store doesn't grow unbounded. */
function _pruneDedup() {
    const now   = Date.now();
    const store = _loadDedup();
    let pruned  = false;
    for (const k of Object.keys(store)) {
        if (store[k] < now) { delete store[k]; pruned = true; }
    }
    if (pruned) _saveDedup();
}

/** Returns true if this exact key was notified recently (within its TTL). */
function _alreadyNotified(key) {
    const store = _loadDedup();
    return store[key] !== undefined && store[key] > Date.now();
}

/** Mark a key as notified; it will be suppressed for ttlMs milliseconds. */
function _markNotified(key, ttlMs) {
    const store = _loadDedup();
    store[key]  = Date.now() + ttlMs;
    _saveDedup();
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 5. NOTIFICATION DISPATCHER ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a single notification.
 *
 * Prefers ServiceWorker.showNotification() for rich action buttons.
 * Falls back to new Notification() for environments without an active SW.
 *
 * @param {string} title
 * @param {string} body
 * @param {object} extras  — merged into the notification options object
 */
async function _send(title, body, extras = {}) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // Build options — strip out falsy `image` (undefined/null) so browsers that
    // don't support the field don't get confused by an explicit undefined value.
    const rawOptions = {
        body,
        icon:   _icons.default || _badgeDataUrl,
        badge:  _badgeDataUrl,
        silent: false,
        ...extras,
        // Action buttons are only supported in SW-dispatched notifications.
        // They are stripped silently in the fallback path below.
    };
    const options = Object.fromEntries(
        Object.entries(rawOptions).filter(([, v]) => v !== undefined && v !== null)
    );

    // Attempt vibration (no-op on desktop, works on Android Chrome).
    if ('vibrate' in navigator) {
        navigator.vibrate(extras.vibrate ?? [200, 100, 200]);
    }

    try {
        // Preferred path: SW context supports action buttons.
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            if (reg && reg.showNotification) {
                await reg.showNotification(title, options);
                return;
            }
        }
    } catch (_) { /* fall through */ }

    // Fallback: plain Notification (no action buttons, but still works).
    try {
        const { actions: _drop, ...fallbackOpts } = options; // actions unsupported here
        new Notification(title, fallbackOpts);
    } catch (_) { /* Notification constructor blocked in some contexts */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 6. SHARED HELPERS ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/** Haversine distance in metres between two lat/lon pairs. */
function _haversineM(lat1, lon1, lat2, lon2) {
    const R   = 6_371_000;
    const φ1  = lat1 * Math.PI / 180;
    const φ2  = lat2 * Math.PI / 180;
    const Δφ  = (lat2 - lat1) * Math.PI / 180;
    const Δλ  = (lon2 - lon1) * Math.PI / 180;
    const a   = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Convert sch_start/sch_end integer (minutes since midnight) → "HH:MM" string. */
function _minsToHHMM(mins) {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** Today's date as "YYYY-MM-DD" in LOCAL time (mirrors itinerary.js _getLocalYMD). */
function _todayYMD() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Current time as integer minutes since midnight (local clock). */
function _nowMins() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

/** Read travelSpots from localStorage (same key as aap.js). */
function _getSpots() {
    try { return JSON.parse(localStorage.getItem(_NOTIF_CONFIG.keys.spots) || '[]'); }
    catch (_) { return []; }
}

/** Read all itineraries from localStorage. */
function _getItineraries() {
    try { return JSON.parse(localStorage.getItem(_NOTIF_CONFIG.keys.itineraries) || '[]'); }
    catch (_) { return []; }
}

/**
 * Returns { lat, lon, ts } from localStorage, or null if coordinates are absent / stale.
 * "Stale" means the GPS fix is older than gpsStaleThresholdMs.
 */
function _getUserCoords() {
    const lat = parseFloat(localStorage.getItem(_NOTIF_CONFIG.keys.userLat));
    const lon = parseFloat(localStorage.getItem(_NOTIF_CONFIG.keys.userLng));
    const ts  = parseInt(localStorage.getItem(_NOTIF_CONFIG.keys.userGpsTs) || '0', 10);
    if (isNaN(lat) || isNaN(lon) || lat === 0 || lon === 0) return null;
    if (Date.now() - ts > _NOTIF_CONFIG.gpsStaleThresholdMs) return null; // stale fix
    return { lat, lon, ts };
}

/**
 * Returns all non-suggested timeline spots for TODAY across every itinerary.
 * Each spot object is the raw timeline entry (includes sch_start, sch_end, spot_name, etc.)
 * plus an extra `_itinTitle` field for display.
 */
function _getTodayTimelineSpots() {
    const today    = _todayYMD();
    const itins    = _getItineraries();
    const results  = [];

    for (const itin of itins) {
        if (!Array.isArray(itin.days)) continue;
        for (const day of itin.days) {
            if (day?.isSuggested) continue;
            if (day?.date !== today) continue;
            for (const entry of (day.timeline || [])) {
                results.push({ ...entry, _itinTitle: itin.title || 'Itinerary' });
            }
        }
    }
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 7. BOOKING-TIME PARSER (for Tardiness checker) ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scan free-text notes for booking / reservation time references.
 *
 * Handles formats:
 *   "Reservation at 7:30 PM", "Booked for 19:30", "Table at 8pm",
 *   "Check-in 14:00", "Appointment: 9:30 AM", "Dinner 20h30"
 *
 * Returns the EARLIEST matched time as integer minutes since midnight,
 * or null if no booking time is found.
 *
 * We intentionally require a booking-intent keyword so that incidental time
 * mentions in notes ("walk takes about 30 minutes") don't trigger false alerts.
 */
function _parseBookingTimeMins(notes) {
    if (!notes || typeof notes !== 'string') return null;

    // Primary: booking keyword followed by a time expression.
    const BOOKING_RE = /(?:reservation|booking|booked|check.?in|appointment|table(?:\s+for)?|scheduled\s+for|dinner\s+at|lunch\s+at|breakfast\s+at|meet(?:ing)?\s+at|show\s+starts?(?:\s+at)?)\s*[:\-]?\s*(\d{1,2})(?:[:\.](\d{2}))?\s*(?:(am|pm)|h(\d{2})?)?/gi;

    // Secondary: bare HH:MM times (only used if a booking keyword was found nearby).
    const BARE_TIME_RE = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi;

    const candidates = [];

    let m;
    BOOKING_RE.lastIndex = 0;
    while ((m = BOOKING_RE.exec(notes)) !== null) {
        const h    = parseInt(m[1], 10);
        const min  = parseInt(m[2] || '0', 10);
        const ampm = (m[3] || '').toLowerCase();
        const h24  = m[4] !== undefined ? parseInt(m[4], 10) : null; // "19h30" style

        let hours = h;
        if (h24 !== null) {
            // "19h30" → 19:30
            hours = h;
        } else if (ampm === 'pm' && h < 12) {
            hours = h + 12;
        } else if (ampm === 'am' && h === 12) {
            hours = 0;
        }

        if (hours >= 0 && hours < 24 && min >= 0 && min < 60) {
            candidates.push(hours * 60 + min);
        }
    }

    // If the booking keyword regex found nothing, try bare HH:MM only if
    // the notes contain an obvious booking-related word anywhere.
    if (candidates.length === 0) {
        const hasBookingWord = /\b(?:reservation|booking|booked|check.?in|appointment|table|reserved)\b/i.test(notes);
        if (hasBookingWord) {
            BARE_TIME_RE.lastIndex = 0;
            while ((m = BARE_TIME_RE.exec(notes)) !== null) {
                const h   = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                const ap  = (m[3] || '').toLowerCase();
                let hours = h;
                if (ap === 'pm' && h < 12) hours += 12;
                if (ap === 'am' && h === 12) hours = 0;
                if (hours >= 0 && hours < 24 && min >= 0 && min < 60) {
                    candidates.push(hours * 60 + min);
                }
            }
        }
    }

    return candidates.length > 0 ? Math.min(...candidates) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 8. CHECKER 1 — PROXIMITY ALERT ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fires if there are one or more saved (non-done) spots within
 * _NOTIF_CONFIG.proximityRadiusM metres of the user's current position.
 *
 * One consolidated notification is sent showing the count.
 * Dedup key is "proximity:<dateYMD>" — resets each calendar day.
 *
 * Extend this checker by returning multiple objects with different keys
 * if you want per-spot proximity alerts in the future.
 *
 * @returns {Array<NotificationDescriptor>}
 */
async function _checkProximity() {
    const results = [];
    const userPos = _getUserCoords();
    if (!userPos) return results; // no valid GPS fix

    const spots   = _getSpots();
    const nearby  = spots.filter(spot => {
        if ((spot.status || '').toLowerCase().trim() === 'done') return false;
        const lat = parseFloat(spot.latitude);
        const lon = parseFloat(spot.longitude);
        if (isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) return false;
        return _haversineM(userPos.lat, userPos.lon, lat, lon) <= _NOTIF_CONFIG.proximityRadiusM;
    });

    if (nearby.length === 0) return results;

    const key = `proximity:${_todayYMD()}`;
    if (_alreadyNotified(key)) return results;

    const n = nearby.length;
    results.push({
        key,
        ttl:   _NOTIF_CONFIG.dedupTtl.proximity,
        title: `📍 ${n} Spot${n !== 1 ? 's' : ''} Nearby`,
        body:  `You have ${n} save${n !== 1 ? 'd spots' : 'd spot'} close to your current location.`,
        options: {
            tag:              'proximity-alert',
            renotify:         false,
            requireInteraction: false,
            icon:             _icons.proximity  || _icons.default,
            badge:            _badgeDataUrl,
            image:            _banners.proximity || undefined,
            vibrate:          [200, 100, 200],
            data: {
                type: 'proximity',
                url:  '/',
            },
            actions: [
                { action: 'view',     title: '🗺  View on Map' },
                { action: 'navigate', title: '🧭 Navigate',
                  // Navigate to the closest spot.
                  ...(nearby[0] ? {
                    _lat: parseFloat(nearby[0].latitude),
                    _lon: parseFloat(nearby[0].longitude),
                  } : {}),
                },
            ],
        },
    });

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 9. CHECKER 2 — SCHEDULE REMINDERS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * For each activity on today's itinerary timeline, check whether the current
 * time is within one of the lead-time windows (5h / 3h / 1h / 30 min).
 *
 * One notification fires per spot per threshold per day.
 * Dedup key: "schedule:<dateYMD>:<rowid>:<thresholdMin>"
 *
 * @returns {Array<NotificationDescriptor>}
 */
async function _checkScheduleReminders() {
    const results      = [];
    const nowMins      = _nowMins();
    const today        = _todayYMD();
    const todaySpots   = _getTodayTimelineSpots();

    for (const entry of todaySpots) {
        if (!entry.rowid || entry.sch_start === undefined) continue;
        if ((entry.status || '').toLowerCase().trim() === 'done') continue;

        const minutesUntil = entry.sch_start - nowMins;

        for (const threshold of _NOTIF_CONFIG.scheduleLeadTimesMin) {
            // Fire if we are AT or JUST PAST the threshold (within one poll window).
            const pollMins = _NOTIF_CONFIG.pollIntervalMs / 60_000;
            if (minutesUntil <= threshold && minutesUntil > threshold - pollMins) {
                const key = `schedule:${today}:${entry.rowid}:${threshold}`;
                if (_alreadyNotified(key)) continue;

                const name   = entry.spot_name || 'Your activity';
                const label  = threshold === 300 ? '5 hours'
                             : threshold === 180 ? '3 hours'
                             : threshold === 60  ? '1 hour'
                             :                     '30 minutes';
                const timeStr = _minsToHHMM(entry.sch_start);

                results.push({
                    key,
                    ttl:   _NOTIF_CONFIG.dedupTtl.schedule,
                    title: `⏰ Coming up in ${label}`,
                    body:  `"${name}" is scheduled at ${timeStr} — don't be late!`,
                    options: {
                        tag:              `schedule-${entry.rowid}-${threshold}`,
                        renotify:         true,
                        requireInteraction: threshold <= 60, // persist for 1h / 30min alerts
                        icon:             _icons.schedule  || _icons.default,
                        badge:            _badgeDataUrl,
                        image:            _banners.schedule || undefined,
                        vibrate:          [200, 100, 200],
                        data: {
                            type:    'schedule',
                            url:     '/',
                            rowid:   entry.rowid,
                            lat:     parseFloat(entry.latitude),
                            lon:     parseFloat(entry.longitude),
                        },
                        actions: [
                            { action: 'view',     title: '📋 View Details' },
                            { action: 'navigate', title: '🧭 Navigate'     },
                        ],
                    },
                });
            }
        }
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 10. CHECKER 3 — TARDINESS WARNING ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scans today's itinerary timeline for spots whose notes contain a booking /
 * reservation time.  If the current clock has passed that booking time by more
 * than tardinessGraceMin, fires a HIGH-PRIORITY alert.
 *
 * Dedup key: "tardiness:<dateYMD>:<rowid>:<bookingMins>"
 * TTL is short (30 min) so the user keeps being reminded if still late.
 *
 * TO ADD IN FUTURE: check travelSpots directly (not just today's itinerary)
 * for same-day dated events stored in the notes layer.
 *
 * @returns {Array<NotificationDescriptor>}
 */
async function _checkTardiness() {
    const results    = [];
    const nowMins    = _nowMins();
    const today      = _todayYMD();
    const todaySpots = _getTodayTimelineSpots();

    for (const entry of todaySpots) {
        if (!entry.rowid) continue;
        if ((entry.status || '').toLowerCase().trim() === 'done') continue;

        const bookingMins = _parseBookingTimeMins(entry.notes || '');
        if (bookingMins === null) continue;

        const lateBy = nowMins - bookingMins;
        if (lateBy < _NOTIF_CONFIG.tardinessGraceMin) continue; // not late yet

        // Future booking times (e.g. a 9pm dinner when it's 10am) — skip.
        // The booking must be reasonably within today's active hours.
        if (bookingMins < 5 * 60 || bookingMins > 23 * 60) continue;

        const key = `tardiness:${today}:${entry.rowid}:${bookingMins}`;
        if (_alreadyNotified(key)) continue;

        const name     = entry.spot_name || 'an activity';
        const timeStr  = _minsToHHMM(bookingMins);
        const lateStr  = lateBy >= 60
            ? `${Math.floor(lateBy / 60)}h ${lateBy % 60}m`
            : `${lateBy} min`;

        results.push({
            key,
            ttl:   _NOTIF_CONFIG.dedupTtl.tardiness,
            title: `🚨 Running Late — ${name}`,
            body:  `Your reservation at ${timeStr} was ${lateStr} ago. Time to get moving!`,
            options: {
                tag:              `tardiness-${entry.rowid}`,
                renotify:         true,      // override previous — you're STILL late
                requireInteraction: true,    // stay on screen until dismissed
                icon:             _icons.tardiness || _icons.default,
                badge:            _badgeDataUrl,
                image:            _banners.tardiness || undefined,
                vibrate:          [300, 150, 300, 150, 300], // more urgent pattern
                data: {
                    type:  'tardiness',
                    url:   '/',
                    rowid: entry.rowid,
                    lat:   parseFloat(entry.latitude),
                    lon:   parseFloat(entry.longitude),
                },
                actions: [
                    { action: 'navigate', title: '🧭 Navigate Now' },
                    { action: 'view',     title: '📋 View Details' },
                ],
            },
        });
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 11. CHECKER REGISTRY — add new checkers here ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All checker functions registered here.
 * Each must be async and return Array<NotificationDescriptor>.
 *
 * To add a new notification type in the future:
 *   1. Write your async function _checkMyNewType() { ... }
 *   2. Push it onto _CHECKERS below — nothing else needs to change.
 */
const _CHECKERS = [
    _checkProximity,
    _checkScheduleReminders,
    _checkTardiness,
];

// ═══════════════════════════════════════════════════════════════════════════
// ── 12. MAIN POLL RUNNER ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run all registered checkers, deduplicate, and dispatch notifications.
 * Only fires notifications when the page is not visible (app minimised).
 * Checkers still run when visible — this computes state early so that the
 * moment the page hides, data is ready.
 */
async function _runAllCheckers() {
    if (Notification.permission !== 'granted') return;

    _pruneDedup(); // housekeeping — evict expired keys

    const results = [];

    for (const checker of _CHECKERS) {
        try {
            const items = await checker();
            results.push(...items);
        } catch (err) {
            // Isolate checker failures — one broken checker must not block others.
            console.warn('[Save2Go Notifications] Checker error:', err);
        }
    }

    // Only dispatch when the page is hidden (user has minimised / backgrounded the app).
    // If the page is visible, the user can see the app — no need for a push notification.
    const shouldDispatch = document.visibilityState === 'hidden' || !document.hasFocus();

    for (const descriptor of results) {
        if (!_alreadyNotified(descriptor.key)) {
            if (shouldDispatch) {
                await _send(descriptor.title, descriptor.body, descriptor.options);
            }
            // Always mark as notified so we don't flood on the next background switch.
            _markNotified(descriptor.key, descriptor.ttl);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── 13. LOOP CONTROL ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

let _pollTimer = null;

/**
 * Start the notification polling loop.
 * Safe to call multiple times — subsequent calls are no-ops if already running.
 */
function startNotificationLoop() {
    if (_pollTimer !== null) return; // already running
    // Run once immediately so the first check happens on app load,
    // then repeat on the configured interval.
    _runAllCheckers();
    _pollTimer = setInterval(_runAllCheckers, _NOTIF_CONFIG.pollIntervalMs);
}

/**
 * Stop the polling loop.
 * Call on logout, profile switch, or explicit user opt-out.
 */
function stopNotificationLoop() {
    if (_pollTimer !== null) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

// Also run a check the moment the app is backgrounded (page hidden).
// This catches edge cases where the interval hasn't fired yet when the user
// switches away from the app.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _pollTimer !== null) {
        _runAllCheckers();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── 14. PUBLIC INIT ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Entry point.  Call once after the user is confirmed logged in.
 *
 *   if (typeof initNotifications === 'function') initNotifications();
 *
 * Permission is requested here.  On first run the browser will show its
 * native "Allow Notifications?" prompt.  On subsequent runs the stored
 * permission is used directly — no prompt appears again.
 */
async function initNotifications() {
    if (!('Notification' in window)) {
        console.info('[Save2Go Notifications] Not supported in this browser.');
        return;
    }

    // Build all notification assets — per-type icons and themed banner images.
    // This runs once async at startup; all subsequent notifications use the cache.
    await _buildNotifAssets();

    const granted = await requestNotificationPermission();
    if (!granted) {
        console.info('[Save2Go Notifications] Permission not granted — notifications disabled.');
        return;
    }

    startNotificationLoop();
    console.info('[Save2Go Notifications] Engine started. Poll interval:', _NOTIF_CONFIG.pollIntervalMs, 'ms');
}

/* ─────────────────────────────────────────────────────────────────────────────
   ██████████████████████████████████████████████████████████████████████████
   ──────────────────────────────────────────────────────────────────────────
   ADD THE BLOCK BELOW TO YOUR EXISTING  sw.js  FILE
   (Paste it at the very end, after all your existing cache logic.)
   It handles the "View Details" and "Navigate" action button clicks that
   come from rich Service Worker notifications.  Without this, tapping an
   action button does nothing.
   ──────────────────────────────────────────────────────────────────────────
   ██████████████████████████████████████████████████████████████████████████
   ─────────────────────────────────────────────────────────────────────────── */

/*

// ── PASTE INTO sw.js ────────────────────────────────────────────────────────

self.addEventListener('notificationclick', event => {
    event.notification.close();

    const action = event.action;               // 'view' | 'navigate' | '' (body tap)
    const data   = event.notification.data || {};
    const appUrl = self.location.origin + '/';

    if (action === 'navigate' && (data.lat || data._lat) && (data.lon || data._lon)) {
        // Open Google Maps with turn-by-turn navigation to the spot.
        const lat   = data.lat  ?? data._lat;
        const lon   = data.lon  ?? data._lon;
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`;
        event.waitUntil(clients.openWindow(mapsUrl));

    } else {
        // 'view' action or direct tap on notification body — bring app to foreground.
        event.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then(clientList => {
                    // If the app tab is already open somewhere, focus it.
                    for (const client of clientList) {
                        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
                            return client.focus();
                        }
                    }
                    // Otherwise open a fresh tab.
                    return clients.openWindow(appUrl);
                })
        );
    }
});

// Handle SW-activated push events (future-proofing for push subscriptions).
// Currently unused — notifications are driven by notification.js page-side code.
self.addEventListener('push', event => {
    if (!event.data) return;
    try {
        const payload = event.data.json();
        event.waitUntil(
            self.registration.showNotification(payload.title || 'Save2Go', {
                body:    payload.body    || '',
                icon:    payload.icon    || '/icon-192.png',
                badge:   payload.badge   || '/badge-96.png',
                data:    payload.data    || {},
                vibrate: payload.vibrate || [200, 100, 200],
            })
        );
    } catch (_) { // malformed push payload — ignore
    }
});

// ── END OF sw.js ADDITION ───────────────────────────────────────────────────

*/
