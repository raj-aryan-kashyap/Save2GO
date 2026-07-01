const APP_VERSION = "v6.0.0";
const API_URL = "https://script.google.com/macros/s/AKfycbyYTU_I0zel50EKpB767LmQ2NjeKudS93yv8-DYSYnBxaFS5_I1TWily79rOkMdGTu5IA/exec";
const BACKEND_URL = API_URL;

// ── Weather (Open-Meteo) ─────────────────────────────────────────────────────
// All live weather data now comes from Open-Meteo (free, no API key, CORS-safe).
// OpenWeatherMap code is preserved in the GAS backend for future use but is NOT
// called by the frontend.
//
// Nominatim reverse-geocode is used for city/country name only (cached 24 h,
// keyed to 0.1° precision so all spots in a city share one lookup).
const weatherCache        = new Map(); // key: "lat,lon" → { iconClass, temp, fetchedAt }
const WEATHER_CACHE_TTL   = 10 * 60 * 1000; // 10 minutes

const _nominatimCache     = new Map(); // key: "lat1,lon1" → { city, country, fetchedAt }
const _NOMINATIM_TTL      = 24 * 60 * 60 * 1000; // 24 h — city/country almost never changes

/**
 * Lightweight reverse-geocode via Nominatim.  Keyed to 0.1° (~10 km) so all
 * spots in the same city share one network call.
 * @returns {{ city: string, country: string }}
 */
async function _reverseGeocode(lat, lon) {
    const key    = `${parseFloat(lat).toFixed(1)},${parseFloat(lon).toFixed(1)}`;
    const cached = _nominatimCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < _NOMINATIM_TTL) return cached;
    try {
        const res  = await fetch(
            `https://nominatim.openstreetmap.org/reverse` +
            `?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`
        );
        const data = await res.json();
        const addr = data.address || {};
        // Preserve settlement tier for Bortle scale estimation
        const tier = addr.city    ? 'city'
                   : addr.town    ? 'town'
                   : addr.village ? 'village'
                   : 'unknown';
        const result = {
            city:      addr.city || addr.town || addr.village || addr.county || '',
            country:   (addr.country_code || '').toUpperCase(),
            tier,
            fetchedAt: Date.now(),
        };
        _nominatimCache.set(key, result);
        return result;
    } catch (_) {
        return { city: '', country: '', tier: 'unknown', fetchedAt: Date.now() };
    }
}

// --- GLOBAL SHARED APPLICATION ENGINE MEMORY STATE ---
let currentUser = localStorage.getItem('compass_user');
let registeredUsersList = []; // cached from get_users fetch; used for profile rename duplicate check
let deviceId = localStorage.getItem('compass_device_id') || generateAndSaveDeviceId();
let travelSpots = JSON.parse(localStorage.getItem('compass_cache')) || [];
let checkedFilterStateArray = JSON.parse(localStorage.getItem('compass_active_filters')) || [];
let checkedCitiesStateArray = JSON.parse(localStorage.getItem('compass_active_cities')) || [];
let showStarredOnly = JSON.parse(localStorage.getItem('compass_starred_only')) || false;
let hideCompletedSpotsStateBool = localStorage.getItem('compass_hide_completed') !== null ? JSON.parse(localStorage.getItem('compass_hide_completed')) : true;
// Active itinerary-day filter — { itineraryId, dayIndex } | null
// Persists across sessions; cleared automatically if the referenced itinerary is deleted.
let activeItineraryFilter = JSON.parse(localStorage.getItem('compass_itinerary_filter')) || null;
let currentMapStyleKey = localStorage.getItem('compass_map_style') || 'dark';

if (currentMapStyleKey === 'street') {
    currentMapStyleKey = 'terrain';
    localStorage.setItem('compass_map_style', 'terrain');
}

// Seed from last session if available; overwritten by live GPS on first fix.
// Falls back to Lisbon city-centre so distance math never operates on undefined.
const _storedLat = parseFloat(localStorage.getItem('compass_user_live_lat'));
const _storedLon = parseFloat(localStorage.getItem('compass_user_live_lng'));
let userLat = (!isNaN(_storedLat) && _storedLat !== 0) ? _storedLat : 38.7223;
let userLon = (!isNaN(_storedLon) && _storedLon !== 0) ? _storedLon : -9.1393;

// ── Proximity sort deferral ───────────────────────────────────────────────────
// Tracks the user's position at the last full list sort so we can decide
// whether an incoming GPS fix warrants a re-sort.
let _sortAnchorLat   = userLat;
let _sortAnchorLon   = userLon;
let _listSortPending = false;      // true = sort needed but list tab not active
const _SORT_MOVE_THRESHOLD_KM = 0.2; // 200 m — ignore smaller GPS drifts

/**
 * Called by the map.js GPS watchPosition callback on every live fix.
 * Decides whether the new position is far enough to warrant a re-sort:
 *  • <200 m from anchor  → silently ignored (distance badges already live-update)
 *  • ≥200 m, list active → update anchor; let badges update naturally (no reorder)
 *  • ≥200 m, list hidden → update anchor; set _listSortPending so the next
 *                          list-tab entry triggers a smooth FLIP reorder
 */
function notifyGpsPositionForListSort(lat, lon) {
    if (typeof calculateDistance !== 'function') return;
    const moved = calculateDistance(_sortAnchorLat, _sortAnchorLon, lat, lon);
    if (moved < _SORT_MOVE_THRESHOLD_KM) return; // not worth re-sorting

    _sortAnchorLat = lat;
    _sortAnchorLon = lon;

    if (activeTabID === 'list') {
        // User is actively browsing — only refresh distance badges, no reorder.
        updateLiveDistancesUI();
    } else {
        // User is on another tab — queue the reorder for when they come back.
        _listSortPending = true;
    }
}
// ─────────────────────────────────────────────────────────────────────────────

let cachedHardwareString = "Unknown Device Model";
let gpsStatusCachedBool = false; 
let activeTabID = 'map';

let liveGpsWatchId = null;
let speechBubbleHideTimer = null;
let _holidayCache = {};      // keyed by "countryCode-year" → array of holiday date strings
let _holidayRichCache = {};  // keyed by "countryCode-year" → array of { date, name, localName }
let continuousGpsFailsafeIntervalId = null; 
let lastGpsSuccessTime = 0; 
// Pre-populate from the last session so recenter is instant on first load,
// even before the GPS stream delivers its first fix this session.
// GPS success callbacks overwrite these values with live coordinates.
let cachedUserCoords = (() => {
    const lat = parseFloat(localStorage.getItem('compass_user_live_lat'));
    const lng = parseFloat(localStorage.getItem('compass_user_live_lng'));
    return (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0)
        ? { lat, lon: lng }
        : null;
})();
let isCameraLocked = false;
let gpsLastKnownDenied = false; // true only after a PERMISSION_DENIED error — enables instant modal-show
let _gpsSyncingInProgress = false; // true while a GPS request is in-flight — prevents duplicate pings
let _gpsSyncTimeoutId     = null;  // handle for the hard-timeout that auto-resolves a stuck "Syncing…" HUD
let currentMapBearingAngle = 0;
let mapTileCleanupTimerId = null;
let hasInitialGpsLockRendered = false;

let leafletMapInstance = null;
let mapMarkersLayerGroup = null;
let userPositionPulseCircle = null;
let userAccuracyRadiusCircle = null;
let activeBaseTileLayer = null;
let proximityRippleMarker  = null;  // divIcon marker that hosts the pink ring animation
let proximityRippleActive  = false; // whether the user is currently within 100 m of a spot

let startY = 0; 
let isPulling = false;
let pullDelta = 0; 

let noteGestureTimerId = null;
let isNoteZoomActive = false;
let noteGestureStartX = 0;
let noteGestureStartY = 0;
let formPriorityState = "Normal";

const ENABLE_MAP_ROTATION = false;

function parseReadableDeviceHardware() {
    const ua = navigator.userAgent;
    let os = "Unknown OS";
    if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    const width = window.screen.width; const height = window.screen.height;
    let modelEstimate = "";
    if (os === "Android") {
        if ((width === 360 && height === 800) || (width === 412 && height === 915)) modelEstimate = " (Likely Samsung S-Series)";
        else if (width === 412 && height === 892) modelEstimate = " (Likely Pixel)";
        else modelEstimate = " Mobile";
    } else if (os === "iOS") {
        if (width === 393 && height === 852) modelEstimate = " (iPhone Pro)";
        else if (width === 430 && height === 932) modelEstimate = " (iPhone Pro Max)";
        else modelEstimate = " Phone";
    }
    return `${os}${modelEstimate}`;
}

function generateAndSaveDeviceId() {
    const newId = "DEV-" + Math.random().toString(36).substring(2, 7).toUpperCase();
    localStorage.setItem('compass_device_id', newId); return newId;
}

// ----------------- NOTES GESTURE ENGINE -----------------
function initializeNoteGestureEngine(clientX, clientY, textContent) {
    if (!textContent || textContent.trim() === "") return;
    killNoteGestureEngine();
    
    noteGestureStartX = clientX;
    noteGestureStartY = clientY;
    
    noteGestureTimerId = setTimeout(() => {
        isNoteZoomActive = true;
        const overlay = document.getElementById('noteExpandedOverlayHUD');
        const overlayCard = document.getElementById('noteExpandedOverlayCard');
        const overlayText = document.getElementById('noteExpandedOverlayText');
        const scrollBox = document.getElementById('noteExpandedOverlayScrollBox');
        
        overlayText.innerText = textContent;
        if(scrollBox) scrollBox.scrollTop = 0;
        
        overlay.classList.remove('hidden');
        if (overlayCard) {
            overlayCard.classList.remove('note-zoom-closing');
            overlayCard.classList.add('note-zoom-active');
        }
        
        if(navigator.vibrate) navigator.vibrate(15);
    }, 500);
}

function handleNoteTouchStartEvent(e, text) {
    // NOTE: Do NOT call e.stopPropagation() here.
    // iOS WebKit needs the touchstart to bubble up to gesture-touch-container so
    // the scroll container can register the touch and initiate a scroll gesture.
    // stopPropagation would silently kill all scroll attempts starting on a note.
    initializeNoteGestureEngine(e.touches[0].clientX, e.touches[0].clientY, text);
}
function handleNoteTouchMoveEvent(e) { evaluateNoteGestureMovement(e.touches[0].clientX, e.touches[0].clientY); }
function handleNoteTouchEndEvent(e) { killNoteGestureEngine(); }

function handleNoteMouseDownEvent(e, text) { e.stopPropagation(); initializeNoteGestureEngine(e.clientX, e.clientY, text); }
function handleNoteMouseMoveEvent(e) { evaluateNoteGestureMovement(e.clientX, e.clientY); }
function handleNoteMouseUpEvent(e) { killNoteGestureEngine(); }

function evaluateNoteGestureMovement(currentX, currentY) {
    if (!noteGestureStartX || isNoteZoomActive) return;
    if (Math.abs(currentX - noteGestureStartX) > 15 || Math.abs(currentY - noteGestureStartY) > 15) killNoteGestureEngine();
}
function killNoteGestureEngine() { if (noteGestureTimerId) { clearTimeout(noteGestureTimerId); noteGestureTimerId = null; } }
function manuallyCloseNoteOverlayHUD() {
    isNoteZoomActive = false;
    const overlay = document.getElementById('noteExpandedOverlayHUD');
    if(overlay) overlay.classList.add('hidden');
}

// ----------------- PULL TO REFRESH -----------------
function setupNativePullToRefreshGestures() {
    const GESTURE_CONTAINER = document.getElementById('gesture-touch-container');
    const PULL_INDICATOR = document.getElementById('pullToRefreshIndicatorHUD');
    if (!GESTURE_CONTAINER) return;

    GESTURE_CONTAINER.addEventListener('touchstart', (e) => {
        if (GESTURE_CONTAINER.scrollTop === 0) { 
            startY = e.touches[0].pageY; 
            isPulling = true; 
            pullDelta = 0; 
        }
    }, { passive: true });

    GESTURE_CONTAINER.addEventListener('touchmove', (e) => {
        if (!isPulling) return;
        const currentY = e.touches[0].pageY; 
        pullDelta = currentY - startY; 
        
        if (pullDelta > 0) { 
            const heightBound = Math.min(pullDelta * 0.4, 50); 
            if(PULL_INDICATOR) PULL_INDICATOR.style.height = `${heightBound}px`; 
        }
    }, { passive: true });

    GESTURE_CONTAINER.addEventListener('touchend', () => {
        if (!isPulling) return; 
        isPulling = false;
        if(PULL_INDICATOR) PULL_INDICATOR.style.height = '0px';
        
        if (pullDelta > 40) {
            syncData(true);
        }
        pullDelta = 0; 
    }, { passive: true });

    GESTURE_CONTAINER.addEventListener('touchcancel', () => {
        if (!isPulling) return; 
        isPulling = false;
        if(PULL_INDICATOR) PULL_INDICATOR.style.height = '0px';
        pullDelta = 0; 
    }, { passive: true });
}

// ----------------- AUTH & SYNC -----------------
/** Shared helper — renders a users array into both dropdowns at once */
function _fillUserDropdowns(users) {
    const optionsHTML = '<option value="">Select User</option>'
        + users.map(u => `<option value="${u}">${u}</option>`).join('');
    const loginDrop   = document.getElementById('user-dropdown-select');
    const settingsDrop = document.getElementById('settingsSwitchUserDropdown');
    if (loginDrop)    loginDrop.innerHTML    = optionsHTML;
    if (settingsDrop) {
        settingsDrop.innerHTML = optionsHTML;
        if (currentUser) settingsDrop.value = currentUser;
    }
}

async function populateUserDropdown() {
    // ── Step 1: instant synchronous paint from localStorage cache ──────────
    // This runs before the async fetch, so the settings dropdown is never
    // empty even if the user opens it the millisecond after app load.
    const cachedUsers = JSON.parse(localStorage.getItem('compass_registered_users') || '[]');
    if (cachedUsers.length > 0) {
        registeredUsersList = cachedUsers;
        _fillUserDropdowns(cachedUsers);
    }

    // ── Step 2: background fetch to refresh the list from the server ────────
    try {
        const response = await fetch(`${BACKEND_URL}?action=get_users`);
        if (!response.ok) throw new Error('Failed to reach server');
        const freshUsers = await response.json();

        registeredUsersList = freshUsers;
        localStorage.setItem('compass_registered_users', JSON.stringify(freshUsers));
        _fillUserDropdowns(freshUsers); // silently update both dropdowns
    } catch (err) {
        console.error('Failed to load users:', err);
        // If we had nothing from cache either, show the error state
        if (cachedUsers.length === 0) {
            const select = document.getElementById('user-dropdown-select');
            if (select) select.innerHTML = '<option value="">Server Error</option>';
        }
        // Settings dropdown keeps whatever cache populated — still usable
    }
}

async function handleInitialLoginSubmit() {
    const dropdown    = document.getElementById('user-dropdown-select');
    const newNameInput = document.getElementById('customUsernameInput');
    const newName     = newNameInput ? newNameInput.value.trim() : '';
    const dropdownVal = dropdown ? dropdown.value.trim() : '';

    let selectedUser = '';

    if (newName.length >= 3) {
        // ── NEW REGISTRATION PATH ──────────────────────────────────────────
        // Defensive duplicate guard (validation UI should have caught this already)
        const isDup = registeredUsersList.some(u => u.toLowerCase() === newName.toLowerCase());
        if (isDup) return;

        try {
            await fetch(BACKEND_URL, {
                method: 'POST',
                mode:   'cors',
                body: JSON.stringify({ action: 'register_new_user', new_name: newName })
            });
            // Keep in-memory and localStorage cache accurate for the rest of the session
            registeredUsersList.push(newName);
            localStorage.setItem('compass_registered_users', JSON.stringify(registeredUsersList));
        } catch (err) {
            console.error('Failed to register new user on server:', err);
            // Continue anyway — user still gets a local session
        }
        selectedUser = newName;

        // New users have no cloud itineraries — mark sync as done immediately
        // so the empty state shows the "create first itinerary" UI right away
        // without a "fetching..." loading phase.
        const _newUserSyncKey = `compass_itin_sync_${selectedUser.trim().toLowerCase().replace(/\s+/g, '_')}`;
        localStorage.setItem(_newUserSyncKey, JSON.stringify({ status: 'done', ts: Date.now() }));

    } else if (dropdownVal !== '') {
        // ── EXISTING USER PATH ─────────────────────────────────────────────
        selectedUser = dropdownVal;

        // Pre-mark itinerary sync as in-progress so that if the user reaches
        // the Itinerary tab before the background fetch completes, they see
        // "Fetching saved data..." rather than the "create first" empty state.
        // Only set if not already tracked (avoid overwriting a recent 'done' state
        // which would indicate the user has a local cache that's already current).
        const _existSyncKey = `compass_itin_sync_${selectedUser.trim().toLowerCase().replace(/\s+/g, '_')}`;
        const _existSyncRaw = localStorage.getItem(_existSyncKey);
        if (!_existSyncRaw) {
            localStorage.setItem(_existSyncKey, JSON.stringify({ status: 'syncing', ts: Date.now() }));
        }

    } else {
        // Nothing valid selected — button should be disabled so we never reach here
        return;
    }

    localStorage.setItem('compass_user', selectedUser);
    currentUser = selectedUser;
    document.getElementById('userModal').classList.add('hidden');
    initializeSessionDashboard();
}

// ─── LANDING PAGE VALIDATION ───────────────────────────────────────────────────

// Called by the "Or Register New" input field on every keystroke.
function validateLandingRegisterInput() {
    const input        = document.getElementById('customUsernameInput');
    const minCharWarn  = document.getElementById('landingRegisterMinCharWarning');
    const nameTakenWarn = document.getElementById('landingRegisterNameTakenWarning');
    const beginBtn     = document.getElementById('beginSessionBtn');
    const dropdown     = document.getElementById('user-dropdown-select');
    if (!input || !minCharWarn || !nameTakenWarn || !beginBtn) return;

    const val = input.value.trim();

    // Reset dropdown whenever the user is typing a new name
    if (val.length > 0 && dropdown) dropdown.value = '';

    if (val.length === 0) {
        // Input cleared — re-evaluate based on dropdown alone
        minCharWarn.classList.add('hidden');
        nameTakenWarn.classList.add('hidden');
        const hasDropdown = dropdown && dropdown.value.trim() !== '';
        _setBeginBtnState(beginBtn, hasDropdown);
        return;
    }

    if (val.length < 3) {
        minCharWarn.classList.remove('hidden');
        nameTakenWarn.classList.add('hidden');
        _setBeginBtnState(beginBtn, false);
        return;
    }

    minCharWarn.classList.add('hidden');
    const nameTaken = registeredUsersList.some(u => u.toLowerCase() === val.toLowerCase());
    if (nameTaken) {
        nameTakenWarn.classList.remove('hidden');
        _setBeginBtnState(beginBtn, false);
    } else {
        nameTakenWarn.classList.add('hidden');
        _setBeginBtnState(beginBtn, true);
    }
}

// Called when the dropdown selection changes.
function handleLandingDropdownChange() {
    const dropdown     = document.getElementById('user-dropdown-select');
    const newNameInput = document.getElementById('customUsernameInput');
    const minCharWarn  = document.getElementById('landingRegisterMinCharWarning');
    const nameTakenWarn = document.getElementById('landingRegisterNameTakenWarning');
    const beginBtn     = document.getElementById('beginSessionBtn');
    if (!dropdown || !beginBtn) return;

    // Selecting an existing user clears the new-name field and all warnings
    if (newNameInput) newNameInput.value = '';
    if (minCharWarn)  minCharWarn.classList.add('hidden');
    if (nameTakenWarn) nameTakenWarn.classList.add('hidden');

    _setBeginBtnState(beginBtn, dropdown.value.trim() !== '');
}

// Resets the entire user modal form to its initial empty/disabled state.
// Called whenever the modal is shown (logout, first load).
function resetUserModalForm() {
    const input        = document.getElementById('customUsernameInput');
    const dropdown     = document.getElementById('user-dropdown-select');
    const minCharWarn  = document.getElementById('landingRegisterMinCharWarning');
    const nameTakenWarn = document.getElementById('landingRegisterNameTakenWarning');
    const beginBtn     = document.getElementById('beginSessionBtn');
    if (input)        input.value = '';
    if (dropdown)     dropdown.value = '';
    if (minCharWarn)  minCharWarn.classList.add('hidden');
    if (nameTakenWarn) nameTakenWarn.classList.add('hidden');
    if (beginBtn)     _setBeginBtnState(beginBtn, false);
}

// Small helper — sets the Begin button's enabled/disabled visual state.
function _setBeginBtnState(btn, enabled) {
    btn.disabled = !enabled;
    if (enabled) {
        btn.classList.remove('opacity-40', 'cursor-not-allowed');
    } else {
        btn.classList.add('opacity-40', 'cursor-not-allowed');
    }
}

function initializeSessionDashboard() {
    syncData(true);
    updateNetworkStatusHUD();
    updateUserGreetingCapsule();
    // Start the HUD cycle slot — will snap to GPS row immediately if GPS is not yet active
    _hudStartCycle();
    // Load per-user Smart Search state (filters, query cache, active filter)
    if (typeof initSmartSearch === 'function') initSmartSearch();
}

async function syncData(isManualForce) {
    const syncText = document.getElementById('syncText');
    const syncIconFrame = document.getElementById('syncButtonIconFrame');
    const PULL_INDICATOR = document.getElementById('pullToRefreshIndicatorHUD');
    
    if (PULL_INDICATOR) PULL_INDICATOR.style.height = '0px';

    if (syncText && isManualForce) syncText.innerText = "Checking cloud...";
    if (syncIconFrame && isManualForce) syncIconFrame.classList.add('animate-spin');
    if (isManualForce) hudCycleLockForSync();
    
    try {
        const response = await fetch(API_URL);
        const cloudData = await response.json();
        if(Array.isArray(cloudData)) {
            travelSpots = cloudData;
            localStorage.setItem('compass_cache', JSON.stringify(travelSpots));
            // Start geocoding city centres for spots with missing coordinates as early
            // as possible — before the user navigates to the map tab.  The guard handles
            // the case where map.js hasn't defined the function yet (shouldn't happen in
            // normal page load order, but safe to check).
            if (typeof prefetchMissingCityCenters === 'function') prefetchMissingCityCenters();
            calculateSmartCityDefaultFilters();
            renderList(); 
            
            // Only recalculate the viewport if the user has no saved position from a prior
            // session. Returning users already have the map at the right spot; calling
            // setView({ reset: true }) again causes an unnecessary black-screen flash.
            if (typeof triggerOptimalLandingViewportRecalculation === 'function') {
                const hasSavedPosition = localStorage.getItem('compass_map_state_lat')
                                      && localStorage.getItem('compass_map_state_lng');
                if (!hasSavedPosition) triggerOptimalLandingViewportRecalculation();
            }
            if (typeof plotDynamicMarkersOnCanvasMap === 'function') {
                plotDynamicMarkersOnCanvasMap();
            }
            if (typeof buildItinerarySubMenuChecklist === 'function') {
                buildItinerarySubMenuChecklist();
            }
            if (typeof loadUserItineraries === 'function') {
                await loadUserItineraries();
            }
            
            updateNetworkStatusHUD();

            if (typeof initTasksBadge === 'function') initTasksBadge();

            if (typeof prefetchBordersCountryTilesMapEngine === 'function') {
                prefetchBordersCountryTilesMapEngine();
            }
        }
    } catch (e) {
        if(syncText) syncText.innerText = "Offline Mode";
    } finally {
        if (syncIconFrame) {
            setTimeout(() => { syncIconFrame.classList.remove('animate-spin'); }, 400);
        }
        hudCycleUnlockAfterSync();
    }
}

async function updateCloudAction(rowId, action, value) {
    // NOTE: spot name is intentionally NOT taken as a parameter — embedding
    // spot_name in inline onclick strings breaks on any name containing a
    // single-quote (e.g. "Jim's Bar"). We look it up from travelSpots instead.
    const target = travelSpots.find(s => s.rowid === rowId);
    const resolvedSpotName = target ? (target.spot_name || '') : '';

    if (target) {
        if (action === 'update_status') target.status = value;
        if (action === 'toggle_priority') target.priority = value;

        // Use the animated renderer so cards glide to their new sorted positions
        // instead of snapping instantly.  Falls back to a plain renderList() when
        // the list panel is not active (animation would have no visible effect).
        if (activeTabID === 'list') {
            renderListAnimated(rowId, action, value);
        } else {
            renderList();
        }
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    }
    if (typeof silentPassiveHardwareLocationPingRefresh === 'function') silentPassiveHardwareLocationPingRefresh();
    try {
        await fetch(API_URL, {
            method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowId, action, value, spot: resolvedSpotName, deviceMeta: cachedHardwareString })
        });
    } catch(err) {}
}

async function submitNewSpotToCloud() {
    const url = document.getElementById('new-url').value;
    const mapsUrl = document.getElementById('new-maps-url').value;
    const city = document.getElementById('new-city').value;
    const cat = document.getElementById('new-category').value;
    const keyword = document.getElementById('new-keyword').value;
    const notes = document.getElementById('new-notes').value;
    const submitBtn = document.getElementById('form-submit-btn');

    if(!keyword) { alert("Enter a name for the spot."); return; }
    if(!url && !mapsUrl) { alert("Please provide a reference link or a Google Maps link."); return; }
    
    submitBtn.innerHTML = "<i class='fa-solid fa-arrows-rotate animate-spin mr-2'></i> Saving to database..."; 
    submitBtn.disabled = true;

    try {
        await fetch(API_URL, {
            method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'append_new_spot', 
                city: city || 'Global', 
                spot_name: keyword, 
                category: cat || 'General', 
                instagram_url: url, 
                maps_url: mapsUrl, 
                notes: notes, 
                priority: formPriorityState, 
                deviceMeta: cachedHardwareString 
            })
        });
        document.getElementById('new-url').value = ''; 
        document.getElementById('new-maps-url').value = ''; 
        document.getElementById('new-city').value = ''; 
        document.getElementById('new-category').value = ''; 
        document.getElementById('new-keyword').value = ''; 
        document.getElementById('new-notes').value = '';
        toggleQuickAddModal(false); setTimeout(() => syncData(true), 1000);
    } catch(err) { alert("Submission timed out"); } 
    finally { submitBtn.innerHTML = "<i class='fa-solid fa-floppy-disk mr-2'></i> Save"; submitBtn.disabled = false; }
}

// ----------------- UI / TABS / MENUS -----------------
function switchMasterMenuDashboardTab(targetTabID) {
    killLiveSpeechBubbleHUDState();
    if(typeof dismissMapDetailTrayHUDCard === 'function') dismissMapDetailTrayHUDCard();
    if(typeof closeUnifiedFilterSheet === 'function') closeUnifiedFilterSheet();

    if(targetTabID === activeTabID) return;
    
    const currentTabBtn = document.getElementById(`nav-tab-${activeTabID}`);
    currentTabBtn.className = "nav-tab-transition flex flex-col items-center gap-0.5 text-slate-500 opacity-50 scale-100 font-medium translate-y-0 brightness-100";
    document.getElementById(`view-${activeTabID}`).classList.remove('active-view');
    
    const nextTabBtn = document.getElementById(`nav-tab-${targetTabID}`);
    nextTabBtn.className = "nav-tab-transition flex flex-col items-center gap-0.5 text-pink-500 scale-110 font-black tracking-wide translate-y-[-2px] brightness-125";
    document.getElementById(`view-${targetTabID}`).classList.add('active-view');
    
    activeTabID = targetTabID;

    const priorityEl = document.getElementById('priorityFilterContainer');
    const typeEl = document.getElementById('filterMenuTriggerBtn');
    if (targetTabID === 'itinerary') {
        // The HUD "All / Starred" toggle is active on the itinerary tab too —
        // it filters itinerary master cards instead of saved spots.
        if (priorityEl) priorityEl.classList.remove('opacity-35', 'pointer-events-none');
        // Type/category filter is still saved-spots–only; keep it dimmed.
        if (typeEl) typeEl.classList.add('opacity-35', 'pointer-events-none');
        closeAllActiveHUDDropdownOverlays();
        // Reflect the remembered itinerary filter state in the shared toggle UI.
        syncPriorityFilterViewModeUI();

        const masterListView = document.getElementById('itineraryMasterListView');
        if (masterListView) masterListView.classList.remove('hidden');
        const detailView = document.getElementById('itineraryDetailView');
        if (detailView) detailView.classList.add('hidden');

        if(typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    } else {
        if (priorityEl) priorityEl.classList.remove('opacity-35', 'pointer-events-none');
        if (typeEl) typeEl.classList.remove('opacity-35', 'pointer-events-none');
        syncPriorityFilterViewModeUI();
        updateHeaderBadgeHUDCounters();
    }

    if (targetTabID === 'list' && _listSortPending) {
        // User has moved ≥200 m since the last sort while they were away.
        // Apply the new order with a smooth FLIP animation instead of an
        // instant snap — the flag is cleared here regardless of outcome.
        _listSortPending = false;
        // Small rAF delay lets the tab transition paint first so the FLIP
        // positions are measured against the fully-visible list.
        requestAnimationFrame(() => renderList());
    }

    if(targetTabID === 'map' && typeof leafletMapInstance !== 'undefined' && leafletMapInstance) {
        setTimeout(() => {
            leafletMapInstance.invalidateSize();
            const savedLat = localStorage.getItem('compass_map_state_lat');
            const savedLng = localStorage.getItem('compass_map_state_lng');
            const savedZoom = localStorage.getItem('compass_map_state_zoom') || '12';
            if (savedLat && savedLng) {
                leafletMapInstance.setView([parseFloat(savedLat), parseFloat(savedLng)], parseInt(savedZoom), { animate: false });
            } else if(typeof gpsStatusCachedBool !== 'undefined' && gpsStatusCachedBool) {
                leafletMapInstance.setView([userLat, userLon], 18, { animate: false });
            }
            // Check for nearby hidden spots whenever the user lands on the map tab
            if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
            // Refresh map weather widget for the current viewport centre
            if (typeof refreshMapWeatherWidget === 'function') refreshMapWeatherWidget();
            // Refresh public-holiday notifier for the current city selection
            updateHolidayNotifierVisibility();
        }, 50);
    } else {
        // Navigating away from map — close drawer and clear HUD
        if (typeof closeHiddenPinsDrawer === 'function') closeHiddenPinsDrawer();
        if (typeof clearHiddenPinsSystemHUD === 'function') clearHiddenPinsSystemHUD();
    }
}

function killLiveSpeechBubbleHUDState() {
    const globalBubbleHUD = document.getElementById('globalToastSpeechBubbleHUD');
    if (globalBubbleHUD) {
        globalBubbleHUD.classList.add('hidden');
        globalBubbleHUD.classList.remove('bubble-popup-anim', 'bubble-popdown-anim');
    }
    if(speechBubbleHideTimer) clearTimeout(speechBubbleHideTimer);
}

/**
 * Show a speech-bubble tooltip anchored above a given element.
 *
 * @param {string}      message       - Text to display inside the bubble.
 * @param {HTMLElement} anchorElement - The button/element to point at.
 * @param {Event}       [event]       - Originating event (unused, kept for call-site compat).
 */
function triggerCuteSpeechBubbleHUD(message, anchorElement, event) {
    const hud      = document.getElementById('globalToastSpeechBubbleHUD');
    const textNode = document.getElementById('speechBubbleTextContainer');
    const pointer  = document.getElementById('bubblePointerNode');
    if (!hud || !textNode) return;

    // Tear down any currently-visible bubble / pending hide timer
    killLiveSpeechBubbleHUDState();

    textNode.textContent = message;

    if (anchorElement) {
        const rect          = anchorElement.getBoundingClientRect();
        const anchorCenterX = rect.left + rect.width / 2;
        const bubbleWidth   = 240;
        const margin        = 8;

        // Centre the bubble on the anchor horizontally, clamped to viewport edges
        let leftPos = anchorCenterX - bubbleWidth / 2;
        leftPos = Math.max(margin, Math.min(window.innerWidth - bubbleWidth - margin, leftPos));

        // The HUD origin sits at the TOP of the anchor button.
        // The CSS animation translates the inner div upward by 100% + 8 px gap,
        // so the bubble floats above the button with the pointer aimed at it.
        hud.style.left = leftPos + 'px';
        hud.style.top  = rect.top  + 'px';

        // Slide the pointer diamond so it lines up with the anchor's horizontal centre
        if (pointer) {
            const pLeft = Math.max(8, Math.min(bubbleWidth - 20, Math.round(anchorCenterX - leftPos - 6)));
            pointer.style.left  = pLeft + 'px';
            pointer.style.right = 'auto';
        }
    }

    // Reveal with pop-in animation (force reflow so re-triggering the same animation works)
    hud.classList.remove('hidden');
    hud.classList.remove('bubble-popup-anim');
    void hud.offsetWidth;
    hud.classList.add('bubble-popup-anim');

    // Auto-dismiss after 2.6 s
    speechBubbleHideTimer = setTimeout(() => {
        killLiveSpeechBubbleHUDState();
    }, 2600);
}

function toggleCityDropdownOverlayMenu(event) {
    event.stopPropagation();
    killLiveSpeechBubbleHUDState();
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    const box = document.getElementById('cityHUDDropdownPopupBox');
    const backdrop = document.getElementById('dropdownBlurBackdrop');
    document.getElementById('filterCategoryDropdownPopupBox').classList.add('hidden');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); backdrop.classList.add('hidden'); } 
    else { box.classList.remove('hidden'); backdrop.classList.remove('hidden'); calculateSmartCityDefaultFilters(); }
}

function toggleFilterDropdownOverlayMenu(event) {
    if (activeTabID === 'itinerary') return;
    event.stopPropagation();
    killLiveSpeechBubbleHUDState();
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    const box = document.getElementById('filterCategoryDropdownPopupBox');
    const backdrop = document.getElementById('dropdownBlurBackdrop');
    document.getElementById('cityHUDDropdownPopupBox').classList.add('hidden');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); backdrop.classList.add('hidden'); } 
    else { box.classList.remove('hidden'); backdrop.classList.remove('hidden'); buildDynamicShoppingCheckboxList(); }
}

function closeAllActiveHUDDropdownOverlays() {
    // Snapshot whether the type-filter dropdown was actually open BEFORE hiding it.
    // autoFitMapToItineraryDaySpots should only fire when the dropdown was genuinely
    // being closed — not on every arbitrary tap (e.g. the map-tray X button, Mark Done,
    // or any other backdrop click).  The document-level click handler calls this
    // function for ALL taps, so without this guard the auto-fit fires every time the
    // user interacts with the map tray while an itinerary day filter is active.
    const _typeFilterWasOpen = !document.getElementById('filterCategoryDropdownPopupBox')
                                         .classList.contains('hidden');

    document.getElementById('cityHUDDropdownPopupBox').classList.add('hidden');
    document.getElementById('filterCategoryDropdownPopupBox').classList.add('hidden');
    document.getElementById('dropdownBlurBackdrop').classList.add('hidden');

    // Only auto-pan if the type filter was the thing that was just closed.
    if (_typeFilterWasOpen && activeItineraryFilter && typeof autoFitMapToItineraryDaySpots === 'function') {
        setTimeout(autoFitMapToItineraryDaySpots, 120);
    }
}

function toggleQuickAddModal(show) { document.getElementById('quickAddModal').classList.toggle('hidden', !show); }

/* ── AI Assist Notepad Modal ─────────────────────────────────────────────────
   Opened from fabSat3 (AI wand satellite).
   Two-step GAS flow:
     Step 1 → aiAssistProcessWithGemini(text)   — Gemini API call + JSON parse
     Step 2 → aiAssistWriteSpotToSheet(data)    — sheet append
   Draft auto-saved to localStorage across open/close cycles.
   App is locked (close blocked, backdrop click blocked) during processing.
   Retry is smart: AI failure retries from Step 1; DB failure retries Step 2
   only (Gemini result is preserved in _aiAssistParsedData).
   ─────────────────────────────────────────────────────────────────────────── */

let _aiAssistIsProcessing = false;
let _aiAssistParsedData   = null;   // survives between step 1 completion and step 2
let _aiAssistRetryFn      = null;   // set to the right retry closure on failure
const _AI_ASSIST_DRAFT_KEY = 'ai_assist_notepad_draft';

const _AI_ASSIST_STEPS = {
    1: { title: 'Sending to AI...',      sub: 'Gemini is analysing your travel data'    },
    2: { title: 'Response received',        sub: 'Checking data structure...' },
    3: { title: 'Saving to database...', sub: 'Saving your spot...'         },
};

/* ── Public ─────────────────────────────────────────────────────────────── */

function openAIAssistNotepad() {
    const modal = document.getElementById('aiAssistNotepadModal');
    if (!modal) return;

    // Restore unsaved draft from previous session
    const input = document.getElementById('aiAssistNotepadInput');
    if (input) {
        try { input.value = localStorage.getItem(_AI_ASSIST_DRAFT_KEY) || ''; }
        catch (e) { input.value = ''; }
    }

    _aiAssistHideStatus();
    _aiAssistSyncSubmitBtn();
    _aiAssistShowPanel('form');
    modal.classList.remove('hidden');
    // Small defer so soft keyboard doesn't fight the open animation
    setTimeout(function() { if (input) input.focus(); }, 120);
}

function closeAIAssistNotepad() {
    // Blocked while a GAS call is in flight — backdrop click and X both hit this
    if (_aiAssistIsProcessing) return;
    const modal = document.getElementById('aiAssistNotepadModal');
    if (modal) modal.classList.add('hidden');
    // Clear transient state; draft stays in localStorage until successful submit
    _aiAssistRetryFn    = null;
    _aiAssistParsedData = null;
}

function submitAIAssistNotepad() {
    const input = document.getElementById('aiAssistNotepadInput');
    const text  = input ? input.value.trim() : '';
    if (!text) {
        _aiAssistShowStatus('error', '⚠', 'Please paste or type some travel data before submitting');
        return;
    }
    _aiAssistParsedData = null;
    _aiAssistRetryFn    = null;
    _aiAssistStep1(text);
}

/* ── Step 1: Gemini API ─────────────────────────────────────────────────── */

async function _aiAssistStep1(text) {
    _aiAssistShowPanel('progress');
    _aiAssistSetProgressStep(1);

    try {
        const resp = await fetch(API_URL, {
            method : 'POST',
            mode   : 'cors',
            body   : JSON.stringify({ action: 'ai_assist_process', input: text }),
        });
        const json = await resp.json();

        if (!json || json.result !== 'success') {
            _aiAssistRetryFn = function() { _aiAssistStep1(text); };
            _aiAssistShowPanel('error');
            _aiAssistShowError(
                'AI Processing Failed',
                (json && json.error)
                    || 'Gemini could not process your input. Try rephrasing or adding more detail.',
                true
            );
            return;
        }

        _aiAssistParsedData = json.data; // array of spot objects
        _aiAssistSetProgressStep(2);
        const countLabel = (json.count && json.count > 1)
            ? json.count + ' spots extracted'
            : '1 spot extracted';
        const subEl = document.getElementById('aiAssistProgressSub');
        if (subEl) subEl.textContent = countLabel + ' — verifying data structure…';
        setTimeout(function() { _aiAssistStep3(text); }, 900);

    } catch (err) {
        _aiAssistRetryFn = function() { _aiAssistStep1(text); };
        const msg   = err && err.message ? err.message : String(err);
        const isNet = /network|timeout|connect|fetch/i.test(msg);
        _aiAssistShowPanel('error');
        _aiAssistShowError(
            isNet ? 'No Response from Server' : 'Connection Error',
            isNet
                ? 'No server connection. Check your internet and try again.'
                : 'A server error occurred: ' + msg,
            true
        );
    }
}

/* ── Step 3: Database write ─────────────────────────────────────────────── */

async function _aiAssistStep3(text) {
    _aiAssistSetProgressStep(3);

    try {
        const resp = await fetch(API_URL, {
            method : 'POST',
            mode   : 'cors',
            body   : JSON.stringify({ action: 'ai_assist_write', data: _aiAssistParsedData }),
        });
        const json = await resp.json();

        if (!json || json.result !== 'success') {
            // AI data still in _aiAssistParsedData — retry DB only, no Gemini re-call
            _aiAssistRetryFn = function() { _aiAssistStep3(text); };
            _aiAssistShowPanel('error');
            _aiAssistShowError(
                'Save Error',
                (json && json.error)
                    || 'AI processed your data but saving failed. Your result is saved. Tap Retry to try again.',
                true
            );
            return;
        }

        _aiAssistShowSuccess(json.count || 1, json.newIds || []);
        try { localStorage.removeItem(_AI_ASSIST_DRAFT_KEY); } catch (e) {}
        _aiAssistParsedData = null;
        _aiAssistRetryFn    = null;
        // User must close manually via X or tapping outside.

    } catch (err) {
        _aiAssistRetryFn = function() { _aiAssistStep3(text); };
        const msg = err && err.message ? err.message : String(err);
        _aiAssistShowPanel('error');
        _aiAssistShowError(
            'Database Error',
            'Failed to write to the sheet: ' + msg
                + '. Your AI result is preserved — tap Retry to try saving again.',
            true
        );
    }
}

/* ── Retry ──────────────────────────────────────────────────────────────── */

function _aiAssistRetry() {
    if (typeof _aiAssistRetryFn === 'function') {
        _aiAssistShowPanel('progress');
        _aiAssistRetryFn();
    }
}

/* ── Panel switcher ─────────────────────────────────────────────────────── */

function _aiAssistShowPanel(panel) {
    const formEl     = document.getElementById('aiAssistFormPanel');
    const progressEl = document.getElementById('aiAssistProgressPanel');
    const errorEl    = document.getElementById('aiAssistErrorPanel');
    const closeBtn   = document.getElementById('aiAssistCloseBtn');

    if (formEl)     formEl.style.display     = 'none';
    if (progressEl) progressEl.style.display = 'none';
    if (errorEl)    errorEl.style.display    = 'none';

    if (panel === 'form') {
        if (formEl)   formEl.style.display   = 'flex';
        if (closeBtn) closeBtn.style.display = '';
        _aiAssistIsProcessing = false;
    } else if (panel === 'progress') {
        if (progressEl) progressEl.style.display = 'flex';
        if (closeBtn)   closeBtn.style.display   = 'none'; // lock app during processing
        _aiAssistIsProcessing = true;
    } else if (panel === 'error') {
        if (errorEl)  errorEl.style.display  = 'flex';
        if (closeBtn) closeBtn.style.display = '';         // allow close on failure
        _aiAssistIsProcessing = false;
    }
}

/* ── Progress step UI ───────────────────────────────────────────────────── */

function _aiAssistSetProgressStep(step) {
    const cfg = _AI_ASSIST_STEPS[step];
    if (!cfg) return;

    const titleEl = document.getElementById('aiAssistProgressTitle');
    const subEl   = document.getElementById('aiAssistProgressSub');
    if (titleEl) { titleEl.textContent = cfg.title; titleEl.style.color = ''; }
    if (subEl)   subEl.textContent   = cfg.sub;

    // Dot states: step 1 → [active,pending,pending]
    //             step 2 → [done,  active, pending]  (brief transition)
    //             step 3 → [done,  done,   active]
    _aiAssistUpdateStepDot(1, step === 1 ? 'active' : 'done');
    _aiAssistUpdateStepDot(2, step < 2   ? 'pending' : step === 2 ? 'active' : 'done');
    _aiAssistUpdateStepDot(3, step < 3   ? 'pending' : 'active');

    // Fill connectors progressively
    const c1 = document.getElementById('aiAssistConnector1');
    const c2 = document.getElementById('aiAssistConnector2');
    if (c1) c1.style.width = step >= 2 ? '100%' : '0';
    if (c2) c2.style.width = step >= 3 ? '100%' : '0';

    // Restore wand icon/animation (in case a previous success changed it)
    const icon = document.getElementById('aiAssistProgressCenterIcon');
    if (icon) {
        icon.className        = 'fa-solid fa-wand-magic-sparkles text-violet-400';
        icon.style.fontSize   = '22px';
        icon.style.animation  = 'aiAssistIconFloat 2.4s ease-in-out infinite';
        icon.style.color      = '';
    }
    const wrap = document.getElementById('aiAssistProgressIconWrap');
    if (wrap) {
        wrap.style.background = 'linear-gradient(135deg,rgba(124,58,237,0.18),rgba(219,39,119,0.12))';
        wrap.style.border     = '1px solid rgba(124,58,237,0.22)';
    }
}

function _aiAssistShowSuccess(count, newIds) {
    const titleEl = document.getElementById('aiAssistProgressTitle');
    const subEl   = document.getElementById('aiAssistProgressSub');
    const isMulti = count && count > 1;
    if (titleEl) {
        titleEl.textContent = isMulti ? count + ' spots added!' : 'Spot added!';
        titleEl.style.color = '#86efac';
    }
    if (subEl) {
        if (isMulti) {
            subEl.textContent = count + ' locations saved to Database'
                + (newIds && newIds.length ? ' (IDs #' + newIds[0] + '–#' + newIds[newIds.length - 1] + ')' : '');
        } else {
            subEl.textContent = 'Saved to Database'
                + (newIds && newIds.length ? ' (Row #' + newIds[0] + ')' : '');
        }
    }

    _aiAssistUpdateStepDot(1, 'done');
    _aiAssistUpdateStepDot(2, 'done');
    _aiAssistUpdateStepDot(3, 'done');
    const c1 = document.getElementById('aiAssistConnector1');
    const c2 = document.getElementById('aiAssistConnector2');
    if (c1) c1.style.width = '100%';
    if (c2) c2.style.width = '100%';

    // Swap animated wand for a green checkmark
    const icon = document.getElementById('aiAssistProgressCenterIcon');
    if (icon) {
        icon.className       = 'fa-solid fa-check';
        icon.style.fontSize  = '22px';
        icon.style.animation = 'none';
        icon.style.color     = '#86efac';
    }
    const wrap = document.getElementById('aiAssistProgressIconWrap');
    if (wrap) {
        wrap.style.background = 'rgba(34,197,94,0.12)';
        wrap.style.border     = '1px solid rgba(34,197,94,0.28)';
    }

    // Processing is done — re-enable the X button and backdrop dismiss
    _aiAssistIsProcessing = false;
    const closeBtn = document.getElementById('aiAssistCloseBtn');
    if (closeBtn) closeBtn.style.display = '';
}

function _aiAssistUpdateStepDot(n, state) {
    const dot   = document.getElementById('aiAssistStep'     + n + 'Dot');
    const icon  = document.getElementById('aiAssistStepIcon' + n);
    const label = document.getElementById('aiAssistStepLabel' + n);
    if (!dot) return;

    const ICONS = { 1: 'fa-wand-magic-sparkles', 2: 'fa-database', 3: 'fa-check' };

    if (state === 'active') {
        dot.style.cssText   = 'background:rgba(124,58,237,0.18);border:2px solid rgba(124,58,237,0.55);animation:aiAssistStepDotPulse 1.2s ease-in-out infinite;width:2rem;height:2rem;border-radius:9999px;display:flex;align-items:center;justify-content:center;margin-bottom:6px;transition:all 0.3s;';
        if (icon)  { icon.className = 'fa-solid ' + ICONS[n]; icon.style.color = '#a78bfa'; icon.style.fontSize = '9px'; }
        if (label) label.style.color = '#a78bfa';
    } else if (state === 'done') {
        dot.style.cssText   = 'background:rgba(124,58,237,0.22);border:2px solid rgba(124,58,237,0.55);animation:none;width:2rem;height:2rem;border-radius:9999px;display:flex;align-items:center;justify-content:center;margin-bottom:6px;transition:all 0.3s;';
        if (icon)  { icon.className = 'fa-solid fa-check'; icon.style.color = '#a78bfa'; icon.style.fontSize = '9px'; }
        if (label) label.style.color = '#a78bfa';
    } else {
        dot.style.cssText   = 'background:rgba(30,41,59,0.9);border:2px solid rgba(51,65,85,0.5);animation:none;width:2rem;height:2rem;border-radius:9999px;display:flex;align-items:center;justify-content:center;margin-bottom:6px;transition:all 0.3s;';
        if (icon)  { icon.className = 'fa-solid ' + ICONS[n]; icon.style.color = '#475569'; icon.style.fontSize = '9px'; }
        if (label) label.style.color = '#475569';
    }
}

/* ── Error panel ────────────────────────────────────────────────────────── */

function _aiAssistShowError(title, detail, showRetry) {
    const t   = document.getElementById('aiAssistErrorTitle');
    const d   = document.getElementById('aiAssistErrorDetail');
    const btn = document.getElementById('aiAssistRetryBtn');
    if (t)   t.textContent = title;
    if (d)   d.textContent = detail;
    if (btn) btn.style.display = (showRetry && typeof _aiAssistRetryFn === 'function') ? '' : 'none';
}

/* ── Form panel helpers ─────────────────────────────────────────────────── */

function _aiAssistOnInput() {
    const input = document.getElementById('aiAssistNotepadInput');
    if (input) {
        try { localStorage.setItem(_AI_ASSIST_DRAFT_KEY, input.value); } catch (e) {}
    }
    _aiAssistSyncSubmitBtn();
}

function _aiAssistSyncSubmitBtn() {
    const input = document.getElementById('aiAssistNotepadInput');
    const btn   = document.getElementById('aiAssistSubmitBtn');
    if (!btn || !input) return;
    const hasText = input.value.trim().length > 0;
    btn.style.opacity       = hasText ? '1'    : '0.45';
    btn.style.pointerEvents = hasText ? 'auto' : 'none';
}

function _aiAssistShowStatus(type, icon, text) {
    const banner = document.getElementById('aiAssistStatusBanner');
    const iconEl = document.getElementById('aiAssistStatusIcon');
    const textEl = document.getElementById('aiAssistStatusText');
    if (!banner) return;
    banner.classList.remove('hidden');
    banner.style.background = type === 'success' ? 'rgba(34,197,94,0.08)'           : 'rgba(248,113,113,0.08)';
    banner.style.border     = type === 'success' ? '1px solid rgba(34,197,94,0.22)' : '1px solid rgba(248,113,113,0.22)';
    banner.style.color      = type === 'success' ? '#86efac'                        : '#fca5a5';
    if (iconEl) iconEl.textContent = icon;
    if (textEl) textEl.textContent = text;
}

function _aiAssistHideStatus() {
    const banner = document.getElementById('aiAssistStatusBanner');
    if (banner) banner.classList.add('hidden');
}

/* ── FAB Radial Satellite Menu ───────────────────────────────────────────────
   toggleFabMenu()      — toggled by the main + button; opens / closes the arc.
   closeFabMenuIfOpen() — call from any code that should dismiss the menu as a
                          side-effect (e.g. tab switches, overlay opens).
   Outside-tap listener — capture-phase so it fires before any child onclick;
                          skips the event if the target lives inside the FAB group.
────────────────────────────────────────────────────────────────────────────── */
let _fabMenuOpen = false;

function toggleFabMenu() {
    _fabMenuOpen = !_fabMenuOpen;

    // Toggle .fab-open on every satellite
    document.querySelectorAll('.fab-satellite').forEach(el =>
        el.classList.toggle('fab-open', _fabMenuOpen)
    );

    // Cone glow
    const glow = document.getElementById('fabConeGlow');
    if (glow) glow.classList.toggle('fab-open', _fabMenuOpen);

    // Rotate + icon 45° → becomes × when open; reset when closed
    const icon = document.getElementById('fabPlusIcon');
    if (icon) icon.style.transform = _fabMenuOpen ? 'rotate(45deg)' : '';
}

function closeFabMenuIfOpen() {
    if (_fabMenuOpen) toggleFabMenu();
}

// ── FAB visibility when drawers are open ─────────────────────────────────────
/**
 * Hides or shows the main FAB button.
 * Satellite buttons are already invisible in their default (closed) state;
 * we close the arc first so no satellite lingers on screen.
 */
function _setFabsVisible(visible) {
    const mainBtn = document.getElementById('globalFloatingActionPlusButton');
    if (!mainBtn) return;
    if (visible) {
        mainBtn.classList.remove('fab-drawer-suppressed');
    } else {
        closeFabMenuIfOpen(); // collapse arc before hiding the anchor button
        mainBtn.classList.add('fab-drawer-suppressed');
    }
}

/**
 * Re-checks whether any drawer is currently open and updates FAB visibility.
 * Call this in every drawer close handler so FABs only reappear when the
 * last open drawer has been dismissed.
 */
function _updateFabVisibility() {
    const anyOpen = [
        document.getElementById('weatherDrawerOverlay'),
        document.getElementById('unifiedFilterSheetOverlay'),
        document.getElementById('currencyDrawerOverlay'),
    ].some(el => el && !el.classList.contains('hidden'));
    _setFabsVisible(!anyOpen);
}

// Dismiss the FAB menu on any tap outside the FAB group
document.addEventListener('click', function _fabOutsideClose(e) {
    if (!_fabMenuOpen) return;
    const mainBtn = document.getElementById('globalFloatingActionPlusButton');
    const sats    = Array.from(document.querySelectorAll('.fab-satellite'));
    const inGroup = (mainBtn && mainBtn.contains(e.target))
                 || sats.some(s => s.contains(e.target));
    if (!inGroup) toggleFabMenu();
}, true /* capture phase — fires before child onclick handlers */);

function toggleFormPriorityState() {
    const btn = document.getElementById('form-priority-btn');
    if(formPriorityState === "Normal") {
        formPriorityState = "Starred"; btn.innerHTML = '<i class="fa-solid fa-star mr-1"></i> Starred';
        btn.className = "px-4 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500 text-amber-400 font-extrabold";
    } else {
        formPriorityState = "Normal"; btn.innerHTML = 'Normal';
        btn.className = "px-4 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 font-bold";
    }
}

// ----------------- FILTERS & LIST VIEW -----------------
function setPriorityFilterState(shouldShowStarredOnly) {
    killLiveSpeechBubbleHUDState();
    if (activeTabID === 'itinerary') {
        // On the itinerary tab the toggle filters itinerary master cards,
        // not saved spots — delegate to the itinerary-specific setter.
        if (typeof setItinFilterState === 'function') setItinFilterState(shouldShowStarredOnly);
        syncPriorityFilterViewModeUI();
        return;
    }
    showStarredOnly = shouldShowStarredOnly;
    localStorage.setItem('compass_starred_only', JSON.stringify(showStarredOnly));
    syncPriorityFilterViewModeUI();
    renderList();
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

// ── Priority capsule toggle — bounce animation ──────────────────────────────
let _priorityToggleLocked = false;

function _setPriorityToggleCell(el, isStarred) {
    const track = document.getElementById('priorityToggleTrack');
    if (!track) return;
    if (isStarred) {
        track.classList.add('is-starred');
    } else {
        track.classList.remove('is-starred');
    }
}

function togglePriorityFilterCapsule() {
    if (_priorityToggleLocked) return;
    _priorityToggleLocked = true;

    const isItinTab  = activeTabID === 'itinerary';
    const curStarred = isItinTab
        ? (typeof itinShowStarredOnly !== 'undefined' ? itinShowStarredOnly : false)
        : showStarredOnly;
    const nextStarred = !curStarred;

    // Commit state immediately — _setPriorityToggleCell (called via
    // syncPriorityFilterViewModeUI inside setPriorityFilterState) updates
    // the pill content and the border glow in the same synchronous frame.
    setPriorityFilterState(nextStarred);

    // Release lock after the thumb slide animation completes (280ms + margin).
    setTimeout(() => { _priorityToggleLocked = false; }, 320);
}

function syncPriorityFilterViewModeUI() {
    // On the itinerary tab reflect the itinerary-specific star filter;
    // on all other tabs reflect the saved-spots star filter.
    const isStarred = (activeTabID === 'itinerary')
        ? (typeof itinShowStarredOnly !== 'undefined' ? itinShowStarredOnly : false)
        : showStarredOnly;
    _setPriorityToggleCell(null, isStarred);
}

function calculateSmartCityDefaultFilters() {
    const container = document.getElementById('cityHUDChecklistContainer');
    if (!container) return; container.innerHTML = '';
    let citySet = new Set();
    // On the itinerary tab build the city list from itinerary data, not spots.
    if (activeTabID === 'itinerary') {
        if (typeof savedItineraries !== 'undefined') {
            savedItineraries.forEach(itin => {
                if (itin.city && String(itin.city).trim() !== '') citySet.add(itin.city.trim());
            });
        }
    } else {
        travelSpots.forEach(spot => { if (spot.city && String(spot.city).trim() !== "") citySet.add(spot.city.trim()); });
    }
    if (citySet.size === 0) {
        container.innerHTML = `<div class="text-slate-500 text-[11px] p-2">No cities recorded</div>`; return;
    }
    citySet.forEach(city => {
        const label = document.createElement('label');
        label.className = "flex items-center justify-between p-2 rounded-lg hover:bg-slate-800 cursor-pointer";
        const isChecked = checkedCitiesStateArray.includes(city);
        label.innerHTML = `<span class="truncate pr-2">${city}</span><input type="checkbox" value="${city}" ${isChecked ? 'checked' : ''} onchange="handleCityHUDCheckboxEventToggle(this)" class="w-3.5 h-3.5 accent-pink-500 rounded bg-slate-950">`;
        container.appendChild(label);
    });
    updateCityHUDTriggerButtonLabelText();
}

function handleCityHUDCheckboxEventToggle(checkboxElement) {
    const val = checkboxElement.value;
    if (checkboxElement.checked) { if(!checkedCitiesStateArray.includes(val)) checkedCitiesStateArray.push(val); }
    else { checkedCitiesStateArray = checkedCitiesStateArray.filter(c => c !== val); }
    localStorage.setItem('compass_active_cities', JSON.stringify(checkedCitiesStateArray));
    updateCityHUDTriggerButtonLabelText();
    if (activeTabID === 'itinerary') {
        // On the itinerary tab, re-render the itinerary master list
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    } else {
        renderList();
        if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        // City filter changed — re-evaluate hidden spot proximity
        if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
    }
}

function clearAllSelectedCityCheckboxes() {
    checkedCitiesStateArray = []; localStorage.setItem('compass_active_cities', JSON.stringify([]));
    const checkboxes = document.getElementById('cityHUDChecklistContainer').querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    updateCityHUDTriggerButtonLabelText();
    if (activeTabID === 'itinerary') {
        // On the itinerary tab, re-render the itinerary master list
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    } else {
        renderList();
        if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        // City filter cleared — no hidden spots possible, dismiss any active HUD
        if (typeof clearHiddenPinsSystemHUD === 'function') clearHiddenPinsSystemHUD();
    }
}

function updateCityHUDTriggerButtonLabelText() {
    const textNode = document.getElementById('cityHUDTriggerText');
    const btn = document.getElementById('cityFilterHUDTriggerBtn');
    const count = checkedCitiesStateArray.length;
    if (count === 0) {
        if (textNode) textNode.innerText = "All Cities";
        if (btn) btn.className = "w-full bg-slate-950 border border-slate-800/80 rounded-xl h-[38px] px-2 text-center text-[11px] font-black text-slate-300 flex items-center justify-center gap-1 truncate shadow-inner";
    } else {
        if (textNode) textNode.innerText = count === 1 ? checkedCitiesStateArray[0] : `Cities (${count})`;
        if (btn) btn.className = "w-full bg-pink-500/10 border border-pink-500/30 rounded-xl h-[38px] px-2 text-center text-[11px] font-black text-pink-400 flex items-center justify-center gap-1 truncate shadow-inner";
    }
    // Sync the unified filter capsule badge whenever the city filter changes
    if (typeof updateFilterCapsuleBadge === 'function') updateFilterCapsuleBadge();
    // Refresh the public-holiday notifier for the newly selected city
    updateHolidayNotifierVisibility();
}

function buildDynamicShoppingCheckboxList() {
    const scrollContainer = document.getElementById('checkboxScrollRegionContainer');
    const stickyPanel = document.getElementById('hideCompletedTargetRowContainer');
    if(!scrollContainer || !stickyPanel) return;
    scrollContainer.innerHTML = ''; stickyPanel.innerHTML = '';
    
    let uniqueCategories = new Set();
    travelSpots.forEach(spot => { if (spot.category) spot.category.split(',').forEach(c => uniqueCategories.add(c.trim())); });
    
    uniqueCategories.forEach(cat => {
        if(!cat) return;
        const label = document.createElement('label');
        label.className = "flex items-center justify-between p-2 rounded-lg hover:bg-slate-800 cursor-pointer";
        label.innerHTML = `<span class="truncate pr-2">${cat}</span><input type="checkbox" value="${cat}" ${checkedFilterStateArray.includes(cat) ? 'checked' : ''} onchange="handleCheckboxToggleEvent(this)" class="w-3.5 h-3.5 accent-pink-500 rounded bg-slate-950">`;
        scrollContainer.appendChild(label);
    });

    const hideCompletedLabel = document.createElement('label');
    hideCompletedLabel.className = "flex items-center justify-between p-2 rounded-lg bg-pink-500/5 hover:bg-pink-500/10 text-pink-400 cursor-pointer text-xs font-bold w-full";
    hideCompletedLabel.innerHTML = `<span class="truncate pr-2 font-black">Hide Completed</span><input type="checkbox" id="hideCompletedFilterSystemCheckbox" ${hideCompletedSpotsStateBool ? 'checked' : ''} onchange="handleHideCompletedStateToggleCheckboxEvent(this)" class="w-3.5 h-3.5 accent-pink-500 rounded bg-slate-950">`;
    stickyPanel.appendChild(hideCompletedLabel);
    updateHeaderBadgeHUDCounters();
}

function handleCheckboxToggleEvent(checkboxElement) {
    const val = checkboxElement.value;
    if (checkboxElement.checked) { if(!checkedFilterStateArray.includes(val)) checkedFilterStateArray.push(val); }
    else { checkedFilterStateArray = checkedFilterStateArray.filter(i => i !== val); }
    // Selecting a category is mutually exclusive with an itinerary day filter — clear it
    // and also reset the city filter that was auto-applied alongside it.
    if (activeItineraryFilter) {
        activeItineraryFilter = null;
        localStorage.removeItem('compass_itinerary_filter');
        clearAllSelectedCityCheckboxes();
    }
    localStorage.setItem('compass_active_filters', JSON.stringify(checkedFilterStateArray));
    updateHeaderBadgeHUDCounters(); renderList();
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
    // If type filter changed, re-evaluate whether nearby hidden spots need alerting
    if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
}

function handleHideCompletedStateToggleCheckboxEvent(checkboxElement) {
    hideCompletedSpotsStateBool = checkboxElement.checked;
    localStorage.setItem('compass_hide_completed', JSON.stringify(hideCompletedSpotsStateBool));
    renderList(); 
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

function clearAllFilterCheckboxes() {
    // Capture before clearing — city filter should only be reset when the itinerary
    // filter was active (it auto-applied the city).  Pure category filters should
    // leave the city filter untouched.
    const _hadItinFilter = !!activeItineraryFilter;
    checkedFilterStateArray = [];
    activeItineraryFilter = null;
    localStorage.setItem('compass_active_filters', JSON.stringify([]));
    localStorage.removeItem('compass_itinerary_filter');
    const checkboxes = document.getElementById('checkboxScrollRegionContainer').querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    if (_hadItinFilter) clearAllSelectedCityCheckboxes();
    updateHeaderBadgeHUDCounters(); renderList();
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
    // Type filter cleared — no hidden spots possible, dismiss any active HUD
    if (typeof clearHiddenPinsSystemHUD === 'function') clearHiddenPinsSystemHUD();
}

/**
 * Apply an itinerary-day filter from the bottom-sheet selector.
 * Called by itinerary.js after the user picks a day with spots.
 *
 * Side-effects:
 *  - Clears category checkboxes (mutually exclusive with itinerary filter)
 *  - Auto-applies the itinerary's city if no city filter is currently active
 *  - Persists both filter states to localStorage
 *  - Re-renders the list + map markers
 *  - Triggers map auto-pan (delayed to let the sheet close animation finish)
 */
function applyItineraryDayFilter(itineraryId, dayIndex) {
    // Clear category filter — mutually exclusive
    checkedFilterStateArray = [];
    localStorage.setItem('compass_active_filters', JSON.stringify([]));
    const _cbs = document.getElementById('checkboxScrollRegionContainer')?.querySelectorAll('input[type="checkbox"]');
    if (_cbs) _cbs.forEach(cb => cb.checked = false);

    // Set itinerary filter
    activeItineraryFilter = { itineraryId, dayIndex };
    localStorage.setItem('compass_itinerary_filter', JSON.stringify(activeItineraryFilter));

    // Auto-apply city if no city filter is currently active
    if (checkedCitiesStateArray.length === 0 && typeof savedItineraries !== 'undefined') {
        const _itin = savedItineraries.find(i => i.id === itineraryId);
        if (_itin?.city) {
            checkedCitiesStateArray = [_itin.city];
            localStorage.setItem('compass_active_cities', JSON.stringify(checkedCitiesStateArray));
            if (typeof updateCityHUDTriggerButtonLabelText === 'function') updateCityHUDTriggerButtonLabelText();
            // Sync city checkbox UI if the city dropdown is open
            const _cityBoxes = document.querySelectorAll('#cityHUDChecklistContainer input[type="checkbox"]');
            _cityBoxes.forEach(cb => { cb.checked = checkedCitiesStateArray.includes(cb.value); });
        }
    }

    // Re-render
    updateHeaderBadgeHUDCounters();
    renderList();
    if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();

    // Close both sheets
    if (typeof closeItineraryFilterSheets === 'function') closeItineraryFilterSheets();

    // Auto-pan map after sheet close animation completes (380 ms)
    setTimeout(() => {
        if (typeof autoFitMapToItineraryDaySpots === 'function') autoFitMapToItineraryDaySpots();
    }, 380);
}

function updateHeaderBadgeHUDCounters() {
    const badge = document.getElementById('activeFilterBadgeCount');
    const btn = document.getElementById('filterMenuTriggerBtn');
    // btn may be a ghost element (display:none) — guard defensively
    const count = checkedFilterStateArray.length + (activeItineraryFilter ? 1 : 0);
    if(count > 0) {
        if(badge) { badge.innerText = count; badge.classList.remove('hidden'); }
        if(btn) btn.className = "w-full bg-pink-500/10 border border-pink-500/30 rounded-xl h-[38px] text-center text-[11px] font-black text-pink-400 flex items-center justify-center gap-1 shadow-inner";
    } else {
        if(badge) badge.classList.add('hidden');
        if(btn) btn.className = "w-full bg-slate-950 border border-slate-800/80 rounded-xl h-[38px] text-center text-[11px] font-black text-slate-300 flex items-center justify-center gap-1 shadow-inner";
    }
    // Itinerary-specific badge on the Type Filter dropdown row
    const itinBadge = document.getElementById('itinTypeBadge');
    if (itinBadge) {
        if (activeItineraryFilter) { itinBadge.classList.remove('hidden'); }
        else { itinBadge.classList.add('hidden'); }
    }
    // Sync the unified filter capsule badge whenever type/itin filter changes
    if (typeof updateFilterCapsuleBadge === 'function') updateFilterCapsuleBadge();
}

// ── Unified Filter Bottom Sheet ───────────────────────────────────────────────
// City icon map — FA solid class for popular destinations (text-only fallback
// for any city not listed here).
const _CITY_FILTER_ICONS = {
    'Paris':        'fa-tower-observation',
    'London':       'fa-crown',
    'Rome':         'fa-landmark-dome',
    'New York':     'fa-city',
    'Tokyo':        'fa-torii-gate',
    'Barcelona':    'fa-sun',
    'Amsterdam':    'fa-bicycle',
    'Dubai':        'fa-star-and-crescent',
    'Sydney':       'fa-opera',
    'Bangkok':      'fa-bahai',
    'Vienna':       'fa-music',
    'Prague':       'fa-chess-rook',
    'Istanbul':     'fa-mosque',
    'Lisbon':       'fa-tram',
    'Berlin':       'fa-tv',
    'Madrid':       'fa-guitar',
    'Athens':       'fa-building-columns',
    'Cairo':        'fa-monument',
    'Singapore':    'fa-map-pin',
    'Mumbai':       'fa-gopuram',
    'Delhi':        'fa-gopuram',
};

let _filterSheetCurrentPage = 1;

function openUnifiedFilterSheet(event) {
    if (event) event.stopPropagation();
    killLiveSpeechBubbleHUDState();
    closeFabMenuIfOpen();
    _setFabsVisible(false); // hide FAB while filter sheet is open
    closeAllActiveHUDDropdownOverlays();

    // Always open on page 1 so the user sees and can change the city
    _filterSheetCurrentPage = 1;
    const page1 = document.getElementById('filterSheetPage1Scroll');
    if (page1) page1.scrollTop = 0;        // reset scroll so top fade starts hidden
    _buildFilterSheetCityGrid();           // → calls _filterSheetSyncFades via rAF
    const inner = document.getElementById('filterSheetPagesInner');
    if (inner) inner.style.transform = 'translateX(0)';
    const headerIcon = document.getElementById('filterSheetHeaderIcon');
    if (headerIcon) headerIcon.style.display = '';
    const title = document.getElementById('filterSheetTitle');
    if (title) title.textContent = 'Filters';

    // Sync Apply button so it's correct the moment the sheet becomes visible
    _filterSheetSyncApplyBtn();

    const overlay = document.getElementById('unifiedFilterSheetOverlay');
    const sheet   = document.getElementById('unifiedFilterSheet');
    if (!overlay || !sheet) return;
    overlay.classList.remove('hidden');
    // Double rAF ensures the translate-100 starting value is painted before
    // we remove it — same pattern used by the itinerary filter sheet.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            sheet.style.transform = 'translateY(0)';
        });
    });
}

function closeUnifiedFilterSheet() {
    const sheet   = document.getElementById('unifiedFilterSheet');
    const overlay = document.getElementById('unifiedFilterSheetOverlay');
    if (!sheet || !overlay) return;
    // Hide overlay immediately — removes dim/blur at the moment of close
    overlay.classList.add('hidden');
    sheet.style.transform = 'translateY(100%)';
    // Post-animation cleanup only (FAB restore)
    setTimeout(() => {
        _updateFabVisibility();
    }, 310);
}

/**
 * Lock or unlock the filter-sheet close affordances while AI Smart Search
 * is processing.  Called by submitSmartSearch() in smart_search.js.
 *
 * locked = true  → dims X + back buttons, blocks overlay tap
 * locked = false → restores everything to normal
 */
function _ssFilterSheetLockUI(locked) {
    const closeBtn = document.getElementById('filterSheetCloseBtn');
    const backBtn  = document.getElementById('filterSheetBackBtn');
    const overlay  = document.getElementById('unifiedFilterSheetOverlay');

    if (closeBtn) {
        closeBtn.style.opacity       = locked ? '0.25' : '';
        closeBtn.style.pointerEvents = locked ? 'none'  : '';
    }
    if (backBtn) {
        backBtn.style.opacity       = locked ? '0.25' : '';
        backBtn.style.pointerEvents = locked ? 'none'  : '';
    }
    // Disable backdrop tap-to-close while AI is running
    if (overlay) {
        overlay.style.pointerEvents = locked ? 'none' : '';
    }
}

function _filterSheetNavBack() {
    const inner      = document.getElementById('filterSheetPagesInner');
    const headerIcon = document.getElementById('filterSheetHeaderIcon');
    const title      = document.getElementById('filterSheetTitle');

    if (_filterSheetCurrentPage === 1) {
        // Already on page 1 — back button closes the sheet
        closeUnifiedFilterSheet();
    } else if (_filterSheetCurrentPage === 4) {
        // Page 4 → Page 3 (day list → itinerary list)
        _filterSheetCurrentPage = 3;
        if (inner) inner.style.transform = 'translateX(-50%)';
        if (headerIcon) headerIcon.style.display = 'none';
        if (title) title.textContent = 'Itineraries';
        requestAnimationFrame(() => {
            const el = document.getElementById('filterSheetPage3Scroll');
            if (el) _filterSheetSyncFades(el);
        });
    } else if (_filterSheetCurrentPage === 3) {
        // Page 3 → Page 2 (itinerary list → categories)
        _filterSheetCurrentPage = 2;
        if (inner) inner.style.transform = 'translateX(-25%)';
        if (headerIcon) headerIcon.style.display = 'none';
        const cityName = checkedCitiesStateArray.length ? checkedCitiesStateArray[0] : '';
        if (title) title.textContent = cityName || 'Filters';
        requestAnimationFrame(() => {
            const el = document.getElementById('filterSheetPage2Scroll');
            if (el) _filterSheetSyncFades(el);
        });
    } else {
        // Page 2 → Page 1 (categories → city grid)
        _filterSheetCurrentPage = 1;
        if (inner) inner.style.transform = 'translateX(0)';
        if (headerIcon) headerIcon.style.display = '';
        if (title) title.textContent = 'Filters';
        // Rebuild grid so the currently selected city tile reflects the live state
        _buildFilterSheetCityGrid(); // already calls _filterSheetSyncFades via rAF
    }
}

function _buildFilterSheetCityGrid() {
    const grid = document.getElementById('filterSheetCityGrid');
    if (!grid) return;
    grid.innerHTML = '';

    // Collect unique cities from the appropriate data source
    const citySet = new Set();
    if (activeTabID === 'itinerary') {
        if (typeof savedItineraries !== 'undefined') {
            savedItineraries.forEach(it => {
                if (it.city && String(it.city).trim()) citySet.add(it.city.trim());
            });
        }
    } else {
        travelSpots.forEach(spot => {
            if (spot.city && String(spot.city).trim()) citySet.add(spot.city.trim());
        });
    }

    // No "All Cities" tile — clearing city selection is done via "Clear All Filters"
    citySet.forEach(city => {
        const isActive = checkedCitiesStateArray.includes(city);
        const iconKey  = _CITY_FILTER_ICONS[city];
        const iconHtml = iconKey
            ? `<i class="fa-solid ${iconKey} text-[11px] shrink-0"></i>`
            : '';
        const btn = document.createElement('button');
        btn.className = 'filter-city-capsule' + (isActive ? ' fs-active' : '');
        btn.style.cssText = '-webkit-tap-highlight-color:transparent';
        btn.onclick = () => _filterSheetSelectCity(city);
        btn.innerHTML = `${iconHtml}<span class="text-[11px] font-black truncate">${city}</span>`;
        grid.appendChild(btn);
    });

    _filterSheetSyncCityBadge();
    // Sync fades after the grid has been painted — rAF ensures layout is ready
    requestAnimationFrame(() => {
        const el = document.getElementById('filterSheetPage1Scroll');
        if (el) _filterSheetSyncFades(el);
    });
}

function _filterSheetSelectCity(city) {
    if (city === null) {
        // Clear city filter — stay on page 1
        checkedCitiesStateArray = [];
        localStorage.setItem('compass_active_cities', JSON.stringify([]));
    } else {
        // Detect whether the city actually changed
        const _prevCity = checkedCitiesStateArray.length ? checkedCitiesStateArray[0] : null;
        const _cityChanged = _prevCity !== city;

        // Single-select: replace whatever was selected
        checkedCitiesStateArray = [city];
        localStorage.setItem('compass_active_cities', JSON.stringify(checkedCitiesStateArray));

        // If the city changed, downstream filters (categories + itinerary) no longer
        // apply to the new city — clear them automatically so stale data can't bleed through
        if (_cityChanged && (checkedFilterStateArray.length > 0 || activeItineraryFilter)) {
            checkedFilterStateArray = [];
            activeItineraryFilter   = null;
            localStorage.setItem('compass_active_filters', JSON.stringify([]));
            localStorage.removeItem('compass_itinerary_filter');
        }
    }

    // Keep ghost checkbox container in sync so legacy clear functions work
    document.querySelectorAll('#cityHUDChecklistContainer input[type="checkbox"]')
        .forEach(cb => { cb.checked = checkedCitiesStateArray.includes(cb.value); });

    // updateCityHUDTriggerButtonLabelText also calls updateFilterCapsuleBadge (patched below)
    updateCityHUDTriggerButtonLabelText();

    if (activeTabID === 'itinerary') {
        if (typeof renderItineraryMasterDashboardWorkspace === 'function')
            renderItineraryMasterDashboardWorkspace();
    } else {
        renderList();
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
    }

    if (city !== null && activeTabID !== 'itinerary') {
        // Navigate to page 2: build categories for the chosen city, then slide
        const page2 = document.getElementById('filterSheetPage2Scroll');
        if (page2) page2.scrollTop = 0;    // reset scroll so top fade starts hidden
        _buildFilterSheetCategoryList(city); // → calls _filterSheetSyncFades via rAF
        _filterSheetCurrentPage = 2;
        const inner = document.getElementById('filterSheetPagesInner');
        if (inner) inner.style.transform = 'translateX(-25%)';
        // On page 2 the sliders icon is replaced by the back chevron — hide it
        const headerIcon = document.getElementById('filterSheetHeaderIcon');
        if (headerIcon) headerIcon.style.display = 'none';
        const title = document.getElementById('filterSheetTitle');
        if (title) title.textContent = city;
    } else if (city !== null && activeTabID === 'itinerary') {
        // On the itinerary tab, category filters don't apply — just close the sheet
        closeUnifiedFilterSheet();
    } else {
        // city === null: refresh the grid (no tile to highlight — clear via footer button)
        _buildFilterSheetCityGrid();
    }
}

/**
 * Builds the innerHTML for a single category row.
 * Left side:  category icon (same getCategoryIconClass helper used everywhere
 *             in the app) + category name.
 * Right side: pink check mark when active, empty checkbox outline when not.
 * Kept in one place so both _buildFilterSheetCategoryList (initial render)
 * and _filterSheetSelectCategory (in-place toggle) stay in sync.
 */
function _filterSheetCatRowHTML(cat, isActive) {
    const iconCls = (typeof getCategoryIconClass === 'function')
        ? getCategoryIconClass(cat)
        : 'fa-location-dot text-slate-400';
    const left  = `<span class="flex items-center gap-2 flex-1 min-w-0 pr-2">`
                + `<i class="fa-solid ${iconCls} text-[13px] shrink-0"></i>`
                + `<span class="text-[12px] font-semibold truncate">${cat}</span>`
                + `</span>`;
    const right = isActive
        ? `<i class="fa-solid fa-check text-pink-400 text-[11px] shrink-0"></i>`
        : `<div class="w-4 h-4 rounded-md border border-slate-600 shrink-0"></div>`;
    return left + right;
}

function _buildFilterSheetCategoryList(city) {
    const container = document.getElementById('filterSheetCategoryList');
    if (!container) return;
    container.innerHTML = '';

    // Gather categories from spots in the selected city
    const catSet = new Set();
    travelSpots.forEach(spot => {
        const spotCity = spot.city ? String(spot.city).trim() : '';
        if (!city || spotCity === city) {
            if (spot.category) {
                spot.category.split(',').forEach(c => { if (c.trim()) catSet.add(c.trim()); });
            }
        }
    });

    if (catSet.size === 0) {
        container.innerHTML = '<div class="text-slate-500 text-[11px] p-3 text-center">No categories found for this city</div>';
    } else {
        catSet.forEach(cat => {
            const isActive = checkedFilterStateArray.includes(cat);
            const btn = document.createElement('button');
            btn.className = 'filter-category-row w-full text-left' + (isActive ? ' fs-active' : '');
            btn.style.cssText = '-webkit-tap-highlight-color:transparent';
            btn.onclick = () => _filterSheetSelectCategory(cat, btn);
            btn.innerHTML = _filterSheetCatRowHTML(cat, isActive);
            container.appendChild(btn);
        });
    }

    _filterSheetSyncCategoryBadge();
    _filterSheetSyncItinBadge();
    // Sync fades after the list has been painted — rAF ensures layout is ready
    requestAnimationFrame(() => {
        const el = document.getElementById('filterSheetPage2Scroll');
        if (el) _filterSheetSyncFades(el);
    });
}

function _filterSheetSelectCategory(cat, btnEl) {
    const idx = checkedFilterStateArray.indexOf(cat);
    if (idx === -1) {
        checkedFilterStateArray.push(cat);
        // Category and itinerary day filters are mutually exclusive
        if (activeItineraryFilter) {
            activeItineraryFilter = null;
            localStorage.removeItem('compass_itinerary_filter');
        }
    } else {
        checkedFilterStateArray.splice(idx, 1);
    }
    localStorage.setItem('compass_active_filters', JSON.stringify(checkedFilterStateArray));

    // Update the tapped row in-place — avoids rebuilding the whole list
    const isActive = checkedFilterStateArray.includes(cat);
    btnEl.className = 'filter-category-row w-full text-left' + (isActive ? ' fs-active' : '');
    btnEl.innerHTML = _filterSheetCatRowHTML(cat, isActive);

    _filterSheetSyncCategoryBadge();
    _filterSheetSyncItinBadge();
    // updateHeaderBadgeHUDCounters also calls updateFilterCapsuleBadge (patched below)
    updateHeaderBadgeHUDCounters();
    renderList();
    if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
    if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
}

let _filterSheetSelectedItineraryId   = null;
let _filterSheetSelectedItineraryName = null;

function _filterSheetOpenItinList() {
    // Navigate to page 3 (itinerary list) inside the unified sheet
    const page3 = document.getElementById('filterSheetPage3Scroll');
    if (page3) page3.scrollTop = 0;
    _buildFilterSheetItineraryList();
    _filterSheetCurrentPage = 3;
    const inner = document.getElementById('filterSheetPagesInner');
    if (inner) inner.style.transform = 'translateX(-50%)';
    const headerIcon = document.getElementById('filterSheetHeaderIcon');
    if (headerIcon) headerIcon.style.display = 'none';
    const title = document.getElementById('filterSheetTitle');
    if (title) title.textContent = 'Itineraries';
}

function _buildFilterSheetItineraryList() {
    const container = document.getElementById('filterSheetItineraryList');
    if (!container) return;
    container.innerHTML = '';

    const selectedCity = checkedCitiesStateArray.length ? checkedCitiesStateArray[0] : null;
    const itins = (typeof savedItineraries !== 'undefined' ? savedItineraries : [])
        .filter(it => !selectedCity || (it.city && it.city.trim() === selectedCity));

    if (itins.length === 0) {
        container.innerHTML = '<div class="text-slate-500 text-[11px] p-3 text-center">No saved itineraries found' +
            (selectedCity ? ' for ' + selectedCity : '') + '</div>';
        requestAnimationFrame(() => {
            const el = document.getElementById('filterSheetPage3Scroll');
            if (el) _filterSheetSyncFades(el);
        });
        return;
    }

    itins.forEach(itin => {
        const realDays = (itin.days || []).filter(d => !d?.isSuggested);
        const isActive = activeItineraryFilter && activeItineraryFilter.itineraryId === itin.id;

        const btn = document.createElement('button');
        btn.style.cssText = '-webkit-tap-highlight-color:transparent';
        btn.className = 'w-full text-left flex items-center gap-3 px-4 py-3.5 rounded-2xl border transition-all '
            + (isActive
                ? 'bg-pink-500/10 border-pink-500/30'
                : 'bg-slate-900/60 border-slate-800/60');
        btn.onclick = () => _filterSheetSelectItinerary(itin);

        const iconPill = `<div class="flex items-center justify-center w-10 h-10 rounded-xl bg-pink-500/15 shrink-0">
            <i class="fa-solid fa-route text-pink-400 text-[16px]"></i>
        </div>`;
        const textBlock = `<div class="flex-1 min-w-0">
            <div class="text-[13px] font-black text-slate-200 truncate">${itin.title || 'Untitled'}</div>
            <div class="text-[10px] text-slate-500 font-semibold mt-0.5">${realDays.length} day${realDays.length !== 1 ? 's' : ''}${itin.city ? ' · ' + itin.city : ''}</div>
        </div>`;
        const chevron = `<i class="fa-solid fa-chevron-right text-[10px] text-slate-500 shrink-0 opacity-60"></i>`;

        btn.innerHTML = iconPill + textBlock + chevron;
        container.appendChild(btn);
    });

    // Sync the page 3 badge on the banner (reuse itinBadge in page 2 is separate — add page3 badge)
    const p3badge = document.getElementById('filterSheetItinListBadge');
    if (p3badge) {
        p3badge.classList.toggle('hidden', !activeItineraryFilter);
    }

    requestAnimationFrame(() => {
        const el = document.getElementById('filterSheetPage3Scroll');
        if (el) _filterSheetSyncFades(el);
    });
}

function _filterSheetSelectItinerary(itin) {
    _filterSheetSelectedItineraryId   = itin.id;
    _filterSheetSelectedItineraryName = itin.title || 'Untitled';

    // Set the page 4 context header
    const nameEl = document.getElementById('filterSheetDayListItinName');
    if (nameEl) nameEl.textContent = _filterSheetSelectedItineraryName;

    const page4 = document.getElementById('filterSheetPage4Scroll');
    if (page4) page4.scrollTop = 0;
    _buildFilterSheetDayList(itin);

    _filterSheetCurrentPage = 4;
    const inner = document.getElementById('filterSheetPagesInner');
    if (inner) inner.style.transform = 'translateX(-75%)';
    const headerIcon = document.getElementById('filterSheetHeaderIcon');
    if (headerIcon) headerIcon.style.display = 'none';
    const title = document.getElementById('filterSheetTitle');
    if (title) title.textContent = _filterSheetSelectedItineraryName;
}

function _buildFilterSheetDayList(itin) {
    const container = document.getElementById('filterSheetDayList');
    if (!container) return;
    container.innerHTML = '';

    const realDays = (itin.days || []).filter(d => !d?.isSuggested);

    if (realDays.length === 0) {
        // Speech bubble empty state — mirrors existing itinerary filter empty state
        container.innerHTML = `<div class="flex flex-col items-center justify-center gap-3 py-8 px-4">
            <div class="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center">
                <i class="fa-regular fa-comment-dots text-slate-500 text-[20px]"></i>
            </div>
            <div class="text-center">
                <div class="text-[12px] font-black text-slate-400">No days yet</div>
                <div class="text-[10px] text-slate-600 mt-1">Add days to this itinerary to filter by them.</div>
            </div>
        </div>`;
        requestAnimationFrame(() => {
            const el = document.getElementById('filterSheetPage4Scroll');
            if (el) _filterSheetSyncFades(el);
        });
        return;
    }

    realDays.forEach((day, visIdx) => {
        const realIdx   = itin.days.indexOf(day);
        const isActive  = activeItineraryFilter &&
                          activeItineraryFilter.itineraryId === itin.id &&
                          activeItineraryFilter.dayIndex    === realIdx;

        // Parse date for display
        let dateLabel = '';
        try {
            if (day.date) {
                const d = new Date(day.date);
                dateLabel = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            }
        } catch(e) {}

        const spotCount = (day.timeline || []).length;
        const isEmpty   = spotCount === 0;

        const btn = document.createElement('button');
        btn.style.cssText = '-webkit-tap-highlight-color:transparent';
        btn.className = 'w-full text-left flex items-center gap-3 px-4 py-3.5 rounded-2xl border transition-all '
            + (isActive
                ? 'bg-pink-500/10 border-pink-500/30'
                : 'bg-slate-900/60 border-slate-800/60');

        // Tapping an empty day does nothing (show speech bubble row but not clickable)
        if (!isEmpty) {
            btn.onclick = () => {
                applyItineraryDayFilter(itin.id, realIdx);
                closeUnifiedFilterSheet();
            };
        } else {
            btn.style.opacity = '0.5';
            btn.style.cursor  = 'default';
        }

        const iconPill = `<div class="flex items-center justify-center w-10 h-10 rounded-xl ${isEmpty ? 'bg-slate-800/60' : 'bg-pink-500/15'} shrink-0">
            <i class="fa-solid ${isEmpty ? 'fa-comment-dots text-slate-500' : 'fa-calendar-day text-pink-400'} text-[15px]"></i>
        </div>`;
        const textBlock = `<div class="flex-1 min-w-0">
            <div class="text-[13px] font-black text-slate-200">Day ${visIdx + 1}${dateLabel ? ' · ' + dateLabel : ''}</div>
            <div class="text-[10px] text-slate-500 font-semibold mt-0.5">${isEmpty ? 'No spots yet' : spotCount + ' spot' + (spotCount !== 1 ? 's' : '')}</div>
        </div>`;
        const right = isActive
            ? `<i class="fa-solid fa-check text-pink-400 text-[12px] shrink-0"></i>`
            : `<i class="fa-solid fa-chevron-right text-[10px] text-slate-500 shrink-0 opacity-60"></i>`;

        btn.innerHTML = iconPill + textBlock + right;
        container.appendChild(btn);
    });

    requestAnimationFrame(() => {
        const el = document.getElementById('filterSheetPage4Scroll');
        if (el) _filterSheetSyncFades(el);
    });
}

function _filterSheetClearAll() {
    const _hadItinFilter = !!activeItineraryFilter;
    checkedCitiesStateArray = [];
    checkedFilterStateArray = [];
    activeItineraryFilter   = null;
    localStorage.setItem('compass_active_cities',  JSON.stringify([]));
    localStorage.setItem('compass_active_filters', JSON.stringify([]));
    localStorage.removeItem('compass_itinerary_filter');
    // Deactivate any active Custom Filter (without deleting it — broom does that)
    if (typeof deactivateCustomFilter === 'function') deactivateCustomFilter();

    // Sync any ghost checkboxes so legacy clear helpers stay consistent
    document.querySelectorAll('#cityHUDChecklistContainer input[type="checkbox"]').forEach(cb => cb.checked = false);
    document.querySelectorAll('#checkboxScrollRegionContainer input[type="checkbox"]').forEach(cb => cb.checked = false);

    updateCityHUDTriggerButtonLabelText(); // → updateFilterCapsuleBadge
    updateHeaderBadgeHUDCounters();        // → updateFilterCapsuleBadge

    if (activeTabID === 'itinerary') {
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    } else {
        renderList();
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        if (_hadItinFilter && typeof clearHiddenPinsSystemHUD === 'function') clearHiddenPinsSystemHUD();
    }

    // Jump directly to page 1 (regardless of current depth) and rebuild the grid
    _filterSheetCurrentPage = 1;
    const _clrInner = document.getElementById('filterSheetPagesInner');
    if (_clrInner) _clrInner.style.transform = 'translateX(0)';
    const _clrIcon = document.getElementById('filterSheetHeaderIcon');
    if (_clrIcon) _clrIcon.style.display = '';
    const _clrTitle = document.getElementById('filterSheetTitle');
    if (_clrTitle) _clrTitle.textContent = 'Filters';
    _buildFilterSheetCityGrid();
}

// Scroll-fade helpers ─────────────────────────────────────────────────────────

/**
 * Reads scrollTop / clientHeight / scrollHeight of a scrollable page div and
 * updates the opacity of the two sibling fade overlays (.fs-fade-top-overlay
 * and .fs-fade-btm-overlay) that live in the same relative wrapper.
 *
 * Call on every 'scroll' event AND once after content is (re)built so the
 * initial state is always correct (e.g. content shorter than the viewport
 * → both fades hidden; content taller → bottom fade shows immediately).
 */
function _filterSheetSyncFades(scrollEl) {
    const wrap = scrollEl.parentElement;
    if (!wrap) return;
    const fadeTop = wrap.querySelector('.fs-fade-top-overlay');
    const fadeBtm = wrap.querySelector('.fs-fade-btm-overlay');
    const st       = scrollEl.scrollTop;
    const atTop    = st <= 2;
    const atBottom = st + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
    if (fadeTop) fadeTop.style.opacity = atTop    ? '0' : '1';
    if (fadeBtm) fadeBtm.style.opacity = atBottom ? '0' : '1';
}

// Badge sync helpers ──────────────────────────────────────────────────────────

function _filterSheetSyncCityBadge() {
    const badge = document.getElementById('filterSheetCityBadge');
    if (!badge) return;
    const n = checkedCitiesStateArray.length;
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
}

function _filterSheetSyncCategoryBadge() {
    const badge = document.getElementById('filterSheetCategoryBadge');
    if (!badge) return;
    const n = checkedFilterStateArray.length;
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
}

function _filterSheetSyncItinBadge() {
    const badge = document.getElementById('filterSheetItinBadge');
    if (!badge) return;
    badge.classList.toggle('hidden', !activeItineraryFilter);
}

/**
 * Enable or disable the Apply button in the filter sheet footer.
 * Apply is only meaningful when at least one filter is selected — otherwise
 * it is visually muted and non-interactive via .fs-apply-disabled.
 * Called from updateFilterCapsuleBadge (which fires on every filter change)
 * and once on sheet open so the button always reflects the live state.
 */
function _filterSheetSyncApplyBtn() {
    const btn = document.getElementById('filterSheetApplyBtn');
    if (!btn) return;
    const hasFilters = checkedCitiesStateArray.length > 0
                    || checkedFilterStateArray.length > 0
                    || !!activeItineraryFilter;
    btn.classList.toggle('fs-apply-disabled', !hasFilters);
}

/**
 * Sync the unified capsule button's label, badge dot, and active styling.
 * Called from updateCityHUDTriggerButtonLabelText + updateHeaderBadgeHUDCounters
 * so it stays consistent whenever any filter state changes.
 */
function updateFilterCapsuleBadge() {
    const btn   = document.getElementById('filterUnifiedCapsuleBtn');
    const badge = document.getElementById('filterCapsuleActiveBadge');
    const wrap  = document.getElementById('filterCapsuleLabelWrap');
    if (!btn || !badge || !wrap) return;

    const cityCount  = checkedCitiesStateArray.length;
    const catCount   = checkedFilterStateArray.length;
    const itinActive = !!activeItineraryFilter;
    // Pull active custom filter name from smart_search.js (guard for load order)
    const customFilterName = (typeof getActiveCustomFilterName === 'function')
        ? getActiveCustomFilterName() : null;
    const isActive = cityCount > 0 || catCount > 0 || itinActive || !!customFilterName;

    // Pink glow via CSS class
    btn.classList.toggle('filter-capsule-active', isActive);

    // ── No filters: restore static "Filter" label ────────────────────────────
    if (!isActive) {
        badge.classList.add('hidden');
        wrap.innerHTML = '<span id="filterCapsuleLabel" class="block text-[11px] font-black whitespace-nowrap">Filter</span>';
        _filterSheetSyncApplyBtn();
        return;
    }

    // ── Build the ordered segment list ───────────────────────────────────────
    // Each entry: { text: string, html: string } — text used for pixel-width
    // measurement, html used for final rendering (allows per-segment colour).
    const segs = [];

    // Helper: HTML-escape a plain string safely
    function _fcEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    // 1. City
    if (cityCount === 1) {
        const t = checkedCitiesStateArray[0];
        segs.push({ text: t, html: _fcEsc(t) });
    }

    // 2. All selected category names, comma-separated
    if (catCount > 0) {
        const t = checkedFilterStateArray.join(', ');
        segs.push({ text: t, html: _fcEsc(t) });
    }

    // 3. Itinerary title + Day
    if (itinActive) {
        const itin = (typeof savedItineraries !== 'undefined')
            ? savedItineraries.find(i => i.id === activeItineraryFilter.itineraryId)
            : null;
        if (itin) {
            const titleT = itin.title || 'Itinerary';
            segs.push({ text: titleT, html: _fcEsc(titleT) });
            if (typeof activeItineraryFilter.dayIndex === 'number') {
                const realDays = (itin.days || []).filter(d => !d?.isSuggested);
                const rawDay   = (itin.days || [])[activeItineraryFilter.dayIndex];
                const visIdx   = rawDay ? realDays.indexOf(rawDay) + 1 : activeItineraryFilter.dayIndex + 1;
                if (visIdx > 0) segs.push({ text: 'Day ' + visIdx, html: _fcEsc('Day ' + visIdx) });
            }
        } else {
            segs.push({ text: 'Itinerary', html: 'Itinerary' });
        }
    }

    // 4. Active custom filter(s) — violet/indigo to match AI Smart Search theme.
    //    getActiveCustomFilterName() returns string[]|null (one entry per active filter).
    //    1 active  → show the name
    //    2 active  → "Name1 + Name2"
    //    3+ active → "Name1 + N more"
    if (customFilterName) {
        let cfText, cfHtml;
        if (customFilterName.length === 1) {
            cfText = customFilterName[0];
            cfHtml = '<span style="color:#a78bfa;font-weight:900;">' + _fcEsc(cfText) + '</span>';
        } else if (customFilterName.length === 2) {
            cfText = customFilterName.join(' + ');
            cfHtml = customFilterName.map(n =>
                '<span style="color:#a78bfa;font-weight:900;">' + _fcEsc(n) + '</span>'
            ).join('<span style="color:#a78bfa;opacity:0.6;"> + </span>');
        } else {
            cfText = customFilterName[0] + ' + ' + (customFilterName.length - 1) + ' more';
            cfHtml = '<span style="color:#a78bfa;font-weight:900;">'
                   + _fcEsc(customFilterName[0])
                   + '</span><span style="color:#a78bfa;opacity:0.65;"> + '
                   + (customFilterName.length - 1) + ' more</span>';
        }
        segs.push({ text: cfText, html: cfHtml });
    }

    // Update badge count (each active custom filter counts as +1)
    const total = cityCount + catCount + (itinActive ? 1 : 0)
                + (customFilterName ? customFilterName.length : 0);
    badge.textContent = total;
    badge.classList.remove('hidden');

    // ── Build label: measure first, then static or animated ─────────────────
    const SEP_TEXT = ' · ';
    const SEP_HTML = '<span style="opacity:0.45;"> · </span>';
    const fullText = segs.map(s => s.text).join(SEP_TEXT);
    const fullHtml = segs.map(s => s.html).join(SEP_HTML);

    // Render a single invisible plain-text copy to measure natural pixel width
    // before committing to either a static or scrolling layout.
    wrap.innerHTML = '<span id="_fcMeasure" class="text-[11px] font-bold whitespace-nowrap"'
                   + ' style="display:inline-block;visibility:hidden;">' + fullText + '</span>';

    requestAnimationFrame(() => {
        const measureEl = document.getElementById('_fcMeasure');
        const wrapWidth = wrap ? wrap.clientWidth : 0;
        const textWidth = measureEl ? measureEl.scrollWidth : Infinity;

        if (textWidth <= wrapWidth) {
            // Fits entirely — show plain static text, no animation needed
            wrap.innerHTML = '<span class="text-[11px] font-bold whitespace-nowrap"'
                           + ' style="display:block;width:100%;">' + fullHtml + '</span>';
        } else {
            // Overflows — activate the looping ticker with pipe bookends
            const paddedHtml = '|&nbsp;&nbsp;' + fullHtml + '&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
            const dur = Math.max(8, Math.min(22, Math.round(fullText.length * 0.38)));
            wrap.innerHTML =
                '<div id="filterCapsuleTicker"'
              + ' style="display:flex;width:max-content;will-change:transform;'
              + 'animation:filterCapsuleScroll ' + dur + 's linear infinite;white-space:nowrap;">'
              + '<span class="text-[11px] font-bold">' + paddedHtml + '</span>'
              + '<span class="text-[11px] font-bold" aria-hidden="true">' + paddedHtml + '</span>'
              + '</div>';
        }
    });

    // Keep Apply button in sync with the live filter state
    _filterSheetSyncApplyBtn();
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Hidden Pins Alert Banner ─────────────────────────────────────────────────
// Shows a sliding banner on the map tab when the user is within 500m of spots
// that are hidden because both a city filter AND a type filter are active.
// After dismissal the banner shrinks into a small red bubble with a periodic
// attention wiggle. Tapping the bubble re-opens the banner.
// ────────────────────────────────────────────────────────────────────────────

let hiddenPinsBannerIsVisible    = false;  // sliding banner currently shown
let hiddenPinsMiniBubbleVisible  = false;  // shrunken bubble currently shown
let hiddenPinsBubbleAttentionLoop = null;  // setInterval handle for icon wiggle
let hiddenPinsLastTriggeredCount  = 0;     // spot count when banner last opened

function checkForNearbyHiddenSpots() {
    // Only act when the user is on the map tab
    if (typeof activeTabID === 'undefined' || activeTabID !== 'map') return;

    // Feature only fires when BOTH a city AND a type filter are active
    if (!checkedCitiesStateArray.length || !checkedFilterStateArray.length) {
        clearHiddenPinsSystemHUD();
        return;
    }

    // Need a live GPS fix to know where the user is
    if (!gpsStatusCachedBool || typeof userLat === 'undefined' || typeof userLon === 'undefined') return;

    // Count spots that pass the city filter but FAIL the type filter and are within 500 m
    const hiddenNearbyCount = travelSpots.filter(spot => {
        if (!checkedCitiesStateArray.includes(spot.city)) return false;             // must match city
        const spotCats = spot.category
            ? spot.category.split(',').map(c => c.trim().toLowerCase())
            : [];
        const passesType = checkedFilterStateArray.some(f => spotCats.includes(f.toLowerCase()));
        if (passesType) return false;                                               // visible — skip
        const lat = parseFloat(spot.latitude);
        const lon = parseFloat(spot.longitude);
        if (!lat || !lon) return false;                                             // no coordinates
        return calculateDistance(userLat, userLon, lat, lon) <= 0.5;               // within 500 m
    }).length;

    if (hiddenNearbyCount > 0) {
        // Show or refresh the banner only when neither UI element is already up
        if (!hiddenPinsBannerIsVisible && !hiddenPinsMiniBubbleVisible) {
            showHiddenPinsBannerHUD(hiddenNearbyCount);
        } else {
            hiddenPinsLastTriggeredCount = hiddenNearbyCount;   // keep count in sync
        }
    } else {
        clearHiddenPinsSystemHUD();
    }
}

function showHiddenPinsBannerHUD(count) {
    const banner   = document.getElementById('hiddenPinsAlertBanner');
    const subtitle = document.getElementById('hiddenPinsAlertBannerSubtitle');
    if (!banner) return;

    hiddenPinsLastTriggeredCount = count;

    if (subtitle) {
        const word = count === 1 ? 'spot' : 'spots';
        const verb = count === 1 ? "it's" : "they're";
        subtitle.textContent = `Saved spots are nearby but hidden by your filter.`;
    }

    // Make sure the bubble is gone before showing the banner
    const bubble = document.getElementById('hiddenPinsMiniBubble');
    if (bubble) bubble.classList.add('hidden');
    hiddenPinsMiniBubbleVisible = false;
    stopHiddenPinsBubbleAttentionLoop();

    // Trigger slide-in animation (force reflow to replay it if already animated)
    banner.classList.remove('hidden-pins-banner-enter', 'hidden-pins-banner-exit');
    banner.classList.remove('hidden');
    void banner.offsetWidth;
    banner.classList.add('hidden-pins-banner-enter');
    hiddenPinsBannerIsVisible = true;
}

function dismissHiddenPinsBannerToMiniBubble() {
    const banner = document.getElementById('hiddenPinsAlertBanner');
    const bubble = document.getElementById('hiddenPinsMiniBubble');
    if (!banner) return;

    // Slide banner back up
    banner.classList.remove('hidden-pins-banner-enter');
    banner.classList.add('hidden-pins-banner-exit');

    setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('hidden-pins-banner-exit');
        hiddenPinsBannerIsVisible = false;

        // Reveal the mini bubble and start its attention loop
        if (bubble) {
            bubble.classList.remove('hidden');
            hiddenPinsMiniBubbleVisible = true;
            startHiddenPinsBubbleAttentionLoop();
        }
    }, 280);
}

function unhideHiddenPinsBannerAction() {
    // Clear the type filter so all pins in the active city become visible again
    clearAllFilterCheckboxes();
    clearHiddenPinsSystemHUD();
}

function clearHiddenPinsSystemHUD() {
    const banner = document.getElementById('hiddenPinsAlertBanner');
    const bubble = document.getElementById('hiddenPinsMiniBubble');

    if (banner && !banner.classList.contains('hidden')) {
        banner.classList.remove('hidden-pins-banner-enter');
        banner.classList.add('hidden-pins-banner-exit');
        setTimeout(() => {
            banner.classList.add('hidden');
            banner.classList.remove('hidden-pins-banner-exit');
        }, 260);
    }
    hiddenPinsBannerIsVisible = false;

    if (bubble) bubble.classList.add('hidden');
    hiddenPinsMiniBubbleVisible   = false;
    hiddenPinsLastTriggeredCount  = 0;
    stopHiddenPinsBubbleAttentionLoop();

    // Also close the drawer if it happens to be open
    if (typeof closeHiddenPinsDrawer === 'function') closeHiddenPinsDrawer();
}

function startHiddenPinsBubbleAttentionLoop() {
    stopHiddenPinsBubbleAttentionLoop();

    const fireWiggle = () => {
        if (!hiddenPinsMiniBubbleVisible) return;
        const icon = document.getElementById('hiddenPinsMiniBubbleIcon');
        if (!icon) return;
        icon.classList.remove('hidden-pins-bubble-attention');
        void icon.offsetWidth;
        icon.classList.add('hidden-pins-bubble-attention');
        // Clean up class once the animation finishes so it can replay next time
        setTimeout(() => icon.classList.remove('hidden-pins-bubble-attention'), 800);
    };

    // First wiggle after 2.5 s so the bubble has a moment to settle
    setTimeout(fireWiggle, 2500);
    // Then repeat every 6 s
    hiddenPinsBubbleAttentionLoop = setInterval(fireWiggle, 6000);
}

function stopHiddenPinsBubbleAttentionLoop() {
    if (hiddenPinsBubbleAttentionLoop !== null) {
        clearInterval(hiddenPinsBubbleAttentionLoop);
        hiddenPinsBubbleAttentionLoop = null;
    }
}

function reopenHiddenPinsBanner() {
    // Bubble tap now opens the detailed drawer instead of the simple banner
    openHiddenPinsDrawer();
}

// ── Hidden Pins Drawer ───────────────────────────────────────────────────────
// Left-side slide-in panel that lists every spot hidden by the active type
// filter, grouped into Starred and Unstarred sections.
// Each row shows the category icon, spot name, a reference link, and a
// per-spot Unhide button that adds that spot's category to the type filter.
// "Unhide All" at the bottom clears the type filter entirely.
// ────────────────────────────────────────────────────────────────────────────

// Maps a category string to a Font Awesome icon class + colour class pair.
// Used by the drawer rows, the list-card badges, and the map-tray badge.
// Mirrors the marker icon logic in map.js so all three views stay in sync.
function getCategoryIconClass(category) {
    const s = (category || "").toLowerCase();
    if (s.includes("photo"))     return "fa-camera-retro text-pink-500";
    if (s.includes("food"))      return "fa-utensils text-orange-500";
    if (s.includes("viewpoint")) return "fa-binoculars text-sky-500";
    if (s.includes("landmark"))  return "fa-landmark text-yellow-500";
    if (s.includes("nature"))    return "fa-leaf text-emerald-500";
    if (s.includes("culture"))   return "fa-landmark text-violet-500";
    if (s.includes("shopping") || s.includes("shop")) return "fa-bag-shopping text-rose-500";
    if (s.includes("activity"))  return "fa-person-running text-amber-500";
    if (s.includes("relax"))     return "fa-spa text-teal-500";
    if (s.includes("nightlife") || s.includes("bar") || s.includes("drink")) return "fa-martini-glass text-indigo-500";
    return "fa-location-dot text-slate-400";
}
// Legacy alias — keeps the drawer code working without any other edits
const getCategoryIconClassForDrawer = getCategoryIconClass;

// ── Weather helpers ──────────────────────────────────────────────────────────

/**
 * Maps WMO weather interpretation codes → Font Awesome 6 Free class strings.
 * isDay: true = daytime variant (sun/cloud-sun), false = night variant (moon/cloud-moon).
 */
function _wmoIconClass(code, isDay) {
    const c = parseInt(code, 10);
    if (c === 0 || c === 1)  return isDay ? 'fa-sun text-yellow-400'       : 'fa-moon text-slate-300';
    if (c === 2)             return isDay ? 'fa-cloud-sun text-yellow-300'  : 'fa-cloud-moon text-slate-400';
    if (c === 3)             return 'fa-cloud text-slate-400';
    if (c === 45 || c === 48) return 'fa-smog text-slate-400';
    if (c >= 51 && c <= 57) return 'fa-cloud-rain text-blue-400';
    if (c >= 61 && c <= 67) return 'fa-cloud-rain text-blue-300';
    if (c >= 71 && c <= 77) return 'fa-snowflake text-sky-300';
    if (c >= 80 && c <= 82) return 'fa-cloud-showers-heavy text-blue-400';
    if (c === 85 || c === 86) return 'fa-snowflake text-sky-300';
    if (c >= 95)             return 'fa-cloud-bolt text-amber-400';
    return 'fa-cloud text-slate-400';
}

/** Maps WMO weather codes → human-readable description string. */
function _wmoDescription(code) {
    const c = parseInt(code, 10);
    const map = {
        0:'Clear Sky', 1:'Mainly Clear', 2:'Partly Cloudy', 3:'Overcast',
        45:'Foggy', 48:'Rime Fog',
        51:'Light Drizzle', 53:'Drizzle', 55:'Dense Drizzle',
        56:'Light Freezing Drizzle', 57:'Freezing Drizzle',
        61:'Light Rain', 63:'Rain', 65:'Heavy Rain',
        66:'Light Freezing Rain', 67:'Freezing Rain',
        71:'Light Snow', 73:'Snow', 75:'Heavy Snow', 77:'Snow Grains',
        80:'Light Showers', 81:'Showers', 82:'Heavy Showers',
        85:'Light Snow Showers', 86:'Snow Showers',
        95:'Thunderstorm', 96:'Thunderstorm w/ Hail', 99:'Thunderstorm',
    };
    return map[c] || 'Cloudy';
}

// Legacy OWM icon mapper — preserved for future reference but no longer called.
// function getWeatherFAIconClass(owmIconCode) { ... }
function getWeatherFAIconClass(owmIconCode) {
    const code = (owmIconCode || ''); const prefix = code.substring(0, 2); const isNight = code.endsWith('n');
    if (prefix === '01') return isNight ? 'fa-moon text-slate-300'        : 'fa-sun text-yellow-400';
    if (prefix === '02') return isNight ? 'fa-cloud-moon text-slate-400'  : 'fa-cloud-sun text-yellow-300';
    if (prefix === '03') return 'fa-cloud text-slate-300';
    if (prefix === '04') return 'fa-cloud text-slate-400';
    if (prefix === '09') return 'fa-cloud-showers-heavy text-blue-400';
    if (prefix === '10') return isNight ? 'fa-cloud-moon-rain text-blue-400' : 'fa-cloud-rain text-blue-300';
    if (prefix === '11') return 'fa-cloud-bolt text-amber-400';
    if (prefix === '13') return 'fa-snowflake text-sky-300';
    if (prefix === '50') return 'fa-smog text-slate-400';
    return 'fa-cloud text-slate-400';
}

/**
 * Fetches current weather for the given lat/lon via Open-Meteo.
 * Returns { iconClass, temp, feelsLike, country, city } on success, or null.
 */
async function fetchWeatherForCoords(lat, lon) {
    const key    = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
    const cached = weatherCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < WEATHER_CACHE_TTL) return cached;
    try {
        const latStr = parseFloat(lat).toFixed(4);
        const lonStr = parseFloat(lon).toFixed(4);
        const [wxResp, geo] = await Promise.all([
            fetch(
                `https://api.open-meteo.com/v1/forecast` +
                `?latitude=${latStr}&longitude=${lonStr}` +
                `&current=temperature_2m,apparent_temperature,weather_code,is_day` +
                `&timezone=auto&forecast_days=1`
            ),
            _reverseGeocode(lat, lon),
        ]);
        const wx = await wxResp.json();
        if (!wx.current) return null;
        const cur       = wx.current;
        const iconClass = _wmoIconClass(cur.weather_code, cur.is_day === 1);
        const temp      = Math.round(cur.temperature_2m      ?? 0);
        const feelsLike = Math.round(cur.apparent_temperature ?? cur.temperature_2m ?? 0);
        const result    = { iconClass, temp, feelsLike, country: geo.country, city: geo.city, fetchedAt: Date.now() };
        weatherCache.set(key, result);
        return result;
    } catch (_) {
        return null;
    }
}

// Walks all currently-rendered list cards and fills in their weather badges.
// Skips spots with no coordinates (they show the disabled state from render time).
async function refreshAllWeatherBadges() {
    for (const spot of travelSpots) {
        const latStr = spot.latitude  ? String(spot.latitude).trim()  : '';
        const lngStr = spot.longitude ? String(spot.longitude).trim() : '';
        if (!latStr || latStr === '0' || !lngStr || lngStr === '0') continue;
        const el = document.getElementById(`weather-badge-${spot.rowid}`);
        if (!el) continue;
        const w = await fetchWeatherForCoords(parseFloat(latStr), parseFloat(lngStr));
        if (w) {
            el.innerHTML = `<i class="fa-solid ${w.iconClass} text-[10px]"></i><span>${w.temp}°</span>`;
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  WEATHER DRAWER
//  Opened by tapping the map weather capsule (mapWeatherWidget).
//  Fetches weather (full), AQI, and UV in parallel via the GAS backend proxy.
//  All times are derived client-side from UNIX timestamps; no extra API calls.
// ════════════════════════════════════════════════════════════════════════════

const _wdDataCache         = new Map();            // "lat,lon" → { data, fetchedAt } — in-session mem cache
const _WD_CACHE_TTL        = 5  * 60 * 1000;      // 5 min  — how long mem cache is considered fresh
const _WD_BG_INTERVAL      = 30 * 60 * 1000;      // 30 min — background refresh cadence (drawer closed)
const _WD_LS_KEY           = 'compass_wd_cache_v5'; // localStorage key for persisted weather cache
let   _wdActiveTab         = 'weather';             // 'weather' | 'stargazing'
let   _wdRefreshInterval   = null;                 // in-drawer live-refresh (5 min)
let   _wdStatusTickId      = null;                 // 1-min tick to keep "Updated X mins ago" current
let   _wdBgRefreshInterval = null;                 // background refresh while drawer is closed
let   _wdLastFetchedAt     = null;                 // ms timestamp of the most recent successful fetch

// ── localStorage cache helpers ─────────────────────────────────────────────────
/** Persist a weather payload to localStorage (capped at 5 locations). */
function _wdSaveToStorage(key, data) {
    try {
        const raw   = localStorage.getItem(_WD_LS_KEY);
        const store = raw ? JSON.parse(raw) : {};
        store[key]  = { data, fetchedAt: Date.now() };
        // Evict oldest entries if we're above 5 locations
        const keys = Object.keys(store);
        if (keys.length > 5) {
            keys.sort((a, b) => store[a].fetchedAt - store[b].fetchedAt)
                .slice(0, keys.length - 5)
                .forEach(k => delete store[k]);
        }
        localStorage.setItem(_WD_LS_KEY, JSON.stringify(store));
    } catch (_) {}
}

/** Load the persisted weather entry for given coords, or null if absent. */
function _wdLoadFromStorage(lat, lon) {
    try {
        const key   = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
        const raw   = localStorage.getItem(_WD_LS_KEY);
        if (!raw) return null;
        return JSON.parse(raw)[key] || null;   // { data, fetchedAt } | null
    } catch (_) { return null; }
}

// ── Sync-status label ─────────────────────────────────────────────────────────
/**
 * Update the small status line in the drawer header.
 * @param {'syncing'|'done'} state
 */
function _wdSetSyncStatus(state) {
    const el = document.getElementById('wdSyncStatus');
    if (!el) return;
    if (state === 'syncing') {
        el.innerHTML =
            `<i class="fa-solid fa-rotate fa-spin text-[8px] text-sky-500/70"></i>` +
            `<span>Syncing...</span>`;
        el.className = 'flex items-center gap-1 mt-1 text-[9px] font-bold text-slate-500';
    } else {
        if (!_wdLastFetchedAt) { el.innerHTML = ''; return; }
        const mins  = Math.round((Date.now() - _wdLastFetchedAt) / 60000);
        const label = mins < 1
            ? 'Updated Just Now'
            : `Updated ${mins} min${mins !== 1 ? 's' : ''} ago`;
        el.innerHTML =
            `<i class="fa-solid fa-circle-check text-[8px] text-emerald-500/80"></i>` +
            `<span>${label}</span>`;
        el.className = 'flex items-center gap-1 mt-1 text-[9px] font-bold text-emerald-700/70';
    }
}

/** Start a 60-second tick that keeps the "Updated X mins ago" label counting up. */
function _wdStartStatusTick() {
    clearInterval(_wdStatusTickId);
    _wdStatusTickId = setInterval(() => {
        // Only update if we're showing the "done" state (i.e. not currently syncing)
        const el = document.getElementById('wdSyncStatus');
        if (el && el.querySelector('.fa-circle-check')) _wdSetSyncStatus('done');
    }, 60 * 1000);
}

// ── Open ──────────────────────────────────────────────────────────────────────
function openWeatherDrawer() {
    const overlay = document.getElementById('weatherDrawerOverlay');
    const sheet   = document.getElementById('weatherDrawerSheet');
    if (!overlay || !sheet) return;

    _setFabsVisible(false);

    // Hide bottom nav so the drawer gets the full bottom screen space
    const _wdNav = document.getElementById('masterGlobalNavigationBarDeck');
    if (_wdNav) _wdNav.style.display = 'none';

    // Reveal overlay + animate sheet in
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            sheet.style.transform = 'translateY(0)';
        });
    });

    // Reset "Don't show on map" toggle — it's a per-session pending action, not persistent state
    _setWeatherHideToggle(false);

    // Restore last-visited tab (weather or stargazing)
    _wdSwitchTabUI(_wdActiveTab || 'weather');

    // Resolve best-available coordinates (live GPS → last-known → globals)
    let lat = userLat, lon = userLon;
    if (cachedUserCoords) { lat = cachedUserCoords.lat; lon = cachedUserCoords.lon; }

    const loading = document.getElementById('wdLoading');
    const content = document.getElementById('wdContent');

    // ── Stale-while-revalidate ────────────────────────────────────────────────
    // If we have persisted data from a previous session or background refresh,
    // render it instantly (no loading spinner) and kick off a background refresh.
    // On mobile this means the user sees weather data in <10ms instead of waiting
    // for a cold network fetch.
    const cached = _wdLoadFromStorage(lat, lon);
    if (cached) {
        // Show cached data immediately — skip the loading spinner
        if (loading) loading.classList.add('hidden');
        if (content) content.classList.remove('hidden');
        _renderWeatherDrawer(cached.data);
        _wdSetSyncStatus('syncing');

        // Force-bypass in-session mem cache so we always hit the network here
        const key = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
        _wdDataCache.delete(key);
        _fetchWeatherDrawerData(lat, lon).then(data => {
            if (data) {
                _renderWeatherDrawer(data);
                _wdSetSyncStatus('done');
            } else {
                // Network failed — restore "Updated X mins ago" based on cached age
                _wdLastFetchedAt = cached.fetchedAt;
                _wdSetSyncStatus('done');
            }
        });
    } else {
        // No cache at all — show loading spinner until first fetch completes
        if (loading) loading.classList.remove('hidden');
        if (content) content.classList.add('hidden');
        _wdSetSyncStatus('syncing');

        _fetchWeatherDrawerData(lat, lon).then(data => {
            if (data) {
                _renderWeatherDrawer(data);
                _wdSetSyncStatus('done');
            }
            // If fetch fails with no cache, the spinner stays — acceptable cold-start behaviour
        });
    }

    // Start the 1-min tick so "Updated X mins ago" counts up while drawer is open
    _wdStartStatusTick();

    // Live-refresh every 5 min while drawer stays open so UV/AQI stay current.
    // Clear any stale interval first (e.g. drawer reopened without closing properly).
    clearInterval(_wdRefreshInterval);
    _wdRefreshInterval = setInterval(() => {
        const key = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
        _wdDataCache.delete(key);
        _wdSetSyncStatus('syncing');
        _fetchWeatherDrawerData(lat, lon).then(data => {
            if (data) {
                _renderWeatherDrawer(data);
                _wdSetSyncStatus('done');
            }
        });
    }, _WD_CACHE_TTL);
}

// ── Close ─────────────────────────────────────────────────────────────────────
function closeWeatherDrawer() {
    const sheet   = document.getElementById('weatherDrawerSheet');
    const overlay = document.getElementById('weatherDrawerOverlay');
    if (!sheet || !overlay) return;

    // If user toggled "Don't show on map" — persist and hide the capsule
    const toggle = document.getElementById('wdHideCapsuleToggle');
    if (toggle && toggle.dataset.active === 'true') {
        localStorage.setItem('compass_show_weather_capsule', 'false');
        const capsule = document.getElementById('mapWeatherWidget');
        if (capsule) capsule.style.display = 'none';
        // Sync settings toggle to OFF
        _syncSettingsWeatherToggle(false);
    }

    // Hide overlay immediately — removes blur/dim at the moment of close
    overlay.classList.add('hidden');
    sheet.style.transform = 'translateY(100%)';
    // Stop both in-drawer timers
    clearInterval(_wdRefreshInterval);
    clearInterval(_wdStatusTickId);
    _wdRefreshInterval = null;
    _wdStatusTickId    = null;
    // Post-animation cleanup only (nav + FAB restore)
    setTimeout(() => {
        const _wdNav = document.getElementById('masterGlobalNavigationBarDeck');
        if (_wdNav) _wdNav.style.display = '';
        _updateFabVisibility();
    }, 340);
}

// ── Data fetch — fully Open-Meteo ────────────────────────────────────────────
// Three parallel calls: weather+hourly (Open-Meteo forecast),
// air quality (Open-Meteo air-quality), and reverse geocode (Nominatim).
// OWM / GAS proxy is no longer used by the drawer.
async function _fetchWeatherDrawerData(lat, lon) {
    const key = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
    const hit  = _wdDataCache.get(key);
    if (hit && (Date.now() - hit.fetchedAt) < _WD_CACHE_TTL) return hit.data;

    try {
        const latStr = parseFloat(lat).toFixed(4);
        const lonStr = parseFloat(lon).toFixed(4);

        const [wxResp, aqiResp, geo] = await Promise.all([
            fetch(
                `https://api.open-meteo.com/v1/forecast` +
                `?latitude=${latStr}&longitude=${lonStr}` +
                `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation` +
                `,weather_code,wind_speed_10m,uv_index,is_day` +
                `&hourly=temperature_2m,weather_code,precipitation_probability,precipitation,wind_speed_10m,is_day` +
                `,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high` +
                `,relative_humidity_2m,dew_point_2m,visibility` +
                `,cape,lifted_index,wind_speed_250hPa` +
                `&daily=sunrise,sunset` +
                `&timezone=auto&forecast_days=2`
            ),
            fetch(
                `https://air-quality-api.open-meteo.com/v1/air-quality` +
                `?latitude=${latStr}&longitude=${lonStr}` +
                `&current=us_aqi,pm2_5&timezone=auto`
            ).catch(() => null),
            _reverseGeocode(lat, lon),
        ]);

        const wx  = await wxResp.json();
        const aqi = aqiResp ? await aqiResp.json().catch(() => null) : null;

        if (!wx.current) return null;

        const cur   = wx.current;
        const daily = wx.daily || {};

        // sunrise/sunset: Open-Meteo returns ISO strings "2024-01-15T07:30" (local TZ)
        const toUnix = iso => iso ? Math.round(new Date(iso).getTime() / 1000) : 0;
        const sunriseUnix = toUnix(daily.sunrise?.[0]);
        const sunsetUnix  = toUnix(daily.sunset?.[0]);

        // AQI: prefer Open-Meteo us_aqi; fall back to PM2.5 EPA calc
        let aqiValue = 0;
        if (aqi?.current?.us_aqi != null && isFinite(aqi.current.us_aqi)) {
            aqiValue = Math.round(aqi.current.us_aqi);
        } else if (aqi?.current?.pm2_5 != null) {
            aqiValue = _calcUsAqi(aqi.current.pm2_5);
        }

        // Build hourly slots: find current-hour index then take next 24 slots
        const nowH    = new Date();
        const nowISO  = `${nowH.getFullYear()}-` +
                        `${String(nowH.getMonth()+1).padStart(2,'0')}-` +
                        `${String(nowH.getDate()).padStart(2,'0')}T` +
                        `${String(nowH.getHours()).padStart(2,'0')}:00`;
        const htimes  = wx.hourly?.time || [];
        let   startIdx = htimes.findIndex(t => t >= nowISO);
        if (startIdx < 0) startIdx = 0;

        const hourly = [];
        for (let i = startIdx; i < Math.min(startIdx + 24, htimes.length); i++) {
            hourly.push({
                time:           htimes[i],
                temp:           Math.round(wx.hourly.temperature_2m[i] ?? 0),
                code:           wx.hourly.weather_code[i] ?? 0,
                isDay:          wx.hourly.is_day[i] === 1,
                precip:         wx.hourly.precipitation_probability[i] ?? 0,
                // Stargazing fields
                cloudCover:     wx.hourly.cloud_cover?.[i]      ?? null,
                cloudCoverLow:  wx.hourly.cloud_cover_low?.[i]  ?? null,
                cloudCoverMid:  wx.hourly.cloud_cover_mid?.[i]  ?? null,
                cloudCoverHigh: wx.hourly.cloud_cover_high?.[i] ?? null,
                humidity:       wx.hourly.relative_humidity_2m?.[i] ?? null,
                dewPoint:       wx.hourly.dew_point_2m?.[i]     ?? null,
                visibility:     wx.hourly.visibility?.[i]       ?? null, // meters
                windSpeed:      wx.hourly.wind_speed_10m[i]     ?? 0,
                // Atmospheric stability / seeing fields
                precipMm:       wx.hourly.precipitation?.[i]           ?? 0,
                cape:           wx.hourly.cape?.[i]              ?? null, // J/kg convective instability
                liftedIndex:    wx.hourly.lifted_index?.[i]      ?? null, // atmospheric stability index
                wind250:        wx.hourly.wind_speed_250hPa?.[i] ?? null, // km/h jet-stream layer
            });
        }

        const data = {
            city:          geo.city    || '',
            country:       geo.country || '',
            tier:          geo.tier    || 'unknown',
            description:   _wmoDescription(cur.weather_code),
            wmoCode:       cur.weather_code,
            isDay:         cur.is_day === 1,
            temp:          Math.round(cur.temperature_2m      ?? 0),
            feelsLike:     Math.round(cur.apparent_temperature ?? cur.temperature_2m ?? 0),
            humidity:      cur.relative_humidity_2m ?? null,
            windSpeed:     cur.wind_speed_10m       ?? null,
            sunrise:       sunriseUnix,
            sunset:        sunsetUnix,
            aqi:           aqiValue,
            uvi:           cur.uv_index ?? 0,
            hourly,
        };

        const now = Date.now();
        _wdDataCache.set(key, { data, fetchedAt: now });
        _wdLastFetchedAt = now;          // track for "Updated X mins ago"
        _wdSaveToStorage(key, data);     // persist across sessions + page reloads
        return data;
    } catch (e) {
        console.warn('[WeatherDrawer] fetch failed:', e.message);
        return null;
    }
}

// ── Render ────────────────────────────────────────────────────────────────────
function _renderWeatherDrawer(data) {
    const loading = document.getElementById('wdLoading');
    const content = document.getElementById('wdContent');
    if (loading) loading.classList.add('hidden');
    if (content) content.classList.remove('hidden');

    // ── Header ────────────────────────────────────────────────────────────────
    const cityEl    = document.getElementById('wdCity');
    const condEl    = document.getElementById('wdCondition');
    const tempHero  = document.getElementById('wdTempHero');
    const feelsLine = document.getElementById('wdFeelsLine');
    const feelsVal  = document.getElementById('wdFeelsVal');

    if (cityEl) {
        cityEl.textContent = (data.city && data.country)
            ? `${data.city}, ${data.country}`
            : (data.city || 'Your Location');
    }
    if (condEl) {
        const ic = _wmoIconClass(data.wmoCode ?? 0, data.isDay !== false);
        condEl.innerHTML =
            `<i class="fa-solid ${ic} text-[10px]"></i>` +
            `<span>${_wdCapitalize(data.description || '')}</span>`;
    }
    if (tempHero && data.temp !== undefined) {
        tempHero.textContent = `${Math.round(data.temp)}°`;
    }
    if (feelsLine && feelsVal && data.feelsLike !== undefined) {
        feelsVal.textContent = `${Math.round(data.feelsLike)}°`;
        feelsLine.classList.remove('hidden');
    }

    // ── AQI ───────────────────────────────────────────────────────────────────
    const aqiInfo  = _getAqiLabel(data.aqi);
    const aqiValEl = document.getElementById('wdAqiValue');
    const aqiLblEl = document.getElementById('wdAqiLabel');
    if (aqiValEl) {
        aqiValEl.textContent  = data.aqi || '—';
        aqiValEl.style.color  = aqiInfo.color;
    }
    if (aqiLblEl) {
        aqiLblEl.textContent  = aqiInfo.label;
        aqiLblEl.style.color  = aqiInfo.color;
    }

    // ── UV ────────────────────────────────────────────────────────────────────
    // The deprecated OWM /data/2.5/uvi endpoint can return stale values (e.g. UV 9 at midnight).
    // Clamp to 0 client-side whenever the current time is outside sunrise–sunset.
    const _nowSec       = Date.now() / 1000;
    const _isNight      = (data.sunrise && data.sunset)
                            ? (_nowSec < data.sunrise || _nowSec > data.sunset)
                            : false;
    const effectiveUvi  = _isNight ? 0 : (data.uvi || 0);

    const uvInfo    = _getUvLabel(effectiveUvi);
    const uvValEl   = document.getElementById('wdUvValue');
    const uvPulseEl = document.getElementById('wdUvPulse');
    const uvLblEl   = document.getElementById('wdUvLabel');
    const uvAdvEl   = document.getElementById('wdUvAdvice');
    if (uvValEl) {
        uvValEl.textContent = Math.round(effectiveUvi);
        uvValEl.style.color = uvInfo.color;
    }
    if (uvLblEl) { uvLblEl.textContent = uvInfo.label;  uvLblEl.style.color = uvInfo.color; }
    if (uvAdvEl) { uvAdvEl.textContent = _isNight ? 'No UV at night' : uvInfo.advice; }
    if (uvPulseEl) {
        if (effectiveUvi >= 6) {
            uvPulseEl.classList.remove('hidden');
            uvPulseEl.classList.add('wd-uv-pulse');
            uvPulseEl.style.backgroundColor = uvInfo.color;
        } else {
            uvPulseEl.classList.add('hidden');
            uvPulseEl.classList.remove('wd-uv-pulse');
        }
    }

    // ── Golden / Blue Hour ────────────────────────────────────────────────────
    const goldenEl = document.getElementById('wdGoldenHour');
    const blueEl   = document.getElementById('wdBlueHour');
    if (data.sunset) {
        const golden = _calcGoldenHour(data.sunset);
        const blue   = _calcBlueHour(data.sunset);
        if (goldenEl) goldenEl.textContent = `${golden.start} – ${golden.end}`;
        if (blueEl)   blueEl.textContent   = `${blue.start} – ${blue.end}`;
    } else {
        if (goldenEl) goldenEl.textContent = 'Unavailable';
        if (blueEl)   blueEl.textContent   = 'Unavailable';
    }

    // ── Solar Cycle ───────────────────────────────────────────────────────────
    const sunriseEl = document.getElementById('wdSunrise');
    const sunsetEl  = document.getElementById('wdSunset');
    if (sunriseEl) sunriseEl.textContent = data.sunrise ? _wdFormatTime(data.sunrise) : '—';
    if (sunsetEl)  sunsetEl.textContent  = data.sunset  ? _wdFormatTime(data.sunset)  : '—';

    // ── Hourly Forecast (next 24 h from Open-Meteo) ──────────────────────────
    const strip = document.getElementById('wdForecastStrip');
    if (strip) {
        if (data.hourly && data.hourly.length > 0) {
            strip.innerHTML = data.hourly.map(slot => {
                const _raw24  = (slot.time || '').slice(11, 13); // "HH"
                const _h24    = parseInt(_raw24, 10);
                const _ampm   = _h24 < 12 ? 'AM' : 'PM';
                const _h12    = _h24 % 12 || 12;              // 0→12, 13→1, etc.
                const timePart = `${_h12}${_ampm}`;           // "12AM", "3PM", "11PM"
                const ic = _wmoIconClass(slot.code, slot.isDay);
                return (
                    `<div class="shrink-0 flex flex-col items-center gap-1 ` +
                    `bg-slate-900/70 border border-slate-700/40 rounded-xl ` +
                    `px-3 py-2.5 min-w-[54px]">` +
                        `<span class="text-[9px] text-slate-500 font-black uppercase tracking-wider tabular-nums">${timePart}</span>` +
                        `<i class="fa-solid ${ic} text-[14px]"></i>` +
                        `<span class="text-[11px] font-black text-slate-300 tabular-nums">${slot.temp}°</span>` +
                        (slot.precip > 0
                            ? `<span class="text-[8px] text-blue-400 font-bold">${slot.precip}%</span>`
                            : `<span class="text-[8px] text-transparent">0%</span>`) +
                    `</div>`
                );
            }).join('');
        } else {
            strip.innerHTML =
                `<span class="text-[10px] text-slate-500 italic pl-1">Forecast unavailable</span>`;
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// STARGAZING ENGINE
// Astronomical seeing score based on:
//   Cloud cover (50%) · Humidity/dew-point/fog (25%) · Wind (15%) · Moon (10%)
// All data from Open-Meteo hourly fields; moon phase from Meeus algorithm.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Moon phase via simplified Meeus algorithm.
 * Returns { illumination: 0–1, phase: 0–1, phaseName, phaseEmoji }
 * phase 0/1 = New Moon, 0.5 = Full Moon
 */
function _sgMoonPhase(date) {
    const JD = (date.getTime() / 86400000) + 2440587.5;
    const T  = (JD - 2451545.0) / 36525.0;
    // Moon's mean longitude (deg)
    const Lm = ((218.3165 + 481267.8813 * T) % 360 + 360) % 360;
    // Sun's mean longitude (deg)
    const Ls = ((280.4665 + 36000.7698 * T) % 360 + 360) % 360;
    // Elongation (0°= new, 180°= full)
    const elong = ((Lm - Ls) % 360 + 360) % 360;
    const phase = elong / 360;
    // Illuminated fraction (0=new, 1=full)
    const illumination = (1 - Math.cos(elong * Math.PI / 180)) / 2;

    let phaseName, phaseEmoji;
    if (phase < 0.025 || phase >= 0.975) { phaseName = 'New Moon';        phaseEmoji = '🌑'; }
    else if (phase < 0.24)               { phaseName = 'Waxing Crescent';  phaseEmoji = '🌒'; }
    else if (phase < 0.26)               { phaseName = 'First Quarter';    phaseEmoji = '🌓'; }
    else if (phase < 0.49)               { phaseName = 'Waxing Gibbous';   phaseEmoji = '🌔'; }
    else if (phase < 0.51)               { phaseName = 'Full Moon';        phaseEmoji = '🌕'; }
    else if (phase < 0.74)               { phaseName = 'Waning Gibbous';   phaseEmoji = '🌖'; }
    else if (phase < 0.76)               { phaseName = 'Third Quarter';    phaseEmoji = '🌗'; }
    else                                 { phaseName = 'Waning Crescent';  phaseEmoji = '🌘'; }

    return { illumination, phase, phaseName, phaseEmoji };
}

/**
 * Bortle scale estimate from geocoder tier + well-known mega-city list.
 * Returns { bortle: 2–9, label, desc }
 */
function _sgBortleEstimate(cityName, tier) {
    const MEGA = [
        'london','paris','tokyo','osaka','beijing','shanghai','new york','los angeles',
        'chicago','houston','dubai','seoul','jakarta','mumbai','delhi','mexico city',
        'cairo','karachi','dhaka','manila','istanbul','moscow','sao paulo','kinshasa',
        'lagos','rio de janeiro','bangalore','singapore','hong kong','bangkok','toronto',
        'sydney','melbourne','kuala lumpur','bogota','lima','chicago','philadelphia',
        'phoenix','san antonio','san diego','dallas','austin','san francisco',
        'amsterdam','berlin','madrid','rome','barcelona','vienna','zürich','brussels',
        'warsaw','prague','budapest','bucharest','tehran','baghdad','riyadh',
    ];
    const lower = (cityName || '').toLowerCase();
    const isMega = MEGA.some(c => lower.includes(c));

    if (isMega)               return { bortle: 8, label: 'City Sky (Bortle 8)',    desc: 'Only Moon, planets & brightest stars visible' };
    if (tier === 'city')      return { bortle: 7, label: 'Suburban-City (Bortle 7)', desc: 'Few stars; Milky Way invisible' };
    if (tier === 'town')      return { bortle: 5, label: 'Suburban Sky (Bortle 5)', desc: 'Milky Way glimpsed on best nights' };
    if (tier === 'village')   return { bortle: 3, label: 'Rural Sky (Bortle 3)',    desc: 'Milky Way plainly visible' };
    /* unknown */             return { bortle: 4, label: 'Rural-Suburban (Bortle 4)', desc: 'Milky Way faintly visible' };
}

/**
 * Per-hour atmospheric quality score (0–100, higher = better).
 *
 * Returns BOTH a combined score and two orthogonal sub-scores:
 *   transparencyScore — how clear/dry the sky is (DSO faintness)
 *   seeingScore       — how stable the air column is (planetary detail)
 *
 * Transparency weights: cloud 55% | humidity/fog 25% | precip/code 20%
 * Seeing weights:       jet-stream 40% | CAPE+LI stability 35% | surface wind 25%
 * Combined:             transparency 50% + seeing 50%, then moon blended at 12%
 *
 * Optional stHour: { seeing:1-8, transparency:1-8 } from 7Timer! ASTRO.
 * When present it is blended at 25% weight into the final combined score.
 */
function _sgHourScore(slot, moonIllum, moonriseUnix, moonsetUnix, stHour) {

    // ══════════════════════════════════════════════════════════════
    //  TRANSPARENCY — how clear / dry the sky is
    // ══════════════════════════════════════════════════════════════

    // ── T1. Cloud cover (55%) ──
    const ccl = slot.cloudCoverLow  ?? 0;
    const ccm = slot.cloudCoverMid  ?? 0;
    const cch = slot.cloudCoverHigh ?? 0;
    // Low clouds are fully opaque; cirrus is ~25% as bad for DSOs
    const effectiveCloud = Math.min(100, ccl * 1.0 + ccm * 0.65 + cch * 0.25);
    const cloudScore = Math.max(0, 100 - effectiveCloud);

    // ── T2. Humidity / dew-point / fog (25%) ──
    const rh   = slot.humidity  ?? 50;
    const temp = slot.temp      ?? 15;
    const dew  = slot.dewPoint  ?? (temp - (100 - rh) / 5);
    const ddelta = temp - dew;   // dew-point spread — lower = more fog risk

    let humScore = 100;
    if      (ddelta < 1)  humScore = 10;  // fog imminent
    else if (ddelta < 3)  humScore = 30;  // mist risk
    else if (ddelta < 6)  humScore = 55;  // high humidity
    else if (rh > 90)     humScore = 55;
    else if (rh > 80)     humScore = 72;
    else if (rh > 70)     humScore = 86;

    // Visibility override (Open-Meteo in metres)
    const vis = slot.visibility ?? 20000;
    if      (vis < 1000)  humScore = Math.min(humScore, 15);
    else if (vis < 3000)  humScore = Math.min(humScore, 40);
    else if (vis < 6000)  humScore = Math.min(humScore, 65);

    // ── T3. Precipitation / weather code (20%) ──
    const precipMm = slot.precipMm ?? 0;
    const wcode    = slot.code     ?? 0;
    let precipScore = 100;
    if      (precipMm >= 5)   precipScore = 0;   // heavy rain
    else if (precipMm >= 1)   precipScore = 15;  // rain
    else if (precipMm >= 0.3) precipScore = 45;  // drizzle
    else if (precipMm > 0)    precipScore = 70;  // trace
    // Weather code penalties for fog / storm / snow regardless of precipMm
    if (wcode >= 95)          precipScore = Math.min(precipScore, 5);  // thunderstorm
    else if (wcode >= 80)     precipScore = Math.min(precipScore, 20); // showers
    else if (wcode >= 71 && wcode <= 77) precipScore = Math.min(precipScore, 30); // snow
    else if (wcode >= 51 && wcode <= 67) precipScore = Math.min(precipScore, 50); // drizzle/rain
    else if (wcode === 45 || wcode === 48) precipScore = Math.min(precipScore, 20); // fog

    const transparencyScore = Math.round(
        cloudScore  * 0.55 +
        humScore    * 0.25 +
        precipScore * 0.20
    );

    // ══════════════════════════════════════════════════════════════
    //  SEEING — how stable the atmospheric column is
    // ══════════════════════════════════════════════════════════════

    // ── S1. Jet stream — wind_speed_250hPa at ~10 km altitude (40%) ──
    const w250 = slot.wind250 ?? 40; // km/h — assume moderate if unknown
    const jetScore = w250 < 20  ? 100
                   : w250 < 40  ? 85
                   : w250 < 60  ? 65
                   : w250 < 80  ? 40
                   : w250 < 100 ? 20 : 5;

    // ── S2. CAPE + Lifted Index — convective stability (35%) ──
    const cape = slot.cape        ?? 0;    // J/kg
    const li   = slot.liftedIndex ?? 2;   // positive = stable

    // CAPE component (lower is better)
    const capeScore = cape <= 0   ? 100
                    : cape < 100  ? 90
                    : cape < 300  ? 75
                    : cape < 500  ? 55
                    : cape < 1000 ? 30
                    : cape < 2000 ? 12 : 2;

    // Lifted Index component (positive = stable = good)
    const liScore = li >= 3    ? 100
                  : li >= 0    ? 85
                  : li >= -2   ? 65
                  : li >= -5   ? 35
                  : li >= -10  ? 15 : 2;

    const stabilityScore = Math.round((capeScore + liScore) / 2);

    // ── S3. Surface wind (25%) ──
    const wind = slot.windSpeed ?? 0; // km/h
    const surfWindScore = wind < 5  ? 100
                        : wind < 10 ? 90
                        : wind < 20 ? 75
                        : wind < 30 ? 55
                        : wind < 45 ? 30 : 10;

    const seeingScore = Math.round(
        jetScore       * 0.40 +
        stabilityScore * 0.35 +
        surfWindScore  * 0.25
    );

    // ══════════════════════════════════════════════════════════════
    //  COMBINED — transparency + seeing, then moon + 7Timer blend
    // ══════════════════════════════════════════════════════════════

    let combined = transparencyScore * 0.50 + seeingScore * 0.50;

    // ── Optional 7Timer! ASTRO calibration anchor (25% blend) ──
    let calibrated = false;
    if (stHour && stHour.seeing >= 1 && stHour.transparency >= 1) {
        // 7Timer seeing & transparency are 1-8 scales (8 = best)
        const st7Transparency = Math.round(((stHour.transparency - 1) / 7) * 100);
        const st7Seeing       = Math.round(((stHour.seeing       - 1) / 7) * 100);
        const st7Combined     = (st7Transparency + st7Seeing) / 2;
        combined   = combined * 0.75 + st7Combined * 0.25;
        calibrated = true;
    }

    // ── Moon impact — 12% of combined score ──
    const slotUnix = slot.time
        ? Math.round(new Date(slot.time).getTime() / 1000)
        : 0;
    let moonAbove = false;
    if (moonriseUnix && moonsetUnix && slotUnix) {
        if (moonriseUnix < moonsetUnix) {
            moonAbove = slotUnix >= moonriseUnix && slotUnix <= moonsetUnix;
        } else {
            moonAbove = slotUnix >= moonriseUnix || slotUnix <= moonsetUnix;
        }
    }
    const moonPenalty = moonAbove ? moonIllum * 72 : moonIllum * 28;
    const moonScore   = Math.max(0, 100 - moonPenalty);

    const score = Math.round(combined * 0.88 + moonScore * 0.12);

    return {
        score:             Math.max(0, Math.min(100, score)),
        transparencyScore: Math.max(0, Math.min(100, Math.round(transparencyScore))),
        seeingScore:       Math.max(0, Math.min(100, Math.round(seeingScore))),
        moonAbove,
        cloudScore:    Math.round(cloudScore),
        humScore:      Math.round(humScore),
        precipScore:   Math.round(precipScore),
        jetScore:      Math.round(jetScore),
        stabilityScore:Math.round(stabilityScore),
        surfWindScore: Math.round(surfWindScore),
        moonScore:     Math.round(moonScore),
        calibrated,
    };
}

/** Seeing quality label from score 0–100 */
function _sgSeeingLabel(score) {
    if (score >= 80) return { label: 'Excellent', color: '#a78bfa' };
    if (score >= 60) return { label: 'Good',      color: '#34d399' };
    if (score >= 40) return { label: 'Fair',       color: '#fbbf24' };
    if (score >= 20) return { label: 'Poor',       color: '#f87171' };
    return                  { label: 'Very Poor',  color: '#ef4444' };
}

/**
 * Format a Unix timestamp (seconds) as "9PM", "12AM" etc.
 * Re-uses _wdFormatTime() which already exists.
 */
function _sgFormatHour(unixSec) {
    if (!unixSec) return '—';
    return _wdFormatTime(unixSec); // "9:30 PM" format
}

/**
 * Find the best consecutive viewing window from night-hour seeing scores.
 * Returns a string like "10 PM – 2 AM" or "No clear window tonight".
 */
function _sgBestWindow(nightScores) {
    if (!nightScores.length) return 'No night hours in forecast';
    const threshold = 55;
    let bestStart = -1, bestEnd = -1, bestAvg = 0;
    let i = 0;
    while (i < nightScores.length) {
        if (nightScores[i].score >= threshold) {
            let j = i;
            let sum = 0;
            while (j < nightScores.length && nightScores[j].score >= threshold) {
                sum += nightScores[j].score;
                j++;
            }
            const avg = sum / (j - i);
            if (avg > bestAvg) {
                bestAvg  = avg;
                bestStart = i;
                bestEnd   = j - 1;
            }
            i = j;
        } else {
            i++;
        }
    }
    if (bestStart < 0) return 'No clear window tonight';
    const startTime = nightScores[bestStart].time;
    const endTime   = nightScores[bestEnd].time;
    const fmt = iso => {
        const h24 = parseInt((iso || '').slice(11, 13), 10);
        const ampm = h24 < 12 ? 'AM' : 'PM';
        const h12  = h24 % 12 || 12;
        return `${h12} ${ampm}`;
    };
    return `Best window: ${fmt(startTime)} – ${fmt(endTime)}`;
}

/** Switch tab UI only (no data ops) */
function _wdSwitchTabUI(tab) {
    _wdActiveTab = tab;
    const btnW   = document.getElementById('wdTabWeather');
    const btnS   = document.getElementById('wdTabStargazing');
    const wxPanel = document.getElementById('wdWeatherPanel');
    const sgPanel = document.getElementById('sgPanel');

    if (tab === 'weather') {
        if (wxPanel) wxPanel.classList.remove('hidden');
        if (sgPanel) sgPanel.classList.add('hidden');
        if (btnW) { btnW.className = btnW.className.replace(/wd-tab-inactive|wd-tab-active-sg/g, '').trim() + ' wd-tab-active-wx'; }
        if (btnS) { btnS.className = btnS.className.replace(/wd-tab-active-wx|wd-tab-active-sg/g, '').trim() + ' wd-tab-inactive'; }
    } else {
        if (wxPanel) wxPanel.classList.add('hidden');
        if (sgPanel) sgPanel.classList.remove('hidden');
        if (btnW) { btnW.className = btnW.className.replace(/wd-tab-active-wx|wd-tab-active-sg/g, '').trim() + ' wd-tab-inactive'; }
        if (btnS) { btnS.className = btnS.className.replace(/wd-tab-inactive|wd-tab-active-wx/g, '').trim() + ' wd-tab-active-sg'; }
    }
}

/**
 * Public entry point called by the tab buttons.
 * Switches UI and, for stargazing, forces a fresh data fetch.
 */
function switchWeatherTab(tab) {
    _wdSwitchTabUI(tab);
    if (tab === 'stargazing') {
        _sgLoadAndRender();
    }
}

/**
 * Force-bypass the weather cache, show sgLoading, fetch fresh data, then render
 * the stargazing panel.  Always called when the Stargazing tab is opened.
 */

/**
 * Fetch 7Timer! ASTRO product for a location.
 * Returns the parsed JSON object or null on any failure.
 * 7Timer uses 3-hourly time slots starting at a UTC init time.
 */
async function _sgFetch7Timer(lat, lon) {
    try {
        const url = `https://www.7timer.info/bin/api.pl` +
            `?lon=${parseFloat(lon).toFixed(4)}&lat=${parseFloat(lat).toFixed(4)}` +
            `&product=astro&output=json`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || !json.dataseries || !json.init) return null;
        return json;
    } catch (_) {
        return null; // graceful fallback — HTTPS may not always be available
    }
}

/**
 * Given an ISO datetime string (e.g. "2025-08-10T22:00") and the 7Timer response,
 * return the matching dataseries slot { seeing, transparency, ... } or null.
 * 7Timer slots are every 3 hours starting from json.init (format "YYYYMMDDHH" UTC).
 */
function _sg7TimerHourFor(isoTime, stJson) {
    if (!stJson || !stJson.dataseries || !stJson.init) return null;
    try {
        const initStr = stJson.init; // e.g. "2025081000"
        const initUTC = new Date(Date.UTC(
            parseInt(initStr.slice(0, 4), 10),
            parseInt(initStr.slice(4, 6), 10) - 1,
            parseInt(initStr.slice(6, 8), 10),
            parseInt(initStr.slice(8, 10), 10)
        ));
        const slotTime = new Date(isoTime);
        const diffH = (slotTime - initUTC) / 3600000; // hours offset
        if (diffH < 0) return null;
        // Each dataseries entry covers 3 hours; find the closest one
        const idx = Math.round(diffH / 3);
        if (idx < 0 || idx >= stJson.dataseries.length) return null;
        return stJson.dataseries[idx];
    } catch (_) {
        return null;
    }
}

function _sgLoadAndRender() {
    const sgLoading = document.getElementById('sgLoading');
    const sgContent = document.getElementById('sgContent');

    // Stale-while-revalidate: if content was already rendered once, keep it visible
    // while silently refreshing in the background — no glitch / spinner flash.
    const alreadyRendered = sgContent && !sgContent.classList.contains('hidden');
    if (!alreadyRendered) {
        if (sgLoading) sgLoading.classList.remove('hidden');
        if (sgContent) sgContent.classList.add('hidden');
    }

    let lat = userLat, lon = userLon;
    if (cachedUserCoords) { lat = cachedUserCoords.lat; lon = cachedUserCoords.lon; }
    if (!lat || !lon) {
        if (!alreadyRendered && sgLoading) {
            sgLoading.innerHTML =
                `<i class="fa-solid fa-location-slash text-slate-600 text-[28px]"></i>` +
                `<span class="text-slate-500 text-[11px] tracking-widest uppercase font-bold mt-2">` +
                    `Location unavailable</span>`;
        }
        return;
    }

    // Bust in-session mem cache so we always get fresh data on tab open
    const cacheKey = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
    _wdDataCache.delete(cacheKey);

    // Fetch Open-Meteo weather + 7Timer ASTRO in parallel; 7Timer failing is non-fatal
    Promise.all([
        _fetchWeatherDrawerData(lat, lon),
        _sgFetch7Timer(lat, lon),
    ]).then(([data, stData]) => {
        if (!data) {
            // Only show error state if nothing is already displayed
            if (!alreadyRendered && sgLoading) {
                sgLoading.innerHTML =
                    `<i class="fa-solid fa-triangle-exclamation text-slate-600 text-[28px]"></i>` +
                    `<span class="text-slate-500 text-[11px] tracking-widest uppercase font-bold mt-2">` +
                        `Data unavailable</span>`;
            }
            return;
        }
        _renderStargazingPanel(data, alreadyRendered, stData || null);
    }).catch(() => {
        if (!alreadyRendered && sgLoading) {
            sgLoading.innerHTML =
                `<i class="fa-solid fa-triangle-exclamation text-slate-600 text-[28px]"></i>` +
                `<span class="text-slate-500 text-[11px] tracking-widest uppercase font-bold mt-2">` +
                    `Network error</span>`;
        }
    });
}

/**
 * Font Awesome icon + style for a given moon phase.
 * Returns { icon: 'fa-*', style: 'inline CSS string' }
 * Uses: fa-circle (full/new), fa-circle-half-stroke (quarters), fa-moon (crescents)
 */
function _sgMoonFAIcon(moon) {
    const p = moon.phase;
    if (p < 0.025 || p >= 0.975)
        // New moon — dark hollow circle
        return { icon: 'fa-regular fa-circle', style: 'color:rgba(100,116,139,0.45); font-size:26px;' };
    if (p < 0.24)
        // Waxing crescent — FA moon icon rotated to face right
        return { icon: 'fa-solid fa-moon',     style: 'color:#e2e8f0; font-size:26px; transform:rotate(120deg); display:inline-block;' };
    if (p < 0.26)
        // First quarter — half-circle, lit on right
        return { icon: 'fa-solid fa-circle-half-stroke', style: 'color:#e2e8f0; font-size:26px; transform:rotate(180deg); display:inline-block;' };
    if (p < 0.49)
        // Waxing gibbous — mostly lit solid circle
        return { icon: 'fa-solid fa-circle',  style: 'color:rgba(226,232,240,0.72); font-size:26px;' };
    if (p < 0.51)
        // Full moon — bright white glowing circle
        return { icon: 'fa-solid fa-circle',  style: 'color:#f8fafc; font-size:26px; filter:drop-shadow(0 0 6px rgba(248,250,252,0.55));' };
    if (p < 0.74)
        // Waning gibbous — mostly lit, slightly dimmer
        return { icon: 'fa-solid fa-circle',  style: 'color:rgba(226,232,240,0.65); font-size:26px;' };
    if (p < 0.76)
        // Third quarter — half-circle, lit on left
        return { icon: 'fa-solid fa-circle-half-stroke', style: 'color:#e2e8f0; font-size:26px;' };
    // Waning crescent — FA moon, mirrored to face left
    return { icon: 'fa-solid fa-moon', style: 'color:#e2e8f0; font-size:26px; transform:rotate(-60deg) scaleX(-1); display:inline-block;' };
}

/**
 * Render the full Stargazing panel from weather data object.
 * @param {boolean} silentRefresh - if true, skip entry animation (content already visible)
 * @param {object|null} stData    - parsed 7Timer! ASTRO JSON (optional calibration anchor)
 */
function _renderStargazingPanel(data, silentRefresh = false, stData = null) {
    const sgLoading = document.getElementById('sgLoading');
    const sgContent = document.getElementById('sgContent');
    if (!sgContent) return;

    // ── Moon phase ────────────────────────────────────────────────────────────
    // Use Meeus algorithm (always authoritative; Open-Meteo moon_phase is a fallback
    // cross-check only)
    const moon = _sgMoonPhase(new Date());

    // ── Moon rise/set — not from API (field unsupported in free tier).
    // Seeing score uses conservative half-penalty when rise/set unknown.
    const moonriseUnix = null;
    const moonsetUnix  = null;

    // ── Bortle scale estimate ─────────────────────────────────────────────────
    const bortle = _sgBortleEstimate(data.city, data.tier);

    // ── Night hours from hourly forecast ─────────────────────────────────────
    const nightHours = (data.hourly || []).filter(h => !h.isDay);
    // Fallback: if no night hours (e.g. Arctic summer), use all hours
    const targetHours = nightHours.length > 0 ? nightHours : data.hourly || [];

    // ── Per-hour seeing scores ────────────────────────────────────────────────
    const scored = targetHours.map(slot => {
        const stHour = stData ? _sg7TimerHourFor(slot.time, stData) : null;
        return {
            ...slot,
            ..._sgHourScore(slot, moon.illumination, moonriseUnix, moonsetUnix, stHour),
        };
    });

    // ── Overall tonight score = average of scored night hours ────────────────
    let overallScore = 0;
    let avgTransparency = 0;
    let avgSeeing = 0;
    let anyCalibrated = false;
    if (scored.length > 0) {
        overallScore    = Math.round(scored.reduce((a, h) => a + h.score, 0) / scored.length);
        avgTransparency = Math.round(scored.reduce((a, h) => a + (h.transparencyScore ?? 0), 0) / scored.length);
        avgSeeing       = Math.round(scored.reduce((a, h) => a + (h.seeingScore ?? 0), 0) / scored.length);
        anyCalibrated   = scored.some(h => h.calibrated);
    }
    const qual = _sgSeeingLabel(overallScore);

    // ── Best viewing window ───────────────────────────────────────────────────
    const bestWindow = _sgBestWindow(scored);

    // ── Current-hour conditions (first night hour, or first hourly slot) ──────
    const curSlot = scored[0] || {};

    // ── Render gauge ─────────────────────────────────────────────────────────
    const gaugeArc   = document.getElementById('sgGaugeArc');
    const gaugeScore = document.getElementById('sgGaugeScore');
    const gaugeQual  = document.getElementById('sgGaugeQual');
    const gaugeWrap  = document.getElementById('sgGaugeWrapper');

    const CIRCUMFERENCE = 301.6; // 2π × 48
    if (gaugeArc) {
        const offset = CIRCUMFERENCE * (1 - overallScore / 100);
        // Short delay so CSS transition fires after element is visible
        setTimeout(() => {
            gaugeArc.style.strokeDashoffset = offset.toFixed(1);
            gaugeArc.style.stroke = qual.color;
        }, 80);
    }
    if (gaugeScore) gaugeScore.textContent = overallScore;
    if (gaugeQual)  gaugeQual.setAttribute('fill', qual.color + 'aa');
    if (gaugeWrap && overallScore >= 80) {
        gaugeWrap.classList.add('sg-gauge-excellent');
    } else if (gaugeWrap) {
        gaugeWrap.classList.remove('sg-gauge-excellent');
    }

    // ── Quality label + best window ───────────────────────────────────────────
    const qualLabelEl  = document.getElementById('sgQualLabel');
    const bestWindowEl = document.getElementById('sgBestWindow');
    const bortleEl     = document.getElementById('sgBortleText');
    if (qualLabelEl)  { qualLabelEl.textContent = qual.label; qualLabelEl.style.color = qual.color; }
    if (bestWindowEl) bestWindowEl.textContent = bestWindow;
    if (bortleEl)     bortleEl.textContent = `${bortle.label} — ${bortle.desc}`;

    // ── Sub-score chips: Transparency + Seeing ────────────────────────────────
    const tScoreEl  = document.getElementById('sgTransparencyScore');
    const sScoreEl  = document.getElementById('sgSeeingScore');
    const calibEl   = document.getElementById('sgCalibrationBadge');

    const _subColor = v => v >= 75 ? '#a78bfa' : v >= 55 ? '#34d399' : v >= 35 ? '#fbbf24' : '#f87171';

    if (tScoreEl) {
        tScoreEl.textContent = `☁ Transparency ${avgTransparency}`;
        tScoreEl.style.color = _subColor(avgTransparency);
    }
    if (sScoreEl) {
        sScoreEl.textContent = `✦ Seeing ${avgSeeing}`;
        sScoreEl.style.color = _subColor(avgSeeing);
    }
    if (calibEl) {
        calibEl.classList.toggle('hidden', !anyCalibrated);
    }

    // ── Moon card ─────────────────────────────────────────────────────────────
    const moonEmoji  = document.getElementById('sgMoonEmoji');
    const moonName   = document.getElementById('sgMoonName');
    const moonIllum  = document.getElementById('sgMoonIllum');
    const moonrise   = document.getElementById('sgMoonrise');
    const moonset    = document.getElementById('sgMoonset');
    const moonImpact = document.getElementById('sgMoonImpact');

    if (moonEmoji) {
        const fi = _sgMoonFAIcon(moon);
        moonEmoji.innerHTML = `<i class="${fi.icon}" style="${fi.style}"></i>`;
    }
    if (moonName)   moonName.textContent   = moon.phaseName;
    if (moonIllum)  moonIllum.textContent  = `${Math.round(moon.illumination * 100)}% illuminated`;
    // Moonrise/moonset: approximated from moon phase cycle (rises ~50 min later each day)
    // Full moon ≈ rises at sunset; New moon ≈ rises at sunrise; interpolated for other phases
    if (moonrise || moonset) {
        const sunsetHour   = data.sunset  ? new Date(data.sunset  * 1000).getHours() : 19;
        const sunriseHour  = data.sunrise ? new Date(data.sunrise * 1000).getHours() : 6;
        // Moon rises approx: phase 0=sunrise time, phase 0.5=sunset time, phase 1=next sunrise
        const rawRiseH = sunriseHour + (moon.phase <= 0.5
            ? moon.phase * 2 * (sunsetHour - sunriseHour)
            : sunsetHour - sunriseHour + (moon.phase - 0.5) * 2 * (24 + sunriseHour - sunsetHour));
        const riseH = Math.round(rawRiseH) % 24;
        const setH  = (riseH + 12) % 24;
        const fmt = h => { const ap = h < 12 ? 'AM' : 'PM'; return `~${h % 12 || 12}:00 ${ap}`; };
        if (moonrise) moonrise.textContent = fmt(riseH);
        if (moonset)  moonset.textContent  = fmt(setH);
    }

    if (moonImpact) {
        const illumPct = Math.round(moon.illumination * 100);
        let impact;
        if (illumPct <= 15) {
            impact = `New Moon phase — minimal light pollution. Ideal for deep-sky observing.`;
        } else if (illumPct <= 40) {
            impact = `Crescent Moon (${illumPct}% lit) — sets early, leaving dark skies for most of the night.`;
        } else if (illumPct <= 65) {
            impact = `${moon.phaseName} (${illumPct}% lit) — some interference. Best observing after moonset.`;
        } else if (illumPct <= 90) {
            impact = `${moon.phaseName} (${illumPct}% lit) — significant glare. Stick to bright objects & planets.`;
        } else {
            impact = `Full Moon (${illumPct}% lit) — sky is very bright. Suitable for lunar observing only.`;
        }
        moonImpact.textContent = impact;
    }

    // ── Condition cards ───────────────────────────────────────────────────────
    // Cloud cover
    const cc = curSlot.cloudCoverLow != null ? Math.round(curSlot.cloudCoverLow) : (curSlot.cloudCover != null ? Math.round(curSlot.cloudCover) : null);
    const cloudValEl   = document.getElementById('sgCloudVal');
    const cloudLabelEl = document.getElementById('sgCloudLabel');
    if (cloudValEl) cloudValEl.textContent = cc != null ? `${cc}%` : '—';
    if (cloudLabelEl) {
        cloudLabelEl.textContent = cc == null ? '—'
            : cc < 20  ? 'Clear — excellent transparency'
            : cc < 40  ? 'Mostly clear'
            : cc < 70  ? 'Partly cloudy'
            : cc < 90  ? 'Mostly cloudy'
            : 'Overcast';
    }

    // Humidity
    const rh      = curSlot.humidity != null ? Math.round(curSlot.humidity) : (data.humidity != null ? Math.round(data.humidity) : null);
    const dewPt   = curSlot.dewPoint != null ? Math.round(curSlot.dewPoint) : null;
    const humValEl  = document.getElementById('sgHumidVal');
    const humLblEl  = document.getElementById('sgHumidLabel');
    if (humValEl)  humValEl.textContent  = rh != null ? `${rh}%` : '—';
    if (humLblEl) {
        humLblEl.textContent = rh == null ? '—'
            : rh < 50 ? 'Dry — great for optics'
            : rh < 70 ? 'Moderate'
            : rh < 85 ? 'High — dew risk'
            : 'Very high — fog likely';
    }

    // Wind
    const wnd      = curSlot.windSpeed != null ? Math.round(curSlot.windSpeed) : (data.windSpeed != null ? Math.round(data.windSpeed) : null);
    const windValEl  = document.getElementById('sgWindVal');
    const windLblEl  = document.getElementById('sgWindLabel');
    if (windValEl) windValEl.textContent  = wnd != null ? `${wnd} km/h` : '—';
    if (windLblEl) {
        windLblEl.textContent = wnd == null ? '—'
            : wnd < 5  ? 'Calm — excellent'
            : wnd < 15 ? 'Light breeze'
            : wnd < 30 ? 'Moderate — some turbulence'
            : wnd < 50 ? 'Windy — atmospheric blur'
            : 'Strong — poor seeing';
    }

    // Dew point spread
    const curTemp  = curSlot.temp != null ? curSlot.temp : data.temp;
    const dp       = dewPt != null ? dewPt : (curTemp != null && rh != null ? Math.round(curTemp - (100 - rh) / 5) : null);
    const spread   = (curTemp != null && dp != null) ? Math.round(curTemp - dp) : null;
    const dewValEl  = document.getElementById('sgDewVal');
    const dewLblEl  = document.getElementById('sgDewLabel');
    if (dewValEl)  dewValEl.textContent  = dp != null ? `${dp}°` : '—';
    if (dewLblEl) {
        dewLblEl.textContent = spread == null ? '—'
            : spread < 1  ? 'Fog forming — stay in'
            : spread < 3  ? 'Mist risk — optics may dew'
            : spread < 6  ? 'Watch for dew'
            : 'Safe — low dew risk';
    }

    // ── Hourly seeing forecast strip ──────────────────────────────────────────
    const strip = document.getElementById('sgHourlyStrip');
    if (strip) {
        if (scored.length > 0) {
            strip.innerHTML = scored.map(slot => {
                const h24   = parseInt((slot.time || '').slice(11, 13), 10);
                const ampm  = h24 < 12 ? 'AM' : 'PM';
                const h12   = h24 % 12 || 12;
                const timeLbl = `${h12}${ampm}`;
                const q = _sgSeeingLabel(slot.score);
                const starOpacity = slot.score >= 60 ? '1' : slot.score >= 40 ? '0.55' : '0.25';
                return (
                    `<div class="shrink-0 flex flex-col items-center gap-1 ` +
                    `bg-[#0d0a1a] border border-violet-500/15 rounded-xl ` +
                    `px-3 py-2.5 min-w-[54px]">` +
                        `<span class="text-[9px] text-slate-500 font-black uppercase tracking-wider tabular-nums">${timeLbl}</span>` +
                        `<i class="fa-solid fa-star text-[13px]" style="color:${q.color}; opacity:${starOpacity}"></i>` +
                        `<span class="text-[13px] font-black tabular-nums" style="color:${q.color}">${slot.score}</span>` +
                        `<span class="text-[8px] font-bold text-slate-600 tabular-nums">${Math.round(slot.cloudScore)}%☁</span>` +
                    `</div>`
                );
            }).join('');
        } else {
            strip.innerHTML = `<span class="text-[10px] text-slate-500 italic pl-1">No night hours in forecast range</span>`;
        }
    }

    // ── Show content ─────────────────────────────────────────────────────────
    if (sgLoading) sgLoading.classList.add('hidden');
    if (sgContent) {
        if (!silentRefresh) {
            // First appearance — play entry animation
            sgContent.classList.remove('sg-panel-in');
            void sgContent.offsetWidth; // reflow to restart animation
            sgContent.classList.add('sg-panel-in');
        }
        sgContent.classList.remove('hidden');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARGAZING LOCATION PLANNER
// Allows users to search any location by name, coordinates, or Google Maps URL
// and get a 7-day seeing forecast, astronomical events, and trip recommendations.
// Saved results persist in localStorage and auto-refresh on next open.
// ═══════════════════════════════════════════════════════════════════════════════

const _SGP_LS_KEY   = 'compass_sg_planner_v1';
const _SGP_MAX_SAVED = 10;

/** Open the planner panel with a slide-in animation. */
function _sgpOpenPlanner() {
    const panel = document.getElementById('sgPlannerPanel');
    if (!panel) return;
    panel.classList.remove('hidden', 'sgp-slide-out');
    void panel.offsetWidth; // reflow to restart animation
    panel.classList.add('sgp-slide-in');
    _sgpRenderSaved();
    _sgpSyncEmptyState();
}

/** Close the planner panel with a slide-out animation. */
function _sgpClosePlanner() {
    const panel = document.getElementById('sgPlannerPanel');
    if (!panel) return;
    panel.classList.remove('sgp-slide-in');
    void panel.offsetWidth;
    panel.classList.add('sgp-slide-out');
    const onEnd = () => {
        panel.classList.add('hidden');
        panel.classList.remove('sgp-slide-out');
    };
    panel.addEventListener('animationend', onEnd, { once: true });
    // Safety fallback in case animationend doesn't fire
    setTimeout(() => {
        if (!panel.classList.contains('hidden')) onEnd();
    }, 400);
}

/**
 * Resolve a user query to { lat, lon, name, country, tier }.
 * Handles: decimal coords, degree-notation coords, Google Maps URLs (full),
 * and plain text via the Open-Meteo Geocoding API (free, no key, same origin
 * as weather data — more reliable than Nominatim search for this use-case).
 */
async function _sgpResolveLocation(query) {
    const q = query.trim();

    // ── 1. Decimal coordinates  e.g. "48.8566, 2.3522"  or  "-33.8688 151.2093"
    const decCoordRe = /^(-?\d{1,3}\.?\d*)[°\s,]+([NS])?[,\s]+(-?\d{1,3}\.?\d*)[°\s]*([EW])?$/i;
    const decMatch = q.match(decCoordRe);
    if (decMatch) {
        let lat = parseFloat(decMatch[1]);
        let lon = parseFloat(decMatch[3]);
        if (decMatch[2] && decMatch[2].toUpperCase() === 'S') lat = -lat;
        if (decMatch[4] && decMatch[4].toUpperCase() === 'W') lon = -lon;
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            const geo = await _reverseGeocode(lat, lon);
            return { lat, lon, name: geo.city || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, country: geo.country, tier: geo.tier };
        }
    }

    // ── 2. Google Maps full URL — extract @lat,lon from URL
    const mapsLatLonRe = /@(-?\d+\.?\d+),(-?\d+\.?\d+)/;
    const mapsMatch = q.match(mapsLatLonRe);
    if (mapsMatch) {
        const lat = parseFloat(mapsMatch[1]);
        const lon = parseFloat(mapsMatch[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            const geo = await _reverseGeocode(lat, lon);
            return { lat, lon, name: geo.city || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, country: geo.country, tier: geo.tier };
        }
    }

    // ── Shortened Maps URL (goo.gl/maps or maps.app.goo.gl) — CORS-blocked, guide user
    if (/goo\.gl\/maps|maps\.app\.goo\.gl/i.test(q)) {
        return { error: 'shortened_url', message: 'Shortened Maps links can\'t be used here. Open the link in a browser, copy the full URL (it contains @lat,lon) — or just type the place name.' };
    }

    // ── 3. Open-Meteo Geocoding API — free, no API key, CORS-safe, same provider as weather
    //    Docs: https://open-meteo.com/en/docs/geocoding-api
    try {
        const res  = await fetch(
            `https://geocoding-api.open-meteo.com/v1/search` +
            `?name=${encodeURIComponent(q)}&count=1&language=en&format=json`
        );
        const json = await res.json();
        const r    = json?.results?.[0];
        if (!r) {
            return {
                error:   'not_found',
                message: `Couldn't find "${q.length > 40 ? q.slice(0, 40) + '…' : q}". Try a more specific name (e.g. "Matera, Italy") or enter GPS coordinates.`,
            };
        }
        // Derive Bortle-relevant tier from population + feature code
        const pop  = r.population || 0;
        const fc   = r.feature_code || '';
        const tier = (pop > 500000 || fc === 'PPLC' || fc === 'PPLA')  ? 'city'
                   : (pop > 50000  || fc === 'PPLA2')                  ? 'town'
                   : (pop > 5000   || fc === 'PPLA3' || fc.startsWith('PPL')) ? 'village'
                   : 'unknown';
        return {
            lat:     r.latitude,
            lon:     r.longitude,
            name:    r.name,
            country: (r.country_code || '').toUpperCase(),
            tier,
        };
    } catch (_) {
        return { error: 'network', message: 'Network error. Check your connection and try again.' };
    }
}

/**
 * Fetch 7-day Open-Meteo forecast for a location.
 * Primary model (GFS/best_match) is used for all 7 days.
 * For days 4-7 (hours 72+), ECMWF is fetched as a secondary model
 * and blended 50/50 into cloud_cover, cloud_cover_low, cape,
 * lifted_index, and wind_speed_250hPa for improved late-week confidence.
 * Returns null on primary fetch failure.
 */
async function _sgpFetch7Day(lat, lon) {
    const BASE = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`;
    const HOURLY_FIELDS =
        `temperature_2m,weather_code,precipitation_probability,precipitation,wind_speed_10m,is_day` +
        `,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high` +
        `,relative_humidity_2m,dew_point_2m,visibility` +
        `,cape,lifted_index,wind_speed_250hPa`;
    const DAILY_FIELDS = `sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_sum`;

    // ── Primary fetch (GFS / best-match) ──────────────────────────────────────
    let json;
    try {
        const res = await fetch(
            `${BASE}&hourly=${HOURLY_FIELDS}&daily=${DAILY_FIELDS}&timezone=auto&forecast_days=16`
        );
        json = await res.json();
    } catch (_) { return null; }
    if (!json || !json.hourly || !json.daily) return null;

    // ── Secondary fetch (ECMWF IFS 0.4°) for days 4-7 blend ─────────────────
    // Only key stability/cloud fields; failure is non-fatal
    let ecmwf = null;
    try {
        const ecmwfFields =
            `cloud_cover,cloud_cover_low,cape,lifted_index,wind_speed_250hPa`;
        const res2 = await fetch(
            `${BASE}&hourly=${ecmwfFields}&timezone=auto&forecast_days=16&models=ecmwf_ifs04`
        );
        const j2 = await res2.json();
        if (j2 && j2.hourly) ecmwf = j2.hourly;
    } catch (_) { /* non-fatal */ }

    // ── Build hourly slots ────────────────────────────────────────────────────
    const h = json.hourly;
    const hourly = (h.time || []).map((t, i) => {
        // For hours 72+ (days 4-7), blend ECMWF if available
        const useEcmwf = ecmwf && i >= 72;
        const blend = (primary, secondary) => {
            if (useEcmwf && secondary?.[i] != null && primary != null)
                return (primary + secondary[i]) / 2;
            return primary;
        };
        return {
            time:          t,
            temp:          h.temperature_2m?.[i]           ?? null,
            code:          h.weather_code?.[i]              ?? null,
            isDay:         h.is_day?.[i] === 1,
            precip:        h.precipitation_probability?.[i] ?? null,
            precipMm:      h.precipitation?.[i]             ?? 0,
            cloudCover:    blend(h.cloud_cover?.[i]      ?? null, ecmwf?.cloud_cover),
            cloudCoverLow: blend(h.cloud_cover_low?.[i]  ?? null, ecmwf?.cloud_cover_low),
            cloudCoverMid: h.cloud_cover_mid?.[i]           ?? null,
            cloudCoverHigh:h.cloud_cover_high?.[i]          ?? null,
            humidity:      h.relative_humidity_2m?.[i]      ?? null,
            dewPoint:      h.dew_point_2m?.[i]              ?? null,
            visibility:    h.visibility?.[i]                ?? null,
            windSpeed:     h.wind_speed_10m?.[i]            ?? null,
            cape:          blend(h.cape?.[i]             ?? null, ecmwf?.cape),
            liftedIndex:   blend(h.lifted_index?.[i]     ?? null, ecmwf?.lifted_index),
            wind250:       blend(h.wind_speed_250hPa?.[i]?? null, ecmwf?.wind_speed_250hPa),
            ecmwfBlended:  useEcmwf,
        };
    });

    // ── Build daily summaries ─────────────────────────────────────────────────
    const d = json.daily;
    const daily = (d.time || []).map((t, i) => ({
        date:      t,
        sunrise:   d.sunrise?.[i]           ?? null,
        sunset:    d.sunset?.[i]            ?? null,
        tempMax:   d.temperature_2m_max?.[i]?? null,
        tempMin:   d.temperature_2m_min?.[i]?? null,
        precipSum: d.precipitation_sum?.[i] ?? null,
    }));

    return { hourly, daily, hasEcmwf: !!ecmwf };
}

/**
 * Compute average seeing score for a set of night hours on a given date.
 * Returns an object { score, transparencyScore, seeingScore }.
 */
function _sgpDayScore(nightHours, moonIllumination) {
    if (!nightHours || nightHours.length === 0)
        return { score: 0, transparencyScore: 0, seeingScore: 0 };
    const scored = nightHours.map(h => _sgHourScore(h, moonIllumination, null, null, null));
    const avg = key => Math.round(scored.reduce((a, s) => a + (s[key] ?? 0), 0) / scored.length);
    return {
        score:             avg('score'),
        transparencyScore: avg('transparencyScore'),
        seeingScore:       avg('seeingScore'),
    };
}

/** Confidence level for a given day index (0=today, up to 15=day 16). */
function _sgpConfidence(dayIndex) {
    // Days 0-6: high-to-moderate confidence; days 7-15: low and declining
    const TABLE = [92, 84, 74, 63, 54, 46, 39, 33, 28, 24, 20, 17, 15, 13, 11, 10];
    return TABLE[Math.min(Math.max(dayIndex, 0), TABLE.length - 1)];
}

/** Hardcoded major annual meteor showers. */
const _SGP_METEOR_SHOWERS = [
    { name: 'Quadrantids',    peak: '01-03', zhr: 100, dur: 2 },
    { name: 'Lyrids',         peak: '04-22', zhr: 20,  dur: 4 },
    { name: 'Eta Aquariids',  peak: '05-06', zhr: 50,  dur: 7 },
    { name: 'Perseids',       peak: '08-12', zhr: 100, dur: 5 },
    { name: 'Draconids',      peak: '10-08', zhr: 10,  dur: 2 },
    { name: 'Orionids',       peak: '10-21', zhr: 25,  dur: 5 },
    { name: 'Leonids',        peak: '11-17', zhr: 15,  dur: 3 },
    { name: 'Geminids',       peak: '12-14', zhr: 150, dur: 4 },
    { name: 'Ursids',         peak: '12-22', zhr: 10,  dur: 3 },
];

/**
 * Return astronomical events visible in the next 7 days starting from startDate.
 * Includes: moon phase milestones and meteor shower windows.
 */
function _sgpAstroEvents(startDate) {
    const events = [];
    const MS = 86400000;
    for (let i = 0; i < 7; i++) {
        const d = new Date(startDate.getTime() + i * MS);
        const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const moon = _sgMoonPhase(d);
        const moonNext = _sgMoonPhase(new Date(d.getTime() + MS));
        // Moon phase milestone detection (crossing 0, 0.25, 0.5, 0.75)
        const MOON_MILESTONES = [
            { t: 0.02, name: 'New Moon',      icon: 'fa-regular fa-circle',           color: '#94a3b8', note: 'Darkest skies — ideal for deep sky' },
            { t: 0.25, name: 'First Quarter', icon: 'fa-solid fa-circle-half-stroke', color: '#818cf8', note: 'Moon sets around midnight' },
            { t: 0.50, name: 'Full Moon',     icon: 'fa-solid fa-circle',             color: '#fbbf24', note: 'Bright sky — lunar observing only' },
            { t: 0.75, name: 'Last Quarter',  icon: 'fa-solid fa-circle-half-stroke', color: '#818cf8', note: 'Moon rises around midnight' },
        ];
        for (const m of MOON_MILESTONES) {
            const distToday = Math.abs(moon.phase - m.t);
            const distTomorrow = Math.abs(moonNext.phase - m.t);
            if (distToday < 0.045 && distToday <= distTomorrow && !events.find(e => e.name === m.name)) {
                events.push({ dayIndex: i, dateLabel, type: 'moon', name: m.name, icon: m.icon, color: m.color, note: m.note });
                break;
            }
        }
        // Meteor showers
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        for (const shower of _SGP_METEOR_SHOWERS) {
            const [pm, pd] = shower.peak.split('-').map(Number);
            const peakDate = new Date(d.getFullYear(), pm - 1, pd);
            const diffDays = Math.round((d - peakDate) / MS);
            const halfDur  = Math.floor(shower.dur / 2);
            if (Math.abs(diffDays) <= halfDur) {
                const atPeak = diffDays === 0;
                // Avoid duplicating same shower on adjacent days
                if (!events.find(e => e.name.startsWith(shower.name))) {
                    events.push({
                        dayIndex: i, dateLabel, type: 'meteor',
                        name: `${shower.name}${atPeak ? ' (Peak)' : ''}`,
                        icon: 'fa-solid fa-meteor', color: '#f43f5e',
                        note: atPeak ? `Peak night — ~${shower.zhr} meteors/hr` : `Active window (peak ${shower.peak})`,
                    });
                }
            }
        }
    }
    return events;
}

/** Return clothing recommendations for a given forecast minimum temperature (°C). */
function _sgpClothing(tempMin) {
    if (tempMin == null) return [];
    if (tempMin >= 20) return ['Light layers — T-shirt and long sleeves', 'Insect repellent for late-night sessions'];
    if (tempMin >= 12) return ['Warm jacket or fleece', 'Comfortable trousers', 'Light gloves optional'];
    if (tempMin >=  4) return ['Insulating mid-layer + windproof jacket', 'Warm hat and gloves', 'Thermal base layer recommended'];
    if (tempMin >= -5) return ['Heavy winter jacket', 'Full thermal layers', 'Wool hat + insulated gloves', 'Hand warmers'];
    return ['Extreme cold gear', 'Multiple thermal layers essential', 'Insulated boots + balaclava', 'Hand and foot warmers'];
}

/** Format a timestamp as a human-readable "time ago" string. */
function _sgpTimeAgo(ts) {
    if (!ts) return 'unknown';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 2)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
}

/** Sync the empty-state div visibility. */
function _sgpSyncEmptyState() {
    const empty   = document.getElementById('sgpEmpty');
    const results = document.getElementById('sgpResults');
    const saved   = document.getElementById('sgpSavedSection');
    if (!empty) return;
    const hasResults = results && !results.classList.contains('hidden');
    const hasSaved   = saved   && !saved.classList.contains('hidden');
    empty.classList.toggle('hidden', hasResults || hasSaved);
}

/** Main search entry point — called from "Go" button and Enter key. */
async function _sgpSearch() {
    const input = document.getElementById('sgpInput');
    if (!input) return;
    const query = input.value.trim();
    if (!query) return;

    // Hide previous results and show loading
    const errEl = document.getElementById('sgpError');
    if (errEl) errEl.classList.add('hidden');
    _sgpShowResults(false);
    _sgpShowLoading(true);
    _sgpSyncEmptyState();

    try {
        // Step 1: resolve to coordinates
        const loc = await _sgpResolveLocation(query);
        if (loc.error) {
            _sgpShowLoading(false);
            _sgpShowError(loc.message);
            _sgpSyncEmptyState();
            return;
        }

        // Step 2: fetch 7-day Open-Meteo data
        const weatherData = await _sgpFetch7Day(loc.lat, loc.lon);
        if (!weatherData) {
            _sgpShowLoading(false);
            _sgpShowError('Weather data unavailable. Please try again in a moment.');
            _sgpSyncEmptyState();
            return;
        }

        // Step 3: build result object
        const result = {
            id:          `${loc.lat.toFixed(3)}_${loc.lon.toFixed(3)}`,
            lat:         loc.lat,
            lon:         loc.lon,
            name:        loc.name,
            country:     loc.country,
            tier:        loc.tier,
            fetchedAt:   Date.now(),
            weatherData,
        };

        // Step 4: render and show (reset date picker for new searches)
        _sgpTargetDate = null;
        _sgpShowLoading(false);
        _sgpRenderResults(result);
        _sgpShowResults(true);
        _sgpSyncEmptyState();

        // Auto-refresh saved entry if this location is already saved
        _sgpAutoRefreshSaved(result);

    } catch (err) {
        _sgpShowLoading(false);
        _sgpShowError('Something went wrong. Check your connection and try again.');
        _sgpSyncEmptyState();
    }
}

function _sgpShowLoading(show) {
    const el = document.getElementById('sgpLoading');
    if (el) el.classList.toggle('hidden', !show);
}

function _sgpShowResults(show) {
    const el = document.getElementById('sgpResults');
    if (el) el.classList.toggle('hidden', !show);
}

function _sgpShowError(msg) {
    const el = document.getElementById('sgpError');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.add('hidden'), 7000);
}

/** Build a 2-column condition card (used in tonight's conditions grid). */
function _sgpCondCard(icon, label, value, sublabel) {
    return `<div class="rounded-xl px-3 py-2.5" style="background:rgba(13,10,26,0.8);border:1px solid rgba(51,65,85,0.35);">
        <div class="flex items-center gap-1.5 mb-1.5">
            <i class="fa-solid ${icon} text-slate-600 text-[9px]"></i>
            <span class="text-[8px] font-black uppercase tracking-wider text-slate-600">${label}</span>
        </div>
        <div class="text-[20px] font-black text-slate-200 leading-none">${value}</div>
        <div class="text-[9px] text-slate-500 mt-1 leading-snug">${sublabel || '—'}</div>
    </div>`;
}

/**
 * Render the full results UI for a location result object.
 * @param {object} result       - location + weatherData object
 * @param {string|null} targetDateStr - YYYY-MM-DD target date, or null for default (today)
 */
function _sgpRenderResults(result, targetDateStr = null) {
    const container = document.getElementById('sgpResults');
    if (!container) return;
    const { name, country, tier, lat, lon, weatherData, fetchedAt } = result;
    const { hourly, daily } = weatherData;
    const bortle = _sgBortleEstimate(name, tier);

    // ── Date-picker window setup ────────────────────────────────────────────
    // today's YYYY-MM-DD string (local timezone)
    const _localYMD = d => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };
    const todayStr  = _localYMD(new Date());
    const targetStr = targetDateStr || todayStr;
    const isCustomDate = !!targetDateStr && targetDateStr !== todayStr;

    // Find target day index in the daily array (0 = today, etc.)
    const targetDayIdx = daily.findIndex(d => d.date === targetStr);
    // Default view: always show the first 7 days (today → today+6).
    // Date-picker view: ±3-day window centred on the chosen date, clamped to available data.
    let winStart, winEnd;
    if (!isCustomDate) {
        winStart = 0;
        winEnd   = Math.min(6, daily.length - 1);
    } else {
        const idx = targetDayIdx >= 0 ? targetDayIdx : 0;
        winStart  = Math.max(0, idx - 3);
        winEnd    = Math.min(daily.length - 1, idx + 3);
    }
    const windowDaily  = daily.slice(winStart, winEnd + 1);
    const windowOffset = winStart; // how many days into `daily` the window starts

    // ── Per-day seeing scores ───────────────────────────────────────────────
    const dayScores = windowDaily.map((day, wi) => {
        const i = wi + windowOffset; // global day index from today
        const isTarget   = day.date === targetStr;
        const isPast     = day.date < todayStr;
        const start      = day.date + 'T00:00';
        const end        = day.date + 'T23:59';
        const nightHours = hourly.filter(h => h.time >= start && h.time <= end && !h.isDay);
        const moon       = _sgMoonPhase(new Date(day.date + 'T20:00'));
        const dayResult  = _sgpDayScore(nightHours, moon.illumination);
        const score      = dayResult.score;
        const conf       = _sgpConfidence(i);
        const qual       = _sgSeeingLabel(score);
        const dayLabel   = new Date(day.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
        const border     = isTarget
            ? 'rgba(139,92,246,0.70)'
            : score >= 70 ? 'rgba(139,92,246,0.40)'
            : score >= 50 ? 'rgba(34,197,94,0.30)'
            : score >= 30 ? 'rgba(245,158,11,0.30)'
            : 'rgba(100,116,139,0.18)';
        return { score, conf, qual, dayLabel, border, day, moon, isTarget, isPast };
    });

    // Best night (within the visible window)
    const bestDay   = dayScores.reduce((b, d) => d.score > b.score ? d : b, dayScores[0] || { score: 0 });
    const bestLabel = bestDay.day ? new Date(bestDay.day.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : '—';
    // Target date display label (for conditions header)
    const targetDayEntry = daily.find(d => d.date === targetStr);
    const targetDateLabel = targetDayEntry
        ? new Date(targetStr + 'T12:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
        : null;

    // ── Next New Moon countdown ─────────────────────────────────────────────
    // Phase 0/1 = New Moon, increases linearly over 29.53 days.
    // Days remaining = (1 - phase) * 29.53  (wraps correctly at any phase)
    const todayMoon      = _sgMoonPhase(new Date());
    // phase < 0.025 means we're IN the new moon window → 0 days remaining
    const daysToNewMoon  = todayMoon.phase < 0.025
        ? 0
        : Math.max(1, Math.round((1 - todayMoon.phase) * 29.53));
    const newMoonDate    = new Date(Date.now() + daysToNewMoon * 86400000);
    const newMoonDateLbl = newMoonDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    // Also compute days to Full Moon (phase 0.5)
    // Guard: if we're in the full moon window (phase 0.47–0.53), daysToFull = 0
    const phaseToFull    = todayMoon.phase < 0.5 ? 0.5 - todayMoon.phase : 1.5 - todayMoon.phase;
    const daysToFull     = (todayMoon.phase >= 0.47 && todayMoon.phase <= 0.53)
        ? 0
        : Math.round(phaseToFull * 29.53);

    // Decide what to feature: if New Moon is sooner (or same), show it; otherwise show Full Moon warning
    const showNewMoon    = daysToNewMoon <= daysToFull;
    let moonBannerHtml;
    if (showNewMoon && daysToNewMoon === 0) {
        moonBannerHtml = `
        <div class="rounded-2xl px-4 py-3 flex items-center gap-3"
             style="background:linear-gradient(135deg,rgba(15,23,42,0.95) 0%,rgba(30,41,59,0.70) 100%);border:1px solid rgba(148,163,184,0.20);">
            <i class="fa-regular fa-circle text-slate-300 text-[16px] flex-shrink-0"></i>
            <div class="flex-1 min-w-0">
                <div class="text-[8.5px] font-black uppercase tracking-widest text-slate-400/70 mb-0.5">New Moon — Tonight</div>
                <div class="text-[12px] font-black text-white">Darkest skies of the month</div>
                <div class="text-[9px] text-slate-400 mt-0.5">Ideal for faint DSOs &amp; Milky Way</div>
            </div>
        </div>`;
    } else if (showNewMoon) {
        const urgency = daysToNewMoon <= 3 ? 'rgba(167,139,250,0.18)' : 'rgba(51,65,85,0.35)';
        const urgencyBorder = daysToNewMoon <= 3 ? 'rgba(167,139,250,0.35)' : 'rgba(71,85,105,0.30)';
        const countdownText = daysToNewMoon === 1 ? 'Tomorrow' : `in ${daysToNewMoon} days`;
        moonBannerHtml = `
        <div class="rounded-2xl px-4 py-3 flex items-center gap-3"
             style="background:${urgency};border:1px solid ${urgencyBorder};">
            <i class="fa-regular fa-circle text-slate-400 text-[15px] flex-shrink-0"></i>
            <div class="flex-1 min-w-0">
                <div class="text-[8.5px] font-black uppercase tracking-widest text-slate-500/80 mb-0.5">Next New Moon</div>
                <div class="text-[12px] font-black text-slate-200">${countdownText} · ${newMoonDateLbl}</div>
                <div class="text-[9px] text-slate-500 mt-0.5">Darkest skies — best for deep-sky &amp; Milky Way</div>
            </div>
            ${daysToNewMoon <= 3 ? `<span class="text-[8px] font-black uppercase px-2 py-0.5 rounded-full flex-shrink-0"
                style="background:rgba(167,139,250,0.18);color:rgb(196,181,253);border:1px solid rgba(167,139,250,0.30);">Soon</span>` : ''}
        </div>`;
    } else {
        // Full Moon is nearer — warn
        const fullCountdown = daysToFull === 0 ? 'Tonight' : daysToFull === 1 ? 'Tomorrow' : `in ${daysToFull} days`;
        moonBannerHtml = `
        <div class="rounded-2xl px-4 py-3 flex items-center gap-3"
             style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.18);">
            <i class="fa-solid fa-circle text-amber-300 text-[15px] flex-shrink-0" style="filter:drop-shadow(0 0 5px rgba(251,191,36,0.45));"></i>
            <div class="flex-1 min-w-0">
                <div class="text-[8.5px] font-black uppercase tracking-widest text-amber-400/60 mb-0.5">Full Moon ${fullCountdown}</div>
                <div class="text-[12px] font-black text-amber-100">Bright skies this week</div>
                <div class="text-[9px] text-slate-500 mt-0.5">New Moon ${daysToNewMoon > 0 ? `in ${daysToNewMoon} days` : 'tonight'} · ${newMoonDateLbl}</div>
            </div>
        </div>`;
    }

    // ── Day card moon icon helper (compact FA, 11px) ─────────────────────────
    const _moonMiniIcon = (moon) => {
        const p = moon.phase;
        const illumPct = Math.round(moon.illumination * 100);
        let icon, color;
        if (p < 0.025 || p >= 0.975) { icon = 'fa-regular fa-circle';          color = 'rgba(148,163,184,0.5)'; }
        else if (p < 0.26)            { icon = 'fa-solid fa-moon';              color = '#cbd5e1'; }
        else if (p < 0.49)            { icon = 'fa-solid fa-circle';            color = 'rgba(203,213,225,0.65)'; }
        else if (p < 0.51)            { icon = 'fa-solid fa-circle';            color = '#f8fafc'; }
        else if (p < 0.74)            { icon = 'fa-solid fa-circle';            color = 'rgba(203,213,225,0.55)'; }
        else if (p < 0.76)            { icon = 'fa-solid fa-circle-half-stroke'; color = '#cbd5e1'; }
        else                          { icon = 'fa-solid fa-moon';              color = '#94a3b8'; }
        return { icon, color, illumPct };
    };

    const dayCardHtml = dayScores.map(({ score, conf, qual, dayLabel, border, moon, isTarget, isPast }) => {
        const mi = _moonMiniIcon(moon);
        // Target card: wider, glowing, larger score; past cards: dimmed
        const cardWidth  = isTarget ? 'min-w-[72px]' : 'min-w-[58px]';
        const cardBg     = isTarget
            ? 'background:rgba(30,10,60,0.90);'
            : 'background:rgba(13,10,26,0.7);';
        const glowStyle  = isTarget
            ? 'box-shadow:0 0 0 2px rgba(139,92,246,0.55),0 0 18px rgba(139,92,246,0.22);'
            : '';
        const opacity    = isPast ? 'opacity:0.38;' : '';
        const scoreSize  = isTarget ? 'text-[26px]' : 'text-[22px]';
        const targetTag  = isTarget
            ? `<span class="text-[6.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full mb-0.5"
                    style="background:rgba(139,92,246,0.25);color:rgb(196,181,253);border:1px solid rgba(139,92,246,0.40);">
                ${isPast ? 'Past' : 'Target'}
               </span>`
            : (isPast ? `<span class="text-[6.5px] text-slate-700 uppercase tracking-wide">Past</span>` : '');
        return (
            `<div class="flex-shrink-0 flex flex-col items-center gap-1 rounded-xl p-2.5 ${cardWidth}"
                  style="${cardBg}border:1px solid ${border};${glowStyle}${opacity}">
                <span class="text-[8.5px] font-black text-slate-400 uppercase tracking-wide tabular-nums">${dayLabel}</span>
                ${targetTag}
                <span class="${scoreSize} font-black leading-none tabular-nums" style="color:${qual.color}">${score}</span>
                <span class="text-[7.5px] font-bold" style="color:${qual.color}aa">${qual.label.split(' ')[0]}</span>
                <div class="flex items-center gap-1 mt-0.5">
                    <i class="${mi.icon} text-[8px]" style="color:${mi.color}"></i>
                    <span class="text-[7px] font-bold tabular-nums" style="color:${mi.color}">${mi.illumPct}%</span>
                </div>
                <span class="text-[6.5px] text-slate-700 tabular-nums">${conf}% conf</span>
            </div>`
        );
    }).join('');

    // ── Target-night conditions (the selected date, or tonight by default) ───
    const tonight       = targetDayEntry || daily[0];
    const tonightNightHrs = hourly.filter(h =>
        tonight && h.time >= tonight.date + 'T20:00' && h.time <= tonight.date + 'T23:59' && !h.isDay
    );
    const repSlot = tonightNightHrs[0] || hourly.find(h => !h.isDay) || hourly[0] || {};

    // ── Astronomical events ─────────────────────────────────────────────────
    const events    = _sgpAstroEvents(new Date());
    const eventsHtml = events.length === 0
        ? `<div class="text-[10px] text-slate-600 italic px-1 py-3">No major events in the next 7 days.</div>`
        : events.map(ev => `
            <div class="flex items-start gap-3 py-2.5 border-b border-slate-800/40 last:border-0">
                <div class="w-7 flex-shrink-0 flex items-center justify-center pt-0.5">
                    <i class="${ev.icon} text-[13px]" style="color:${ev.color}"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-[11px] font-black text-slate-200">${ev.name}</div>
                    <div class="text-[9px] text-slate-500 mt-0.5 leading-snug">${ev.dateLabel} · ${ev.note}</div>
                </div>
            </div>`).join('');

    // ── Clothing ────────────────────────────────────────────────────────────
    const minTemps  = daily.map(d => d.tempMin).filter(t => t != null);
    const weekLow   = minTemps.length > 0 ? Math.min(...minTemps) : null;
    const clothes   = _sgpClothing(weekLow);
    const clothesHtml = clothes.map(c =>
        `<div class="flex items-start gap-2">
            <i class="fa-solid fa-circle text-[4px] text-violet-500/60 mt-1.5 flex-shrink-0"></i>
            <span class="text-[10px] text-slate-300 leading-relaxed">${c}</span>
        </div>`
    ).join('');

    // ── Check if already saved ──────────────────────────────────────────────
    const isSaved = _sgpIsLocationSaved(lat, lon);

    container.innerHTML = `
        <!-- Location header -->
        <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0">
                <div class="text-[19px] font-black text-white leading-tight">
                    ${name}${country ? `<span class="text-slate-500 font-bold">, ${country}</span>` : ''}
                </div>
                <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span class="text-[9px] font-bold px-2 py-0.5 rounded-full"
                          style="background:rgba(139,92,246,0.12);color:rgba(196,181,253,0.85);border:1px solid rgba(139,92,246,0.22);">
                        Bortle ${bortle.class} · ${bortle.label}
                    </span>
                    <span class="text-[8px] text-slate-600">Updated ${_sgpTimeAgo(fetchedAt)}</span>
                </div>
            </div>
            <button id="sgpSaveBtn" onclick="_sgpToggleSave()"
                    class="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider"
                    style="background:${isSaved ? 'rgba(139,92,246,0.22)' : 'rgba(51,65,85,0.5)'};color:${isSaved ? 'rgb(196,181,253)' : 'rgba(148,163,184,0.8)'};border:1px solid ${isSaved ? 'rgba(139,92,246,0.40)' : 'rgba(71,85,105,0.4)'};-webkit-tap-highlight-color:transparent;">
                <i class="fa-${isSaved ? 'solid' : 'regular'} fa-bookmark text-[9px]"></i>
                ${isSaved ? 'Saved' : 'Save'}
            </button>
        </div>

        <!-- Best night banner -->
        <div class="rounded-2xl px-4 py-3 flex items-center gap-3"
             style="background:linear-gradient(135deg,rgba(139,92,246,0.10) 0%,rgba(99,102,241,0.07) 100%);border:1px solid rgba(139,92,246,0.18);">
            <i class="fa-solid fa-star text-violet-400 text-[18px]"></i>
            <div class="flex-1 min-w-0">
                <div class="text-[8.5px] font-black uppercase tracking-widest text-violet-400/70 mb-0.5">Best Night This Week</div>
                <div class="text-[13px] font-black text-violet-100">${bestLabel}</div>
                <div class="text-[9px] text-slate-400 mt-0.5">Score <span class="font-black" style="color:${bestDay.qual?.color}">${bestDay.score}</span> · ${bestDay.qual?.label || '—'}</div>
            </div>
        </div>

        <!-- Moon phase / new moon countdown -->
        ${moonBannerHtml}

        <!-- 7-day grid -->
        <div>
            <div class="flex items-center justify-between mb-2.5">
                <div class="text-[9px] font-black uppercase tracking-widest text-slate-500">
                    ${isCustomDate ? `Around ${targetDateLabel || targetStr}` : '7-Day Seeing Forecast'}
                </div>
                ${isCustomDate
                    ? `<button onclick="_sgpResetDate()"
                              class="flex items-center gap-1 px-2 py-1 rounded-lg text-[8px] font-black"
                              style="background:rgba(51,65,85,0.5);color:rgba(148,163,184,0.8);border:1px solid rgba(71,85,105,0.35);-webkit-tap-highlight-color:transparent;">
                          <i class="fa-solid fa-xmark text-[8px] pointer-events-none"></i> Reset
                      </button>`
                    : ''}
            </div>
            ${isCustomDate ? `
            <div class="flex items-center gap-2 mb-2.5 px-3 py-2 rounded-xl"
                 style="background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.18);">
                <i class="fa-regular fa-calendar text-violet-400 text-[10px]"></i>
                <span class="text-[9px] font-black text-violet-300">Viewing: ${targetDateLabel || targetStr}</span>
                <span class="text-[8px] text-slate-600 ml-auto">±3 days shown</span>
            </div>` : ''}
            <div class="flex gap-2 overflow-x-auto pb-1 wd-forecast-strip">${dayCardHtml}</div>
            <div class="text-[7.5px] text-slate-700 mt-1.5 flex items-center justify-between">
                <span>Moon % = illumination · Conf % = forecast confidence</span>
                <span>Bortle ${bortle.class}</span>
            </div>
        </div>

        <!-- Pick a Date / date picker trigger -->
        <div>
            <button onclick="_sgpOpenCalendar()"
                    class="w-full flex items-center justify-between px-4 py-3 rounded-2xl"
                    style="background:rgba(30,41,59,0.40);border:1px solid rgba(71,85,105,0.28);-webkit-tap-highlight-color:transparent;">
                <div class="flex items-center gap-2.5">
                    <i class="fa-regular fa-calendar-days text-slate-400 text-[13px]"></i>
                    <div class="text-left">
                        <div class="text-[11px] font-black text-slate-300">
                            ${isCustomDate ? 'Change Date' : 'Pick a Date'}
                        </div>
                        <div class="text-[8.5px] text-slate-600 mt-0.5">
                            ${isCustomDate
                                ? `Viewing ${targetDateLabel || targetStr}`
                                : 'Forecast available up to 16 days ahead'}
                        </div>
                    </div>
                </div>
                <i class="fa-solid fa-chevron-right text-slate-600 text-[10px]"></i>
            </button>
        </div>

        <!-- Target-night conditions -->
        <div>
            <div class="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2.5">
                ${isCustomDate && targetDateLabel ? `${targetDateLabel} · Conditions` : "Tonight's Conditions"}
            </div>
            <div class="grid grid-cols-2 gap-2">
                ${_sgpCondCard('fa-cloud', 'Cloud Cover',
                    repSlot.cloudCoverLow != null ? `${Math.round(repSlot.cloudCoverLow)}%` : '—',
                    repSlot.cloudCoverLow == null ? '—' : repSlot.cloudCoverLow < 20 ? 'Clear — excellent' : repSlot.cloudCoverLow < 50 ? 'Partly cloudy' : 'Cloudy')}
                ${_sgpCondCard('fa-droplet', 'Humidity',
                    repSlot.humidity != null ? `${Math.round(repSlot.humidity)}%` : '—',
                    repSlot.humidity == null ? '—' : repSlot.humidity < 50 ? 'Dry — great for optics' : repSlot.humidity < 75 ? 'Moderate' : 'High — dew risk')}
                ${_sgpCondCard('fa-wind', 'Wind',
                    repSlot.windSpeed != null ? `${Math.round(repSlot.windSpeed)} km/h` : '—',
                    repSlot.windSpeed == null ? '—' : repSlot.windSpeed < 10 ? 'Calm' : repSlot.windSpeed < 25 ? 'Light breeze' : 'Windy')}
                ${_sgpCondCard('fa-temperature-half', 'Night Low',
                    tonight?.tempMin != null ? `${Math.round(tonight.tempMin)}°C` : '—',
                    tonight?.tempMin == null ? '—' : tonight.tempMin < 5 ? 'Cold — dress warm' : tonight.tempMin < 15 ? 'Cool' : 'Mild')}
            </div>
        </div>

        <!-- Astronomical events -->
        <div>
            <div class="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2">Astronomical Events (7 Days)</div>
            <div class="rounded-xl border border-violet-500/10 px-3 divide-y divide-slate-800/30"
                 style="background:rgba(13,10,26,0.6);">
                ${eventsHtml}
            </div>
        </div>

        ${clothes.length > 0 ? `
        <!-- Clothing recommendations -->
        <div>
            <div class="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2.5">What to Wear</div>
            <div class="rounded-xl px-3.5 py-3 space-y-2"
                 style="background:rgba(13,10,26,0.6);border:1px solid rgba(51,65,85,0.35);">
                <div class="text-[8px] text-slate-600 mb-1">Based on forecast low: ${weekLow != null ? Math.round(weekLow) + '°C' : '—'}</div>
                ${clothesHtml}
            </div>
        </div>` : ''}

        <!-- Footer attribution -->
        <div class="text-[7.5px] text-slate-700 leading-relaxed pb-4 border-t border-slate-800/40 pt-3">
            Score = Transparency (cloud 55% + humidity 25% + precip 20%) × 50% + Seeing (jet stream 40% + stability 35% + wind 25%) × 50%, moon blended at 12%.${weatherData.hasEcmwf ? ' Days 4–7 use ECMWF + GFS blend.' : ''} Weather: Open-Meteo. Moon: Meeus algorithm. Accuracy decreases beyond day 3.
        </div>
    `;

    // Store current result for save/toggle
    window._sgpCurrentResult = result;
}

// ──────────────────────────────────────────────────────────────────────────────
//  DATE PICKER — calendar overlay + date-centred render
// ──────────────────────────────────────────────────────────────────────────────

/** Currently selected target date string (YYYY-MM-DD), or null for "today". */
let _sgpTargetDate = null;

/**
 * Open the date picker calendar overlay inside the planner panel.
 * Only dates in the range [today, today+15] are selectable.
 */
function _sgpOpenCalendar() {
    // Remove any existing calendar overlay
    const existing = document.getElementById('sgpCalendarOverlay');
    if (existing) existing.remove();

    const today    = new Date();
    today.setHours(0, 0, 0, 0);
    const maxDate  = new Date(today.getTime() + 15 * 86400000); // today + 15 days (16-day range)

    // Build an array of all calendar days to show.
    // We show from the Sunday on or before today through the Saturday on or after maxDate,
    // spanning at most two months.
    const calStart = new Date(today);
    calStart.setDate(calStart.getDate() - calStart.getDay()); // back to Sunday

    const calEnd = new Date(maxDate);
    calEnd.setDate(calEnd.getDate() + (6 - calEnd.getDay())); // forward to Saturday

    // Group days by month for rendering
    const months = [];
    let cursor = new Date(calStart);
    while (cursor <= calEnd) {
        const mKey = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0');
        let month = months.find(m => m.key === mKey);
        if (!month) {
            month = { key: mKey, label: cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), days: [] };
            months.push(month);
        }
        month.days.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }

    const _fmtYMD = d => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    const todayStr   = _fmtYMD(today);
    const maxDateStr = _fmtYMD(maxDate);
    const selectedStr = _sgpTargetDate || todayStr;

    const DAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

    const monthsHtml = months.map(month => {
        const header = `<div class="text-[11px] font-black text-slate-300 mb-2 mt-1">${month.label}</div>`;
        const dow = `<div class="grid grid-cols-7 gap-0.5 mb-1">
            ${DAYS_SHORT.map(d => `<div class="text-[8px] font-black text-slate-600 text-center py-0.5">${d}</div>`).join('')}
        </div>`;

        // Pad beginning with empty cells so the first day lands in the correct column
        let dayHtml = '<div class="grid grid-cols-7 gap-0.5">';
        const firstDow = month.days[0].getDay(); // 0=Sun … 6=Sat
        for (let e = 0; e < firstDow; e++) {
            dayHtml += '<div></div>';
        }
        month.days.forEach(d => {
            const ds = _fmtYMD(d);
            const isPast     = ds < todayStr;
            const isBeyond   = ds > maxDateStr;
            const isDisabled = isPast || isBeyond;
            const isToday    = ds === todayStr;
            const isSelected = ds === selectedStr;
            const dayNum     = d.getDate();

            let cellStyle = '', textColor = '', ringStyle = '';
            if (isSelected) {
                cellStyle = 'background:rgba(139,92,246,0.30);border:1px solid rgba(139,92,246,0.60);';
                textColor = 'color:#ddd6fe;';
                ringStyle = 'box-shadow:0 0 0 2px rgba(139,92,246,0.45);';
            } else if (isToday) {
                cellStyle = 'background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.30);';
                textColor = 'color:#a5b4fc;';
            } else if (isDisabled) {
                cellStyle = 'background:transparent;border:1px solid transparent;';
                textColor = 'color:rgba(100,116,139,0.25);';
            } else {
                cellStyle = 'background:rgba(30,41,59,0.50);border:1px solid rgba(51,65,85,0.30);';
                textColor = 'color:#94a3b8;';
            }

            const clickAttr = isDisabled ? '' : `onclick="_sgpSelectDate('${ds}')"`;
            const cursor    = isDisabled ? 'cursor:default;' : 'cursor:pointer;';
            dayHtml += `<div ${clickAttr}
                class="flex items-center justify-center rounded-lg text-[11px] font-black tabular-nums py-1.5"
                style="${cellStyle}${textColor}${ringStyle}${cursor}-webkit-tap-highlight-color:transparent;">
                ${isDisabled ? `<span style="opacity:0.3">${dayNum}</span>` : dayNum}
            </div>`;
        });
        dayHtml += '</div>';
        return header + dow + dayHtml;
    }).join('<div class="my-3 border-t border-slate-800/40"></div>');

    const overlay = document.createElement('div');
    overlay.id = 'sgpCalendarOverlay';
    overlay.style.cssText = `
        position:fixed; inset:0; z-index:70;
        background:rgba(2,6,23,0.88);
        display:flex; flex-direction:column;
        -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    `;
    overlay.innerHTML = `
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800/60 flex-shrink-0">
            <div>
                <div class="text-[13px] font-black text-white">Pick a Date</div>
                <div class="text-[9px] text-slate-500 mt-0.5">Forecast available for the next 16 days only</div>
            </div>
            <button onclick="_sgpCloseCalendar()"
                    class="w-8 h-8 rounded-xl flex items-center justify-center"
                    style="background:rgba(51,65,85,0.6);border:1px solid rgba(71,85,105,0.4);-webkit-tap-highlight-color:transparent;">
                <i class="fa-solid fa-xmark text-slate-400 text-[13px] pointer-events-none"></i>
            </button>
        </div>
        <!-- Calendar body -->
        <div class="flex-1 overflow-y-auto px-4 py-3">
            <!-- Disclaimer -->
            <div class="flex items-start gap-2.5 rounded-xl px-3 py-2.5 mb-4"
                 style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.18);">
                <i class="fa-solid fa-triangle-exclamation text-amber-400 text-[11px] mt-0.5 flex-shrink-0"></i>
                <span class="text-[9px] text-amber-200/70 leading-relaxed">
                    Open-Meteo provides hourly forecasts up to <strong class="text-amber-300">16 days ahead</strong>.
                    Dates beyond <strong class="text-amber-300">${maxDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</strong> are not forecastable.
                    Confidence drops significantly after day 7.
                </span>
            </div>
            ${monthsHtml}
        </div>
        <!-- Footer -->
        <div class="px-5 py-4 border-t border-slate-800/60 flex-shrink-0">
            ${_sgpTargetDate ? `
            <button onclick="_sgpResetDate()"
                    class="w-full py-2.5 rounded-xl text-[10px] font-black text-slate-400 mb-2"
                    style="background:rgba(51,65,85,0.35);border:1px solid rgba(71,85,105,0.30);-webkit-tap-highlight-color:transparent;">
                Reset to Today
            </button>` : ''}
            <button onclick="_sgpCloseCalendar()"
                    class="w-full py-2.5 rounded-xl text-[10px] font-black text-slate-300"
                    style="background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.22);-webkit-tap-highlight-color:transparent;">
                Cancel
            </button>
        </div>
    `;
    document.body.appendChild(overlay);
    // Entry animation
    overlay.style.opacity = '0';
    overlay.style.transform = 'translateY(12px)';
    requestAnimationFrame(() => {
        overlay.style.transition = 'opacity 0.20s ease, transform 0.20s ease';
        overlay.style.opacity = '1';
        overlay.style.transform = 'translateY(0)';
    });
}

/** Close the calendar overlay without selecting a date. */
function _sgpCloseCalendar() {
    const overlay = document.getElementById('sgpCalendarOverlay');
    if (!overlay) return;
    overlay.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    overlay.style.opacity    = '0';
    overlay.style.transform  = 'translateY(8px)';
    setTimeout(() => overlay.remove(), 180);
}

/**
 * Select a date from the calendar. Closes the calendar and re-renders
 * the results view centred on the chosen date.
 * @param {string} dateStr YYYY-MM-DD
 */
function _sgpSelectDate(dateStr) {
    _sgpCloseCalendar();
    _sgpTargetDate = dateStr;
    const result = window._sgpCurrentResult;
    if (result) _sgpRenderResults(result, dateStr);
}

/** Reset the date picker back to the default (today) view. */
function _sgpResetDate() {
    _sgpCloseCalendar();
    _sgpTargetDate = null;
    const result = window._sgpCurrentResult;
    if (result) _sgpRenderResults(result, null);
}

/** Check if a location (by lat/lon) is already saved. */
function _sgpIsLocationSaved(lat, lon) {
    try {
        const saved = JSON.parse(localStorage.getItem(_SGP_LS_KEY) || '[]');
        return saved.some(s => Math.abs(s.lat - lat) < 0.1 && Math.abs(s.lon - lon) < 0.1);
    } catch (_) { return false; }
}

/** Toggle save state for the currently displayed result. */
function _sgpToggleSave() {
    const result = window._sgpCurrentResult;
    if (!result) return;
    if (_sgpIsLocationSaved(result.lat, result.lon)) {
        _sgpDeleteByLatLon(result.lat, result.lon);
    } else {
        _sgpSaveResult(result);
    }
    // Re-render just the save button
    const btn = document.getElementById('sgpSaveBtn');
    if (btn) {
        const saved = _sgpIsLocationSaved(result.lat, result.lon);
        btn.innerHTML = `<i class="fa-${saved ? 'solid' : 'regular'} fa-bookmark text-[9px]"></i> ${saved ? 'Saved' : 'Save'}`;
        btn.style.background = saved ? 'rgba(139,92,246,0.22)' : 'rgba(51,65,85,0.5)';
        btn.style.color      = saved ? 'rgb(196,181,253)'      : 'rgba(148,163,184,0.8)';
        btn.style.border     = `1px solid ${saved ? 'rgba(139,92,246,0.40)' : 'rgba(71,85,105,0.4)'}`;
    }
    _sgpRenderSaved();
    _sgpSyncEmptyState();
}

/** Save a result to localStorage. */
function _sgpSaveResult(result) {
    try {
        const saved = JSON.parse(localStorage.getItem(_SGP_LS_KEY) || '[]');
        const idx   = saved.findIndex(s => Math.abs(s.lat - result.lat) < 0.1 && Math.abs(s.lon - result.lon) < 0.1);
        if (idx !== -1) { saved[idx] = result; }
        else {
            if (saved.length >= _SGP_MAX_SAVED) saved.shift(); // drop oldest
            saved.push(result);
        }
        localStorage.setItem(_SGP_LS_KEY, JSON.stringify(saved));
    } catch (_) {}
}

/** Delete a saved entry by lat/lon match. */
function _sgpDeleteByLatLon(lat, lon) {
    try {
        const saved = JSON.parse(localStorage.getItem(_SGP_LS_KEY) || '[]');
        const filtered = saved.filter(s => !(Math.abs(s.lat - lat) < 0.1 && Math.abs(s.lon - lon) < 0.1));
        localStorage.setItem(_SGP_LS_KEY, JSON.stringify(filtered));
    } catch (_) {}
}

/** Delete a saved entry by index in the saved array. */
function _sgpDeleteSaved(index) {
    try {
        const saved = JSON.parse(localStorage.getItem(_SGP_LS_KEY) || '[]');
        // index is from the reversed display list — convert back to real array position
        const realIndex = saved.length - 1 - index;
        if (realIndex < 0 || realIndex >= saved.length) return;
        const deletedItem = saved[realIndex]; // capture before splice
        saved.splice(realIndex, 1);
        localStorage.setItem(_SGP_LS_KEY, JSON.stringify(saved));
        _sgpRenderSaved();
        _sgpSyncEmptyState();
        // If the deleted entry is the one currently shown, clear the results view
        const curr = window._sgpCurrentResult;
        if (curr && deletedItem && Math.abs(curr.lat - deletedItem.lat) < 0.1) {
            _sgpShowResults(false);
            _sgpSyncEmptyState();
        }
    } catch (_) {}
}

/** Auto-refresh a saved entry if its location already exists in saved list. */
function _sgpAutoRefreshSaved(result) {
    try {
        const saved = JSON.parse(localStorage.getItem(_SGP_LS_KEY) || '[]');
        const idx   = saved.findIndex(s => Math.abs(s.lat - result.lat) < 0.1 && Math.abs(s.lon - result.lon) < 0.1);
        if (idx !== -1) {
            saved[idx] = result;
            localStorage.setItem(_SGP_LS_KEY, JSON.stringify(saved));
            _sgpRenderSaved();
        }
    } catch (_) {}
}

/** Load and display a saved location (tapping a saved card). */
function _sgpLoadSaved(displayIndex) {
    try {
        const saved = JSON.parse(localStorage.getItem(_SGP_LS_KEY) || '[]');
        const realIndex = saved.length - 1 - displayIndex;
        const loc = saved[realIndex];
        if (!loc) return;

        window._sgpCurrentResult = loc;
        _sgpTargetDate = null; // Reset date picker when loading a new location

        // Show stale data immediately (stale-while-revalidate)
        _sgpRenderResults(loc);
        _sgpShowResults(true);
        _sgpSyncEmptyState();

        // Scroll results into view
        const section = document.getElementById('sgpResultsSection');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Silently refresh data in background
        _sgpFetch7Day(loc.lat, loc.lon).then(weatherData => {
            if (!weatherData) return;
            loc.weatherData = weatherData;
            loc.fetchedAt   = Date.now();
            saved[realIndex] = loc;
            localStorage.setItem(_SGP_LS_KEY, JSON.stringify(saved));
            window._sgpCurrentResult = loc;
            _sgpRenderResults(loc); // re-render with fresh data
            _sgpRenderSaved();
        }).catch(() => {});
    } catch (_) {}
}

/** Render the saved locations list. */
function _sgpRenderSaved() {
    const container = document.getElementById('sgpSavedList');
    const section   = document.getElementById('sgpSavedSection');
    if (!container) return;
    try {
        const saved = JSON.parse(localStorage.getItem(_SGP_LS_KEY) || '[]');
        if (saved.length === 0) {
            if (section) section.classList.add('hidden');
            _sgpSyncEmptyState();
            return;
        }
        if (section) section.classList.remove('hidden');

        // Display newest first (reverse index)
        container.innerHTML = saved.slice().reverse().map((loc, displayIdx) => {
            const bortle = _sgBortleEstimate(loc.name, loc.tier);
            const ago    = _sgpTimeAgo(loc.fetchedAt || 0);
            // Build 7 mini dot scores
            const dots = (loc.weatherData?.daily || []).slice(0, 7).map((day) => {
                const start = day.date + 'T00:00', end = day.date + 'T23:59';
                const nightHrs = (loc.weatherData?.hourly || []).filter(h => h.time >= start && h.time <= end && !h.isDay);
                const moon  = _sgMoonPhase(new Date(day.date + 'T20:00'));
                const score = _sgpDayScore(nightHrs, moon.illumination).score;
                const c     = score >= 70 ? '#8b5cf6' : score >= 50 ? '#22c55e' : score >= 30 ? '#f59e0b' : '#475569';
                return `<span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block;flex-shrink:0;"></span>`;
            }).join('');
            // Best score
            const allScores = (loc.weatherData?.daily || []).map((day) => {
                const start = day.date + 'T00:00', end = day.date + 'T23:59';
                const nightHrs = (loc.weatherData?.hourly || []).filter(h => h.time >= start && h.time <= end && !h.isDay);
                const moon = _sgMoonPhase(new Date(day.date + 'T20:00'));
                return _sgpDayScore(nightHrs, moon.illumination).score;
            });
            const best    = allScores.length > 0 ? Math.max(...allScores) : 0;
            const bestQ   = _sgSeeingLabel(best);
            return `<div class="flex items-center gap-3 px-4 py-3 border-b border-slate-800/40 last:border-0"
                         onclick="_sgpLoadSaved(${displayIdx})"
                         style="-webkit-tap-highlight-color:transparent;cursor:pointer;">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-[13px] font-black text-white truncate">${loc.name}</span>
                        ${loc.country ? `<span class="text-[10px] text-slate-500">${loc.country}</span>` : ''}
                    </div>
                    <div class="flex items-center gap-2 mt-1">
                        <div class="flex items-center gap-0.5 flex-shrink-0">${dots}</div>
                        <span class="text-[8px] text-slate-600">B${bortle.class} · ${ago}</span>
                    </div>
                    <div class="text-[9px] mt-0.5 font-bold" style="color:${bestQ.color}aa">Best: ${best} · ${bestQ.label}</div>
                </div>
                <button onclick="event.stopPropagation();_sgpDeleteSaved(${displayIdx});"
                        class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full"
                        style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.15);-webkit-tap-highlight-color:transparent;">
                    <i class="fa-solid fa-trash text-[9px] text-red-500/70 pointer-events-none"></i>
                </button>
            </div>`;
        }).join('');
    } catch (_) {
        if (section) section.classList.add('hidden');
    }
    _sgpSyncEmptyState();
}

// ── Background refresh (drawer closed) ───────────────────────────────────────
/**
 * Starts a 30-min background interval that keeps the localStorage weather cache
 * warm even when the drawer is never opened.  This means the very first time the
 * user taps the weather capsule after a long idle period they still see
 * near-current data instantly instead of a cold-start spinner.
 *
 * The interval is intentionally skipped if the drawer is already open — the
 * in-drawer 5-min timer handles freshness while the user is looking at it.
 */
function _wdStartBgRefresh() {
    clearInterval(_wdBgRefreshInterval);
    _wdBgRefreshInterval = setInterval(() => {
        // Skip if drawer is currently open — its own interval handles freshness
        const overlay = document.getElementById('weatherDrawerOverlay');
        if (overlay && !overlay.classList.contains('hidden')) return;

        // Resolve best-available coordinates
        let lat = userLat, lon = userLon;
        if (cachedUserCoords) { lat = cachedUserCoords.lat; lon = cachedUserCoords.lon; }
        if (!lat || !lon) return;

        // Bypass in-session mem cache to force a live API call
        const key = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
        _wdDataCache.delete(key);
        // Fire-and-forget — _fetchWeatherDrawerData saves result to LS automatically
        _fetchWeatherDrawerData(lat, lon).catch(() => {});
    }, _WD_BG_INTERVAL);
}

// _fetchWeatherDrawerForecast is no longer needed — hourly data is embedded
// in the _fetchWeatherDrawerData response and rendered directly in _renderWeatherDrawer.

// ── Currency Conversion ───────────────────────────────────────────────────────
// Ambient rate display in a dedicated currency capsule + drawer on the map screen.
// Rates are fetched from frankfurter.app (free, no API key, CORS-enabled, ECB-backed).
// The home currency is set inline in the currency drawer and persisted in localStorage.
// Rate cache has a 24-hour TTL — ECB updates daily.

const _FX_LS_KEY        = 'compass_home_currency';
const _FX_CACHE_LS_KEY  = 'compass_fx_cache';
const _FX_CACHE_TTL     = 24 * 60 * 60 * 1000; // 24 h
// Persists converter FROM / TO / last entered amount across drawer sessions
const _CD_FROM_LS_KEY   = 'compass_cd_from';
const _CD_TO_LS_KEY     = 'compass_cd_to';
const _CD_AMOUNT_LS_KEY = 'compass_cd_amount';

let _homeCurrency = localStorage.getItem(_FX_LS_KEY) || 'USD';

// ISO 3166-1 alpha-2 country code → ISO 4217 currency code
const _COUNTRY_CURRENCY_MAP = {
    // Eurozone
    AD:'EUR', AT:'EUR', BE:'EUR', CY:'EUR', EE:'EUR', FI:'EUR', FR:'EUR', DE:'EUR',
    GR:'EUR', IE:'EUR', IT:'EUR', LV:'EUR', LT:'EUR', LU:'EUR', MT:'EUR', MC:'EUR',
    ME:'EUR', NL:'EUR', PT:'EUR', SM:'EUR', SK:'EUR', SI:'EUR', ES:'EUR', VA:'EUR',
    // Major currencies
    AU:'AUD', CA:'CAD', CN:'CNY', DK:'DKK', HK:'HKD', HU:'HUF', IN:'INR', ID:'IDR',
    IL:'ILS', JP:'JPY', KR:'KRW', MY:'MYR', MX:'MXN', NZ:'NZD', NO:'NOK', PH:'PHP',
    PL:'PLN', QA:'QAR', RO:'RON', RU:'RUB', SA:'SAR', SG:'SGD', ZA:'ZAR', SE:'SEK',
    CH:'CHF', TW:'TWD', TH:'THB', TR:'TRY', GB:'GBP', US:'USD', AE:'AED', VN:'VND',
    // Extended travel destinations
    AR:'ARS', BD:'BDT', BG:'BGN', BR:'BRL', CL:'CLP', CO:'COP', CZ:'CZK', EG:'EGP',
    GE:'GEL', GH:'GHS', IS:'ISK', JO:'JOD', KZ:'KZT', KE:'KES', KW:'KWD', MA:'MAD',
    MV:'MVR', MN:'MNT', MM:'MMK', NP:'NPR', NG:'NGN', PK:'PKR', RS:'RSD', LK:'LKR',
    UA:'UAH', UZ:'UZS', TN:'TND', TZ:'TZS', UG:'UGX', AM:'AMD', AZ:'AZN', BA:'BAM',
    BH:'BHD', HR:'HRK', KH:'KHR', LA:'LAK', MK:'MKD', OM:'OMR', AL:'ALL', ET:'ETB',
};

// ISO 3166-1 alpha-2 country code → full English country name
const _ISO_COUNTRY_NAMES = {
    AD:'Andorra',         AE:'UAE',              AL:'Albania',         AM:'Armenia',
    AR:'Argentina',       AT:'Austria',          AU:'Australia',       AZ:'Azerbaijan',
    BA:'Bosnia',          BD:'Bangladesh',        BE:'Belgium',         BG:'Bulgaria',
    BH:'Bahrain',         BR:'Brazil',            CA:'Canada',          CH:'Switzerland',
    CL:'Chile',           CN:'China',             CO:'Colombia',        CY:'Cyprus',
    CZ:'Czech Republic',  DE:'Germany',           DK:'Denmark',         EE:'Estonia',
    EG:'Egypt',           ES:'Spain',             ET:'Ethiopia',        FI:'Finland',
    FR:'France',          GB:'United Kingdom',    GE:'Georgia',         GH:'Ghana',
    GR:'Greece',          HK:'Hong Kong',         HR:'Croatia',         HU:'Hungary',
    ID:'Indonesia',       IE:'Ireland',           IL:'Israel',          IN:'India',
    IS:'Iceland',         IT:'Italy',             JO:'Jordan',          JP:'Japan',
    KE:'Kenya',           KH:'Cambodia',          KR:'South Korea',     KW:'Kuwait',
    KZ:'Kazakhstan',      LA:'Laos',              LK:'Sri Lanka',       LT:'Lithuania',
    LU:'Luxembourg',      LV:'Latvia',            MA:'Morocco',         MC:'Monaco',
    ME:'Montenegro',      MK:'North Macedonia',   MM:'Myanmar',         MN:'Mongolia',
    MT:'Malta',           MV:'Maldives',          MX:'Mexico',          MY:'Malaysia',
    NG:'Nigeria',         NL:'Netherlands',        NO:'Norway',          NP:'Nepal',
    NZ:'New Zealand',     OM:'Oman',              PH:'Philippines',     PK:'Pakistan',
    PL:'Poland',          PT:'Portugal',           QA:'Qatar',           RO:'Romania',
    RS:'Serbia',          RU:'Russia',             SA:'Saudi Arabia',    SE:'Sweden',
    SG:'Singapore',       SI:'Slovenia',           SK:'Slovakia',        SM:'San Marino',
    TH:'Thailand',        TN:'Tunisia',            TR:'Turkey',          TW:'Taiwan',
    TZ:'Tanzania',        UA:'Ukraine',            UG:'Uganda',          US:'United States',
    UZ:'Uzbekistan',      VA:'Vatican',            VN:'Vietnam',         ZA:'South Africa',
};

// Currency symbols for display
const _CURRENCY_SYMBOLS = {
    AED:'د.إ', ALL:'L',   AMD:'֏',   ARS:'$',   AUD:'A$',  AZN:'₼',  BAM:'KM', BDT:'৳',
    BGN:'лв',  BHD:'BD',  BRL:'R$',  CAD:'C$',  CHF:'Fr',  CLP:'$',  CNY:'¥',  COP:'$',
    CZK:'Kč',  DKK:'kr',  EGP:'£',   ETB:'Br',  EUR:'€',   GBP:'£',  GEL:'₾',  GHS:'₵',
    HKD:'HK$', HRK:'kn',  HUF:'Ft',  IDR:'Rp',  ILS:'₪',   INR:'₹',  ISK:'kr', JOD:'JD',
    JPY:'¥',   KES:'KSh', KHR:'៛',   KRW:'₩',   KWD:'KD',  KZT:'₸',  LAK:'₭',  LKR:'Rs',
    MAD:'د.م', MKD:'ден', MMK:'K',   MNT:'₮',   MVR:'Rf',  MXN:'$',  MYR:'RM', NGN:'₦',
    NOK:'kr',  NPR:'Rs',  NZD:'NZ$', OMR:'﷼',   PHP:'₱',   PKR:'Rs', PLN:'zł', QAR:'﷼',
    RON:'lei', RSD:'din', RUB:'₽',   SAR:'﷼',   SEK:'kr',  SGD:'S$', THB:'฿',  TND:'د.ت',
    TRY:'₺',   TWD:'NT$', TZS:'TSh', UAH:'₴',   UGX:'USh', USD:'$',  UZS:'сўм',VND:'₫',
    ZAR:'R',   AMB:'֏',   BAM:'KM',
};

// Currency full names (for the Settings selector)
const _CURRENCY_NAMES = {
    AED:'UAE Dirham',          ALL:'Albanian Lek',       AMD:'Armenian Dram',
    ARS:'Argentine Peso',      AUD:'Australian Dollar',  AZN:'Azerbaijani Manat',
    BAM:'Bosnia Mark',         BDT:'Bangladeshi Taka',   BGN:'Bulgarian Lev',
    BHD:'Bahraini Dinar',      BRL:'Brazilian Real',     CAD:'Canadian Dollar',
    CHF:'Swiss Franc',         CLP:'Chilean Peso',       CNY:'Chinese Yuan',
    COP:'Colombian Peso',      CZK:'Czech Koruna',       DKK:'Danish Krone',
    EGP:'Egyptian Pound',      ETB:'Ethiopian Birr',     EUR:'Euro',
    GBP:'British Pound',       GEL:'Georgian Lari',      GHS:'Ghanaian Cedi',
    HKD:'Hong Kong Dollar',    HRK:'Croatian Kuna',      HUF:'Hungarian Forint',
    IDR:'Indonesian Rupiah',   ILS:'Israeli Shekel',     INR:'Indian Rupee',
    ISK:'Icelandic Króna',     JOD:'Jordanian Dinar',    JPY:'Japanese Yen',
    KES:'Kenyan Shilling',     KHR:'Cambodian Riel',     KRW:'South Korean Won',
    KWD:'Kuwaiti Dinar',       KZT:'Kazakhstani Tenge',  LAK:'Lao Kip',
    LKR:'Sri Lankan Rupee',    MAD:'Moroccan Dirham',    MKD:'Macedonian Denar',
    MMK:'Myanmar Kyat',        MNT:'Mongolian Tögrög',   MVR:'Maldivian Rufiyaa',
    MXN:'Mexican Peso',        MYR:'Malaysian Ringgit',  NGN:'Nigerian Naira',
    NOK:'Norwegian Krone',     NPR:'Nepalese Rupee',     NZD:'New Zealand Dollar',
    OMR:'Omani Rial',          PHP:'Philippine Peso',    PKR:'Pakistani Rupee',
    PLN:'Polish Złoty',        QAR:'Qatari Riyal',       RON:'Romanian Leu',
    RSD:'Serbian Dinar',       RUB:'Russian Ruble',      SAR:'Saudi Riyal',
    SEK:'Swedish Krona',       SGD:'Singapore Dollar',   THB:'Thai Baht',
    TND:'Tunisian Dinar',      TRY:'Turkish Lira',       TWD:'Taiwan Dollar',
    TZS:'Tanzanian Shilling',  UAH:'Ukrainian Hryvnia',  UGX:'Ugandan Shilling',
    USD:'US Dollar',           UZS:'Uzbekistani Som',    VND:'Vietnamese Dong',
    ZAR:'South African Rand',
};

// In-memory + localStorage FX rate cache (24 h TTL)
// Shape: { "EUR→INR": { rate: 92.3, fetchedAt: 1719000000000 }, ... }
let _fxRateCache = (() => {
    try { return JSON.parse(localStorage.getItem(_FX_CACHE_LS_KEY)) || {}; }
    catch (_) { return {}; }
})();

/**
 * Fetch the exchange rate  1 fromCur → X toCur.
 * Returns a number, or null on failure. Results are cached 24 h.
 *
 * API: fawazahmed0/exchange-api (open-source, no key, CORS-enabled, daily ECB+IMF data).
 *   Primary:  https://latest.currency-api.pages.dev  (Cloudflare Pages)
 *   Fallback: https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest
 * Both are in sw.js NETWORK_ONLY_HOSTS so the Service Worker never stale-caches them.
 */
async function _fetchFXRate(fromCur, toCur) {
    if (!fromCur || !toCur || fromCur === toCur) return 1;
    const cacheKey = `${fromCur}→${toCur}`;
    const hit = _fxRateCache[cacheKey];
    if (hit && (Date.now() - hit.fetchedAt) < _FX_CACHE_TTL) return hit.rate;

    const from = fromCur.toLowerCase();
    const to   = toCur.toLowerCase();

    const urls = [
        `https://latest.currency-api.pages.dev/v1/currencies/${from}.json`,
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from}.json`,
    ];

    for (const url of urls) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const json = await resp.json();
            const rate = json[from]?.[to];
            if (rate == null) continue;

            _fxRateCache[cacheKey] = { rate, fetchedAt: Date.now() };
            try { localStorage.setItem(_FX_CACHE_LS_KEY, JSON.stringify(_fxRateCache)); } catch (_) {}
            return rate;
        } catch (_) {
            // try next URL
        }
    }

    return null;
}

/**
 * Format a rate number to a readable string based on its magnitude.
 */
function _fmtFXRate(r) {
    if (r >= 100) return r.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (r >= 10)  return r.toLocaleString(undefined, { maximumFractionDigits: 1 });
    if (r >= 1)   return r.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (r >= 0.01) return r.toLocaleString(undefined, { maximumFractionDigits: 3 });
    return r.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// Tracks the most recently resolved country code from the weather fetch,
// so the currency drawer can populate instantly when opened.
let _currencyCurrentCountryCode = null;
let _currencyCurrentCityLabel   = null; // e.g. "Paris, FR"

// ── Currency Drawer (open / close) ────────────────────────────────────────────

/**
 * Resolves the ISO 3166-1 alpha-2 country code for a given city name.
 *
 * Resolution order (fastest → slowest):
 *  1. weatherCache  – any cached entry for a spot in that city (instant, no network)
 *  2. fetchWeatherForCoords – OWM call on the first spot with valid coords (populates cache)
 *  3. Nominatim addressdetails search – last-resort geocode when no spots have coords
 *
 * @param   {string}          cityName  – e.g. "Paris", "Tokyo"
 * @returns {Promise<string|null>}       ISO country code (e.g. "FR") or null
 */
async function _resolveCityCountry(cityName) {
    if (!cityName) return null;

    // ── 1. Find first spot in that city with valid coordinates ────────────────
    const spot = (typeof travelSpots !== 'undefined' ? travelSpots : []).find(s => {
        if (s.city !== cityName) return false;
        const lat = parseFloat(s.latitude);
        const lon = parseFloat(s.longitude);
        return !isNaN(lat) && lat !== 0 && !isNaN(lon) && lon !== 0;
    });

    if (spot) {
        const lat = parseFloat(spot.latitude);
        const lon = parseFloat(spot.longitude);

        // Check weatherCache instantly (key format matches map.js)
        const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
        const hit = weatherCache.get(key);
        if (hit && hit.country) return hit.country;

        // Not cached — fetch weather (also populates cache for the map capsule)
        try {
            const w = await fetchWeatherForCoords(lat, lon);
            if (w && w.country) return w.country;
        } catch (_) {}
    }

    // ── 2. Nominatim geocode fallback (city name → country_code) ──────────────
    try {
        const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1&addressdetails=1`,
            { headers: { 'User-Agent': 'Save2Go/5.0 (raj.aryan@miniclip.com)' } }
        );
        if (resp.ok) {
            const hits = await resp.json();
            if (hits[0]?.address?.country_code) {
                return hits[0].address.country_code.toUpperCase();
            }
        }
    } catch (_) {}

    return null;
}

function openCurrencyDrawer() {
    const overlay = document.getElementById('currencyDrawerOverlay');
    const sheet   = document.getElementById('currencyDrawerSheet');
    if (!overlay || !sheet) return;

    // ── Guard: no city filter active → speech bubble hint, same as magnifying glass ──
    if (!checkedCitiesStateArray || checkedCitiesStateArray.length === 0) {
        const capsule = document.getElementById('mapCurrencyWidget');
        if (typeof triggerCuteSpeechBubbleHUD === 'function') {
            triggerCuteSpeechBubbleHUD('Select a city filter first!', capsule, null);
        }
        return;
    }

    _setFabsVisible(false);

    // Hide bottom nav so the drawer gets the full bottom screen space
    const _cdNav = document.getElementById('masterGlobalNavigationBarDeck');
    if (_cdNav) _cdNav.style.display = 'none';

    // Reset the "don't show" toggle to OFF each time the drawer opens
    _setCurrencyHideToggle(false);

    overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            sheet.style.transform  = 'translateY(0)';
            sheet.style.transition = 'transform 0.32s cubic-bezier(0.32,0.72,0,1)';
        });
    });

    initHomeCurrency();

    // ── Derive location from the active city filter (not GPS) ─────────────────
    const cityName = checkedCitiesStateArray[0];
    _currencyCurrentCityLabel = cityName;

    // Show loading skeleton immediately, then fill in once the country resolves
    _populateCurrencyDrawerContent(null, cityName);
    _resolveCityCountry(cityName).then(countryCode => {
        _currencyCurrentCountryCode = countryCode || null;
        // Only re-render if the drawer is still open (user may have closed it during lookup)
        const o = document.getElementById('currencyDrawerOverlay');
        if (o && !o.classList.contains('hidden')) {
            _populateCurrencyDrawerContent(countryCode, cityName);
        }
    });
}

function closeCurrencyDrawer() {
    const overlay = document.getElementById('currencyDrawerOverlay');
    const sheet   = document.getElementById('currencyDrawerSheet');
    if (!sheet) return;

    // If user toggled "Don't show on map" — persist and hide the capsule
    const toggle = document.getElementById('cdHideCapsuleToggle');
    if (toggle && toggle.dataset.active === 'true') {
        localStorage.setItem('compass_show_currency_capsule', 'false');
        const capsule = document.getElementById('mapCurrencyWidget');
        if (capsule) capsule.style.display = 'none';
        // Sync settings toggle to OFF
        _syncSettingsCurrencyToggle(false);
    }

    // Close the converter currency picker panel if open
    closeConverterCurrencyPicker();

    // Hide overlay immediately — removes blur/dim at the moment of close
    if (overlay) overlay.classList.add('hidden');
    sheet.style.transition = 'transform 0.28s cubic-bezier(0.32,0.72,0,1)';
    sheet.style.transform  = 'translateY(100%)';
    // Post-animation cleanup only (nav + FAB restore)
    setTimeout(() => {
        const _cdNav = document.getElementById('masterGlobalNavigationBarDeck');
        if (_cdNav) _cdNav.style.display = '';
        _updateFabVisibility();
    }, 300);
}

// ── Currency Drawer content ────────────────────────────────────────────────────

async function _populateCurrencyDrawerContent(countryCode, cityLabel) {
    const locationEl = document.getElementById('cdLocation');
    const labelEl    = document.getElementById('cdLocalCurrencyLabel');
    // Show country name (+ local currency) once resolved; city name during async load
    if (locationEl) {
        const countryName = countryCode ? (_ISO_COUNTRY_NAMES[countryCode] || countryCode) : null;
        if (countryName) {
            // Derive the country's local currency name for the secondary label
            const locCode = _COUNTRY_CURRENCY_MAP[countryCode] || '';
            const locName = locCode ? (_CURRENCY_NAMES[locCode] || locCode) : '';
            locationEl.innerHTML = locName
                ? `${countryName}<span class="font-normal text-[13px] text-slate-500 ml-2">— ${locName}</span>`
                : countryName;
        } else {
            locationEl.textContent = cityLabel || 'Your Location';
        }
    }

    const loadingEl      = document.getElementById('cdLoading');
    const rateBlock      = document.getElementById('cdRateBlock');
    const zoneBlock      = document.getElementById('cdHomeCurrencyZone');
    const errorBlock     = document.getElementById('cdError');
    const converterBlock = document.getElementById('cdConverterBlock');
    if (loadingEl)      loadingEl.classList.remove('hidden');
    if (rateBlock)      rateBlock.classList.add('hidden');
    if (zoneBlock)      zoneBlock.classList.add('hidden');   // always hidden — no zone concept
    if (errorBlock)     errorBlock.classList.add('hidden');
    if (converterBlock) converterBlock.classList.add('hidden');

    // ── Determine FROM and TO currencies ────────────────────────────────────
    // Priority (highest → lowest):
    //   1. User's persisted selection (localStorage) — always wins once set
    //   2. Location-derived currency (localCur) — only used as a first-visit hint
    //   3. First-launch defaults: EUR → INR
    //
    // localCur must NEVER override a persisted choice.  The previous ordering
    // (localCur first) was what caused the drawer to revert on reopen.
    const localCur = _COUNTRY_CURRENCY_MAP[(countryCode || '').toUpperCase()] || null;

    const fromCur = localStorage.getItem(_CD_FROM_LS_KEY) || 'EUR';
    const toCur   = localStorage.getItem(_CD_TO_LS_KEY)   // 1st: user's saved choice
        || localCur                                        // 2nd: city's local currency
        || (fromCur !== 'INR' ? 'INR' : 'USD');            // 3rd: first-launch default (EUR→INR)

    // Update the "local currency" label
    const localName   = _CURRENCY_NAMES[toCur]  || toCur;
    const localSymbol = _CURRENCY_SYMBOLS[toCur] || toCur;
    if (labelEl) labelEl.textContent = `To ${localName} (${toCur})`;


    // ── Same currency on both sides → rate is 1 ──────────────────────────────
    if (fromCur === toCur) {
        if (loadingEl) loadingEl.classList.add('hidden');
        _initCurrencyConverter(fromCur, toCur, 1);
        _updateCurrencyCapsuleText(fromCur, toCur, 1, null);
        return;
    }

    // ── Fetch rate and initialise converter ──────────────────────────────────
    const rate = await _fetchFXRate(fromCur, toCur);
    if (loadingEl) loadingEl.classList.add('hidden');

    if (rate == null) {
        if (errorBlock) {
            const errTxt = document.getElementById('cdErrorText');
            if (errTxt) errTxt.textContent = `Rate for ${fromCur} → ${toCur} unavailable`;
            errorBlock.classList.remove('hidden');
        }
        _updateCurrencyCapsuleText(null, null, null, null);
        return;
    }

    // Initialise the converter — it owns the Live Rate block + capsule text from here on
    _initCurrencyConverter(fromCur, toCur, rate);
}

// ── Currency capsule updater ──────────────────────────────────────────────────

/**
 * Updates the two ticker spans in mapCurrencyWidget and toggles the marquee
 * animation on/off.  Called from notifyWeatherCountryForCurrency and from
 * the converter when rate/direction/amount changes.
 *
 * @param {string}      fromCur – FROM currency code (e.g. "USD")
 * @param {string}      toCur   – TO currency code   (e.g. "INR")
 * @param {number|null} rate    – FROM→TO rate; null clears to "Exchange"
 * @param {number|null} amount  – the amount typed by the user; falls back to 1
 */
function _updateCurrencyCapsuleText(fromCur, toCur, rate, amount) {
    const ticker = document.getElementById('mapCurrencyTicker');
    const spanA  = document.getElementById('mapCurrencyRateA');
    const spanB  = document.getElementById('mapCurrencyRateB');
    if (!ticker || !spanA || !spanB) return;

    let text;
    if (fromCur && toCur && rate != null && isFinite(rate) && rate >= 0) {
        const fromSym      = _CURRENCY_SYMBOLS[fromCur] || fromCur;
        const toSym        = _CURRENCY_SYMBOLS[toCur]   || toCur;
        const displayAmt   = (amount != null && isFinite(amount) && amount > 0) ? amount : 1;
        const converted    = _fmtAmount(displayAmt * rate);
        text = `${fromSym}${_fmtAmount(displayAmt)} = ${toSym}${converted}`;
    } else {
        text = 'Exchange';
    }

    spanA.textContent = text;
    spanB.textContent = text;

    if (text !== 'Exchange') {
        ticker.classList.add('currency-ticker-anim');
    } else {
        ticker.classList.remove('currency-ticker-anim');
    }
}

async function _updateCurrencyCapsule(countryCode, rate, sameZone) {
    // sameZone argument is ignored — there is no home-currency zone concept.
    // Always defer to the active converter state if available.
    if (_cdFromCur && _cdToCur && _cdCurrentRate != null) {
        const persistedAmt = parseFloat(localStorage.getItem(_CD_AMOUNT_LS_KEY));
        _updateCurrencyCapsuleText(
            _cdFromCur, _cdToCur, _cdCurrentRate,
            (!isNaN(persistedAmt) && persistedAmt > 0) ? persistedAmt : null
        );
        return;
    }

    // No converter state yet — try to infer from country
    const localCur = _COUNTRY_CURRENCY_MAP[(countryCode || '').toUpperCase()] || null;
    const homeCur  = _homeCurrency;
    if (!localCur) {
        _updateCurrencyCapsuleText(null, null, null, null);
        return;
    }

    let r = rate;
    if (r == null) {
        _updateCurrencyCapsuleText(homeCur, localCur, null, null); // "Exchange" while loading
        r = await _fetchFXRate(homeCur, localCur);
    }
    _updateCurrencyCapsuleText(homeCur, localCur, r, null);
}

/**
 * Called by map.js after weather data resolves with a country code.
 * Persists the country so the drawer can open without waiting for GPS.
 */
function notifyWeatherCountryForCurrency(countryCode, cityLabel) {
    if (!countryCode) return;
    _currencyCurrentCountryCode = countryCode;
    _currencyCurrentCityLabel   = cityLabel || countryCode;
    _updateCurrencyCapsule(countryCode, null, false);
}

/** Load the persisted home currency code at startup. */
function initHomeCurrency() {
    _homeCurrency = localStorage.getItem(_FX_LS_KEY) || 'USD';
}

// ── Converter currency picker (inline, shared for FROM and TO) ────────────────

/** Which side the inline picker is currently open for: 'from' | 'to' | null */
let _cdPickerSide = null;
let _cdPickerOpen = false;

/**
 * Opens the inline cdPickerPanel to let the user choose a currency for
 * side 'from' (home) or side 'to' (local).
 */
function openConverterCurrencyPicker(side) {
    _cdPickerSide = side;
    _cdPickerOpen = true;
    const panel  = document.getElementById('cdPickerPanel');
    const title  = document.getElementById('cdPickerPanelTitle');
    const search = document.getElementById('cdPickerSearch');
    if (!panel) return;

    if (title) title.textContent = side === 'from' ? 'Select From Currency' : 'Select Target Currency';

    panel.classList.remove('hidden');
    panel.style.maxHeight  = '0px';
    panel.style.opacity    = '0';
    panel.style.transition = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => {
        panel.style.transition = 'max-height 0.22s ease, opacity 0.18s ease';
        panel.style.maxHeight  = '340px';
        panel.style.opacity    = '1';
    }));

    _renderConverterCurrencyList('');
    if (search) {
        search.value = '';
        setTimeout(() => search.focus(), 80);
    }
    // Scroll the converter block into view so the picker is visible
    setTimeout(() => {
        const block = document.getElementById('cdConverterBlock');
        if (block) block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 120);
}

/** Closes the inline currency picker panel. */
function closeConverterCurrencyPicker() {
    if (!_cdPickerOpen) return;
    _cdPickerOpen = false;
    _cdPickerSide = null;
    const panel = document.getElementById('cdPickerPanel');
    if (panel) {
        panel.style.transition = 'max-height 0.18s ease, opacity 0.15s ease';
        panel.style.maxHeight  = '0px';
        panel.style.opacity    = '0';
        setTimeout(() => panel.classList.add('hidden'), 200);
    }
}

/** Called by the picker search input's oninput. */
function filterConverterCurrencyList(query) {
    _renderConverterCurrencyList(query);
}

/**
 * Renders the currency list for the inline picker.
 * Highlights the currency already selected on the active side.
 * Sort: exact code → name starts → code starts → name contains.
 */
function _renderConverterCurrencyList(query) {
    const list = document.getElementById('cdPickerList');
    if (!list) return;

    const q = (query || '').trim().toLowerCase();
    const allEntries = Object.entries(_CURRENCY_NAMES).sort((a, b) => a[1].localeCompare(b[1]));

    let displayed;
    if (!q) {
        displayed = allEntries;
    } else {
        const exactCode    = allEntries.filter(([c])    => c.toLowerCase() === q);
        const nameStarts   = allEntries.filter(([c, n]) => n.toLowerCase().startsWith(q)  && c.toLowerCase() !== q);
        const codeStarts   = allEntries.filter(([c, n]) => c.toLowerCase().startsWith(q)  && !n.toLowerCase().startsWith(q) && c.toLowerCase() !== q);
        const nameContains = allEntries.filter(([c, n]) => n.toLowerCase().includes(q)    && !n.toLowerCase().startsWith(q) && c.toLowerCase() !== q);
        displayed = [...exactCode, ...nameStarts, ...codeStarts, ...nameContains];
    }

    if (displayed.length === 0) {
        list.innerHTML = `<div class="px-4 py-6 text-center text-[11px] text-slate-600 italic">No currencies found</div>`;
        return;
    }

    const activeCur = _cdPickerSide === 'from' ? _cdFromCur : _cdToCur;

    list.innerHTML = displayed.map(([code, name], idx) => {
        const sym        = _CURRENCY_SYMBOLS[code] || code;
        const isSelected = code === activeCur;
        const borderTop  = idx > 0 ? 'border-t border-slate-800/50' : '';
        const bgClass    = isSelected ? 'bg-emerald-500/8' : '';
        return (
            `<button onclick="selectConverterCurrency('${code}')"` +
            ` class="w-full flex items-center gap-3 px-4 py-3 text-left ${bgClass} ${borderTop}` +
            ` active:bg-slate-800/60 transition-colors"` +
            ` style="-webkit-tap-highlight-color:transparent;">` +
                `<span class="shrink-0 w-8 h-8 rounded-lg ` +
                    `${isSelected ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300' : 'bg-slate-800 border border-slate-700/50 text-slate-400'}` +
                    ` flex items-center justify-center text-[11px] font-black leading-none">${sym}</span>` +
                `<div class="flex-1 min-w-0">` +
                    `<div class="text-[11.5px] font-bold ${isSelected ? 'text-emerald-200' : 'text-slate-300'} leading-tight truncate">${name}</div>` +
                    `<div class="text-[9.5px] ${isSelected ? 'text-emerald-500' : 'text-slate-600'} font-black leading-tight mt-0.5 tracking-wider">${code}</div>` +
                `</div>` +
                (isSelected
                    ? `<i class="fa-solid fa-circle-check text-emerald-400 text-[13px] shrink-0"></i>`
                    : `<i class="fa-solid fa-chevron-right text-slate-700 text-[9px] shrink-0"></i>`) +
            `</button>`
        );
    }).join('');

    if (!q) {
        requestAnimationFrame(() => {
            const selected = list.querySelector('button:has(.fa-circle-check)');
            if (selected) selected.scrollIntoView({ block: 'nearest' });
        });
    }
}

/**
 * Called when the user taps a currency row in the inline picker.
 * Persists the chosen FROM/TO and refreshes the rate.
 */
function selectConverterCurrency(code) {
    if (_cdPickerSide === 'from') {
        _cdFromCur    = code;
        _homeCurrency = code;
        try {
            localStorage.setItem(_FX_LS_KEY,      code);
            localStorage.setItem(_CD_FROM_LS_KEY, code);
        } catch (_) {}
    } else {
        _cdToCur = code;
        try { localStorage.setItem(_CD_TO_LS_KEY, code); } catch (_) {}
        // Immediately update the "To …" subtitle so it reflects the new selection
        // without needing to close and reopen the drawer.
        const labelEl = document.getElementById('cdLocalCurrencyLabel');
        if (labelEl) labelEl.textContent = `To ${_CURRENCY_NAMES[code] || code} (${code})`;
    }
    _fxRateCache = {};
    try { localStorage.removeItem(_FX_CACHE_LS_KEY); } catch (_) {}

    _updateConverterRowUI(_cdPickerSide, code);
    closeConverterCurrencyPicker();
    _refreshConverterRate();
}

/** Keeps the FROM/TO row symbol + code labels in sync. */
function _updateConverterRowUI(side, code) {
    const sym = _CURRENCY_SYMBOLS[code] || code;
    if (side === 'from') {
        const symEl  = document.getElementById('cdConvFromSymbol');
        const codeEl = document.getElementById('cdConvFromCode');
        if (symEl) {
            symEl.textContent = sym;
            symEl.className   = 'w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-[13px] font-black text-emerald-300';
        }
        if (codeEl) codeEl.textContent = code;
    } else {
        const symEl  = document.getElementById('cdConvToSymbol');
        const codeEl = document.getElementById('cdConvToCode');
        if (symEl) {
            symEl.textContent = sym;
            symEl.className   = 'w-8 h-8 rounded-lg bg-slate-800 border border-slate-700/40 flex items-center justify-center text-[13px] font-black text-slate-400';
        }
        if (codeEl) codeEl.textContent = code;
    }
}

/** Legacy stubs — keep so any stale references don't throw. */
function toggleCurrencyPicker()   {}
function saveHomeCurrency()       {}
function selectCurrencyFromPicker(code) { selectConverterCurrency(code); }

// ── Converter engine ──────────────────────────────────────────────────────────

/** Converter state */
let _cdFromCur      = null;   // current FROM currency code
let _cdToCur        = null;   // current TO currency code
let _cdCurrentRate  = null;   // FROM→TO rate

/**
 * Formats a converted amount for display in the converter result field.
 * Always shows at least 2 significant decimal places.
 */
function _fmtAmount(v) {
    if (!isFinite(v) || v === 0) return '0';
    if (v >= 10000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (v >= 100)   return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (v >= 1)     return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 0.001) return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/**
 * Updates the Live Rate block (cdRatePrimary / cdRateInverse) to reflect the
 * currently active FROM→TO direction and rate.
 */
function _updateLiveRateBlock(fromCur, toCur, rate) {
    const primaryEl = document.getElementById('cdRatePrimary');
    const inverseEl = document.getElementById('cdRateInverse');
    const rateBlock = document.getElementById('cdRateBlock');
    if (!primaryEl) return;

    const fromSym = _CURRENCY_SYMBOLS[fromCur] || fromCur;
    const toSym   = _CURRENCY_SYMBOLS[toCur]   || toCur;
    primaryEl.textContent = `1 ${fromSym} = ${toSym}${_fmtFXRate(rate)}`;
    if (inverseEl) {
        inverseEl.textContent = `1 ${toSym} = ${fromSym}${_fmtFXRate(1 / rate)}`;
        inverseEl.classList.remove('hidden');
    }
    if (rateBlock) rateBlock.classList.remove('hidden');
}

/**
 * Updates the result field, Live Rate block, and map capsule ticker from the
 * current converter state.  Pass null to reset the result to "—".
 */
function _updateConverterDisplay(amount) {
    const resultEl = document.getElementById('cdConverterResult');
    const validAmt = (amount != null && !isNaN(amount) && amount >= 0);
    if (resultEl) {
        if (!validAmt || _cdCurrentRate == null) {
            resultEl.textContent = '—';
        } else {
            resultEl.textContent = _fmtAmount(amount * _cdCurrentRate);
        }
    }
    if (_cdCurrentRate != null) {
        _updateLiveRateBlock(_cdFromCur, _cdToCur, _cdCurrentRate);
        // Pass the actual input amount so the capsule mirrors what the user typed
        _updateCurrencyCapsuleText(_cdFromCur, _cdToCur, _cdCurrentRate, validAmt ? amount : null);
    }
}

/**
 * Fetches a fresh rate for the current _cdFromCur → _cdToCur pair, then
 * re-renders the display.  Called after currency selection or swap.
 */
async function _refreshConverterRate() {
    if (!_cdFromCur || !_cdToCur) return;

    // Same currency on both sides → trivial 1:1
    if (_cdFromCur === _cdToCur) {
        _cdCurrentRate = 1;
        const inputEl = document.getElementById('cdConverterInput');
        const amt = parseFloat(inputEl?.value);
        _updateConverterDisplay(!isNaN(amt) && amt >= 0 ? amt : 1);
        return;
    }

    _cdCurrentRate = null;
    const inputEl  = document.getElementById('cdConverterInput');
    const resultEl = document.getElementById('cdConverterResult');
    if (resultEl) resultEl.textContent = '…';

    const rate = await _fetchFXRate(_cdFromCur, _cdToCur);
    _cdCurrentRate = rate;
    if (rate == null) {
        if (resultEl) resultEl.textContent = '—';
        return;
    }
    const currentInput = parseFloat(inputEl?.value);
    _updateConverterDisplay(isNaN(currentInput) || currentInput < 0 ? null : currentInput);
}

/**
 * Swaps the FROM and TO currencies, mirrors the result → input, refreshes the
 * rate, and persists the new direction so it survives drawer close / reopen.
 */
function swapCurrencyDirection() {
    if (!_cdFromCur || !_cdToCur) return;

    // Capture the current result to use as the new input after swap
    const resultEl   = document.getElementById('cdConverterResult');
    const inputEl    = document.getElementById('cdConverterInput');
    const prevResult = resultEl ? resultEl.textContent : '';

    // Swap codes and invert the cached rate so we don't need to re-fetch
    [_cdFromCur, _cdToCur] = [_cdToCur, _cdFromCur];
    if (_cdCurrentRate != null && _cdCurrentRate !== 0) {
        _cdCurrentRate = 1 / _cdCurrentRate;
    }

    // Persist the new FROM/TO directly so direction survives close/reopen
    try {
        localStorage.setItem(_CD_FROM_LS_KEY, _cdFromCur);
        localStorage.setItem(_CD_TO_LS_KEY,   _cdToCur);
    } catch (_) {}

    _updateConverterRowUI('from', _cdFromCur);
    _updateConverterRowUI('to',   _cdToCur);

    // Mirror result → input (only if it looks like a number)
    const numericResult = parseFloat((prevResult || '').replace(/,/g, ''));
    let newAmt;
    if (!isNaN(numericResult) && numericResult > 0) {
        newAmt = numericResult;
    } else if (_cdCurrentRate) {
        newAmt = 1 / _cdCurrentRate;
    } else {
        newAmt = 1;
    }
    if (inputEl) inputEl.value = _fmtAmount(newAmt);
    try { localStorage.setItem(_CD_AMOUNT_LS_KEY, String(newAmt)); } catch (_) {}
    _updateConverterDisplay(newAmt);
}

/**
 * Initialises the converter block.
 * Called by _populateCurrencyDrawerContent once the rate is known.
 * Restores the user's last entered amount from localStorage; if none,
 * pre-fills so that the result shows exactly 1 toCur (i.e. input = 1/rate).
 *
 * @param {string} fromCur – FROM currency code (e.g. "USD")
 * @param {string} toCur   – TO currency code   (e.g. "INR")
 * @param {number} rate    – fromCur→toCur rate
 */
function _initCurrencyConverter(fromCur, toCur, rate) {
    _cdFromCur    = fromCur;
    _cdToCur      = toCur;
    _cdCurrentRate = rate;

    // Persist FROM and TO so next open restores them
    try {
        localStorage.setItem(_CD_FROM_LS_KEY, fromCur);
        localStorage.setItem(_CD_TO_LS_KEY,   toCur);
    } catch (_) {}

    _updateConverterRowUI('from', _cdFromCur);
    _updateConverterRowUI('to',   _cdToCur);

    const block   = document.getElementById('cdConverterBlock');
    const inputEl = document.getElementById('cdConverterInput');
    if (block) block.classList.remove('hidden');

    // Restore the last amount the user typed; fall back to inverse-of-rate (shows 1 toCur)
    const persistedAmt = parseFloat(localStorage.getItem(_CD_AMOUNT_LS_KEY));
    let displayAmt;
    if (!isNaN(persistedAmt) && persistedAmt > 0) {
        displayAmt = persistedAmt;
    } else if (rate && rate !== 0 && rate !== 1) {
        displayAmt = 1 / rate; // "how many fromCur to get 1 toCur"
    } else {
        displayAmt = 1;
    }

    if (inputEl) inputEl.value = _fmtAmount(displayAmt);
    _updateConverterDisplay(displayAmt);
}

/**
 * Called on every keystroke in the converter input.
 * Persists the entered amount so it survives drawer close/reopen.
 */
function onCurrencyConverterInput() {
    const inputEl = document.getElementById('cdConverterInput');
    if (!inputEl) return;
    const amount = parseFloat(inputEl.value);
    const valid  = !isNaN(amount) && amount >= 0;
    if (valid) {
        try { localStorage.setItem(_CD_AMOUNT_LS_KEY, String(amount)); } catch (_) {}
    }
    _updateConverterDisplay(valid ? amount : null);
}

// ── Currency capsule visibility preference ────────────────────────────────────

/**
 * Sets the visual state of the "Don't show on map" toggle inside the currency drawer.
 * @param {boolean} active – true = toggle is ON (red; capsule will be hidden on close)
 */
function _setCurrencyHideToggle(active) {
    const toggle  = document.getElementById('cdHideCapsuleToggle');
    const infoMsg = document.getElementById('cdHideCapsuleInfo');
    if (!toggle) return;

    toggle.dataset.active = active ? 'true' : 'false';
    toggle.setAttribute('aria-pressed', String(active));

    if (active) {
        toggle.classList.add('cd-toggle-on');
    } else {
        toggle.classList.remove('cd-toggle-on');
    }

    if (infoMsg) {
        if (active) {
            infoMsg.classList.remove('hidden');
        } else {
            infoMsg.classList.add('hidden');
        }
    }
}

/**
 * Called by the toggle's onclick — flips the "don't show on map" state.
 */
function toggleCurrencyHidePreference() {
    const toggle = document.getElementById('cdHideCapsuleToggle');
    if (!toggle) return;
    const current = toggle.dataset.active === 'true';
    _setCurrencyHideToggle(!current);
}

/**
 * Reads compass_show_currency_capsule from localStorage and shows/hides the
 * map capsule accordingly. Called once at app startup.
 */
function _applyCurrencyCapsuleVisibility() {
    const capsule = document.getElementById('mapCurrencyWidget');
    if (!capsule) return;
    // Default is to show (pref is null on first run, or 'true')
    const pref = localStorage.getItem('compass_show_currency_capsule');
    capsule.style.display = (pref === 'false') ? 'none' : '';
}

/**
 * Syncs the Settings toggle visual state to match the current capsule preference.
 * @param {boolean} visible – true = capsule is showing (toggle ON / emerald)
 */
function _syncSettingsCurrencyToggle(visible) {
    const btn = document.getElementById('settingsCurrencyToggle');
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(visible));
    if (visible) {
        btn.classList.add('cd-toggle-settings-on');
    } else {
        btn.classList.remove('cd-toggle-settings-on');
    }
}

/**
 * Called by the Settings toggle onclick — flips capsule visibility, persists the
 * preference and keeps both toggles in sync.
 */
function settingsToggleCurrencyCapsule() {
    const current = localStorage.getItem('compass_show_currency_capsule') !== 'false';
    const next    = !current;
    localStorage.setItem('compass_show_currency_capsule', next ? 'true' : 'false');
    const capsule = document.getElementById('mapCurrencyWidget');
    if (capsule) capsule.style.display = next ? '' : 'none';
    _syncSettingsCurrencyToggle(next);
    // Keep the in-drawer "don't show" toggle consistent
    if (next) _setCurrencyHideToggle(false);
}

/**
 * Called at app startup — initialises the Settings toggle to reflect the stored preference.
 */
function initSettingsCurrencyToggle() {
    const visible = localStorage.getItem('compass_show_currency_capsule') !== 'false';
    _syncSettingsCurrencyToggle(visible);
}

// ── Weather capsule visibility preference ─────────────────────────────────────

/**
 * Sets the visual state of the "Don't show on map" toggle inside the weather drawer.
 * @param {boolean} active – true = toggle is ON (red; capsule will be hidden on close)
 */
function _setWeatherHideToggle(active) {
    const toggle  = document.getElementById('wdHideCapsuleToggle');
    const infoMsg = document.getElementById('wdHideCapsuleInfo');
    if (!toggle) return;

    toggle.dataset.active = active ? 'true' : 'false';
    toggle.setAttribute('aria-pressed', String(active));
    toggle.classList.toggle('cd-toggle-on', active);

    if (infoMsg) infoMsg.classList.toggle('hidden', !active);
}

/** Called by the toggle's onclick — flips the "don't show on map" state. */
function toggleWeatherHidePreference() {
    const toggle = document.getElementById('wdHideCapsuleToggle');
    if (!toggle) return;
    _setWeatherHideToggle(toggle.dataset.active !== 'true');
}

/**
 * Reads compass_show_weather_capsule from localStorage and shows/hides the
 * map capsule accordingly. Called once at app startup.
 */
function _applyWeatherCapsuleVisibility() {
    const capsule = document.getElementById('mapWeatherWidget');
    if (!capsule) return;
    const pref = localStorage.getItem('compass_show_weather_capsule');
    capsule.style.display = (pref === 'false') ? 'none' : '';
}

/**
 * Syncs the Settings toggle visual state to match the current capsule preference.
 * @param {boolean} visible – true = capsule is showing (toggle ON / emerald)
 */
function _syncSettingsWeatherToggle(visible) {
    const btn = document.getElementById('settingsWeatherToggle');
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(visible));
    btn.classList.toggle('cd-toggle-settings-on', visible);
}

/**
 * Called by the Settings toggle onclick — flips capsule visibility, persists the
 * preference and keeps both toggles in sync.
 */
function settingsToggleWeatherCapsule() {
    const current = localStorage.getItem('compass_show_weather_capsule') !== 'false';
    const next    = !current;
    localStorage.setItem('compass_show_weather_capsule', next ? 'true' : 'false');
    const capsule = document.getElementById('mapWeatherWidget');
    if (capsule) capsule.style.display = next ? '' : 'none';
    _syncSettingsWeatherToggle(next);
    // Keep the in-drawer "don't show" toggle consistent
    if (next) _setWeatherHideToggle(false);
}

/** Called at app startup — initialises the Settings toggle to reflect the stored preference. */
function initSettingsWeatherToggle() {
    const visible = localStorage.getItem('compass_show_weather_capsule') !== 'false';
    _syncSettingsWeatherToggle(visible);
}

// ── Time helpers ──────────────────────────────────────────────────────────────

// Golden Hour: sunset − 60 min → sunset − 5 min
function _calcGoldenHour(sunsetUnix) {
    return {
        start: _wdFormatTime(sunsetUnix - 60 * 60),
        end:   _wdFormatTime(sunsetUnix -  5 * 60),
    };
}

// Blue Hour: sunset → sunset + 30 min
function _calcBlueHour(sunsetUnix) {
    return {
        start: _wdFormatTime(sunsetUnix),
        end:   _wdFormatTime(sunsetUnix + 30 * 60),
    };
}

// Format a UNIX timestamp (seconds) to 12-hour h:MMam/pm using the device's local time zone.
function _wdFormatTime(unixSec) {
    const d    = new Date(unixSec * 1000);
    const h24  = d.getHours();
    const min  = d.getMinutes();
    const ampm = h24 < 12 ? 'AM' : 'PM';
    const h12  = h24 % 12 || 12;
    const mm   = String(min).padStart(2, '0');
    return `${h12}:${mm}${ampm}`;
}

// ── Label helpers ─────────────────────────────────────────────────────────────

/**
 * Converts a PM2.5 concentration (µg/m³) to the US EPA AQI (0–500 scale).
 * Uses the official EPA piecewise linear formula with the 2024 PM2.5 breakpoints.
 *
 * Other sites (IQAir, Weather.com, Apple Weather) all use this scale, so the
 * value here will match what the user expects to see.
 *
 * @param {number} pm25 – PM2.5 concentration in µg/m³ (from OWM components.pm2_5)
 * @returns {number} US AQI integer 0–500
 */
function _calcUsAqi(pm25) {
    if (pm25 == null || isNaN(pm25) || pm25 < 0) return 0;
    // EPA PM2.5 AQI breakpoints [cLow, cHigh, iLow, iHigh]
    const bp = [
        [0.0,   9.0,   0,  50],   // 2024 revised breakpoints
        [9.1,  35.4,  51, 100],
        [35.5,  55.4, 101, 150],
        [55.5, 125.4, 151, 200],
        [125.5, 225.4, 201, 300],
        [225.5, 325.4, 301, 400],
        [325.5, 500.4, 401, 500],
    ];
    // Truncate to 1 decimal as per EPA guidance
    const c = Math.floor(pm25 * 10) / 10;
    for (const [cL, cH, iL, iH] of bp) {
        if (c >= cL && c <= cH) {
            return Math.round(((iH - iL) / (cH - cL)) * (c - cL) + iL);
        }
    }
    return c > 500 ? 500 : 0;
}

/**
 * UV index label + SPF advice.
 * Pulse animation threshold set to 6 (High) — calibrated for Fitzpatrick IV–V
 * (Indian skin tones with higher melanin protection up to UV 5).
 */
function _getUvLabel(uvi) {
    const u = Math.round(uvi || 0);
    if (u <= 2)  return { label: 'Low',       color: '#4ade80', advice: 'Sunscreen optional'    };
    if (u <= 5)  return { label: 'Moderate',  color: '#facc15', advice: 'Use sunscreen'  };
    if (u <= 7)  return { label: 'High',      color: '#fb923c', advice: 'SPF 50+ advised'       };
    if (u <= 10) return { label: 'Very High', color: '#f87171', advice: 'Limit 10am–4pm'      };
    return              { label: 'Extreme',   color: '#e879f9', advice: 'Avoid midday sun'       };
}

/**
 * US EPA AQI label + colour (0–500 scale).
 * Mirrors the colour coding used by IQAir, Weather.com, and Apple Weather.
 */
function _getAqiLabel(aqi) {
    const v = Math.round(aqi || 0);
    if (v <= 50)  return { label: 'Good',                    color: '#4ade80' };
    if (v <= 100) return { label: 'Moderate',                color: '#facc15' };
    if (v <= 150) return { label: 'Unhealthy for sensitive groups',   color: '#fb923c' };
    if (v <= 200) return { label: 'Unhealthy',               color: '#f87171' };
    if (v <= 300) return { label: 'Very Unhealthy',          color: '#e879f9' };
    return              { label: 'Hazardous',                color: '#dc2626' };
}

function _wdCapitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// ── END WEATHER DRAWER ────────────────────────────────────────────────────────

function openHiddenPinsDrawer() {
    const overlay = document.getElementById('hiddenPinsDrawerOverlay');
    const panel   = document.getElementById('hiddenPinsDrawerPanel');
    if (!overlay || !panel) return;

    // Stop the bubble's attention wiggle while the drawer is open
    stopHiddenPinsBubbleAttentionLoop();

    renderHiddenPinsDrawerContent();

    overlay.classList.remove('hidden');
    panel.classList.remove('hidden-pins-drawer-enter', 'hidden-pins-drawer-exit');
    void panel.offsetWidth;
    panel.classList.add('hidden-pins-drawer-enter');
}

function renderHiddenPinsDrawerContent() {
    const body       = document.getElementById('hiddenPinsDrawerBody');
    const countLabel = document.getElementById('hiddenPinsDrawerCount');
    if (!body) return;

    // Collect ALL spots hidden by the type filter (not just nearby ones —
    // the drawer gives the user the full picture)
    const hiddenSpots = travelSpots.filter(spot => {
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(spot.city)) return false;
        if (!checkedFilterStateArray.length) return false;
        const spotCats = spot.category
            ? spot.category.split(',').map(c => c.trim().toLowerCase())
            : [];
        return !checkedFilterStateArray.some(f => spotCats.includes(f.toLowerCase()));
    });

    if (countLabel) {
        const n = hiddenSpots.length;
        countLabel.textContent = n === 0 ? 'All Spots Are Visible' : `${n} spot${n !== 1 ? 's' : ''} hidden by type filter`;
    }

    body.innerHTML = '';

    if (hiddenSpots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'flex flex-col items-center justify-center py-12 gap-3';
        empty.innerHTML = `
            <div class="w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                <i class="fa-solid fa-eye text-emerald-400 text-base"></i>
            </div>
            <p class="text-[11px] text-slate-400 font-bold">All spots are now visible!</p>`;
        body.appendChild(empty);
        return;
    }

    const isStarredFn = s => ['high', '🔥', 'must do', 'starred'].includes((s.priority || "").toLowerCase());
    const starred   = hiddenSpots.filter(isStarredFn);
    const unstarred = hiddenSpots.filter(s => !isStarredFn(s));

    if (starred.length > 0) {
        body.appendChild(buildDrawerSection(
            'Starred', 'fa-star text-amber-400', starred
        ));
    }
    if (unstarred.length > 0) {
        body.appendChild(buildDrawerSection(
            'Unstarred', 'fa-location-dot text-slate-500', unstarred
        ));
    }
}

function buildDrawerSection(title, titleIconClass, spots) {
    const section = document.createElement('div');
    section.className = 'space-y-2';

    // Section label
    const labelRow = document.createElement('div');
    labelRow.className = 'flex items-center gap-1.5 px-1 mb-1.5';
    labelRow.innerHTML = `
        <i class="fa-solid ${titleIconClass} text-[9px]"></i>
        <span class="text-[9px] font-black uppercase tracking-widest text-slate-500">${title}</span>
        <span class="text-[9px] font-mono text-slate-600">(${spots.length})</span>`;
    section.appendChild(labelRow);

    spots.forEach(spot => {
        section.appendChild(buildDrawerRow(spot));
    });

    return section;
}

function buildDrawerRow(spot) {
    // Use only the first category token so the unhide button targets exactly
    // one category, avoiding ambiguity on multi-category spots.
    const rawCat    = (spot.category || 'General').split(',')[0].trim();
    const iconClass = getCategoryIconClassForDrawer(rawCat);
    const isStarred = ['high', '🔥', 'must do', 'starred'].includes((spot.priority || "").toLowerCase());

    const row = document.createElement('div');
    row.className = `flex items-center gap-2.5 rounded-xl px-3 py-2.5 border ${isStarred ? 'bg-amber-500/5 border-amber-500/15' : 'bg-slate-950/50 border-slate-800/60'}`;

    // ── Category icon ────────────────────────────────────────────────────────
    const iconWrap = document.createElement('div');
    iconWrap.className = 'w-8 h-8 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0';
    iconWrap.innerHTML = `<i class="fa-solid ${iconClass} text-[13px]"></i>`;

    // ── Name + category label ────────────────────────────────────────────────
    const textWrap = document.createElement('div');
    textWrap.className = 'flex-1 min-w-0';

    const nameEl = document.createElement('p');
    nameEl.className = 'text-[11px] font-bold text-slate-200 truncate';
    nameEl.textContent = spot.spot_name || 'Unnamed';   // textContent is injection-safe

    const catEl = document.createElement('p');
    catEl.className = 'text-[9px] text-slate-500 truncate mt-0.5';
    catEl.textContent = rawCat;

    textWrap.appendChild(nameEl);
    textWrap.appendChild(catEl);

    // ── Action buttons ───────────────────────────────────────────────────────
    const btnWrap = document.createElement('div');
    btnWrap.className = 'flex items-center gap-1.5 shrink-0';

    // Reference link button
    const linkBtn = document.createElement('a');
    linkBtn.href      = spot.instagram_url || '#';
    linkBtn.target    = '_blank';
    linkBtn.className = 'w-7 h-7 bg-slate-800 border border-slate-700 rounded-lg flex items-center justify-center text-slate-400 active:bg-slate-700 text-[11px]';
    linkBtn.innerHTML = '<i class="fa-solid fa-link"></i>';

    // Unhide button — closure captures rawCat directly; no inline string injection
    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'w-7 h-7 bg-pink-500/10 border border-pink-500/20 rounded-lg flex items-center justify-center text-pink-400 active:bg-pink-500/20 text-[11px]';
    unhideBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
    unhideBtn.title     = `Unhide "${rawCat}"`;
    unhideBtn.addEventListener('click', function() {
        unhideSpecificSpotCategory(rawCat);
    });

    btnWrap.appendChild(linkBtn);
    btnWrap.appendChild(unhideBtn);

    row.appendChild(iconWrap);
    row.appendChild(textWrap);
    row.appendChild(btnWrap);

    return row;
}

function closeHiddenPinsDrawer() {
    const overlay = document.getElementById('hiddenPinsDrawerOverlay');
    const panel   = document.getElementById('hiddenPinsDrawerPanel');
    if (!overlay || overlay.classList.contains('hidden')) return;

    panel.classList.remove('hidden-pins-drawer-enter');
    panel.classList.add('hidden-pins-drawer-exit');

    setTimeout(() => {
        overlay.classList.add('hidden');
        panel.classList.remove('hidden-pins-drawer-exit');
        // Restart bubble attention loop if the bubble is still on screen
        if (hiddenPinsMiniBubbleVisible) startHiddenPinsBubbleAttentionLoop();
    }, 240);
}

function unhideSpecificSpotCategory(categoryRaw) {
    const catLower = (categoryRaw || '').toLowerCase().trim();

    // Find canonical casing from the live travelSpots data
    const allCats = new Set();
    travelSpots.forEach(s => {
        if (s.category) s.category.split(',').forEach(c => allCats.add(c.trim()));
    });

    let canonical = categoryRaw; // fallback to whatever was passed
    allCats.forEach(c => {
        if (c.toLowerCase() === catLower) canonical = c;
    });

    // Add to the type filter if not already present
    if (!checkedFilterStateArray.map(c => c.toLowerCase()).includes(catLower)) {
        checkedFilterStateArray.push(canonical);
        localStorage.setItem('compass_active_filters', JSON.stringify(checkedFilterStateArray));

        // Keep the checkbox UI in sync with the filter state
        const checkboxes = document.getElementById('checkboxScrollRegionContainer')
            ? document.getElementById('checkboxScrollRegionContainer').querySelectorAll('input[type="checkbox"]')
            : [];
        checkboxes.forEach(cb => {
            if (cb.value.toLowerCase() === catLower) cb.checked = true;
        });

        updateHeaderBadgeHUDCounters();
        renderList();
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
    }

    // Refresh the drawer content to reflect the newly visible spot
    renderHiddenPinsDrawerContent();

    // If no more hidden spots exist, auto-close the drawer and clear the HUD
    if (!hiddenPinsDrawerHasRemainingSpots()) {
        closeHiddenPinsDrawer();
        setTimeout(() => clearHiddenPinsSystemHUD(), 260);
    }
}

function unhideAllAndCloseDrawer() {
    closeHiddenPinsDrawer();
    // Wait for the slide-out to finish before blowing away the filter state
    setTimeout(() => {
        clearAllFilterCheckboxes();
        clearHiddenPinsSystemHUD();
    }, 260);
}

// Returns true when at least one spot is still hidden by the type filter
function hiddenPinsDrawerHasRemainingSpots() {
    if (!checkedFilterStateArray.length) return false;
    return travelSpots.some(spot => {
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(spot.city)) return false;
        const spotCats = spot.category
            ? spot.category.split(',').map(c => c.trim().toLowerCase())
            : [];
        return !checkedFilterStateArray.some(f => spotCats.includes(f.toLowerCase()));
    });
}

// ── End Hidden Pins Drawer ────────────────────────────────────────────────────

// ── End Hidden Pins Alert Banner ─────────────────────────────────────────────

function getFilteredDatasetRows() {
    // ── Itinerary filter guard ────────────────────────────────────────────────
    // If the referenced itinerary was deleted since the filter was saved, clear
    // silently so the app doesn't get stuck in an empty-list state.
    if (activeItineraryFilter) {
        const _itins = (typeof savedItineraries !== 'undefined') ? savedItineraries : [];
        const _refItin = _itins.find(i => i.id === activeItineraryFilter.itineraryId);
        if (!_refItin) {
            activeItineraryFilter = null;
            localStorage.removeItem('compass_itinerary_filter');
            // Also clear the city filter that was paired with this itinerary.
            // State-only update here (no DOM) because we're inside a render cycle.
            checkedCitiesStateArray = [];
            localStorage.setItem('compass_active_cities', JSON.stringify([]));
        }
    }
    // Pre-compute the rowid set for the selected day so the filter below is O(1).
    let _itinDayRowIds = null;
    if (activeItineraryFilter) {
        const _itins = (typeof savedItineraries !== 'undefined') ? savedItineraries : [];
        const _itin  = _itins.find(i => i.id === activeItineraryFilter.itineraryId);
        const _day   = _itin?.days[activeItineraryFilter.dayIndex];
        _itinDayRowIds = new Set((_day?.timeline || []).map(s => String(s.rowid)));
    }

    return travelSpots.map(spot => {
        const latStr = spot.latitude ? String(spot.latitude).trim() : "";
        const lngStr = spot.longitude ? String(spot.longitude).trim() : "";
        const hasLatLon = latStr !== "" && latStr !== "0" && lngStr !== "" && lngStr !== "0";
        
        // Keep fallback strings short — the badge has a max-width and long text overflows.
        let distanceOutputLabel = !hasLatLon ? "<i class='fa-solid fa-triangle-exclamation'></i>" : (!gpsStatusCachedBool ? "<i class='fa-solid fa-location-dot'></i>" : "");
        let rawDistanceValue = 99999;
        let stableDistanceZoneBucket = 4; 

        if (hasLatLon && gpsStatusCachedBool) {
            const dist = calculateDistance(userLat, userLon, parseFloat(spot.latitude), parseFloat(spot.longitude));
            rawDistanceValue = dist; 
            distanceOutputLabel = dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`;
            
            if (dist <= 0.5) stableDistanceZoneBucket = 1;       
            else if (dist <= 2.0) stableDistanceZoneBucket = 2;  
            else if (dist <= 10.0) stableDistanceZoneBucket = 3; 
            else stableDistanceZoneBucket = 4;                  
        }

        return { 
            ...spot, 
            distRaw: rawDistanceValue, 
            distStr: distanceOutputLabel,
            distZone: stableDistanceZoneBucket 
        };
    }).filter(s => {
        if (hideCompletedSpotsStateBool && (s.status || "").toLowerCase().trim() === "done") return false;
        if (showStarredOnly && !['high','🔥','must do','starred'].includes((s.priority || "").toLowerCase())) return false;
        // Itinerary day filter takes priority over city/category filters — it is a
        // direct rowId whitelist so city-string mismatches must not block spots.
        // The done + starred guards above still apply.
        if (_itinDayRowIds !== null) return _itinDayRowIds.has(String(s.rowid));
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(s.city)) return false;
        if (checkedFilterStateArray.length > 0) {
            if (!s.category) return false;
            const spotCats = s.category.split(',').map(item => item.trim().toLowerCase());
            if (!checkedFilterStateArray.some(checkedCat => spotCats.includes(checkedCat.toLowerCase()))) return false;
        }
        // Custom Smart Search filter — AND-gated with city + category above.
        // getActiveCustomFilterRowIds() returns a Set<string> or null.
        if (typeof getActiveCustomFilterRowIds === 'function') {
            const _cfRowIds = getActiveCustomFilterRowIds();
            if (_cfRowIds !== null && !_cfRowIds.has(String(s.rowid))) return false;
        }
        return true;
    }).sort((a, b) => {
        const aDone = (a.status || "").toLowerCase().trim() === "done" ? 1 : 0;
        const bDone = (b.status || "").toLowerCase().trim() === "done" ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;

        const aStarred = ['high','🔥','must do','starred'].includes((a.priority || "").toLowerCase()) ? 1 : 0;
        const bStarred = ['high','🔥','must do','starred'].includes((b.priority || "").toLowerCase()) ? 1 : 0;
        if (aStarred !== bStarred) return bStarred - aStarred; 

        if (a.distZone !== b.distZone) return a.distZone - b.distZone;

        // Within the same zone sort by exact distance (nearest first).
        // Spots without coordinates all land at distRaw=99999 so they cluster
        // together at the bottom of their group; rowId is the tiebreaker there.
        if (a.distRaw !== b.distRaw) return a.distRaw - b.distRaw;

        const aRowId = parseInt(a.rowid) || 0;
        const bRowId = parseInt(b.rowid) || 0;
        return aRowId - bRowId;
    });
}

function updateLiveDistancesUI() {
    if (activeTabID !== 'list') return; 
    const processed = getFilteredDatasetRows();
    
    processed.forEach(spot => {
        const distHUD = document.getElementById(`dist-badge-${spot.rowid}`);
        if (distHUD) {
            distHUD.innerHTML = spot.distStr;
            const latVal = spot.latitude ? String(spot.latitude).trim() : "";
            const hasCoordinates = latVal !== "" && latVal !== "0";
            const _baseDistClass = "text-xs font-mono font-bold px-2 py-1 rounded-lg h-fit max-w-[5rem] truncate whitespace-nowrap";
            if (!hasCoordinates) {
                distHUD.className = `${_baseDistClass} bg-amber-500/10 text-amber-400 border border-amber-500/20`;
            } else {
                distHUD.className = `${_baseDistClass} bg-pink-500/10 text-pink-400`;
            }
        }
    });
}

function handleManualInlineCardFlipExecution(event, nodeWrapperId, operationDirection) {
    if(event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const targetElement = document.getElementById(nodeWrapperId);
    if(!targetElement) return;

    if(operationDirection === 'forward') {
        targetElement.classList.add('flipped');
    } else {
        targetElement.classList.remove('flipped');
    }
}

function handleAdaptiveDirectionClick(buttonElement, event) {
    if (event) event.stopPropagation();
    const rowId = buttonElement.getAttribute('data-row-id');
    const targetSpot = travelSpots.find(s => String(s.rowid) === String(rowId));
    if (!targetSpot) return;

    const mapsUrl = targetSpot.maps_url ? String(targetSpot.maps_url).trim() : "";
    const lat = targetSpot.latitude ? String(targetSpot.latitude).trim() : "";
    const lng = targetSpot.longitude ? String(targetSpot.longitude).trim() : "";
    
    if (mapsUrl !== "" && mapsUrl !== "N/A") {
        window.open(mapsUrl, '_blank');
    } else if (lat !== "" && lat !== "0" && lng !== "" && lng !== "0") {
        window.open(`https://maps.google.com/?q=${lat},${lng}`, '_blank');
    } else {
        triggerCuteSpeechBubbleHUD("No map data", buttonElement, event);
    }
}

/**
 * Animated wrapper around renderList() — uses the FLIP technique so existing
 * cards glide to their new sorted positions instead of teleporting.
 *
 * Two special cases are handled:
 *  a) "Mark Done" with hideCompletedSpotsStateBool = true → card slides out
 *     and collapses before the list is rebuilt (card disappears from view).
 *  b) All other reorders → snapshot old positions, rebuild, then FLIP-animate
 *     each card from its snapshot position to its new position.
 *
 * A contextual flash animation runs on the card that triggered the action:
 *   • Mark Done  → slate ripple (card-flash-done)
 *   • Undo Done  → pink ripple  (card-flash-undo)
 *   • Star       → amber glow   (card-flash-star)
 *   • Unstar     → no flash (motion alone is sufficient feedback)
 *
 * @param {number|string} triggeredRowId  rowid of the spot that changed
 * @param {string}        action          'update_status' | 'toggle_priority'
 * @param {string}        value           new value passed to updateCloudAction
 */
function renderListAnimated(triggeredRowId, action, value) {
    const strId = String(triggeredRowId);

    // ── Case A: done card disappears (hide-completed mode) ───────────────────
    // Animate the card out first, THEN rebuild — avoids a jarring instant vanish.
    if (action === 'update_status' && value === 'Done' && hideCompletedSpotsStateBool) {
        const cardEl = document.querySelector(`.dynamic-card-node[data-rowid="${strId}"]`);
        if (cardEl) {
            const cardH = cardEl.offsetHeight;
            // Phase 1: slide right + fade out
            cardEl.style.transition = 'transform 0.26s ease-in, opacity 0.22s ease-in';
            cardEl.style.transform  = 'translateX(48px)';
            cardEl.style.opacity    = '0';
            cardEl.style.overflow   = 'hidden';
            // Phase 2: collapse height so the gap closes smoothly
            setTimeout(() => {
                cardEl.style.transition += ', max-height 0.22s ease-in, margin-bottom 0.22s ease-in, padding 0.22s ease-in';
                cardEl.style.maxHeight    = cardH + 'px';
                void cardEl.offsetHeight; // flush
                cardEl.style.maxHeight    = '0px';
                cardEl.style.marginBottom = '0px';
            }, 200);
            // Phase 3: rebuild after animation completes
            setTimeout(() => renderList(), 440);
            return;
        }
    }

    // ── Inner helper: FLIP snapshot → rebuild → slide animation ──────────────
    // skipFlash=true when the burst was already played in-place (star action)
    // so it doesn't fire a second time once the card arrives at its new position.
    function _doFlipReorder(skipFlash) {
        // 1. Snapshot every card's current Y position, keyed by rowid
        const snapBefore = new Map();
        document.querySelectorAll('.dynamic-card-node[data-rowid]').forEach(el => {
            snapBefore.set(el.dataset.rowid, el.getBoundingClientRect().top);
        });

        // 2. Rebuild the list DOM (synchronous)
        renderList();

        // 3. Animate — two rAF frames: first sets displaced initial state (no paint),
        //    second applies the transition so the browser animates from there to 0.
        requestAnimationFrame(() => {
            const allCards = [...document.querySelectorAll('.dynamic-card-node[data-rowid]')];

            // Batch reads first (avoid layout thrashing)
            const entries = allCards.map(el => ({
                el,
                rowid:  el.dataset.rowid,
                newTop: el.getBoundingClientRect().top,
            }));

            // Batch writes — set each card at its old visual position instantly
            entries.forEach(({ el, rowid, newTop }) => {
                const oldTop = snapBefore.get(rowid);
                if (oldTop !== undefined) {
                    const deltaY = oldTop - newTop;
                    if (Math.abs(deltaY) > 1) {
                        el.style.transition = 'none';
                        el.style.transform  = `translateY(${deltaY}px)`;
                        el.dataset.animMove = '1';
                    }
                } else {
                    // Card is newly visible (e.g. undo on a hidden done card)
                    el.style.opacity    = '0';
                    el.dataset.animFade = '1';
                }
            });

            // Force a synchronous layout pass so the browser registers the displaced
            // transforms before we apply the transition in the next frame
            void allCards[0]?.offsetHeight;

            requestAnimationFrame(() => {
                const EASE = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';

                entries.forEach(({ el }) => {
                    if (el.dataset.animMove) {
                        el.style.transition = `transform 0.42s ${EASE}`;
                        el.style.transform  = 'translateY(0)';
                        delete el.dataset.animMove;
                    } else if (el.dataset.animFade) {
                        el.style.transition = 'opacity 0.32s ease';
                        el.style.opacity    = '1';
                        delete el.dataset.animFade;
                    }
                });

                if (!skipFlash) {
                    // Contextual flash on the card that triggered the action
                    const tEl = document.querySelector(`.dynamic-card-node[data-rowid="${strId}"]`);
                    if (tEl) {
                        let flashClass = null;
                        if (action === 'update_status') {
                            flashClass = value === 'Done' ? 'card-flash-done' : 'card-flash-undo';
                        } else if (action === 'toggle_priority' && value === 'Starred') {
                            flashClass = 'card-flash-star';
                        }
                        if (flashClass) {
                            tEl.classList.add(flashClass);
                            // animationend fires on the child that holds the keyframe
                            const frontFace = tEl.querySelector('.flip-card-front-face');
                            (frontFace || tEl).addEventListener(
                                'animationend',
                                () => tEl.classList.remove(flashClass),
                                { once: true }
                            );
                        }
                    }
                }
            });
        });
    }

    // ── Case B-star: flash in-place first, THEN reorder ──────────────────────
    // Without this, the card jumps to the top and the amber burst fires there,
    // making the glow imperceptible at the position the user tapped.
    // Sequence: burst at current position → animationend → FLIP slide to top.
    if (action === 'toggle_priority' && value === 'Starred') {
        const cardEl = document.querySelector(`.dynamic-card-node[data-rowid="${strId}"]`);
        if (cardEl) {
            // ── Instant visual update ─────────────────────────────────────────
            // The list won't be rebuilt until animationend (~0.52 s later).
            // Without this, the "Star" button stays frozen during the whole flash,
            // making the tap feel sluggish.  We update the label and onclick NOW
            // so the user sees "Unstar" the moment they tap.
            const _starBtn = [...cardEl.querySelectorAll('button')].find(
                b => b.textContent.includes('Star')
            );
            if (_starBtn) {
                _starBtn.innerHTML = '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar';
                // Update onclick so a second tap correctly unstarrs
                _starBtn.setAttribute('onclick',
                    `updateCloudAction(${strId}, 'toggle_priority', 'Normal')`);
            }
            // Add starred-gold-glow to card faces immediately
            cardEl.querySelectorAll('.flip-card-front-face, .flip-card-back-face')
                  .forEach(f => f.classList.add('starred-gold-glow'));

            cardEl.classList.add('card-flash-star');
            const frontFace = cardEl.querySelector('.flip-card-front-face');
            (frontFace || cardEl).addEventListener('animationend', () => {
                cardEl.classList.remove('card-flash-star');
                _doFlipReorder(true); // skipFlash — burst already played in-place
            }, { once: true });
            return; // reorder deferred until after the flash
        }
        // Card not found in DOM — fall through to normal reorder below
    }

    // ── Case B: FLIP reorder for all other actions ────────────────────────────
    _doFlipReorder(false);
}

function renderList() {
    const scrollContainerFrame = document.getElementById('gesture-touch-container');
    const counterHUD = document.getElementById('vaultDensityHUDLabelCounter');
    if(!scrollContainerFrame) return;

    const dynamicOldCards = scrollContainerFrame.querySelectorAll('.dynamic-card-node, .dynamic-tailpiece-node, .dynamic-empty-node, .dynamic-spacer-node');
    dynamicOldCards.forEach(el => el.remove());

    const processed = getFilteredDatasetRows();
    if (counterHUD) counterHUD.innerText = `Showing ${processed.length} / ${travelSpots.length} Spots`;
    
    if (processed.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = "dynamic-empty-node w-full block shrink-0";
        if (showStarredOnly) {
            // Starred filter active but no starred spots — match the itinerary master empty state
            emptyDiv.innerHTML = `
                <div class="flex flex-col items-center justify-center py-16 text-center px-6">
                    <i class="fa-regular fa-star text-3xl text-slate-700 mb-4"></i>
                    <p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">No Starred Spots</p>
                    <p class="text-[11px] text-slate-600 font-medium">Star a spot to save it here</p>
                    <button onclick="setPriorityFilterState(false)"
                            class="mt-5 px-5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-[10px] font-black text-slate-400 active:bg-slate-800 transition-colors">
                        Show All
                    </button>
                </div>`;
        } else {
            // Generic empty state (city filter, search, etc.)
            emptyDiv.innerHTML = `
                <div class="text-center text-slate-600 py-12 text-xs">
                    No results found
                </div>`;
        }
        scrollContainerFrame.appendChild(emptyDiv);
        return;
    }

    processed.forEach((spot, idx) => {
        const isDone = (spot.status || "").toLowerCase().trim() === "done";
        const isHigh = ['high','🔥','must do','starred'].includes((spot.priority || "").toLowerCase());
        const ticketLink = spot.ticket_url || "";
        
        const directMapsUrl = spot.maps_url ? String(spot.maps_url).trim() : "";
        const latVal = spot.latitude ? String(spot.latitude).trim() : "";
        const lngVal = spot.longitude ? String(spot.longitude).trim() : "";
        const hasCoordinates = latVal !== "" && latVal !== "0" && lngVal !== "" && lngVal !== "0";
        const hasValidMapDestination = (directMapsUrl !== "" && directMapsUrl !== "N/A") || hasCoordinates;

        const uniqueCardContainerId = `list-flip-wrapper-node-${idx}`;

        let hoursHTMLTokens = '';
        if(spot.opening_hours && spot.opening_hours !== "N/A" && spot.opening_hours.trim() !== "") {
            spot.opening_hours.split(/[\n;]+/).forEach(t => {
                if(t.trim()) hoursHTMLTokens += `<div class="flex justify-between border-b border-slate-950 last:border-0 py-0.5"><span>${t.trim()}</span></div>`;
            });
        } else {
            hoursHTMLTokens = `<div class="text-slate-600 italic text-[10px]">No schedule</div>`;
        }

        const cardWrapper = document.createElement('div');
        cardWrapper.id = uniqueCardContainerId;
        cardWrapper.dataset.rowid = String(spot.rowid); // used by renderListAnimated FLIP engine
        cardWrapper.className = "dynamic-card-node w-full min-h-[260px] h-auto flip-perspective-container transform transition-transform duration-200 shrink-0 block overflow-hidden";

        // Category icon class for the badge (icon · category · city)
        const catIconClass = getCategoryIconClass(spot.category);

        // Weather badge — disabled placeholder when coordinates are missing;
        // refreshAllWeatherBadges() will fill in real data after render.
        // No-coords: visible grey box, same min-width as the live weather badge
        // so both states stay horizontally consistent regardless of content.
        const weatherBadgeClass = !hasCoordinates
            ? 'bg-slate-700/40 text-slate-500'
            : 'bg-sky-500/10 text-sky-300';
        const weatherBadgeInitHTML = !hasCoordinates
            ? `<i class="fa-solid fa-cloud text-[10px]" style="opacity:0.35"></i><i class="fa-solid fa-slash text-[7px]" style="margin-left:-0.55em;opacity:0.35"></i>`
            : `<i class="fa-solid fa-cloud text-[10px] opacity-40"></i>`;

        cardWrapper.innerHTML = `
            <div class="flip-card-inner-rotator w-full h-full">

                <div class="flip-card-front-face w-full h-full p-4 rounded-2xl border flex flex-col justify-between ${isDone ? 'itin-done-card' : 'bg-slate-900 ' + (isHigh ? 'starred-gold-glow' : 'border-slate-800')}">
                    <div>
                        <div class="flex justify-between items-start gap-2 overflow-hidden">
                            <div class="min-w-0 flex-1">
                                <span class="inline-flex items-center gap-1.5 text-[9px] px-2 py-1 rounded-lg bg-slate-950 text-slate-400 font-bold border border-slate-800 max-w-full overflow-hidden ${isDone ? 'opacity-40' : ''}"><i class="fa-solid ${catIconClass} text-[8px] shrink-0"></i><span class="uppercase tracking-wider truncate">${spot.category || 'General'}</span><span class="text-slate-700 font-normal shrink-0">•</span><span class="uppercase tracking-wider text-slate-500 truncate">${spot.city || 'Global'}</span></span>
                                <h3 class="text-base font-bold ${isDone ? 'text-slate-500 line-through' : 'text-slate-200'} mt-1.5 truncate">${spot.spot_name}</h3>
                            </div>
                            <div class="flex items-stretch gap-1.5 shrink-0 max-w-[44%] overflow-hidden">
                                <span id="weather-badge-${spot.rowid}" class="inline-flex items-center justify-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-lg min-w-[3.25rem] shrink-0 ${weatherBadgeClass} ${isDone ? 'opacity-30' : ''}">${weatherBadgeInitHTML}</span>
                                <span id="dist-badge-${spot.rowid}" class="text-xs font-mono font-bold px-2 py-1 rounded-lg h-fit max-w-[5rem] truncate whitespace-nowrap ${isDone ? 'bg-slate-800/20 text-slate-600 opacity-40' : (!hasCoordinates ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-pink-500/10 text-pink-400')}">${spot.distStr}</span>
                            </div>
                        </div>
                        <div class="mt-3 bg-slate-950/40 p-2.5 rounded-xl border border-slate-900/60 min-h-[90px] overflow-hidden">
                            <p class="text-xs ${isDone ? 'text-slate-500 line-through' : 'text-slate-400'} leading-relaxed max-h-16 overflow-hidden pr-1" style="touch-action: pan-y;" ontouchstart="handleNoteTouchStartEvent(event, this.innerText)" ontouchmove="handleNoteTouchMoveEvent(event)" ontouchend="handleNoteTouchEndEvent(event)" onmousedown="handleNoteMouseDownEvent(event, this.innerText)" onmousemove="handleNoteMouseMoveEvent(event)" onmouseup="handleNoteMouseUpEvent(event)">${spot.notes || 'No custom notes'}</p>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2 mt-3">
                        <div class="flex gap-2">
                            <a href="${spot.instagram_url || '#'}" target="_blank" class="flex-1 text-center text-xs font-bold py-3 rounded-xl flex items-center justify-center ${isDone ? 'bg-slate-800/40 border border-slate-700/30 text-slate-600 opacity-40 pointer-events-none' : 'bg-gradient-to-r from-pink-600 to-purple-600 text-white shadow-lg'}">Open Reference</a>
                            <button data-row-id="${spot.rowid}" onclick="handleAdaptiveDirectionClick(this, event)" class="px-4 flex items-center justify-center rounded-xl text-xs font-bold whitespace-nowrap h-12 ${isDone ? 'bg-slate-800/30 border border-slate-700/20 text-slate-600 flex-1 opacity-40 pointer-events-none' : (!hasValidMapDestination ? 'bg-slate-950 border border-slate-800 text-amber-400 text-sm font-black w-14 shrink-0' : 'bg-slate-950 border border-slate-800 text-slate-300 flex-1')}">
                                ${isDone ? '<i class="fa-solid fa-map mr-1.5 text-sm"></i> Directions' : (!hasValidMapDestination ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-map mr-1.5 text-sm"></i> Directions')}
                            </button>
                        </div>
                        ${ticketLink.trim() !== "" && !isDone ? `<a href="${ticketLink}" target="_blank" class="w-full mt-1 bg-emerald-600 text-center text-xs font-bold py-2.5 rounded-xl text-white block">View Ticket Details</a>` : ''}
                        <div class="flex gap-2 mt-1 justify-end items-center">
                            <button onclick="handleManualInlineCardFlipExecution(event, '${uniqueCardContainerId}', 'forward')" class="px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto ${isDone ? 'text-slate-600 bg-slate-950/50 border border-slate-800/30 opacity-40 pointer-events-none' : 'text-sky-400 bg-sky-500/10 border border-sky-500/20 active:bg-sky-500/20'}">
                                <i class="fa-solid fa-circle-info mr-1"></i> Extra Info
                            </button>
                            <button onclick="updateCloudAction(${spot.rowid}, 'update_status', '${isDone ? 'Pending' : 'Done'}')" class="text-xs px-3 py-1.5 font-bold rounded-lg ${isDone ? 'bg-pink-600/10 border border-pink-600/20 text-pink-400 active:bg-pink-600/20' : 'bg-slate-950 border border-slate-800 text-slate-400 active:bg-slate-855'}">${isDone ? '<i class="fa-solid fa-arrow-rotate-left mr-1"></i> Undo' : '<i class="fa-solid fa-check mr-1"></i> Mark Done'}</button>
                            <button onclick="updateCloudAction(${spot.rowid}, 'toggle_priority', '${isHigh ? 'Normal' : 'Starred'}')" class="text-xs px-2 py-1.5 rounded-lg ${isDone ? 'bg-slate-950/50 border border-slate-800/30 text-slate-600 opacity-40 pointer-events-none' : 'bg-slate-950 border border-slate-800 text-amber-400'}">${isHigh ? '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar' : '<i class="fa-solid fa-star mr-1"></i> Star'}</button>
                        </div>
                    </div>
                </div>
                <div class="flip-card-back-face w-full h-full p-4 rounded-2xl border bg-slate-900 ${isHigh ? 'starred-gold-glow' : 'border-slate-800'} flex flex-col justify-between overflow-hidden">
                    <div class="flex border-b border-slate-800/60 pb-1.5 shrink-0 items-center justify-between">
                        <span class="text-[10px] font-black uppercase text-slate-400 tracking-wider">Extra Info</span>
                        <span class="text-[8px] text-slate-600 font-mono">ID: #${spot.rowid}</span>
                    </div>
                    <div class="flex-1 overflow-y-auto subtle-scrollbar my-2 pr-0.5 space-y-3 text-[11px]">
                        <p class="text-slate-300 leading-relaxed font-medium bg-slate-950/50 border border-slate-950 p-2.5 rounded-xl">${(spot.long_description && spot.long_description !== "N/A") ? spot.long_description : 'No background summary recorded'}</p>
                        
                        <div>
                            <span class="text-[8px] font-black uppercase tracking-widest text-slate-500 block mb-0.5">Schedule</span>
                            <div class="bg-slate-950/50 border border-slate-950 p-2.5 rounded-xl font-mono text-[10px] text-slate-400 space-y-0.5">${hoursHTMLTokens}</div>
                        </div>
                        ${(spot.booking_requirement && spot.booking_requirement !== "N/A" && spot.booking_requirement.toLowerCase() !== "none") ? `
                        <div class="p-2.5 bg-amber-500/5 border border-amber-500/20 rounded-xl">
                            <span class="text-[8px] font-black uppercase tracking-widest text-amber-400 block">Alert</span>
                            <span class="text-slate-300 leading-relaxed block mt-0.5">${spot.booking_requirement}</span>
                        </div>` : ''}
                    </div>
                    <div class="flex gap-2 justify-end pt-2 border-t border-slate-950 shrink-0 items-center">
                        <button onclick="handleManualInlineCardFlipExecution(event, '${uniqueCardContainerId}', 'backward')" class="text-slate-400 bg-slate-950 border border-slate-800/80 px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto active:bg-sky-500/20">
                            <i class="fa-solid fa-arrow-left mr-1"></i> Back
                        </button>
                    </div>
                </div>
            </div>
        `;
        scrollContainerFrame.appendChild(cardWrapper);
    });

    const tailEndLabelDeckNode = document.createElement('div');
    tailEndLabelDeckNode.className = "dynamic-tailpiece-node w-full py-4 flex items-center justify-center gap-4 shrink-0 block px-4";
    tailEndLabelDeckNode.innerHTML = `
        <div class="flex-grow border-t border-slate-900 max-w-[40px]"></div>
        <span class="text-[9px] font-bold tracking-[0.15em] uppercase text-slate-600 whitespace-nowrap">End Of Filtered List</span>
        <div class="flex-grow border-t border-slate-900 max-w-[40px]"></div>
    `;
    scrollContainerFrame.appendChild(tailEndLabelDeckNode);

    const physicalScrollSpacer = document.createElement('div');
    physicalScrollSpacer.className = "dynamic-spacer-node h-16 shrink-0 block w-full";
    scrollContainerFrame.appendChild(physicalScrollSpacer);

    // Kick off async weather fetches — runs after the DOM is painted
    setTimeout(refreshAllWeatherBadges, 0);
}

function toggleSettingsMenu(show) {
    const drawer = document.getElementById('settingsDrawer');
    if (drawer) drawer.classList.toggle('hidden', !show);
    // When opening settings, force-close all other right-side drawers
    if (show) {
        document.getElementById('profileDrawer')?.classList.add('hidden');
        document.getElementById('tasksDrawer')?.classList.add('hidden');
    }
}

/** Open/close the profile drawer (greeting capsule → person icon tap). */
function toggleProfileDrawer(show) {
    const drawer = document.getElementById('profileDrawer');
    if (drawer) drawer.classList.toggle('hidden', !show);

    if (show) {
        // When opening profile drawer, force-close settings (mutually exclusive)
        const sd = document.getElementById('settingsDrawer');
        if (sd) sd.classList.add('hidden');

        const switchUserBox    = document.getElementById('settingsSwitchUserDropdown');
        const mainSelectionBox = document.getElementById('user-dropdown-select');
        if (switchUserBox && mainSelectionBox) {
            if (switchUserBox.options.length <= 1 && mainSelectionBox.options.length > 1) {
                switchUserBox.innerHTML = mainSelectionBox.innerHTML;
            }
            if (currentUser) switchUserBox.value = currentUser;
        }
        // Reset rename input and validation state each time the drawer opens
        resetProfileRenameValidationUI();
    }
}

function setupNetworkListeners() { 
    window.addEventListener('online', updateNetworkStatusHUD); 
    window.addEventListener('offline', updateNetworkStatusHUD); 
}

function updateNetworkStatusHUD() {
    const indicator = document.getElementById('networkIndicator');
    const syncText = document.getElementById('syncText');
    if(!indicator || !syncText) return;
    if (navigator.onLine) {
        indicator.className = "w-1.5 h-1.5 rounded-full bg-emerald-500";
        syncText.className = "text-[9px] font-mono text-slate-500";
        syncText.innerText = "Synced Live Data";
    } else {
        indicator.className = "w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse";
        syncText.className = "text-[9px] font-mono text-amber-400 font-black tracking-wide";
        syncText.innerText = "Offline Mode";
    }
}

/* ── User Greeting Capsule ────────────────────────────────────────────────────
   Shows "Hey! <currentUser>" in the HUD capsule next to the refresh button.
   If the text overflows the viewport, it enables a seamless marquee using the
   same doubled-copy translateX(-50%) technique as the weather ticker.
   Status dot: emerald = online, red + breathing pulse = offline.
────────────────────────────────────────────────────────────────────────────── */
function _updateUserStatusDot() {
    const dot = document.getElementById('userOnlineStatusDot');
    if (!dot) return;
    const online = navigator.onLine;
    dot.style.background = online ? '#10b981' : '#ef4444'; // emerald-500 / red-500
    dot.classList.toggle('user-dot-offline-pulse', !online);
}

function updateUserGreetingCapsule() {
    const name  = (currentUser || 'Guest').trim();
    // One repeating unit: "Hey! Name  •  " (bullet separator)
    const copy  = 'Hey! ' + name + '   •   ';

    const ticker = document.getElementById('userGreetingTicker');
    if (!ticker) return;

    // Always run as a continuous bus-sign marquee.
    // Two identical copies sit side-by-side; translateX(-50%) scrolls
    // exactly one copy-width, then the loop restarts invisibly.
    ticker.style.cssText = 'display:flex;width:max-content;will-change:transform;';
    ticker.innerHTML =
        '<span>' + copy + '</span>' +
        '<span aria-hidden="true">' + copy + '</span>';

    // Derive duration from rendered width so speed stays ~20 px/s.
    // Minimum 7 s keeps very short names feeling leisurely.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const oneW = ticker.scrollWidth / 2;
        const dur  = Math.max(7, (oneW / 20)).toFixed(2);
        ticker.style.animation = 'userGreetingScroll ' + dur + 's linear infinite';
        _updateUserStatusDot();
    }));
}
// Keep status dot live when connectivity changes
window.addEventListener('online',  _updateUserStatusDot);
window.addEventListener('offline', _updateUserStatusDot);

// ═══════════════════════════════════════════════════════════════════════════
// ── HUD CYCLE CONTROLLER ────────────────────────────────────────────────────
//
// The slot below the app title cycles between two rows:
//   Row 0 — Synced Live Data (networkIndicator + syncText)
//   Row 1 — GPS Status      (compact gpsBadgeButton)
//
// A soft vertical translateY transition (defined in style.css on #hudCycleInner)
// gives the slot-machine / jackpot roll feel.
//
// Priority rules:
//   • GPS NOT active (syncing / off / error)  → GPS row persistent, no cycling
//   • Manual sync in-flight                   → Sync row locked, no cycling
//   • GPS badge recently tapped               → GPS row locked until modal closes
//   • Normal (GPS active, no locks)           → 4 s per row, looping
//
// Zero changes to GPS logic, sync logic, or button handlers.
// The hooks below are called by syncData() and map.js via typeof guards.
// ═══════════════════════════════════════════════════════════════════════════

let _hudCycleTimer      = null;   // setInterval handle
let _hudCycleIndex      = 0;      // 0 = sync row, 1 = GPS row
let _hudCycleSyncLocked = false;  // true while a manual sync is in-flight
let _hudCycleGpsPaused  = false;  // true while GPS badge interaction is active
const _HUD_ROW_H        = 16;     // px — must match each row's height in the HTML
const _HUD_CYCLE_MS     = 4000;   // ms each item stays visible before cycling

/**
 * Translate the #hudCycleInner wrapper to show the given row.
 * @param {0|1} index
 * @param {boolean} [instant]  if true, bypass the CSS transition for immediate snaps
 */
function _hudShowSlot(index, instant) {
    const inner = document.getElementById('hudCycleInner');
    if (!inner) return;
    if (instant) {
        inner.style.transition = 'none';
        inner.style.transform  = `translateY(${-index * _HUD_ROW_H}px)`;
        void inner.offsetHeight; // force reflow before re-enabling transition
        inner.style.transition = '';
    } else {
        inner.style.transform = `translateY(${-index * _HUD_ROW_H}px)`;
    }
    _hudCycleIndex = index;
}

/**
 * Returns true only when cycling is permitted.
 * GPS must be in 'active' (emerald) state AND no sync/tap locks are active.
 */
function _hudCanCycle() {
    if (_hudCycleSyncLocked || _hudCycleGpsPaused) return false;
    const btn = document.getElementById('gpsBadgeButton');
    // updateGpsHudStatus() in map.js sets 'emerald' colour when GPS is active.
    return !!btn && btn.className.includes('emerald');
}

/** (Re)start the cycling setInterval. */
function _hudStartCycle() {
    _hudStopCycle();
    _hudCycleTimer = setInterval(() => {
        if (_hudCanCycle()) {
            _hudShowSlot((_hudCycleIndex + 1) % 2, false);
        } else if (_hudCycleIndex !== 1) {
            // GPS is not active — snap to GPS row and hold there
            _hudShowSlot(1, false);
        }
        // If already on GPS row and GPS is not active, nothing to do
    }, _HUD_CYCLE_MS);
}

function _hudStopCycle() {
    if (_hudCycleTimer) { clearInterval(_hudCycleTimer); _hudCycleTimer = null; }
}

// ── Public hooks ────────────────────────────────────────────────────────────

/**
 * Lock the HUD on the sync row while a manual sync is in-flight.
 * Called by syncData() when isManualForce === true.
 */
function hudCycleLockForSync() {
    _hudCycleSyncLocked = true;
    _hudStopCycle();
    _hudShowSlot(0, false); // show sync row ("Checking cloud...")
}

/**
 * Release the sync lock once the result has settled.
 * Shows the sync row for 2 s then resumes normal cycling.
 * Called by syncData() in its finally block.
 */
function hudCycleUnlockAfterSync() {
    _hudCycleSyncLocked = false;
    _hudShowSlot(0, true); // snap to sync row (timer restarts from row 0)
    setTimeout(() => {
        if (_hudCycleSyncLocked) return; // another sync began — leave it alone
        if (_hudCanCycle()) {
            _hudStartCycle();
        } else {
            // GPS is not active — go to GPS row persistently
            _hudShowSlot(1, false);
            _hudStartCycle(); // keep interval alive to react when GPS goes active
        }
    }, 2000);
}

/**
 * Pause cycling when the GPS badge is tapped.
 * Stays paused until the GPS error modal closes, or 4 s if no modal opens
 * (e.g. a plain recenter tap when GPS is already active).
 * Called by handleGpsBadgeClickAction() in map.js.
 */
function hudCyclePauseForGpsTap() {
    _hudCycleGpsPaused = true;
    _hudStopCycle();
    _hudShowSlot(1, false); // keep GPS row visible while the user is interacting

    const modal = document.getElementById('gpsInstructionsOverlayModal');
    if (!modal) {
        // No modal element found — just resume after 4 s
        setTimeout(() => { _hudCycleGpsPaused = false; if (!_hudCycleSyncLocked) _hudStartCycle(); }, 4000);
        return;
    }

    // Give the modal 200 ms to open (it opens synchronously, but this guards
    // any deferred show logic) then watch for it to close via MutationObserver.
    setTimeout(() => {
        if (!modal.classList.contains('hidden')) {
            // Modal is open — release the pause when it hides
            const obs = new MutationObserver(() => {
                if (modal.classList.contains('hidden')) {
                    obs.disconnect();
                    _hudCycleGpsPaused = false;
                    if (!_hudCycleSyncLocked) _hudStartCycle();
                }
            });
            obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
        } else {
            // Modal did not open (recenter tap) — resume after 4 s
            setTimeout(() => { _hudCycleGpsPaused = false; if (!_hudCycleSyncLocked) _hudStartCycle(); }, 4000);
        }
    }, 200);
}

/**
 * Notification hook called by updateGpsHudStatus() in map.js after every
 * GPS state change.  Immediately snaps to the GPS row if GPS is not active,
 * or lets the running interval pick up the active state naturally.
 */
function onHudGpsStateChange() {
    if (!_hudCanCycle()) {
        // GPS is off / syncing — show GPS row persistently
        _hudStopCycle();
        _hudShowSlot(1, false);
        _hudStartCycle(); // keep running to react when GPS eventually goes active
    } else {
        // GPS just became active — ensure the interval is running
        if (!_hudCycleTimer) _hudStartCycle();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETTINGS MODAL SYSTEM
//  Three themed modals replace all native alert/confirm/prompt calls that
//  originate from the settings drawer flow.
// ═══════════════════════════════════════════════════════════════════════════

let _sConfirmCb          = null;  // stored callback for executeSettingsConfirmAction
let _sConfirmShowLoading  = false; // when true, executeSettingsConfirmAction shows loading state
let _sConfirmLoadingLabel = '';    // text shown in the button during loading (no dots suffix)
let _sConfirmDotsInterval = null;  // setInterval handle for animated dots
let _sConfirmCancelCb    = null;  // optional — when set, X dismisses to its target instead of toggleSettingsMenu

/**
 * Open the reusable confirm modal.
 * @param {object} cfg - { faIcon, iconBg, iconColor, topBar, title, body,
 *                         btnLabel, btnClass, callback,
 *                         showLoading, loadingLabel }
 *   showLoading  {boolean} — when true the modal stays open after the button
 *                            is pressed, shows an animated loading state, and
 *                            only closes once the async callback resolves.
 *   loadingLabel {string}  — text shown in the button during loading
 *                            (dots are appended automatically). Defaults to
 *                            the btnLabel value.
 */
function openSettingsConfirmModal(cfg) {
    document.getElementById('sConfirmIconWrap').className =
        `w-12 h-12 rounded-2xl flex items-center justify-center text-xl ${cfg.iconBg || 'bg-red-500/10'}`;
    document.getElementById('sConfirmIconEl').className =
        `fa-solid ${cfg.faIcon} ${cfg.iconColor || 'text-red-400'}`;
    document.getElementById('sConfirmTopBar').className =
        `h-0.5 w-full ${cfg.topBar || 'bg-gradient-to-r from-pink-500 to-violet-500'}`;
    document.getElementById('sConfirmTitle').textContent = cfg.title;
    document.getElementById('sConfirmBody').textContent  = cfg.body;
    const btn = document.getElementById('sConfirmActionBtn');
    btn.disabled     = false; // always reset — loading state sets disabled=true and className reassignment doesn't clear DOM properties
    btn.textContent  = cfg.btnLabel;
    btn.className    = `w-full py-3 ${cfg.btnClass || 'bg-gradient-to-r from-red-600 to-rose-700'} font-black text-xs uppercase tracking-wider rounded-xl text-white active:scale-95 transition-transform shadow-lg`;
    _sConfirmCb          = cfg.callback || null;
    _sConfirmCancelCb    = cfg.cancelCallback || null;
    _sConfirmShowLoading  = !!cfg.showLoading;
    _sConfirmLoadingLabel = cfg.loadingLabel || cfg.btnLabel || 'Processing';
    document.getElementById('settingsConfirmModal').classList.remove('hidden');
}

function closeSettingsConfirmModal() {
    // Always clean up loading state before hiding
    _exitConfirmModalLoadingState();
    document.getElementById('settingsConfirmModal').classList.add('hidden');
    _sConfirmCb          = null;
    _sConfirmCancelCb    = null;
    _sConfirmShowLoading  = false;
    _sConfirmLoadingLabel = '';
}

function cancelSettingsConfirmModal() {
    // X button dismiss — navigate back to whoever opened the modal.
    // Guard: do nothing if currently in a loading state (X is visually disabled
    // but belt-and-suspenders here in case it fires via keyboard or AT).
    if (_sConfirmDotsInterval !== null) return;
    // Save cancel callback before closeSettingsConfirmModal nulls it out.
    const cancelCb = _sConfirmCancelCb;
    closeSettingsConfirmModal();
    if (cancelCb) {
        cancelCb();
    } else {
        toggleSettingsMenu(true);
    }
}

async function executeSettingsConfirmAction() {
    const cb = _sConfirmCb;
    if (!cb) return;

    if (_sConfirmShowLoading) {
        // ── Async path: keep modal open, lock it down, await the callback ──
        _enterConfirmModalLoadingState();
        try {
            await cb();
        } catch (err) {
            console.error('Settings confirm action error:', err);
        } finally {
            // Clean up loading UI; the callback is responsible for opening the
            // result modal. We close the confirm modal last so it dissolves
            // cleanly behind whatever the callback already rendered.
            closeSettingsConfirmModal();
        }
    } else {
        // ── Synchronous path: original behaviour ────────────────────────────
        closeSettingsConfirmModal();
        cb();
    }
}

// ─── Confirm modal loading-state helpers ──────────────────────────────────────

function _enterConfirmModalLoadingState() {
    const modal = document.getElementById('settingsConfirmModal');
    if (!modal) return;

    // Lock the X button — user must wait for the operation to complete
    const xBtn = modal.querySelector('button[onclick="cancelSettingsConfirmModal()"]');
    if (xBtn) {
        xBtn.disabled = true;
        xBtn.classList.add('opacity-30', 'pointer-events-none');
    }

    // Switch action button to animated loading text
    const actionBtn = document.getElementById('sConfirmActionBtn');
    if (actionBtn) {
        actionBtn.disabled = true;
        actionBtn.classList.remove('active:scale-95');
        actionBtn.classList.add('opacity-70', 'cursor-not-allowed', 'pointer-events-none');
        const base = _sConfirmLoadingLabel;
        let dots = 0;
        actionBtn.textContent = base;
        _sConfirmDotsInterval = setInterval(() => {
            dots = (dots + 1) % 4;
            actionBtn.textContent = base + '.'.repeat(dots);
        }, 450);
    }
}

function _exitConfirmModalLoadingState() {
    // Stop animated dots
    if (_sConfirmDotsInterval !== null) {
        clearInterval(_sConfirmDotsInterval);
        _sConfirmDotsInterval = null;
    }
    const modal = document.getElementById('settingsConfirmModal');
    if (!modal) return;

    // Restore X button
    const xBtn = modal.querySelector('button[onclick="cancelSettingsConfirmModal()"]');
    if (xBtn) {
        xBtn.disabled = false;
        xBtn.classList.remove('opacity-30', 'pointer-events-none');
    }

    // Restore action button — className reassignment in openSettingsConfirmModal
    // clears visual classes but NOT the disabled DOM property, so we must reset
    // it here explicitly to ensure subsequent modal uses work correctly.
    const actionBtn = document.getElementById('sConfirmActionBtn');
    if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.classList.remove('opacity-70', 'cursor-not-allowed', 'pointer-events-none');
    }
}

/** Purge modal helpers */
function openSettingsPurgeModal() {
    const inp = document.getElementById('purgePasswordInput');
    const err = document.getElementById('purgePasswordError');
    if (inp) inp.value = '';
    if (err) err.classList.add('hidden');
    document.getElementById('settingsPurgeModal').classList.remove('hidden');
    if (inp) setTimeout(() => inp.focus(), 120);
}
function closeSettingsPurgeModal() {
    // Programmatic close (after action) — no settings reopen needed
    document.getElementById('settingsPurgeModal').classList.add('hidden');
    const inp = document.getElementById('purgePasswordInput');
    if (inp) inp.value = '';
    document.getElementById('purgePasswordError').classList.add('hidden');
}
function cancelSettingsPurgeModal() {
    // X button dismiss — navigate back to settings drawer
    closeSettingsPurgeModal();
    toggleSettingsMenu(true);
}

/** Execute the purge request once user submits password */
async function executePurgeWithPassword() {
    const inp = document.getElementById('purgePasswordInput');
    const err = document.getElementById('purgePasswordError');
    const errTxt = document.getElementById('purgePasswordErrorText');
    const btn = document.getElementById('sPurgeActionBtn');

    const password = inp ? inp.value.trim() : '';
    if (!password) {
        errTxt.textContent = 'Password cannot be blank.';
        err.classList.remove('hidden');
        return;
    }

    // Loading state
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>Deleting...';
    btn.disabled = true;
    err.classList.add('hidden');

    try {
        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            mode: 'cors',
            body: JSON.stringify({
                action: 'purge_server_history',
                user: currentUser || 'System Admin',
                password
            })
        });
        const outcome = await response.json();

        closeSettingsPurgeModal();
        toggleSettingsMenu(false);

        if (outcome.result === 'success') {
            syncData(true);
            openSettingsResultModal('success', 'Logs Purged', 'Server records and logs have been cleared.');
        } else if (outcome.result === 'auth_failed') {
            openSettingsResultModal('error', 'Access Denied', 'Incorrect admin password. Purge request rejected.');
        } else {
            openSettingsResultModal('error', 'Server Error', outcome.error || 'Unknown response received from cloud.');
        }
    } catch (err) {
        console.error('Purge failure:', err);
        closeSettingsPurgeModal();
        openSettingsResultModal('error', 'Connection Failed', 'Connection error. Check your web app script setup.');
    } finally {
        btn.innerHTML = origHTML;
        btn.disabled = false;
    }
}

/**
 * Open the generic result / feedback modal.
 * @param {'success'|'error'|'info'} type
 */
function openSettingsResultModal(type, title, body) {
    const iconWrap = document.getElementById('sResultIconWrap');
    const iconEl   = document.getElementById('sResultIconEl');
    const topBar   = document.getElementById('sResultTopBar');

    if (type === 'success') {
        iconWrap.className = 'w-12 h-12 rounded-2xl flex items-center justify-center text-xl bg-emerald-500/10';
        iconEl.className   = 'fa-solid fa-circle-check text-emerald-400';
        topBar.className   = 'h-0.5 w-full bg-gradient-to-r from-emerald-500 to-teal-500';
    } else if (type === 'error') {
        iconWrap.className = 'w-12 h-12 rounded-2xl flex items-center justify-center text-xl bg-red-500/10';
        iconEl.className   = 'fa-solid fa-circle-xmark text-red-400';
        topBar.className   = 'h-0.5 w-full bg-gradient-to-r from-red-500 to-rose-500';
    } else {
        iconWrap.className = 'w-12 h-12 rounded-2xl flex items-center justify-center text-xl bg-slate-700/40';
        iconEl.className   = 'fa-solid fa-circle-info text-slate-400';
        topBar.className   = 'h-0.5 w-full bg-gradient-to-r from-pink-500 to-violet-500';
    }

    document.getElementById('sResultTitle').textContent = title;
    document.getElementById('sResultBody').textContent  = body;
    document.getElementById('settingsResultModal').classList.remove('hidden');
}
function closeSettingsResultModal() {
    document.getElementById('settingsResultModal').classList.add('hidden');
}

// ─── Missing settings action functions ───────────────────────────────────────

/** Clear all saved itinerary data — replaces native confirm/alert */
function triggerClearItineraryData() {
    openSettingsConfirmModal({
        faIcon: 'fa-trash-can', iconBg: 'bg-red-500/10', iconColor: 'text-red-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-red-500 to-rose-500',
        title: 'Clear Itinerary',
        body:  'All timeline maps and saved itinerary schedules will be permanently reset. This cannot be undone.',
        btnLabel: 'Clear All Data',
        btnClass: 'bg-gradient-to-r from-red-600 to-rose-700',
        callback: () => {
            // Reset the in-memory itinerary cache
            if (typeof itineraryItems !== 'undefined') {
                itineraryItems = { '1': [], '2': [], '3': [] };
                localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
            }
            // Also wipe saved itineraries list (both per-user and legacy flat key)
            if (typeof savedItineraries !== 'undefined') {
                savedItineraries = [];
            }
            localStorage.removeItem('compass_saved_itineraries');
            // Remove the per-user namespaced key so re-sync starts clean
            if (currentUser) {
                const _wipeSlug = currentUser.trim().toLowerCase().replace(/\s+/g, '_');
                localStorage.removeItem(`compass_itins_${_wipeSlug}`);
                // Mark sync state as done (not pending/syncing) so create UI shows immediately
                localStorage.setItem(`compass_itin_sync_${_wipeSlug}`, JSON.stringify({ status: 'done', ts: Date.now() }));
            }
            toggleSettingsMenu(false);
            if (typeof renderItineraryMasterDashboardWorkspace === 'function') {
                renderItineraryMasterDashboardWorkspace();
            }
            openSettingsResultModal('success', 'Itinerary Cleared', 'All itinerary data has been wiped and the timeline has been reset.');
        }
    });
}

/** Switch to the user selected in the settings dropdown */
function switchUserSessionViaSettings() {
    const switchBox = document.getElementById('settingsSwitchUserDropdown');
    if (!switchBox || !switchBox.value) return;
    const selectedUser = switchBox.value;

    if (selectedUser === currentUser) {
        openSettingsResultModal('info', 'Already Active', `"${selectedUser}" is already your active profile.`);
        return;
    }

    openSettingsConfirmModal({
        faIcon: 'fa-user-gear', iconBg: 'bg-violet-500/10', iconColor: 'text-violet-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-violet-500 to-pink-500',
        title: 'Switch User',
        body:  `Switch active session to "${selectedUser}"? Your cached data will reload for this profile.`,
        btnLabel: 'Switch Session',
        btnClass: 'bg-gradient-to-r from-violet-600 to-pink-600',
        cancelCallback: () => toggleProfileDrawer(true),
        callback: () => {
            localStorage.setItem('compass_user', selectedUser);
            currentUser = selectedUser;
            updateUserGreetingCapsule(); // update greeting + status dot for new user

            // ── Immediately show the new user's cached itineraries (if any) ──
            // This ensures the previous user's data is never visible to the
            // incoming user, even for a single render frame.
            if (typeof savedItineraries !== 'undefined') {
                const _newKey = `compass_itins_${selectedUser.trim().toLowerCase().replace(/\s+/g, '_')}`;
                savedItineraries = JSON.parse(localStorage.getItem(_newKey) || '[]');
                // Reset active itinerary selection — it belongs to the old user
                if (typeof activeItineraryId !== 'undefined') activeItineraryId = null;
                if (typeof activeItineraryDayTracker !== 'undefined') activeItineraryDayTracker = 0;
            }

            // Re-render the itinerary view with the new user's cached data
            // (or with loading state if they've never been synced on this device).
            if (typeof renderItineraryMasterDashboardWorkspace === 'function') {
                renderItineraryMasterDashboardWorkspace();
            }

            toggleProfileDrawer(false);
            openSettingsResultModal('success', 'Session Switched', `Now signed in as "${selectedUser}". Loading your itineraries...`);

            // ── Background itinerary-only sync ────────────────────────────────
            // travelSpots are shared across users (no need to re-fetch them).
            // Only the itinerary data is user-specific, so we sync just that.
            if (typeof loadUserItineraries === 'function') {
                loadUserItineraries();
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────

function validateProfileRenameInput() {
    const input = document.getElementById('settingsRenameField');
    const minCharWarn = document.getElementById('profileRenameMinCharWarning');
    const nameTakenWarn = document.getElementById('profileRenameNameTakenWarning');
    const submitBtn = document.getElementById('profileRenameSubmitBtn');
    if (!input || !minCharWarn || !nameTakenWarn || !submitBtn) return;

    const val = input.value.trim();

    if (val.length === 0) {
        minCharWarn.classList.add('hidden');
        nameTakenWarn.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
        return;
    }

    if (val.length < 3) {
        minCharWarn.classList.remove('hidden');
        nameTakenWarn.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
        return;
    }

    // 3+ chars — hide min-char warning, check for duplicate name
    minCharWarn.classList.add('hidden');
    const nameTaken = registeredUsersList.some(u => u.toLowerCase() === val.toLowerCase());
    if (nameTaken) {
        nameTakenWarn.classList.remove('hidden');
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
    } else {
        nameTakenWarn.classList.add('hidden');
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-40', 'cursor-not-allowed');
    }
}

function resetProfileRenameValidationUI() {
    const input = document.getElementById('settingsRenameField');
    const minCharWarn = document.getElementById('profileRenameMinCharWarning');
    const nameTakenWarn = document.getElementById('profileRenameNameTakenWarning');
    const submitBtn = document.getElementById('profileRenameSubmitBtn');
    if (input) input.value = '';
    if (minCharWarn) minCharWarn.classList.add('hidden');
    if (nameTakenWarn) nameTakenWarn.classList.add('hidden');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
    }
}

function commitProfileRename() {
    const renameField = document.getElementById('settingsRenameField');
    if (!renameField || !renameField.value.trim()) return; // button disabled state guards this

    const oldName = currentUser || 'Global Traveller';
    const newName = renameField.value.trim();

    if (oldName === newName) {
        openSettingsResultModal('info', 'No Change', 'The new profile name matches your current label.');
        return;
    }

    openSettingsConfirmModal({
        faIcon: 'fa-user-pen', iconBg: 'bg-violet-500/10', iconColor: 'text-violet-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-violet-500 to-pink-500',
        title: 'Rename Profile',
        body:  `Change your name from "${oldName}" to "${newName}"?`,
        btnLabel: 'Update Profile',
        cancelCallback: () => toggleProfileDrawer(true),
        btnClass: 'bg-gradient-to-r from-violet-600 to-pink-600',
        showLoading:  true,
        loadingLabel: 'Updating Profile Name',
        callback: async () => {
            try {
                // Single call: finds the old name row in RegisteredUsers and
                // overwrites it with the new name in-place. Also logs to History.
                await fetch(BACKEND_URL, {
                    method: 'POST',
                    mode: 'cors',
                    body: JSON.stringify({
                        action: 'rename_user',
                        old_name: oldName,
                        new_name: newName,
                        deviceMeta: cachedHardwareString
                    })
                });
            } catch (err) {
                console.error('Failed to rename user on server:', err);
            }

            // ── Update local state ──────────────────────────────────────────
            localStorage.setItem('compass_user', newName);
            currentUser = newName;

            // Replace old name in-place in the in-memory list so duplicate
            // checks remain accurate without needing a fresh server fetch.
            const renameIdx = registeredUsersList.findIndex(
                u => u.toLowerCase() === oldName.toLowerCase()
            );
            if (renameIdx !== -1) {
                registeredUsersList[renameIdx] = newName;
            } else {
                registeredUsersList.push(newName);
            }
            localStorage.setItem('compass_registered_users', JSON.stringify(registeredUsersList));

            // Refresh both dropdowns with the updated list. _fillUserDropdowns
            // reads currentUser so the settings dropdown auto-selects the new
            // name immediately — before settings is closed.
            _fillUserDropdowns(registeredUsersList);

            // ── Migrate per-user localStorage keys to the new username ──────
            // Itinerary cache and sync state are keyed by username; copy them
            // so cached data isn't lost after a rename.
            const _oldSlug = oldName.trim().toLowerCase().replace(/\s+/g, '_');
            const _newSlug = newName.trim().toLowerCase().replace(/\s+/g, '_');
            const _oldItinKey  = `compass_itins_${_oldSlug}`;
            const _newItinKey  = `compass_itins_${_newSlug}`;
            const _oldSyncKey  = `compass_itin_sync_${_oldSlug}`;
            const _newSyncKey  = `compass_itin_sync_${_newSlug}`;
            const _cachedItins = localStorage.getItem(_oldItinKey);
            if (_cachedItins) {
                localStorage.setItem(_newItinKey, _cachedItins);
                localStorage.removeItem(_oldItinKey);
            }
            // Reset sync state to 'syncing' so we verify cloud data under the new name
            localStorage.setItem(_newSyncKey, JSON.stringify({ status: 'syncing', ts: Date.now() }));
            localStorage.removeItem(_oldSyncKey);

            resetProfileRenameValidationUI();
            toggleProfileDrawer(false);
            // Only re-fetch itineraries (spots don't change on rename)
            if (typeof loadUserItineraries === 'function') loadUserItineraries();
            openSettingsResultModal('success', 'Profile Updated', `Profile updated to "${newName}". Syncing...`);
        }
    });
}

function triggerSecureServerHistoryPurgeVault() {
    // Opens the themed password modal; all async logic lives in executePurgeWithPassword()
    openSettingsPurgeModal();
}

function clearDeviceSessionAndLogout() {
    openSettingsConfirmModal({
        faIcon: 'fa-right-from-bracket', iconBg: 'bg-red-500/10', iconColor: 'text-red-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-red-500 to-rose-500',
        title: 'Logout Session',
        body:  'You will be logged out and your saved offline cache data will be completely reset.',
        btnLabel: 'Log Out And Reset',
        btnClass: 'bg-gradient-to-r from-red-600 to-rose-700',
        callback: () => {
            // Preserve the registered-users list across logout so the login
            // dropdown can be painted from cache instantly on the next load,
            // without waiting for a fresh server fetch. The list is not
            // sensitive — it contains only display names.
            const preservedUsersCache = localStorage.getItem('compass_registered_users');
            localStorage.clear();
            if (preservedUsersCache) {
                localStorage.setItem('compass_registered_users', preservedUsersCache);
            }
            window.location.reload();
        }
    });
}

// ----------------- APP INITIALIZATION (MASTER BOOTLOADER) -----------------
window.onload = function() {
    // NOTE: Do NOT write any default zoom/lat/lng here — doing so would wipe the
    // user's last active view on every reload. The priority resolver in map.js
    // reads and validates those values independently.

    // ── Kick off the user-list fetch as the very first async operation ────────
    // populateUserDropdown() has two phases:
    //   1. Synchronous: paint dropdown instantly from localStorage cache
    //   2. Async: refresh the list from the server in the background
    // By starting it before initLeafletMapEngineCanvas() we give the network
    // request the maximum possible head-start. The calibration canvas takes
    // 1-3 s to dismiss (tile load), so the fetch almost always completes before
    // the user ever sees the login screen — making the dropdown immediately ready.
    populateUserDropdown();
    // Migrate: clear any FX rate cache written by the old frankfurter.app integration.
    // Those entries used the reversed direction (localCur→homeCur) and a different API
    // shape, so they must never be replayed.  One-time guard key prevents re-clearing.
    if (!localStorage.getItem('compass_fx_cache_v2')) {
        localStorage.removeItem(_FX_CACHE_LS_KEY);
        _fxRateCache = {};
        localStorage.setItem('compass_fx_cache_v2', '1');
    }
    initHomeCurrency();
    _applyCurrencyCapsuleVisibility();
    initSettingsCurrencyToggle();
    _applyWeatherCapsuleVisibility();
    initSettingsWeatherToggle();
    _wdStartBgRefresh(); // keep localStorage weather cache warm every 30 min

    cachedHardwareString = parseReadableDeviceHardware();
    document.getElementById('meta-id').innerText = `Device ID: ${deviceId}`;
    document.getElementById('meta-hardware').innerText = `Model: ${cachedHardwareString}`;
    document.getElementById('meta-version').innerText = `Version: ${APP_VERSION}`;
    
    if (typeof initLeafletMapEngineCanvas === 'function') initLeafletMapEngineCanvas();

    // Always attempt GPS on load — shows "GPS Syncing…" immediately and resolves to
    // GPS Active or GPS Off once the browser responds. On first visit this triggers
    // the browser's native location request; on repeat visits (already granted) it
    // starts silently. monitorNativeGpsPermissions() handles mid-session revocation.
    // Camera is pre-locked so the first successful fix centres the map viewport.
    if (typeof startLiveHardwareGPSTracking === 'function') {
        isCameraLocked = true;
        if (typeof syncCameraLockVisualUIState === 'function') syncCameraLockVisualUIState();
        startLiveHardwareGPSTracking();
    }

    // Safety net: if the tile-load event never fires (offline / map init error),
    // force-dismiss the calibration screen after 10 s so the app is never locked.
    setTimeout(() => {
        const loader = document.getElementById('mapCanvasWarmupLoader');
        if (loader && loader.style.display !== 'none') {
            loader.style.pointerEvents = 'none';
            loader.style.touchAction   = 'auto';
            loader.style.transition    = 'opacity 0.45s ease';
            loader.style.opacity       = '0';
            setTimeout(() => { loader.style.display = 'none'; }, 500);
        }
    }, 10000);

    // ── Minimize / Maximize (Page Visibility) handler ────────────────────────
    // window.onload does NOT re-fire on background → foreground transitions, so
    // the calibration curtain is never re-shown. This handler silently refreshes
    // map geometry and ensures the GPS stream is still running after a resume.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;

        // Dismiss loader immediately if it somehow survived into the background
        const loader = document.getElementById('mapCanvasWarmupLoader');
        if (loader && loader.style.display !== 'none') {
            loader.style.display       = 'none';
            loader.style.pointerEvents = 'none';
        }

        // Re-fit map to its container (browser may have resized it while hidden)
        if (leafletMapInstance) {
            window.requestAnimationFrame(() => leafletMapInstance.invalidateSize({ animate: false }));
        }

        // Resume GPS stream if it was running before and has since stalled
        if (gpsStatusCachedBool && liveGpsWatchId === null && typeof startLiveHardwareGPSTracking === 'function') {
            startLiveHardwareGPSTracking();
        }
    });
    syncPriorityFilterViewModeUI();
    setupNativePullToRefreshGestures();

    document.getElementById('trayFlipToBackBtn').addEventListener('click', (e) => { 
        e.stopPropagation(); 
        document.getElementById('mapDetailTrayHUD').classList.add('flipped'); 
        if (typeof assembleTrayInlineAssignorRow === 'function') assembleTrayInlineAssignorRow(); 
    });
    document.getElementById('trayFlipToFrontBtn').addEventListener('click', (e) => { 
        e.stopPropagation(); 
        document.getElementById('mapDetailTrayHUD').classList.remove('flipped'); 
    });
    
    const trayNode = document.getElementById('mapDetailTrayHUD');
    if(trayNode && typeof L !== 'undefined') {
        L.DomEvent.disableClickPropagation(trayNode);
        L.DomEvent.on(trayNode, 'contextmenu', L.DomEvent.stopPropagation);
    }
    
    document.getElementById('dropdownBlurBackdrop').addEventListener('click', () => {
        closeAllActiveHUDDropdownOverlays();
        toggleSettingsMenu(false);
        if(typeof dismissMapDetailTrayHUDCard === 'function') dismissMapDetailTrayHUDCard();
        if(typeof toggleItineraryCreationDrawerForm === 'function') toggleItineraryCreationDrawerForm(false);
    });

    // Tapping the tray-specific backdrop (outside the tray card) dismisses the tray
    const trayBackdropEl = document.getElementById('trayBlurBackdrop');
    if (trayBackdropEl) {
        trayBackdropEl.addEventListener('click', () => {
            if (typeof dismissMapDetailTrayHUDCard === 'function') dismissMapDetailTrayHUDCard();
        });
    }

    if (travelSpots.length > 0) {
        calculateSmartCityDefaultFilters();
        renderList();
        initTasksBadge();

        // NOTE: intentionally NOT calling triggerOptimalLandingViewportRecalculation here.
        // The map was already positioned correctly by initLeafletMapEngineCanvas using the
        // same resolveInitialMapViewState() logic. A second setView({ reset: true }) here
        // causes a visible black-screen flicker with no benefit.
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') {
            plotDynamicMarkersOnCanvasMap();
        }
        if (typeof buildItinerarySubMenuChecklist === 'function') {
            buildItinerarySubMenuChecklist();
        }
        
        const masterListViewInit = document.getElementById('itineraryMasterListView');
        if (masterListViewInit) masterListViewInit.classList.remove('hidden');
        
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    }
    
    if (!currentUser) {
        document.getElementById('userModal').classList.remove('hidden');
        resetUserModalForm(); // ensure clean form state on every show
    } else {
        initializeSessionDashboard();
    }
    document.addEventListener('click', (event) => {
         if (event.target.closest('button[onclick*="nukeAllSavedData"]') || event.target.closest('#itineraryCreationDrawerModal')) {
             return;
         }

         if (!event.target.closest('#cityHUDDropdownPopupBox') &&
             !event.target.closest('#filterCategoryDropdownPopupBox') &&
             !event.target.closest('#cityFilterHUDTriggerBtn') &&
             !event.target.closest('#filterMenuTriggerBtn') &&
             !event.target.closest('#filterUnifiedCapsuleBtn') &&
             !event.target.closest('#unifiedFilterSheet')) {
             closeAllActiveHUDDropdownOverlays();
         }
         
         if (!event.target.closest('#mapLayerStyleDropdownDeck') && !event.target.closest('button[onclick*="mapLayerStyleDropdownDeck"]')) {
             const deck = document.getElementById('mapLayerStyleDropdownDeck');
             if (deck) deck.classList.add('hidden');
         }
         
         const settingsMenu = document.getElementById('settingsDrawer');
         if (settingsMenu && !settingsMenu.classList.contains('hidden')) {
             // Don't close settings while a settings sub-modal is open — those modals
             // sit above the drawer and their X button handles the back-navigation.
             const subModalOpen = document.getElementById('settingsConfirmModal')?.classList.contains('hidden') === false
                               || document.getElementById('settingsPurgeModal')?.classList.contains('hidden') === false
                               || document.getElementById('settingsResultModal')?.classList.contains('hidden') === false;
             // Also guard against clicks that originated inside a sub-modal container.
             // Without this, the cancel* functions hide the sub-modal and re-open settings,
             // but the click then bubbles here — subModalOpen is already false by then —
             // and the handler incorrectly closes settings again.
             if (!subModalOpen
                 && !event.target.closest('#settingsDrawerContentBody')
                 && !event.target.closest('#settingsConfirmModal')
                 && !event.target.closest('#settingsPurgeModal')
                 && !event.target.closest('#settingsResultModal')
                 && !event.target.closest('button[onclick="toggleSettingsMenu(true)"]')) {
                 toggleSettingsMenu(false);
             }
         }

         // Close the profile drawer when clicking outside it (same guard pattern)
         const profileMenu = document.getElementById('profileDrawer');
         if (profileMenu && !profileMenu.classList.contains('hidden')) {
             const subModalOpen = document.getElementById('settingsConfirmModal')?.classList.contains('hidden') === false
                               || document.getElementById('settingsResultModal')?.classList.contains('hidden') === false;
             if (!subModalOpen
                 && !event.target.closest('#profileDrawerContentBody')
                 && !event.target.closest('#settingsConfirmModal')
                 && !event.target.closest('#settingsResultModal')
                 && !event.target.closest('#userGreetingCapsule')) {
                 toggleProfileDrawer(false);
             }
         }

         // Close the tasks drawer when clicking outside it
         const tasksDrawerEl = document.getElementById('tasksDrawer');
         if (tasksDrawerEl && !tasksDrawerEl.classList.contains('hidden')) {
             if (!event.target.closest('#tasksDrawerBody')
                 && !event.target.closest('button[onclick*="toggleTasksDrawer"]')) {
                 toggleTasksDrawer(false);
             }
         }
     });
};

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOLIDAY NOTIFIER
// Uses Nager.Date free API — no auth, CORS-supported
// GET https://date.nager.at/api/v3/PublicHolidays/{year}/{countryCode}
// ═══════════════════════════════════════════════════════════════════════════

// City name (lowercase) → ISO 3166-1 alpha-2 country code
// Covers the most common international travel destinations.
// Add more entries here as new cities are added to the database.
const _CITY_COUNTRY_MAP = {
    // Europe
    'amsterdam': 'NL', 'rotterdam': 'NL', 'the hague': 'NL', 'utrecht': 'NL',
    'paris': 'FR', 'lyon': 'FR', 'marseille': 'FR', 'nice': 'FR', 'bordeaux': 'FR', 'toulouse': 'FR',
    'london': 'GB', 'manchester': 'GB', 'birmingham': 'GB', 'edinburgh': 'GB', 'glasgow': 'GB', 'bristol': 'GB', 'liverpool': 'GB',
    'berlin': 'DE', 'munich': 'DE', 'hamburg': 'DE', 'frankfurt': 'DE', 'cologne': 'DE', 'düsseldorf': 'DE', 'dusseldorf': 'DE', 'stuttgart': 'DE',
    'madrid': 'ES', 'barcelona': 'ES', 'seville': 'ES', 'valencia': 'ES', 'bilbao': 'ES', 'malaga': 'ES',
    'rome': 'IT', 'milan': 'IT', 'florence': 'IT', 'venice': 'IT', 'naples': 'IT', 'turin': 'IT', 'bologna': 'IT',
    'lisbon': 'PT', 'porto': 'PT', 'faro': 'PT',
    'athens': 'GR', 'thessaloniki': 'GR', 'santorini': 'GR', 'mykonos': 'GR',
    'vienna': 'AT', 'salzburg': 'AT', 'innsbruck': 'AT',
    'zurich': 'CH', 'geneva': 'CH', 'bern': 'CH', 'lausanne': 'CH', 'basel': 'CH',
    'brussels': 'BE', 'bruges': 'BE', 'ghent': 'BE', 'antwerp': 'BE',
    'stockholm': 'SE', 'gothenburg': 'SE', 'malmo': 'SE',
    'oslo': 'NO', 'bergen': 'NO', 'trondheim': 'NO',
    'copenhagen': 'DK', 'aarhus': 'DK',
    'helsinki': 'FI', 'tampere': 'FI',
    'reykjavik': 'IS',
    'dublin': 'IE', 'cork': 'IE', 'galway': 'IE',
    'warsaw': 'PL', 'krakow': 'PL', 'wroclaw': 'PL', 'gdansk': 'PL',
    'prague': 'CZ', 'brno': 'CZ',
    'budapest': 'HU',
    'bucharest': 'RO', 'cluj-napoca': 'RO',
    'sofia': 'BG',
    'zagreb': 'HR', 'dubrovnik': 'HR', 'split': 'HR',
    'sarajevo': 'BA',
    'belgrade': 'RS',
    'ljubljana': 'SI',
    'bratislava': 'SK',
    'tallinn': 'EE',
    'riga': 'LV',
    'vilnius': 'LT',
    'moscow': 'RU', 'saint petersburg': 'RU', 'st. petersburg': 'RU',
    'kyiv': 'UA', 'lviv': 'UA', 'odesa': 'UA',
    'valletta': 'MT',
    'nicosia': 'CY', 'limassol': 'CY',
    'luxembourg': 'LU',
    'monaco': 'MC',
    'andorra': 'AD',
    // Americas
    'new york': 'US', 'los angeles': 'US', 'chicago': 'US', 'houston': 'US', 'miami': 'US',
    'san francisco': 'US', 'seattle': 'US', 'boston': 'US', 'washington dc': 'US', 'washington d.c.': 'US',
    'las vegas': 'US', 'new orleans': 'US', 'nashville': 'US', 'austin': 'US', 'denver': 'US',
    'portland': 'US', 'san diego': 'US', 'phoenix': 'US', 'atlanta': 'US', 'minneapolis': 'US',
    'toronto': 'CA', 'vancouver': 'CA', 'montreal': 'CA', 'calgary': 'CA', 'ottawa': 'CA', 'quebec': 'CA',
    'mexico city': 'MX', 'cancun': 'MX', 'guadalajara': 'MX', 'monterrey': 'MX', 'oaxaca': 'MX', 'tulum': 'MX',
    'buenos aires': 'AR', 'cordoba': 'AR', 'mendoza': 'AR', 'bariloche': 'AR',
    'são paulo': 'BR', 'sao paulo': 'BR', 'rio de janeiro': 'BR', 'brasilia': 'BR', 'salvador': 'BR', 'recife': 'BR',
    'santiago': 'CL', 'valparaiso': 'CL',
    'lima': 'PE', 'cusco': 'PE',
    'bogota': 'CO', 'medellín': 'CO', 'medellin': 'CO', 'cartagena': 'CO',
    'quito': 'EC', 'galapagos': 'EC',
    'montevideo': 'UY',
    'asuncion': 'PY',
    'la paz': 'BO',
    'caracas': 'VE',
    'havana': 'CU',
    'san jose': 'CR',
    'panama city': 'PA',
    'guatemala city': 'GT',
    'santo domingo': 'DO',
    'san juan': 'PR',
    // Asia
    'tokyo': 'JP', 'osaka': 'JP', 'kyoto': 'JP', 'hiroshima': 'JP', 'sapporo': 'JP', 'fukuoka': 'JP', 'nagoya': 'JP',
    'beijing': 'CN', 'shanghai': 'CN', 'guangzhou': 'CN', 'shenzhen': 'CN', 'chengdu': 'CN', 'xian': 'CN', "xi'an": 'CN',
    'hong kong': 'HK',
    'macau': 'MO',
    'taipei': 'TW', 'kaohsiung': 'TW',
    'seoul': 'KR', 'busan': 'KR', 'jeju': 'KR',
    'singapore': 'SG',
    'bangkok': 'TH', 'chiang mai': 'TH', 'phuket': 'TH', 'pattaya': 'TH', 'koh samui': 'TH',
    'kuala lumpur': 'MY', 'penang': 'MY', 'langkawi': 'MY', 'kota kinabalu': 'MY',
    'jakarta': 'ID', 'bali': 'ID', 'yogyakarta': 'ID', 'surabaya': 'ID', 'medan': 'ID', 'lombok': 'ID',
    'manila': 'PH', 'cebu': 'PH', 'davao': 'PH',
    'hanoi': 'VN', 'ho chi minh city': 'VN', 'hoi an': 'VN', 'da nang': 'VN', 'nha trang': 'VN',
    'phnom penh': 'KH', 'siem reap': 'KH',
    'vientiane': 'LA', 'luang prabang': 'LA',
    'yangon': 'MM', 'mandalay': 'MM',
    'colombo': 'LK',
    'dhaka': 'BD',
    'kathmandu': 'NP',
    'mumbai': 'IN', 'delhi': 'IN', 'new delhi': 'IN', 'bangalore': 'IN', 'bengaluru': 'IN',
    'kolkata': 'IN', 'chennai': 'IN', 'hyderabad': 'IN', 'jaipur': 'IN', 'goa': 'IN', 'agra': 'IN',
    'karachi': 'PK', 'lahore': 'PK', 'islamabad': 'PK',
    'kabul': 'AF',
    'tehran': 'IR',
    'baghdad': 'IQ',
    'dubai': 'AE', 'abu dhabi': 'AE', 'sharjah': 'AE',
    'doha': 'QA',
    'kuwait city': 'KW',
    'manama': 'BH',
    'muscat': 'OM',
    'riyadh': 'SA', 'jeddah': 'SA', 'mecca': 'SA', 'medina': 'SA',
    'amman': 'JO',
    'beirut': 'LB',
    'damascus': 'SY',
    'jerusalem': 'IL', 'tel aviv': 'IL', 'haifa': 'IL',
    'ankara': 'TR', 'istanbul': 'TR', 'izmir': 'TR', 'antalya': 'TR', 'cappadocia': 'TR',
    'baku': 'AZ',
    'yerevan': 'AM',
    'tbilisi': 'GE',
    'tashkent': 'UZ', 'samarkand': 'UZ',
    'almaty': 'KZ',
    'ulaanbaatar': 'MN',
    // Africa
    'cairo': 'EG', 'luxor': 'EG', 'alexandria': 'EG', 'aswan': 'EG',
    'casablanca': 'MA', 'marrakech': 'MA', 'fez': 'MA', 'rabat': 'MA', 'tangier': 'MA',
    'tunis': 'TN',
    'algiers': 'DZ',
    'tripoli': 'LY',
    'nairobi': 'KE', 'mombasa': 'KE',
    'dar es salaam': 'TZ', 'zanzibar': 'TZ', 'arusha': 'TZ',
    'kampala': 'UG',
    'addis ababa': 'ET',
    'accra': 'GH',
    'lagos': 'NG', 'abuja': 'NG',
    'dakar': 'SN',
    'cape town': 'ZA', 'johannesburg': 'ZA', 'durban': 'ZA', 'pretoria': 'ZA',
    'harare': 'ZW',
    'lusaka': 'ZM',
    'maputo': 'MZ',
    'antananarivo': 'MG',
    'luanda': 'AO',
    'kinshasa': 'CD',
    'kigali': 'RW',
    // Oceania
    'sydney': 'AU', 'melbourne': 'AU', 'brisbane': 'AU', 'perth': 'AU', 'adelaide': 'AU',
    'gold coast': 'AU', 'cairns': 'AU', 'darwin': 'AU', 'canberra': 'AU',
    'auckland': 'NZ', 'wellington': 'NZ', 'christchurch': 'NZ', 'queenstown': 'NZ',
    'suva': 'FJ',
    'nuku\'alofa': 'TO',
    'apia': 'WS',
    'port moresby': 'PG',
    // Caribbean
    'bridgetown': 'BB',
    'kingston': 'JM',
    'port of spain': 'TT',
    'nassau': 'BS',
    'george town': 'KY',
};

/**
 * Fetch public holidays for a country+year from Nager.Date API.
 * Results are cached in _holidayCache by "CC-YYYY" key.
 * Returns an array of date strings "YYYY-MM-DD", or [] on error.
 */
async function _fetchPublicHolidays(countryCode, year) {
    const cacheKey = `${countryCode}-${year}`;
    if (_holidayCache[cacheKey] !== undefined) return _holidayCache[cacheKey];

    try {
        const res = await fetch(
            `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (!res.ok) { _holidayCache[cacheKey] = []; return []; }
        const data = await res.json();
        const dates = Array.isArray(data) ? data.map(h => h.date) : [];
        _holidayCache[cacheKey] = dates;
        return dates;
    } catch (e) {
        _holidayCache[cacheKey] = [];
        return [];
    }
}

/**
 * Fetch full public holiday objects for a country+year from Nager.Date.
 * Shares the same API endpoint as _fetchPublicHolidays but stores rich objects.
 * Returns an array of { date: "YYYY-MM-DD", name: string, localName: string }.
 */
async function _fetchPublicHolidaysRich(countryCode, year) {
    const cacheKey = `${countryCode}-${year}`;
    if (_holidayRichCache[cacheKey] !== undefined) return _holidayRichCache[cacheKey];
    try {
        const res = await fetch(
            `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (!res.ok) { _holidayRichCache[cacheKey] = []; return []; }
        const data = await res.json();
        const rich = Array.isArray(data)
            ? data.map(h => ({ date: h.date, name: h.name, localName: h.localName }))
            : [];
        _holidayRichCache[cacheKey] = rich;
        return rich;
    } catch (e) {
        _holidayRichCache[cacheKey] = [];
        return [];
    }
}

/**
 * Returns the public holiday object { date, name, localName } for a given city
 * and date string "YYYY-MM-DD", or null if the day is not a public holiday.
 * Called by the itinerary timeline banner renderer.
 */
async function getPublicHolidayForDate(cityName, dateYMD) {
    if (!cityName || !dateYMD) return null;
    const countryCode = _CITY_COUNTRY_MAP[cityName.toLowerCase().trim()];
    if (!countryCode) return null;
    const year = parseInt(dateYMD.slice(0, 4), 10);
    const holidays = await _fetchPublicHolidaysRich(countryCode, year);
    return holidays.find(h => h.date === dateYMD) || null;
}

/**
 * Returns true if today is a public holiday in the given city.
 * Returns false if the city is not in the lookup map, or on any error.
 */
async function _isTodayPublicHoliday(cityName) {
    if (!cityName) return false;
    const countryCode = _CITY_COUNTRY_MAP[cityName.toLowerCase().trim()];
    if (!countryCode) return false;

    const today = new Date();
    const year  = today.getFullYear();
    const todayStr = `${year}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const holidays = await _fetchPublicHolidays(countryCode, year);
    return holidays.includes(todayStr);
}

/**
 * Show or hide #holidayNotifierWrapper based on:
 *  - user is on the map tab
 *  - exactly one city is selected
 *  - that city has a public holiday today
 */
async function updateHolidayNotifierVisibility() {
    const wrapper = document.getElementById('holidayNotifierWrapper');
    if (!wrapper) return;

    // Must be on the map tab
    if (typeof activeTabID !== 'undefined' && activeTabID !== 'map') {
        wrapper.classList.add('hidden');
        return;
    }

    // Must have exactly one city selected
    if (!Array.isArray(checkedCitiesStateArray) || checkedCitiesStateArray.length !== 1) {
        wrapper.classList.add('hidden');
        return;
    }

    const isHoliday = await _isTodayPublicHoliday(checkedCitiesStateArray[0]);
    if (isHoliday) {
        wrapper.classList.remove('hidden');
    } else {
        wrapper.classList.add('hidden');
    }
}

/**
 * Tap handler for the holiday notifier button.
 * Shows a two-line persistent speech bubble using the shared HUD,
 * auto-dismisses after 2.6 s (same as other bubbles) or on any tap.
 */
function handleHolidayNotifierTap(event) {
    if (event) event.stopPropagation();

    const hud       = document.getElementById('globalToastSpeechBubbleHUD');
    const textNode  = document.getElementById('speechBubbleTextContainer');
    const pointer   = document.getElementById('bubblePointerNode');
    if (!hud || !textNode) return;

    // Dismiss any live bubble first
    if (typeof killLiveSpeechBubbleHUDState === 'function') killLiveSpeechBubbleHUDState();

    // Two-line message via innerHTML (content is hardcoded / safe)
    textNode.innerHTML = 'Public holiday reminder!<br>Check the calendar of the selected city.';

    // Position bubble above the notifier button
    const btn = document.getElementById('holidayNotifierBtn');
    if (btn) {
        const rect          = btn.getBoundingClientRect();
        const anchorCenterX = rect.left + rect.width / 2;
        const bubbleWidth   = 240;
        const margin        = 8;
        const leftPos = Math.max(margin,
            Math.min(window.innerWidth - bubbleWidth - margin,
                anchorCenterX - bubbleWidth / 2));

        hud.style.left = leftPos + 'px';
        hud.style.top  = rect.top  + 'px';

        if (pointer) {
            const pLeft = Math.max(8, Math.min(bubbleWidth - 20,
                Math.round(anchorCenterX - leftPos - 6)));
            pointer.style.left  = pLeft + 'px';
            pointer.style.right = 'auto';
        }
    }

    // Show with pop animation
    hud.classList.remove('hidden');
    hud.classList.remove('bubble-popup-anim');
    void hud.offsetWidth; // force reflow
    hud.classList.add('bubble-popup-anim');

    // Auto-dismiss after 2.6 s
    speechBubbleHideTimer = setTimeout(() => {
        if (typeof killLiveSpeechBubbleHUDState === 'function') killLiveSpeechBubbleHUDState();
    }, 2600);
}

// ═══════════════════════════════════════════════════════════════════════════
// TASKS DRAWER
// Smart booking/reservation reminder list derived from saved spots and
// future itinerary entries.
//
// • Action labels are computed locally by a multi-field scoring engine —
//   no API call needed.  Fields scanned: booking_requirement (highest weight),
//   category, spot_name, notes, long_description, opening_hours.
// • State (done, muted) is stored in localStorage and survives reloads.
// • Entry point: fa-clipboard-check button in the top HUD, between sync and settings.
// ═══════════════════════════════════════════════════════════════════════════

const _TASKS_LS_DONE  = 'save2go_tasks_done_v1';
const _TASKS_LS_MUTED = 'save2go_tasks_muted_v1';

let _tasksTab    = 'saved'; // 'saved' | 'itin'
let _tasksFilter = 'all';   // 'all' | 'muted'

// ── State helpers ─────────────────────────────────────────────────────────
function _tasksGetDone()      { try { return new Set(JSON.parse(localStorage.getItem(_TASKS_LS_DONE)  || '[]')); } catch { return new Set(); } }
function _tasksGetMuted()     { try { return new Set(JSON.parse(localStorage.getItem(_TASKS_LS_MUTED) || '[]')); } catch { return new Set(); } }
function _tasksSaveDone(s)    { localStorage.setItem(_TASKS_LS_DONE,  JSON.stringify([...s])); }
function _tasksSaveMuted(s)   { localStorage.setItem(_TASKS_LS_MUTED, JSON.stringify([...s])); }

// ── Action scoring engine ─────────────────────────────────────────────────
/**
 * Scans all available fields on a spot and returns
 * { label: string, urgency: 1|2|3 } or null if the spot needs no action.
 *
 * urgency 3 = required (red)   · 2 = recommended (amber)   · 1 = optional (sky)
 */
function _tasksComputeAction(spot) {
    const lc = t => (t || '').toLowerCase();
    const bookingReq = lc(spot.booking_requirement);
    const cat        = lc(spot.category);
    const allText    = [spot.spot_name, spot.notes, spot.long_description, spot.opening_hours].join(' ').toLowerCase();

    // ── Phrases that explicitly signal NO user action is needed ───────────
    // If any of these appear in booking_requirement or the full text, the
    // spot is not actionable and must be excluded from the task menu.
    const NON_ACTIONABLE = [
        'no booking', 'no reservation', 'no reserv', 'no advance',
        'not required', 'not needed', 'none required', 'not applicable',
        'walk-in', 'walk in', 'free entry', 'free admission',
        'open to all', 'open to public', 'always open',
        'no need to book', 'without reservation', 'just turn up',
        'drop in', 'drop-in',
    ];

    // ── Tier 1: explicit booking_requirement field ─────────────────────────
    if (bookingReq && bookingReq !== 'n/a' && bookingReq !== 'none'
        && bookingReq !== '-' && bookingReq !== 'no' && bookingReq.length > 2) {

        // If the value explicitly says no action → exclude
        for (const phrase of NON_ACTIONABLE) {
            if (bookingReq.includes(phrase)) return null;
        }

        // Non-empty, not excluded → actionable; derive urgency from wording
        const raw = (spot.booking_requirement || '').trim();
        const urgency = /required|mandatory|must|essential/.test(bookingReq) ? 3
                      : /recommend|advised|suggested|preferred/.test(bookingReq) ? 2
                      : 2; // default to recommended if wording is ambiguous
        return { label: raw.length <= 48 ? raw : 'Booking required', urgency };
    }

    // ── Before Tiers 2+3: bail out if any non-actionable phrase appears
    // anywhere in the spot's text (notes, description, opening hours, name)
    for (const phrase of NON_ACTIONABLE) {
        if (allText.includes(phrase)) return null;
    }

    let score = 0;
    let label = null;
    let urgency = 1;

    // ── Tier 2: category signals (boost only — not sufficient alone) ───────
    // Category contributes +1 toward the threshold; it cannot trigger an
    // entry on its own — at least one concrete keyword (Tier 3) is required.
    if (/food|restaurant|dining|cafe|café|eatery|bistro|brasserie/.test(cat)) {
        score += 1; label = 'Reservation recommended';
    } else if (/activity|tour|excursion|experience|adventure|sport/.test(cat)) {
        score += 1; label = 'Pre-booking recommended';
    } else if (/nightlife|bar|drink|club|cocktail|lounge/.test(cat)) {
        score += 1; label = 'Reservation recommended';
    } else if (/culture|museum|gallery|exhibit|theatre|theater/.test(cat)) {
        score += 1; label = 'Tickets recommended';
    }
    // Photo, Viewpoint, Nature, Shopping, Landmark → no inherent booking need

    // ── Tier 3: keyword scan across all text fields ────────────────────────
    // Intentionally excludes vague signals like 'popular', 'queue', 'famous',
    // 'iconic' — these do not indicate a real booking obligation.
    const BOOK_KW = [
        'book', 'reserv', 'ticket', 'advance booking', 'advance purchase',
        'limited seat', 'limited space', 'capacity', 'sell out', 'sold out',
        'waiting list', 'pre-book', 'must book', 'booking required',
        'reservation required', 'pre-register',
    ];
    const BOOST_KW = ['michelin', 'exclusive', 'world-class'];

    let kwHits = 0;
    for (const kw of BOOK_KW)  { if (allText.includes(kw) && ++kwHits >= 3) break; }
    for (const kw of BOOST_KW) { if (allText.includes(kw)) { urgency = Math.min(urgency + 1, 3); break; } }

    score += kwHits;

    if (score >= 4) urgency = 3;
    else if (score >= 2) urgency = Math.max(urgency, 2);

    // Gate: category alone (score = 1, kwHits = 0) is not enough.
    // A spot must have at least one concrete booking keyword to appear.
    if (kwHits === 0) return null;
    if (score < 2)    return null;
    if (!label)       label = 'Check availability';

    return { label, urgency };
}

// ── Drawer open/close ─────────────────────────────────────────────────────
function toggleTasksDrawer(show) {
    const drawer = document.getElementById('tasksDrawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden', !show);
    if (show) {
        // Mutual exclusion with other right-side drawers
        document.getElementById('settingsDrawer')?.classList.add('hidden');
        document.getElementById('profileDrawer')?.classList.add('hidden');
        // Always start with the spot panel closed
        document.getElementById('tasksSpotPanel')?.classList.add('hidden');
        _tasksFilter = 'all';
        _tasksTab    = 'saved';
        _syncTasksTabUI();
        _syncTasksFilterUI();
        _renderTasksList();
    } else {
        // Ensure the spot panel is hidden when the drawer closes
        document.getElementById('tasksSpotPanel')?.classList.add('hidden');
    }
}

// ── Tab and filter UI sync ────────────────────────────────────────────────
function _syncTasksTabUI() {
    const savedBtn = document.getElementById('tasksTabBtnSaved');
    const itinBtn  = document.getElementById('tasksTabBtnItin');
    const activeC  = 'bg-pink-600 text-white';
    const inactiveC = 'bg-slate-800 text-slate-400';
    if (savedBtn) savedBtn.className = `flex-1 text-[10px] font-bold py-1.5 rounded-xl transition-colors ${_tasksTab === 'saved' ? activeC : inactiveC}`;
    if (itinBtn)  itinBtn.className  = `flex-1 text-[10px] font-bold py-1.5 rounded-xl transition-colors ${_tasksTab === 'itin'  ? activeC : inactiveC}`;
}

function _syncTasksFilterUI() {
    const allBtn   = document.getElementById('tasksToggleBtnAll');
    const mutedBtn = document.getElementById('tasksToggleBtnMuted');
    const activeC  = 'bg-slate-700 text-slate-200';
    const inactiveC = 'text-slate-500';
    if (allBtn)   allBtn.className   = `text-[9px] font-bold px-2.5 py-1 rounded-lg transition-colors ${_tasksFilter === 'all'   ? activeC : inactiveC}`;
    if (mutedBtn) mutedBtn.className = `text-[9px] font-bold px-2.5 py-1 rounded-lg transition-colors ${_tasksFilter === 'muted' ? activeC : inactiveC}`;
}

function switchTasksTab(tab) {
    _tasksTab = tab;
    _syncTasksTabUI();
    _renderTasksList();
}

function setTasksFilter(filter) {
    _tasksFilter = filter;
    _syncTasksFilterUI();
    _renderTasksList();
}

// ── Badge + pending notch helpers ─────────────────────────────────────────
function _tasksUpdateBadge(count) {
    [document.getElementById('tasksHudBadge'),
     document.getElementById('tasksHeaderBadge')].forEach(el => {
        if (!el) return;
        el.classList.toggle('hidden', count < 1);
        el.textContent = count > 99 ? '99+' : String(count);
    });
}

/** Updates the "X/Y Pending" notch below the drawer header. */
function _tasksUpdatePendingNotch(pending, total) {
    const pEl = document.getElementById('tasksPendingCount');
    const tEl = document.getElementById('tasksTotalCount');
    if (pEl) pEl.textContent = String(pending);
    if (tEl) tEl.textContent = String(total);
}

/** Called after data loads — pre-computes the pending count for the HUD badge. */
function initTasksBadge() {
    const rows  = Array.isArray(travelSpots) ? travelSpots : [];
    const done  = _tasksGetDone();
    const muted = _tasksGetMuted();
    let count = 0;
    for (const row of rows) {
        if (!_tasksComputeAction(row)) continue;
        const key = String(row.rowid);
        if (!done.has(key) && !muted.has(key)) count++;
    }
    _tasksUpdateBadge(count);
}

// ── Urgency pill style ────────────────────────────────────────────────────
function _tasksUrgencyPill(urgency) {
    if (urgency >= 3) return 'text-red-400 bg-red-500/10 border border-red-500/20';
    if (urgency >= 2) return 'text-amber-400 bg-amber-500/10 border border-amber-500/20';
    return 'text-sky-400 bg-sky-500/10 border border-sky-500/20';
}

// ── Row builder ───────────────────────────────────────────────────────────
function _tasksBuildRow(spot, taskKey, action, isDone, isMuted) {
    const row = document.createElement('div');
    row.className = `flex items-start gap-2.5 bg-slate-800/40 border border-slate-700/30 rounded-2xl px-3 py-2.5 transition-opacity ${isDone ? 'opacity-40' : ''}`;

    const _esc    = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const noteRaw = (spot.notes || spot.long_description || '').trim();
    const note    = noteRaw.length > 68 ? noteRaw.slice(0, 68) + '…' : noteRaw;
    const pillCls = _tasksUrgencyPill(action.urgency);
    const safeKey = _esc(taskKey);
    const rowid   = _esc(String(spot.rowid || ''));

    row.innerHTML = `
        <button onclick="tasksToggleDone('${safeKey}')"
                title="${isDone ? 'Mark pending' : 'Mark done'}"
                class="mt-1 shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all active:scale-90
                       ${isDone ? 'bg-emerald-500 border-emerald-500' : 'border-slate-500 hover:border-emerald-500/70'}">
            <i class="fa-solid fa-check text-[7px] ${isDone ? 'text-white' : 'text-transparent'}"></i>
        </button>
        <div class="flex-1 min-w-0">
            <p class="text-[12px] font-black text-slate-200 leading-tight truncate">${_esc(spot.spot_name)}</p>
            <div class="flex items-center gap-1.5 mt-1 mb-1 min-w-0 overflow-hidden">
                <span class="text-[8px] font-black px-1.5 py-0.5 rounded-lg min-w-0 truncate ${pillCls}">${_esc(action.label)}</span>
                <button onclick="tasksToggleMute('${safeKey}')"
                        class="shrink-0 whitespace-nowrap inline-flex items-center gap-1 text-[9px] font-bold text-slate-500 border border-slate-700/50 rounded-lg px-2 py-0.5 active:bg-slate-800 transition-colors">
                    <i class="fa-solid ${isMuted ? 'fa-bell' : 'fa-bell-slash'} text-[8px]"></i>
                    ${isMuted ? 'Unmute' : "Don't Remind"}
                </button>
            </div>
            ${note ? `<p class="text-[10px] text-slate-500 font-medium line-clamp-1">${_esc(note)}</p>` : ''}
        </div>
        <button onclick="tasksOpenTray('${rowid}')"
                title="View details"
                class="mt-0.5 shrink-0 w-7 h-7 flex items-center justify-center rounded-xl bg-slate-700/30 border border-slate-700/40 text-slate-400 active:bg-slate-700 transition-colors">
            <i class="fa-solid fa-circle-info text-[11px]"></i>
        </button>`;

    return row;
}

// ── Empty-state helper ────────────────────────────────────────────────────
function _tasksEmptyState(container, msg) {
    const el = document.createElement('div');
    el.className = 'flex flex-col items-center gap-2 mt-10 px-4 text-center';
    el.innerHTML = `<i class="fa-solid fa-circle-check text-slate-700 text-2xl"></i>
                    <p class="text-[11px] text-slate-500 font-medium">${msg}</p>`;
    container.appendChild(el);
}

// ── Main render ───────────────────────────────────────────────────────────
function _renderTasksList() {
    const container = document.getElementById('tasksListContent');
    if (!container) return;
    container.innerHTML = '';
    if (_tasksTab === 'saved') _tasksRenderSavedTab(container);
    else                       _tasksRenderItinTab(container);
}

// ── Saved Spots tab ───────────────────────────────────────────────────────
function _tasksRenderSavedTab(container) {
    const rows = Array.isArray(travelSpots) ? travelSpots : [];
    if (!rows.length) { _tasksEmptyState(container, 'No saved spots yet'); return; }

    const done  = _tasksGetDone();
    const muted = _tasksGetMuted();

    // Score every row
    const all = [];
    for (const row of rows) {
        const action = _tasksComputeAction(row);
        if (!action) continue;
        const key = String(row.rowid);
        all.push({ row, action, key, isDone: done.has(key), isMuted: muted.has(key) });
    }

    if (!all.length) { _tasksUpdatePendingNotch(0, 0); _tasksEmptyState(container, 'No action items found in your saved spots.'); return; }

    // Update HUD badge and pending notch with live counts
    const pendingCount = all.filter(i => !i.isDone && !i.isMuted).length;
    _tasksUpdateBadge(pendingCount);
    _tasksUpdatePendingNotch(pendingCount, all.length);

    // Apply filter: 'muted' shows only muted; 'all' shows non-muted
    const visible = _tasksFilter === 'muted' ? all.filter(i => i.isMuted)
                                              : all.filter(i => !i.isMuted);
    if (!visible.length) {
        _tasksEmptyState(container, _tasksFilter === 'muted' ? 'No muted items' : 'All clear. Nothing pending!');
        return;
    }

    // Sort: pending first sorted by urgency desc, done items last
    visible.sort((a, b) => {
        if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
        return b.action.urgency - a.action.urgency;
    });

    for (const item of visible) {
        container.appendChild(_tasksBuildRow(item.row, item.key, item.action, item.isDone, item.isMuted));
    }
}

// ── Itinerary tab ─────────────────────────────────────────────────────────
function _tasksRenderItinTab(container) {
    const itins = Array.isArray(savedItineraries) ? savedItineraries : [];
    if (!itins.length) { _tasksEmptyState(container, 'No itineraries yet'); return; }

    const today = new Date().toISOString().slice(0, 10);
    const done  = _tasksGetDone();
    const muted = _tasksGetMuted();
    const rows  = Array.isArray(travelSpots) ? travelSpots : [];

    const all = [];
    for (const itin of itins) {
        if (!Array.isArray(itin.days)) continue;
        const futureDays = itin.days.filter(d => d.date && d.date >= today && !d.isSuggested);
        if (!futureDays.length) continue;

        for (const day of futureDays) {
            for (const spot of (day.timeline || [])) {
                // Enrich with full row data for richer field scanning
                const full = rows.find(r => r.rowid != null && String(r.rowid) === String(spot.rowid))
                          || rows.find(r => r.spot_name === spot.spot_name);
                const spotData = full ? { ...spot, ...full } : spot;

                const action = _tasksComputeAction(spotData);
                if (!action) continue;

                const key = `itin:${itin.id}:${spot.rowid || spot.spot_name}`;
                all.push({
                    row: spotData, action, key,
                    isDone:  done.has(key),
                    isMuted: muted.has(key),
                    itinTitle: itin.title || 'Itinerary',
                    date: day.date,
                });
            }
        }
    }

    if (!all.length) { _tasksUpdatePendingNotch(0, 0); _tasksEmptyState(container, 'No upcoming itinerary items need action.'); return; }

    // Update pending notch
    _tasksUpdatePendingNotch(all.filter(i => !i.isDone && !i.isMuted).length, all.length);

    const visible = _tasksFilter === 'muted' ? all.filter(i => i.isMuted)
                                              : all.filter(i => !i.isMuted);
    if (!visible.length) {
        _tasksEmptyState(container, _tasksFilter === 'muted' ? 'No muted items' : 'All clear. Nothing pending!');
        return;
    }

    // Sort: pending first → earliest date → urgency desc, done last
    visible.sort((a, b) => {
        if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
        if (a.date   !== b.date)   return a.date < b.date ? -1 : 1;
        return b.action.urgency - a.action.urgency;
    });

    // Render grouped by itinerary name
    let lastTitle = null;
    for (const item of visible) {
        if (item.itinTitle !== lastTitle) {
            const header = document.createElement('div');
            header.className = 'flex items-center gap-1.5 px-1 pt-2 pb-1';
            header.innerHTML = `<i class="fa-solid fa-route text-pink-500/50 text-[9px]"></i>
                                <span class="text-[9px] font-black uppercase tracking-widest text-slate-500">${(item.itinTitle).replace(/</g,'&lt;')}</span>`;
            container.appendChild(header);
            lastTitle = item.itinTitle;
        }
        container.appendChild(_tasksBuildRow(item.row, item.key, item.action, item.isDone, item.isMuted));
    }
}

// ── Action handlers ───────────────────────────────────────────────────────
function tasksToggleDone(taskKey) {
    const done = _tasksGetDone();
    if (done.has(taskKey)) done.delete(taskKey); else done.add(taskKey);
    _tasksSaveDone(done);
    _renderTasksList();
}

function tasksToggleMute(taskKey) {
    const muted = _tasksGetMuted();
    if (muted.has(taskKey)) muted.delete(taskKey); else muted.add(taskKey);
    _tasksSaveMuted(muted);
    _renderTasksList();
}

// ── Tasks spot panel state ────────────────────────────────────────────────
let _tspCurrentRow    = null;  // full spot object currently shown in the panel
let _tspCurrentTaskKey = null; // task key for done-toggle from panel

/**
 * Open the self-contained spot detail panel inside #tasksDrawerBody.
 * Exact replica of revealMapItemDetailTrayHUD — same logic, tsp* element IDs.
 */
function tasksOpenTray(rowid) {
    const rows = Array.isArray(travelSpots) ? travelSpots : [];
    const row  = rows.find(r => String(r.rowid) === String(rowid));
    if (!row) return;

    _tspCurrentRow     = row;
    _tspCurrentTaskKey = String(row.rowid);

    const panel = document.getElementById('tasksSpotPanel');
    if (!panel) return;

    const isDone    = (row.status || '').toLowerCase().trim() === 'done';
    const isStarred = !!(
        row.priority === 'high' || row.isHigh ||
        (row.priority || '').toLowerCase() === 'starred'
    );
    const ticketLink = (row.ticket_url || '').trim();

    // ── Reset flip to front face ──────────────────────────────────────────
    const flipContainer = document.getElementById('tspFlipContainer');
    if (flipContainer) flipContainer.classList.remove('flipped');

    // ── Distance badge — computed on-the-fly ─────────────────────────────
    // travelSpots objects never carry distStr (that's only on the enriched
    // copies returned by getFilteredDatasetRows). Mirror the same logic.
    const distBadge = document.getElementById('tspDistanceBadge');
    if (distBadge) {
        const _dLat = row.latitude  ? String(row.latitude).trim()  : '';
        const _dLng = row.longitude ? String(row.longitude).trim() : '';
        const _hasLatLon = _dLat !== '' && _dLat !== '0' && _dLng !== '' && _dLng !== '0';
        let _distLabel, _distWarn = false;
        if (!_hasLatLon) {
            _distLabel = "<i class='fa-solid fa-triangle-exclamation'></i>";
            _distWarn  = true;
        } else if (!gpsStatusCachedBool) {
            _distLabel = "<i class='fa-solid fa-location-dot'></i>";
        } else {
            const _d = calculateDistance(userLat, userLon, parseFloat(_dLat), parseFloat(_dLng));
            _distLabel = _d < 1 ? `${Math.round(_d * 1000)}m` : `${_d.toFixed(1)}km`;
        }
        distBadge.innerHTML   = _distLabel;
        distBadge.className   = _distWarn
            ? 'text-xs font-mono font-bold bg-amber-500/10 text-amber-400 px-2 py-1 rounded-lg border border-amber-500/20 shrink-0 h-fit'
            : 'text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-pink-500/10 text-pink-400';
    }

    // ── Weather badge ─────────────────────────────────────────────────────
    const weatherBadge = document.getElementById('tspWeatherBadge');
    if (weatherBadge) {
        const wLat = row.latitude  ? String(row.latitude).trim()  : '';
        const wLng = row.longitude ? String(row.longitude).trim() : '';
        const hasCoords = wLat !== '' && wLat !== '0' && wLng !== '' && wLng !== '0';
        if (!hasCoords) {
            weatherBadge.className = 'inline-flex items-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-slate-900/50 text-slate-600';
            weatherBadge.innerHTML = '<i class="fa-solid fa-cloud text-[10px]" style="opacity:0.35"></i>' +
                                     '<i class="fa-solid fa-slash text-[7px]" style="margin-left:-0.55em;opacity:0.35"></i>';
        } else {
            weatherBadge.className = 'inline-flex items-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-sky-500/10 text-sky-300';
            weatherBadge.innerHTML = '<i class="fa-solid fa-cloud text-[10px] opacity-40"></i>';
            if (typeof fetchWeatherForCoords === 'function') {
                fetchWeatherForCoords(parseFloat(wLat), parseFloat(wLng)).then(w => {
                    const badge = document.getElementById('tspWeatherBadge');
                    if (w && badge) {
                        badge.innerHTML = `<i class="fa-solid ${w.iconClass} text-[10px]"></i><span>${w.temp}°</span>`;
                    }
                });
            }
        }
    }

    // ── City / category badge ─────────────────────────────────────────────
    const iconCls = (typeof getCategoryIconClass === 'function')
        ? getCategoryIconClass(row.category) : 'fa-location-dot text-slate-400';
    const cat  = row.category || 'General';
    const city = row.city     || 'Global';
    const cityBadge = document.getElementById('tspCityBadge');
    if (cityBadge) cityBadge.innerHTML =
        `<i class="fa-solid ${iconCls} text-[8px] shrink-0"></i>` +
        `<span class="uppercase tracking-wider">${cat}</span>` +
        `<span class="text-slate-700 font-normal">•</span>` +
        `<span class="uppercase tracking-wider text-slate-500">${city}</span>`;

    // ── Booked badge ──────────────────────────────────────────────────────
    const bookedBadge = document.getElementById('tspBookedBadge');
    if (bookedBadge) bookedBadge.classList.toggle(
        'hidden', (row.status || '').toLowerCase().trim() !== 'booked');

    // ── Spot title ────────────────────────────────────────────────────────
    const titleEl = document.getElementById('tspSpotTitle');
    if (titleEl) {
        titleEl.innerText = row.spot_name || 'Unnamed Destination';
        titleEl.className = isDone
            ? 'text-base font-black text-slate-500 line-through mt-2 truncate'
            : 'text-base font-black text-slate-200 mt-2 truncate';
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    const notesEl = document.getElementById('tspSpotNotes');
    if (notesEl) {
        notesEl.innerText = row.notes || 'No custom notes assigned';
        notesEl.className = isDone
            ? 'text-xs text-slate-500 leading-relaxed overflow-y-auto subtle-scrollbar max-h-[220px] line-through pr-1 select-none'
            : 'text-xs text-slate-400 leading-relaxed overflow-y-auto subtle-scrollbar max-h-[220px] pr-1 select-none';
    }

    // ── Reference button ──────────────────────────────────────────────────
    const refBtn = document.getElementById('tspOpenReferenceBtn');
    const refUrl = (row.instagram_url || '').trim();
    if (refBtn) refBtn.href = refUrl || '#';

    // ── Action button (Map view / no-location warning) ────────────────────
    const actionBtn     = document.getElementById('tspActionBtn');
    const directMapsUrl = (row.maps_url  ? String(row.maps_url)  : '').trim();
    const rawLat        = (row.latitude  ? String(row.latitude)  : '').trim();
    const rawLng        = (row.longitude ? String(row.longitude) : '').trim();
    const hasValidMapDest = (directMapsUrl !== '' && directMapsUrl !== 'N/A') ||
                            (rawLat !== '' && rawLat !== '0' && rawLng !== '' && rawLng !== '0');
    if (actionBtn) {
        if (!hasValidMapDest) {
            actionBtn.innerHTML = "<i class='fa-solid fa-triangle-exclamation'></i>";
            actionBtn.className = "px-6 bg-slate-950 border border-slate-800 text-amber-400 flex items-center justify-center rounded-xl text-sm font-black h-12 whitespace-nowrap";
        } else {
            actionBtn.innerHTML = "<i class='fa-solid fa-map mr-1.5 text-sm'></i> Directions";
            actionBtn.className = "px-4 bg-slate-950 border border-slate-800 text-slate-300 flex items-center justify-center rounded-xl text-xs font-bold h-12 whitespace-nowrap";
        }
    }

    // ── Ticket row ────────────────────────────────────────────────────────
    const ticketRow = document.getElementById('tspTicketRow');
    const ticketBtn = document.getElementById('tspTicketBtn');
    if (ticketRow) ticketRow.classList.toggle('hidden', !ticketLink);
    if (ticketBtn && ticketLink) ticketBtn.href = ticketLink;

    // ── Star glow on both faces ───────────────────────────────────────────
    const tspFaces = document.querySelectorAll(
        '#tspFlipContainer .flip-card-front-face, #tspFlipContainer .flip-card-back-face');
    tspFaces.forEach(face => {
        if (isStarred) face.classList.add('starred-gold-glow');
        else           face.classList.remove('starred-gold-glow');
    });

    // ── Done button ───────────────────────────────────────────────────────
    const doneBtn = document.getElementById('tspDoneToggleBtn');
    if (doneBtn) doneBtn.innerHTML = isDone
        ? '<i class="fa-solid fa-arrow-rotate-left mr-1"></i> Undo'
        : '<i class="fa-solid fa-check mr-1"></i> Mark Done';

    // ── Star button ───────────────────────────────────────────────────────
    const starBtn = document.getElementById('tspStarToggleBtn');
    if (starBtn) starBtn.innerHTML = isStarred
        ? '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar'
        : '<i class="fa-solid fa-star mr-1"></i> Star';

    // ── Back face: long description ───────────────────────────────────────
    const backDesc = document.getElementById('tspBackLongDescription');
    if (backDesc) backDesc.innerText = (row.long_description && row.long_description !== 'N/A')
        ? row.long_description : 'Disclaimer: Detailed background information unavailable.';

    // ── Back face: opening hours grid ────────────────────────────────────
    const hoursGrid = document.getElementById('tspBackHoursGrid');
    if (hoursGrid) {
        hoursGrid.innerHTML = '';
        const hoursRaw = (row.opening_hours || '').trim();
        if (hoursRaw && hoursRaw !== 'N/A') {
            hoursRaw.split(/[\n;]+/).forEach(tok => {
                if (!tok.trim()) return;
                const d = document.createElement('div');
                d.className = 'flex justify-between items-center py-0.5 border-b border-slate-900/40 last:border-0';
                d.innerHTML = `<span>${tok.trim()}</span>`;
                hoursGrid.appendChild(d);
            });
        } else {
            hoursGrid.innerHTML = '<div class="text-slate-500 italic text-[10px] p-1">Disclaimer: Schedule data unavailable.</div>';
        }
    }

    // ── Back face: booking warning card ──────────────────────────────────
    const warningCard = document.getElementById('tspBackBookingWarningCard');
    const warningText = document.getElementById('tspBackBookingValueText');
    const bookingStr  = (row.booking_requirement || '').trim();
    const hasBooking  = bookingStr && bookingStr !== 'N/A' && bookingStr.toLowerCase() !== 'none';
    if (warningText) warningText.innerText = bookingStr;
    if (warningCard) warningCard.classList.toggle('hidden', !hasBooking);

    // ── Done-state dimming (mirrors map tray exactly) ─────────────────────
    // Each interactive element is dimmed individually — no parent filter,
    // so the Undo / close buttons remain fully active.
    const _frontFace = flipContainer ? flipContainer.querySelector('.flip-card-front-face') : null;
    const flipBtn    = document.getElementById('tspFlipToBackBtn');

    if (isDone) {
        // Card background — subtle grey wash
        if (_frontFace) {
            _frontFace.style.backgroundColor = 'rgba(15,23,42,0.60)';
            _frontFace.style.borderColor     = 'rgba(100,116,139,0.18)';
        }
        // Badges — wash out
        if (cityBadge)    cityBadge.style.opacity    = '0.35';
        if (bookedBadge)  bookedBadge.style.opacity   = '0.35';
        if (weatherBadge) weatherBadge.style.opacity  = '0.30';
        if (distBadge)    distBadge.className =
            'text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-slate-800/20 text-slate-600 opacity-40';
        // Open Reference — strip gradient, grey + no-click
        if (refBtn) refBtn.className =
            'flex-1 bg-slate-800/40 border border-slate-700/30 text-slate-600 text-center text-xs font-bold py-3.5 rounded-xl flex items-center justify-center opacity-40 pointer-events-none';
        // Directions / Map — grey + no-click
        if (actionBtn) actionBtn.className =
            'px-4 bg-slate-800/30 border border-slate-700/20 text-slate-600 flex items-center justify-center rounded-xl text-xs font-bold h-12 whitespace-nowrap opacity-40 pointer-events-none';
        // Ticket row — hide when done
        if (ticketRow) ticketRow.classList.add('hidden');
        // Extra Info flip button — grey + no-click
        if (flipBtn) flipBtn.className =
            'text-slate-600 bg-slate-950/50 border border-slate-800/30 px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto opacity-40 pointer-events-none';
        // Star toggle — grey + no-click
        if (starBtn) starBtn.className =
            'text-xs px-3 py-2 font-black rounded-lg bg-slate-950/50 border border-slate-800/30 text-slate-600 opacity-40 pointer-events-none';
        // Undo — muted pink, fully active
        if (doneBtn) doneBtn.className =
            'text-xs px-3 py-2 font-bold rounded-lg bg-pink-600/10 border border-pink-600/20 text-pink-400 active:bg-pink-600/20';
    } else {
        // Restore all default styles
        if (_frontFace) {
            _frontFace.style.backgroundColor = '';
            _frontFace.style.borderColor     = '';
        }
        if (cityBadge)    cityBadge.style.opacity    = '';
        if (bookedBadge)  bookedBadge.style.opacity   = '';
        if (weatherBadge) weatherBadge.style.opacity  = '';
        // distBadge class already set correctly in the distance block above
        if (refBtn) refBtn.className =
            'flex-1 bg-gradient-to-r from-pink-600 to-purple-600 text-center text-xs font-bold py-3.5 rounded-xl text-white flex items-center justify-center shadow-lg';
        // actionBtn class already set correctly in the has/no-destination branch above
        if (flipBtn) flipBtn.className =
            'text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto active:bg-sky-500/20';
        if (starBtn) starBtn.className =
            'text-xs px-3 py-2 font-black rounded-lg bg-slate-950 border border-slate-800 text-amber-400 active:bg-slate-800';
        if (doneBtn) doneBtn.className =
            'text-xs px-3 py-2 font-bold rounded-lg bg-slate-950 border border-slate-800 text-slate-300 active:bg-slate-800';
    }

    // ── Show panel ────────────────────────────────────────────────────────
    panel.classList.remove('hidden');

    // ── Opening spring animation on the card (flip container) ────────────
    if (flipContainer) {
        flipContainer.classList.remove('tray-spring-in');
        void flipContainer.offsetWidth;  // force reflow
        flipContainer.classList.add('tray-spring-in');
        flipContainer.addEventListener('animationend',
            () => flipContainer.classList.remove('tray-spring-in'), { once: true });
    }
}

function tasksCloseSpotPanel() {
    // Clear state immediately — no interaction possible during the 240 ms animation
    _tspCurrentRow     = null;
    _tspCurrentTaskKey = null;

    const panel         = document.getElementById('tasksSpotPanel');
    const flipContainer = document.getElementById('tspFlipContainer');

    // ── Closing spring-out animation ──────────────────────────────────────
    if (flipContainer) {
        flipContainer.classList.remove('tray-spring-in');
        flipContainer.classList.add('tray-spring-out');
        flipContainer.addEventListener('animationend', () => {
            flipContainer.classList.remove('tray-spring-out');
            if (panel) panel.classList.add('hidden');
        }, { once: true });
    } else {
        if (panel) panel.classList.add('hidden');
    }
}

/** Done toggle from the spot panel — mirrors map tray done handler. */
function tasksSpotPanelToggleDone() {
    if (!_tspCurrentRow || !_tspCurrentTaskKey) return;
    const isDoneNow = (_tspCurrentRow.status || '').toLowerCase().trim() === 'done';
    // Toggle status on the shared row object (same reference held by travelSpots)
    _tspCurrentRow.status = isDoneNow ? 'Pending' : 'done';
    if (typeof updateCloudAction === 'function' && _tspCurrentRow.rowid) {
        updateCloudAction(_tspCurrentRow.rowid, 'update_status', isDoneNow ? 'Pending' : 'Done');
    }
    // Re-render task list badges in the background
    _renderTasksList();
    // Re-populate the panel so done-state styling updates (stays on front face)
    tasksOpenTray(_tspCurrentRow.rowid);
}

/** Star toggle from the spot panel — mirrors map tray star handler. */
function tasksSpotPanelToggleStar() {
    if (!_tspCurrentRow) return;
    const isStarredNow = !!(
        _tspCurrentRow.priority === 'high' || _tspCurrentRow.isHigh ||
        (_tspCurrentRow.priority || '').toLowerCase() === 'starred'
    );
    const newVal = isStarredNow ? 'Normal' : 'Starred';
    _tspCurrentRow.priority = newVal;
    if (typeof updateCloudAction === 'function' && _tspCurrentRow.rowid) {
        updateCloudAction(_tspCurrentRow.rowid, 'toggle_priority', newVal);
    }
    _renderTasksList();
    tasksOpenTray(_tspCurrentRow.rowid);
}

/** Close the drawer and navigate to the map tab showing the spot. */
function tasksSpotPanelViewOnMap() {
    if (!_tspCurrentRow) return;
    const spotRef = _tspCurrentRow;
    tasksCloseSpotPanel();
    toggleTasksDrawer(false);
    if (typeof switchMasterMenuDashboardTab === 'function') {
        switchMasterMenuDashboardTab('map');
    }
    setTimeout(() => {
        if (typeof revealMapItemDetailTrayHUD === 'function') {
            const starred = !!(
                spotRef.priority === 'high' || spotRef.isHigh ||
                (spotRef.priority || '').toLowerCase() === 'starred'
            );
            revealMapItemDetailTrayHUD(spotRef, starred);
        }
    }, 300);
}


// ================================================================
//  STARGAZING HEATMAP TOGGLE  (wires index.html UI → map.js engine)
// ================================================================

let _sgHeatmapOn = false;

function sgToggleHeatmap() {
    _sgHeatmapOn = !_sgHeatmapOn;

    const btn    = document.getElementById('sgHeatmapToggle');
    const thumb  = document.getElementById('sgHeatmapThumb');
    const radRow = document.getElementById('sgHeatmapRadiusRow');
    const status = document.getElementById('sgHeatmapStatus');

    if (_sgHeatmapOn) {
        // Style toggle ON
        if (btn)   { btn.style.background = 'rgba(124,58,237,0.35)'; btn.style.borderColor = 'rgba(139,92,246,0.6)'; }
        if (thumb) { thumb.style.transform = 'translateX(18px)'; thumb.style.background = '#a78bfa'; thumb.style.boxShadow = '0 0 8px rgba(167,139,250,0.7)'; }
        if (radRow) radRow.classList.remove('hidden');
        if (status) { status.classList.remove('hidden'); }

        const km = parseInt(document.getElementById('sgHeatmapRadiusSlider')?.value || '150', 10);

        // Close the weather drawer so the map is visible
        const drawerEl = document.getElementById('weatherDrawer');
        if (drawerEl && drawerEl.classList.contains('open')) {
            toggleWeatherDrawer?.();
        }

        // Activate overlay via map.js
        if (typeof sgActivateOverlay === 'function') {
            sgActivateOverlay(km);
        }

        // Show legend pill
        const pill = document.getElementById('sgHeatLegendPill');
        if (pill) pill.classList.remove('hidden');

        // Auto-enable score labels (% values) by default on every activation
        _sgLabelsOn = true;
        const labBtn   = document.getElementById('sgLabelsBtn');
        const labThumb = document.getElementById('sgLabelsThumb');
        if (labBtn)   { labBtn.classList.add('bg-emerald-600');   labBtn.classList.remove('bg-slate-700'); }
        if (labThumb) { labThumb.style.transform = 'translateX(1.25rem)'; }
        if (typeof sgSetShowLabels === 'function') sgSetShowLabels(true);

        // Hide status indicator after a moment (fetch is async in map.js)
        setTimeout(() => { if (status) status.classList.add('hidden'); }, 4000);

    } else {
        // Style toggle OFF
        if (btn)   { btn.style.background = '#1e1b2e'; btn.style.borderColor = 'rgba(139,92,246,0.25)'; }
        if (thumb) { thumb.style.transform = 'translateX(0)'; thumb.style.background = '#4c1d95'; thumb.style.boxShadow = '0 0 0 1px rgba(139,92,246,0.4)'; }
        if (radRow) radRow.classList.add('hidden');
        if (status) status.classList.add('hidden');

        // Hide legend pill + close drawer if open
        const pill = document.getElementById('sgHeatLegendPill');
        if (pill) pill.classList.add('hidden');
        sgCloseHeatmapControls();

        // Reset labels toggle back to OFF so it defaults ON again next activation
        _sgLabelsOn = false;
        const labBtn2   = document.getElementById('sgLabelsBtn');
        const labThumb2 = document.getElementById('sgLabelsThumb');
        if (labBtn2)   { labBtn2.classList.remove('bg-emerald-600');  labBtn2.classList.add('bg-slate-700'); }
        if (labThumb2) { labThumb2.style.transform = 'translateX(0.125rem)'; }

        if (typeof sgDeactivateOverlay === 'function') {
            sgDeactivateOverlay();
        }
    }
}

function sgOnRadiusInput(val) {
    const km    = parseInt(val, 10);
    const label = document.getElementById('sgHeatmapRadiusLabel');
    if (label) label.textContent = km + ' km';

    if (_sgHeatmapOn && typeof sgUpdateOverlayRadius === 'function') {
        sgUpdateOverlayRadius(km);
    }
}

// ── Heatmap Controls Drawer ───────────────────────────────────────────────

function sgOpenHeatmapControls() {
    const backdrop = document.getElementById('sgHeatControlsBackdrop');
    const drawer   = document.getElementById('sgHeatControlsDrawer');
    if (!drawer) return;
    backdrop?.classList.remove('hidden');
    drawer.classList.remove('hidden');
    // Animate slide-in
    drawer.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
    drawer.style.transform  = 'translateX(-100%)';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            drawer.style.transform = 'translateX(0)';
        });
    });
}

function sgCloseHeatmapControls() {
    const backdrop = document.getElementById('sgHeatControlsBackdrop');
    const drawer   = document.getElementById('sgHeatControlsDrawer');
    if (!drawer) return;
    drawer.style.transition = 'transform 0.18s cubic-bezier(0.4,0,0.2,1)';
    drawer.style.transform  = 'translateX(-100%)';
    setTimeout(() => {
        drawer.classList.add('hidden');
        backdrop?.classList.add('hidden');
        drawer.style.transform = '';
    }, 190);
}

let _sgLayerVisible = true;   // colour blobs visible by default

function sgToggleHeatmapLayerVisibility() {
    _sgLayerVisible = !_sgLayerVisible;
    const btn   = document.getElementById('sgLayerVisBtn');
    const thumb = document.getElementById('sgLayerVisThumb');
    const pill  = document.getElementById('sgHeatLegendPill');
    if (_sgLayerVisible) {
        // ── Layer turned ON ──────────────────────────────────────
        if (btn)   { btn.classList.add('bg-violet-600'); btn.classList.remove('bg-slate-700'); }
        if (thumb) { thumb.style.transform = 'translateX(1.25rem)'; }
        if (typeof sgSetCanvasVisible === 'function') sgSetCanvasVisible(true);
        if (pill && _sgHeatmapOn) pill.classList.remove('hidden');
    } else {
        // ── Layer turned OFF = turn off the whole heatmap ────────
        // Pre-reset the layer toggle back to ON so it's ready for the next activation
        _sgLayerVisible = true;
        if (btn)   { btn.classList.add('bg-violet-600'); btn.classList.remove('bg-slate-700'); }
        if (thumb) { thumb.style.transform = 'translateX(1.25rem)'; }
        // Fully shut down: closes drawer, hides pill, deactivates overlay,
        // resets the stargazing toggle in the weather drawer
        sgTurnOffHeatmap();
    }
}

let _sgLabelsOn = false;

function sgToggleHeatmapScoreLabels() {
    _sgLabelsOn = !_sgLabelsOn;
    const btn   = document.getElementById('sgLabelsBtn');
    const thumb = document.getElementById('sgLabelsThumb');
    if (_sgLabelsOn) {
        if (btn)   { btn.classList.add('bg-emerald-600'); btn.classList.remove('bg-slate-700'); }
        if (thumb) { thumb.style.transform = 'translateX(1.25rem)'; }
    } else {
        if (btn)   { btn.classList.remove('bg-emerald-600'); btn.classList.add('bg-slate-700'); }
        if (thumb) { thumb.style.transform = 'translateX(0.125rem)'; }
    }
    // Tell map.js to redraw with/without labels
    if (typeof sgSetShowLabels === 'function') sgSetShowLabels(_sgLabelsOn);
}

function sgTurnOffHeatmap() {
    sgCloseHeatmapControls();
    // Dismiss spot detail HUD if open
    if (typeof sgHideSpotDetail === 'function') sgHideSpotDetail();
    // If heatmap is on, toggle it off
    if (_sgHeatmapOn) {
        sgToggleHeatmap();
    }
}
