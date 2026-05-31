const APP_VERSION = "v5.0.10";
const API_URL = "https://script.google.com/macros/s/AKfycbyYTU_I0zel50EKpB767LmQ2NjeKudS93yv8-DYSYnBxaFS5_I1TWily79rOkMdGTu5IA/exec";
const BACKEND_URL = API_URL;

// ── OpenWeatherMap ───────────────────────────────────────────────────────────
// API key is stored in Google Apps Script Script Properties (key: OWM_API_KEY).
// The frontend never holds the key — it requests weather via the backend proxy.
const weatherCache        = new Map(); // key: "lat,lon" → { iconClass, temp, fetchedAt }
const WEATHER_CACHE_TTL   = 30 * 60 * 1000; // 30 minutes

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
let cachedHardwareString = "Unknown Device Model";
let gpsStatusCachedBool = false; 
let activeTabID = 'map';

let liveGpsWatchId = null; 
let speechBubbleHideTimer = null;
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
            if (select) select.innerHTML = '<option value="">Error: Server Unreachable</option>';
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

    if(!keyword) { alert("Provide a keyword title for the spot asset."); return; }
    if(!url && !mapsUrl) { alert("Please provide at least a Reference Link or a Google Maps Link."); return; }
    
    submitBtn.innerHTML = "<i class='fa-solid fa-arrows-rotate animate-spin mr-2'></i> Injecting into Sheet Database..."; 
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
    } catch(err) { alert("Submission timed out."); } 
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
    1: { title: 'Sending to AI…',      sub: 'Gemini is analyzing your travel data'    },
    2: { title: 'Response received',        sub: 'Verifying extracted data structure…' },
    3: { title: 'Saving to database…', sub: 'Writing your spot to Mastervalue'         },
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
        _aiAssistShowStatus('error', '⚠', 'Please paste or type some travel data before submitting.');
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
                ? 'Could not reach the server. Check your internet connection and try again.'
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
                'Database Write Failed',
                (json && json.error)
                    || 'AI processed your data but saving to the sheet failed. Your AI result is preserved — tap Retry to try again.',
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
            subEl.textContent = count + ' locations saved to MasterVault'
                + (newIds && newIds.length ? ' (IDs #' + newIds[0] + '–#' + newIds[newIds.length - 1] + ')' : '');
        } else {
            subEl.textContent = 'Saved to MasterVault'
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
    sheet.style.transform = 'translateY(100%)';
    setTimeout(() => overlay.classList.add('hidden'), 310);
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
    const isActive   = cityCount > 0 || catCount > 0 || itinActive;

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
    const segments = [];

    // 1. City
    if (cityCount === 1) segments.push(checkedCitiesStateArray[0]);

    // 2. All selected category names, comma-separated
    if (catCount > 0) {
        segments.push(checkedFilterStateArray.join(', '));
    }

    // 3. Itinerary title + Day
    if (itinActive) {
        const itin = (typeof savedItineraries !== 'undefined')
            ? savedItineraries.find(i => i.id === activeItineraryFilter.itineraryId)
            : null;
        if (itin) {
            segments.push(itin.title || 'Itinerary');
            // Resolve visual day number (1-based count of non-suggested days)
            if (typeof activeItineraryFilter.dayIndex === 'number') {
                const realDays = (itin.days || []).filter(d => !d?.isSuggested);
                const rawDay   = (itin.days || [])[activeItineraryFilter.dayIndex];
                const visIdx   = rawDay ? realDays.indexOf(rawDay) + 1 : activeItineraryFilter.dayIndex + 1;
                if (visIdx > 0) segments.push('Day ' + visIdx);
            }
        } else {
            segments.push('Itinerary');
        }
    }

    // Update badge count
    const total = cityCount + catCount + (itinActive ? 1 : 0);
    badge.textContent = total;
    badge.classList.remove('hidden');

    // ── Build label: measure first, then static or animated ─────────────────
    const fullText = segments.join(' · ');

    // Render a single invisible copy so we can measure its natural pixel width
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
                           + ' style="display:block;width:100%;">' + fullText + '</span>';
        } else {
            // Overflows — activate the looping ticker with pipe bookends
            const paddedText = '|&nbsp;&nbsp;' + fullText + '&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
            const dur = Math.max(8, Math.min(22, Math.round(fullText.length * 0.38)));
            wrap.innerHTML =
                '<div id="filterCapsuleTicker"'
              + ' style="display:flex;width:max-content;will-change:transform;'
              + 'animation:filterCapsuleScroll ' + dur + 's linear infinite;white-space:nowrap;">'
              + '<span class="text-[11px] font-bold">' + paddedText + '</span>'
              + '<span class="text-[11px] font-bold" aria-hidden="true">' + paddedText + '</span>'
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
        subtitle.textContent = `You're near ${count} saved ${word}, but ${verb} hidden by the active type filter.`;
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
// Maps OpenWeatherMap icon codes (e.g. "01d", "10n") → Font Awesome 6 Free class strings.
function getWeatherFAIconClass(owmIconCode) {
    const c = (owmIconCode || '').substring(0, 2);
    if (c === '01') return 'fa-sun text-yellow-400';
    if (c === '02') return 'fa-cloud-sun text-yellow-300';
    if (c === '03') return 'fa-cloud text-slate-300';
    if (c === '04') return 'fa-cloud text-slate-400';
    if (c === '09') return 'fa-cloud-showers-heavy text-blue-400';
    if (c === '10') return 'fa-cloud-rain text-blue-300';
    if (c === '11') return 'fa-cloud-bolt text-amber-400';
    if (c === '13') return 'fa-snowflake text-sky-300';
    if (c === '50') return 'fa-smog text-slate-300';
    return 'fa-cloud text-slate-400';
}

// Fetches current weather for the given lat/lon. Results are cached for 30 min.
// Returns { iconClass, temp } on success, or null on network error.
async function fetchWeatherForCoords(lat, lon) {
    const key    = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
    const cached = weatherCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < WEATHER_CACHE_TTL) return cached;
    try {
        // Route through the Apps Script backend — the OWM key never touches the client.
        const res  = await fetch(
            `${BACKEND_URL}?action=get_weather&lat=${lat}&lon=${lon}`
        );
        const data = await res.json();
        if (data.error) return null;
        const iconClass  = getWeatherFAIconClass(data.icon || '');
        const temp       = Math.round(data.temp       ?? 0);
        const feelsLike  = Math.round(data.feels_like ?? data.temp ?? 0);
        const result     = { iconClass, temp, feelsLike, fetchedAt: Date.now() };
        weatherCache.set(key, result);
        return result;
    } catch (e) {
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
        countLabel.textContent = n === 0 ? 'All spots are visible' : `${n} spot${n !== 1 ? 's' : ''} hidden by type filter`;
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
        
        let distanceOutputLabel = !hasLatLon ? "Missing Location" : (!gpsStatusCachedBool ? "<i class='fa-solid fa-location-dot mr-1'></i>GPS Off" : "");
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
            return checkedFilterStateArray.some(checkedCat => spotCats.includes(checkedCat.toLowerCase()));
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
            if (!hasCoordinates) {
                distHUD.className = "text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-amber-500/10 text-amber-400 border border-amber-500/20";
            } else {
                distHUD.className = "text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-pink-500/10 text-pink-400";
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
        triggerCuteSpeechBubbleHUD("Map data missing in database!", buttonElement, event);
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
                    <p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">No starred spots</p>
                    <p class="text-[11px] text-slate-600 font-medium">Star a spot to save it here.</p>
                    <button onclick="setPriorityFilterState(false)"
                            class="mt-5 px-5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-[10px] font-black text-slate-400 active:bg-slate-800 transition-colors">
                        Show All
                    </button>
                </div>`;
        } else {
            // Generic empty state (city filter, search, etc.)
            emptyDiv.innerHTML = `
                <div class="text-center text-slate-600 py-12 text-xs">
                    No entries loaded matching these selection profiles.
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
            hoursHTMLTokens = `<div class="text-slate-600 italic text-[10px]">Schedule unpopulated.</div>`;
        }

        const cardWrapper = document.createElement('div');
        cardWrapper.id = uniqueCardContainerId;
        cardWrapper.dataset.rowid = String(spot.rowid); // used by renderListAnimated FLIP engine
        cardWrapper.className = "dynamic-card-node w-full min-h-[260px] h-auto flip-perspective-container transform transition-transform duration-200 shrink-0 block";

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
                        <div class="flex justify-between items-start gap-2">
                            <div class="max-w-[70%]">
                                <span class="inline-flex items-center gap-1.5 text-[9px] px-2 py-1 rounded-lg bg-slate-950 text-slate-400 font-bold border border-slate-800 ${isDone ? 'opacity-40' : ''}"><i class="fa-solid ${catIconClass} text-[8px] shrink-0"></i><span class="uppercase tracking-wider">${spot.category || 'General'}</span><span class="text-slate-700 font-normal">•</span><span class="uppercase tracking-wider text-slate-500">${spot.city || 'Global'}</span></span>
                                <h3 class="text-base font-bold ${isDone ? 'text-slate-500 line-through' : 'text-slate-200'} mt-1.5 truncate">${spot.spot_name}</h3>
                            </div>
                            <div class="flex items-stretch gap-1.5 shrink-0">
                                <span id="weather-badge-${spot.rowid}" class="inline-flex items-center justify-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-lg min-w-[3.25rem] ${weatherBadgeClass} ${isDone ? 'opacity-30' : ''}">${weatherBadgeInitHTML}</span>
                                <span id="dist-badge-${spot.rowid}" class="text-xs font-mono font-bold px-2 py-1 rounded-lg h-fit ${isDone ? 'bg-slate-800/20 text-slate-600 opacity-40' : (!hasCoordinates ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-pink-500/10 text-pink-400')}">${spot.distStr}</span>
                            </div>
                        </div>
                        <div class="mt-3 bg-slate-950/40 p-2.5 rounded-xl border border-slate-900/60 min-h-[90px] overflow-hidden">
                            <p class="text-xs ${isDone ? 'text-slate-500 line-through' : 'text-slate-400'} leading-relaxed max-h-16 overflow-hidden pr-1" style="touch-action: pan-y;" ontouchstart="handleNoteTouchStartEvent(event, this.innerText)" ontouchmove="handleNoteTouchMoveEvent(event)" ontouchend="handleNoteTouchEndEvent(event)" onmousedown="handleNoteMouseDownEvent(event, this.innerText)" onmousemove="handleNoteMouseMoveEvent(event)" onmouseup="handleNoteMouseUpEvent(event)">${spot.notes || 'No custom notes.'}</p>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2 mt-3">
                        <div class="flex gap-2">
                            <a href="${spot.instagram_url || '#'}" target="_blank" class="flex-1 text-center text-xs font-bold py-3 rounded-xl flex items-center justify-center ${isDone ? 'bg-slate-800/40 border border-slate-700/30 text-slate-600 opacity-40 pointer-events-none' : 'bg-gradient-to-r from-pink-600 to-purple-600 text-white shadow-lg'}">Open Reference</a>
                            <button data-row-id="${spot.rowid}" onclick="handleAdaptiveDirectionClick(this, event)" class="px-4 flex items-center justify-center rounded-xl text-xs font-bold whitespace-nowrap h-12 ${isDone ? 'bg-slate-800/30 border border-slate-700/20 text-slate-600 flex-1 opacity-40 pointer-events-none' : (!hasValidMapDestination ? 'bg-slate-950 border border-slate-800 text-amber-400 text-sm font-black w-14 shrink-0' : 'bg-slate-950 border border-slate-800 text-slate-300 flex-1')}">
                                ${isDone ? '<i class="fa-solid fa-map mr-1.5 text-sm"></i> Directions' : (!hasValidMapDestination ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-map mr-1.5 text-sm"></i> Directions')}
                            </button>
                        </div>
                        ${ticketLink.trim() !== "" && !isDone ? `<a href="${ticketLink}" target="_blank" class="w-full mt-1 bg-emerald-600 text-center text-xs font-bold py-2.5 rounded-xl text-white block">📄 View Ticket Details</a>` : ''}
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
                        <p class="text-slate-300 leading-relaxed font-medium bg-slate-950/50 border border-slate-950 p-2.5 rounded-xl">${(spot.long_description && spot.long_description !== "N/A") ? spot.long_description : 'No background summary recorded.'}</p>
                        
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
        <span class="text-[9px] font-bold tracking-[0.15em] uppercase text-slate-600 whitespace-nowrap">End of filtered list</span>
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

    if (show) {
        const switchUserBox    = document.getElementById('settingsSwitchUserDropdown');
        const mainSelectionBox = document.getElementById('user-dropdown-select');

        if (switchUserBox && mainSelectionBox) {
            // If the settings dropdown somehow still has no options (extremely rare —
            // cache was empty AND fetch not yet done), mirror the login dropdown as a
            // last-resort fallback.
            if (switchUserBox.options.length <= 1 && mainSelectionBox.options.length > 1) {
                switchUserBox.innerHTML = mainSelectionBox.innerHTML;
            }
            if (currentUser) switchUserBox.value = currentUser;
        }
        // Reset rename input and validation state each time settings opens
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
        syncText.innerText = "OFFLINE MODE";
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
    _sConfirmShowLoading  = !!cfg.showLoading;
    _sConfirmLoadingLabel = cfg.loadingLabel || cfg.btnLabel || 'Processing';
    document.getElementById('settingsConfirmModal').classList.remove('hidden');
}

function closeSettingsConfirmModal() {
    // Always clean up loading state before hiding
    _exitConfirmModalLoadingState();
    document.getElementById('settingsConfirmModal').classList.add('hidden');
    _sConfirmCb          = null;
    _sConfirmShowLoading  = false;
    _sConfirmLoadingLabel = '';
}

function cancelSettingsConfirmModal() {
    // X button dismiss — user cancelled, navigate back to settings drawer.
    // Guard: do nothing if currently in a loading state (X is visually disabled
    // but belt-and-suspenders here in case it fires via keyboard or AT).
    if (_sConfirmDotsInterval !== null) return;
    closeSettingsConfirmModal();
    toggleSettingsMenu(true);
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
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>Purging...';
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
            openSettingsResultModal('success', 'Logs Purged', 'Google Sheets server records and log metrics have been fully scrubbed.');
        } else if (outcome.result === 'auth_failed') {
            openSettingsResultModal('error', 'Access Denied', 'Invalid Admin Password. The purge request was rejected.');
        } else {
            openSettingsResultModal('error', 'Server Error', outcome.error || 'Unknown response received from cloud ecosystem.');
        }
    } catch (err) {
        console.error('Purge failure:', err);
        closeSettingsPurgeModal();
        openSettingsResultModal('error', 'Connection Failed', 'Communication crash. Verify your web app script setup.');
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

            toggleSettingsMenu(false);
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
        body:  `Change your identity from "${oldName}" to "${newName}"?`,
        btnLabel: 'Update Profile',
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
            toggleSettingsMenu(false);
            // Only re-fetch itineraries (spots don't change on rename)
            if (typeof loadUserItineraries === 'function') loadUserItineraries();
            openSettingsResultModal('success', 'Profile Updated', `Identity profile updated to "${newName}". Syncing resources...`);
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
        body:  'Your active profile context will be dropped and the local offline registry cache will be fully reset.',
        btnLabel: 'Logout & Reset',
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
     });
};