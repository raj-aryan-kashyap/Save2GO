// ── Itinerary state globals ──────────────────────────────────────────────────
// All itinerary logic shares these; they are intentionally module-level so
// every function in this file (and callers from aap.js / map.js) can read them.

let savedItineraries         = JSON.parse(localStorage.getItem('compass_saved_itineraries')) || [];
let itineraryItems           = JSON.parse(localStorage.getItem('compass_itinerary_cache'))    || { '1': [], '2': [], '3': [] };
let activeItineraryId        = null;
let activeItineraryDayTracker = 0;
let itinSelectedCategorySequence = [];
let itinPacingMode           = 'max';
let selectedMultiDatesArray  = [];
let calMonth                 = new Date().getMonth();
let calYear                  = new Date().getFullYear();
let finalGeneratedSequenceRowIds = [null, null, null, null];
let isEditingMode            = false;
let editingItinId            = null;
let pendingConfirmCallback   = null;

// Duration (minutes) and operating hours per category keyword.
// Used by getCategoryLogic() when scheduling time slots.
const CATEGORY_DEFAULTS = {
    'food':        { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 22 },
    'restaurant':  { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 22 },
    'cafe':        { durationMax: 45,  durationRelaxed: 75,  open:  7, close: 21 },
    'coffee':      { durationMax: 45,  durationRelaxed: 60,  open:  7, close: 20 },
    'attraction':  { durationMax: 90,  durationRelaxed: 120, open:  9, close: 18 },
    'museum':      { durationMax: 90,  durationRelaxed: 120, open:  9, close: 17 },
    'gallery':     { durationMax: 60,  durationRelaxed: 90,  open: 10, close: 18 },
    'shopping':    { durationMax: 60,  durationRelaxed: 90,  open: 10, close: 21 },
    'market':      { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 20 },
    'park':        { durationMax: 60,  durationRelaxed: 90,  open:  6, close: 20 },
    'garden':      { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 18 },
    'beach':       { durationMax: 120, durationRelaxed: 180, open:  6, close: 20 },
    'nature':      { durationMax: 90,  durationRelaxed: 120, open:  6, close: 19 },
    'hotel':       { durationMax: 30,  durationRelaxed: 30,  open:  0, close: 24 },
    'bar':         { durationMax: 60,  durationRelaxed: 90,  open: 17, close: 24 },
    'nightlife':   { durationMax: 90,  durationRelaxed: 120, open: 20, close: 24 },
    'club':        { durationMax: 90,  durationRelaxed: 120, open: 21, close: 24 },
    'sport':       { durationMax: 90,  durationRelaxed: 120, open:  8, close: 20 },
    'spa':         { durationMax: 90,  durationRelaxed: 120, open:  9, close: 20 },
    'default':     { durationMax: 60,  durationRelaxed: 90,  open:  9, close: 18 }
};

// ── Itinerary weather cache ──────────────────────────────────────────────────
// Keyed by lowercase city name. Each entry: { days: [{date, iconClass, temp}], fetchedAt }
const itinWeatherCache    = new Map();
const ITIN_WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetches a 5-day weather forecast for a city via the Apps Script proxy.
 * Returns { days: [{date, iconClass, temp}] } from cache or network,
 * or null if the city is invalid / the network request fails.
 */
async function fetchItineraryForecast(city) {
    if (!city || !city.trim()) return null;
    const cacheKey = city.trim().toLowerCase();
    const cached   = itinWeatherCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < ITIN_WEATHER_CACHE_TTL) return cached;

    try {
        const base = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL
                   : (typeof API_URL    !== 'undefined') ? API_URL : null;
        if (!base) return null;

        const res  = await fetch(`${base}?action=get_forecast&city=${encodeURIComponent(city.trim())}`);
        const data = await res.json();
        if (data.error || !Array.isArray(data.days) || data.days.length === 0) return null;

        const result = {
            days:      data.days.map(d => ({
                date:      d.date,
                iconClass: (typeof getWeatherFAIconClass === 'function')
                               ? getWeatherFAIconClass(d.icon)
                               : 'fa-cloud text-slate-400',
                temp:      d.temp,
            })),
            fetchedAt: Date.now(),
        };
        itinWeatherCache.set(cacheKey, result);
        return result;
    } catch (e) {
        return null;
    }
}

// ── Missing utility functions ────────────────────────────────────────────────

/** Returns the currently active itinerary object or null. */
function getActiveItinerary() {
    if (!activeItineraryId) return null;
    return savedItineraries.find(i => i.id === activeItineraryId) || null;
}

/**
 * Validates the itinerary creation form on every keystroke in the title field
 * or change to any other required field.
 *
 * Rules for the title:
 *   • Empty      → hide both warnings, button disabled
 *   • < 3 chars  → yellow "Minimum 3 characters" warning, button disabled
 *   • ≥ 3 chars  → check for case-insensitive duplicate among savedItineraries
 *                  for the current user (scoped by itin.user === currentUser):
 *                  - duplicate found → red "already exists" warning, button disabled
 *                  - no duplicate    → clear both warnings, enable if all other
 *                                      fields are also complete
 */
function validateItineraryForm() {
    const btn           = document.getElementById('buildItinerarySubmitBtn');
    const minCharWarn   = document.getElementById('itinTitleMinCharWarning');
    const dupWarn       = document.getElementById('itinTitleDuplicateWarning');
    if (!btn || !minCharWarn || !dupWarn) return;

    const title = (document.getElementById('itin-new-name')?.value || '').trim();
    const city  = document.getElementById('itin-new-city')?.value  || '';
    const otherFieldsReady = city && selectedMultiDatesArray.length > 0 && itinSelectedCategorySequence.length > 0;

    // Helper: put the button into disabled state
    function _disable() {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'grayscale', 'cursor-not-allowed');
        btn.classList.remove('active:scale-95');
    }
    // Helper: put the button into enabled state
    function _enable() {
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'grayscale', 'cursor-not-allowed');
        btn.classList.add('active:scale-95');
    }

    // ── Empty ────────────────────────────────────────────────────────────────
    if (title.length === 0) {
        minCharWarn.classList.add('hidden');
        dupWarn.classList.add('hidden');
        _disable();
        return;
    }

    // ── Under 3 chars ────────────────────────────────────────────────────────
    if (title.length < 3) {
        minCharWarn.classList.remove('hidden');
        dupWarn.classList.add('hidden');
        _disable();
        return;
    }

    // ── 3+ chars — check for duplicate ──────────────────────────────────────
    minCharWarn.classList.add('hidden');

    const lowerTitle  = title.toLowerCase();
    const user        = typeof currentUser !== 'undefined' ? currentUser : null;
    const isDuplicate = (savedItineraries || []).some(itin => {
        const sameUser  = !user || !itin.user || itin.user === user;
        const sameTitle = (itin.title || '').trim().toLowerCase() === lowerTitle;
        // When editing, exclude the itinerary currently being edited
        const notSelf   = !isEditingMode || itin.id !== editingItinId;
        return sameUser && sameTitle && notSelf;
    });

    if (isDuplicate) {
        dupWarn.classList.remove('hidden');
        _disable();
        return;
    }

    // ── All title rules pass — gate on remaining fields ───────────────────
    dupWarn.classList.add('hidden');
    if (otherFieldsReady) {
        _enable();
    } else {
        _disable();
    }
}

/**
 * Resets the title validation UI to its initial (empty / disabled) state.
 * Call this every time the creation drawer is opened or closed.
 */
function resetItineraryTitleValidationUI() {
    const nameInput   = document.getElementById('itin-new-name');
    const minCharWarn = document.getElementById('itinTitleMinCharWarning');
    const dupWarn     = document.getElementById('itinTitleDuplicateWarning');
    const btn         = document.getElementById('buildItinerarySubmitBtn');
    if (nameInput)   nameInput.value = '';
    if (minCharWarn) minCharWarn.classList.add('hidden');
    if (dupWarn)     dupWarn.classList.add('hidden');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'grayscale', 'cursor-not-allowed');
        btn.classList.remove('active:scale-95');
    }
}

/**
 * Fetches all itineraries for the current user from the ItineraryVault cloud
 * sheet, merges with any locally-stored itineraries that haven't been synced
 * yet, and updates both the in-memory array and localStorage.
 *
 * Falls back to localStorage-only if the network request fails.
 */
async function loadUserItineraries() {
    const localData = JSON.parse(localStorage.getItem('compass_saved_itineraries')) || [];
    const user      = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;

    if (!user) {
        savedItineraries = localData;
        return;
    }

    try {
        const backendBase = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL : (typeof API_URL !== 'undefined' ? API_URL : null);
        if (!backendBase) { savedItineraries = localData; return; }

        const res      = await fetch(`${backendBase}?action=get_itineraries&user=${encodeURIComponent(user)}`);
        const cloudRows = await res.json();

        if (Array.isArray(cloudRows) && cloudRows.length > 0) {
            // Each cloud row: { user, itin_id, data: <itinerary object>, last_updated }
            const cloudItins = cloudRows.map(row => ({
                ...row.data,
                id:   row.itin_id || (row.data && row.data.id),
                user: row.user    || (row.data && row.data.user),
            }));

            // Keep any local itineraries that haven't been uploaded to cloud yet
            // (cloud is source of truth; local-only items are appended)
            const cloudIds  = new Set(cloudItins.map(i => i.id));
            const localOnly = localData.filter(i => !cloudIds.has(i.id));

            savedItineraries = [...cloudItins, ...localOnly];
        } else {
            // Cloud returned nothing — trust local data (may be first run or offline)
            savedItineraries = localData;
        }
    } catch (err) {
        console.warn('[ItinerarySync] cloud fetch failed, using localStorage:', err);
        savedItineraries = localData;
    }

    // Keep localStorage in sync with whatever we resolved
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
}

/**
 * Persists a single itinerary to the ItineraryVault cloud sheet and updates
 * localStorage.  `action` must be 'save' or 'delete'.
 *
 * Uses mode:'no-cors' (same pattern as all other backend POSTs in this app)
 * so the response body is opaque — errors are silent to the user but logged.
 */
async function syncItineraryToCloud(itin, action) {
    // Always update localStorage immediately so the UI stays consistent even
    // if the network call fails or the user is offline.
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));

    if (!itin || !itin.id) return;
    const user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    if (!user) return; // nothing to key the cloud row against without a user

    const backendBase = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL : (typeof API_URL !== 'undefined' ? API_URL : null);
    if (!backendBase) return;

    const payload = {
        action:  'sync_itinerary',
        user,
        itin_id: itin.id,
        method:  action === 'delete' ? 'delete' : 'save',
        data:    action !== 'delete' ? itin : undefined,
    };

    try {
        await fetch(backendBase, {
            method:  'POST',
            mode:    'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
    } catch (err) {
        console.warn('[ItinerarySync] cloud POST failed (offline?):', err);
    }
}

/**
 * Opens the creation drawer pre-filled with an existing itinerary's data
 * so the user can edit and re-generate it.
 */
function openEditItineraryModal(itinId) {
    const itin = savedItineraries.find(i => i.id === itinId);
    if (!itin) return;
    isEditingMode = true;
    editingItinId = itinId;
    openItineraryCreationDrawerForm();
    const nameEl = document.getElementById('itin-new-name');
    if (nameEl) nameEl.value = itin.title;
    if (itin.config) {
        selectedMultiDatesArray      = [...(itin.config.dates      || [])];
        itinSelectedCategorySequence = [...(itin.config.categories || [])];
        if (itin.config.pacing) setItinPacingMode(itin.config.pacing);
        const startEl = document.getElementById('itin-new-start');
        const endEl   = document.getElementById('itin-new-end');
        if (startEl && itin.config.start != null) startEl.value = minutesToHHMM(itin.config.start);
        if (endEl   && itin.config.end   != null) endEl.value   = minutesToHHMM(itin.config.end);
    }
    updateMultiDateUILabel();
    renderItineraryFormCategoriesAndQueryRows();
    validateItineraryForm();
}

/**
 * Stub for the inline spot-picker drawer (to be implemented).
 * Shows a friendly toast until the full UI is wired up.
 */
function openInlineUnscheduledSpotDrawer() {
    if (typeof showFormErrorSpeechBubble === 'function') {
        showFormErrorSpeechBubble(['Spot picker coming soon!']);
    }
}

// ── End of globals / stubs block ─────────────────────────────────────────────

function isItineraryCacheWhollyEmpty() {
    return (!itineraryItems["1"] || itineraryItems["1"].length === 0) &&
           (!itineraryItems["2"] || itineraryItems["2"].length === 0) &&
           (!itineraryItems["3"] || itineraryItems["3"].length === 0);
}

function forceClearItinerarySavedCache() {
    if (!confirm("Force clear saved itinerary data? All timeline maps will be reset.")) return;
    itineraryItems = { "1": [], "2": [], "3": [] };
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    if(typeof toggleSettingsMenu === 'function') toggleSettingsMenu(false);
    renderItineraryMasterDashboardWorkspace();
    alert("Itinerary registry wiped.");
}

function toggleItineraryChildDropdownMenu(event) {
    if (event) event.stopPropagation();
    const bucket = document.getElementById('itineraryChildSelectorMenuBucket');
    const caret = document.getElementById('itinChildCaretNode');
    if (!bucket || !caret) return;
    if (bucket.classList.contains('hidden')) {
        bucket.classList.remove('hidden'); caret.innerText = "▼";
    } else {
        bucket.classList.add('hidden'); caret.innerText = "▶";
    }
}

function buildItinerarySubMenuChecklist() {
    const bucket = document.getElementById('itineraryChildSelectorMenuBucket');
    if (!bucket) return;
    bucket.innerHTML = `
        <button onclick="injectActiveSpotToItineraryDay(1, null, event)" class="w-full text-left text-[10px] py-1 px-2 hover:bg-slate-800 text-slate-300 font-semibold rounded block">→ Schedule Day 1</button>
        <button onclick="injectActiveSpotToItineraryDay(2, null, event)" class="w-full text-left text-[10px] py-1 px-2 hover:bg-slate-800 text-slate-300 font-semibold rounded block">→ Schedule Day 2</button>
        <button onclick="injectActiveSpotToItineraryDay(3, null, event)" class="w-full text-left text-[10px] py-1 px-2 hover:bg-slate-800 text-slate-300 font-semibold rounded block">→ Schedule Day 3</button>
    `;
}

function assembleTrayInlineAssignorRow() {
    const container = document.getElementById('trayItineraryBtnDeck');
    const actionBtn = document.getElementById('trayActionBtn');
    if (!container || !actionBtn) return;
    const currentRowId = actionBtn.getAttribute('data-row-id');
    if (!currentRowId) { container.innerHTML = ''; return; }
    container.innerHTML = `
        <button onclick="injectActiveSpotToItineraryDay(1, ${currentRowId}, event)" class="px-2 py-1 bg-slate-900 border border-slate-800 rounded font-black text-[9px] text-pink-400 active:bg-slate-850">D1</button>
        <button onclick="injectActiveSpotToItineraryDay(2, ${currentRowId}, event)" class="px-2 py-1 bg-slate-900 border border-slate-800 rounded font-black text-[9px] text-pink-400 active:bg-slate-850">D2</button>
        <button onclick="injectActiveSpotToItineraryDay(3, ${currentRowId}, event)" class="px-2 py-1 bg-slate-900 border border-slate-800 rounded font-black text-[9px] text-pink-400 active:bg-slate-850">D3</button>
    `;
}

function injectActiveSpotToItineraryDay(dayIndex, fallbackRowId, event) {
    if (event) event.stopPropagation();
    let resolvedRowId = fallbackRowId;
    if (!resolvedRowId) {
        const actionBtn = document.getElementById('trayActionBtn');
        if (actionBtn) resolvedRowId = actionBtn.getAttribute('data-row-id');
    }
    if (!resolvedRowId) { alert("Select a location asset card payload first."); return; }
    
    const numericId = parseInt(resolvedRowId);
    if (!itineraryItems[dayIndex]) itineraryItems[dayIndex] = [];
    if (itineraryItems[dayIndex].includes(numericId)) {
        alert(`Asset row #${numericId} is already mapped to Day ${dayIndex}.`); return;
    }
    
    itineraryItems[dayIndex].push(numericId);
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    renderItineraryMasterDashboardWorkspace();
    
    const notificationTarget = event ? event.target : document.body;
    if(typeof triggerCuteSpeechBubbleHUD === 'function') triggerCuteSpeechBubbleHUD(`Added to Day ${dayIndex}!`, notificationTarget, event);
}

function selectActiveItineraryDayIndex(dayIndex) {
    activeItineraryDayTracker = dayIndex;
    const container = document.getElementById('itineraryMasterDaySelectorDeck');
    if (container) {
        const buttons = container.querySelectorAll('button');
        buttons.forEach((btn, idx) => {
            if ((idx + 1) === dayIndex) {
                btn.className = "px-3 py-1.5 rounded-lg text-xs font-black transition-all bg-pink-600 text-white shadow";
            } else {
                btn.className = "px-3 py-1.5 rounded-lg text-xs font-black transition-all bg-slate-900 text-slate-400 border border-slate-800";
            }
        });
    }
    renderItineraryMasterDashboardWorkspace();
}

function clearItineraryDay() {
    if (!confirm(`Flush all matrix sequence records mapped to Day ${activeItineraryDayTracker}?`)) return;
    itineraryItems[activeItineraryDayTracker] = [];
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    renderItineraryMasterDashboardWorkspace();
}

function removeSpotFromItineraryDay(rowId) {
    if (!itineraryItems[activeItineraryDayTracker]) return;
    itineraryItems[activeItineraryDayTracker] = itineraryItems[activeItineraryDayTracker].filter(id => id !== parseInt(rowId));
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    renderItineraryMasterDashboardWorkspace();
}

function toggleItineraryWizardModalTray(show) {
    document.getElementById('itineraryWizardModalTray').classList.toggle('hidden', !show);
}

function openItineraryAutoSequenceWizard() {
    toggleItineraryWizardModalTray(true);
    const container = document.getElementById('wizardBlueprintSlotsContainer');
    if (!container) return;
    container.innerHTML = '';
    finalGeneratedSequenceRowIds = [null, null, null, null];

    itinWizardSequenceBlueprint.forEach((categoryLabel, slotIndex) => {
        const rowWrapper = document.createElement('div');
        rowWrapper.className = "space-y-1 bg-slate-950 p-2 rounded-xl border border-slate-850 flex flex-col";
        rowWrapper.innerHTML = `<span class="text-[9px] font-black tracking-wide text-slate-400">Slot ${slotIndex + 1}: ${categoryLabel}</span>`;
        
        const selector = document.createElement('select');
        selector.className = "w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-[11px] font-semibold text-slate-200 focus:outline-none focus:border-pink-500 h-9";
        selector.onchange = function() { finalGeneratedSequenceRowIds[slotIndex] = this.value ? parseInt(this.value) : null; };
        
        const defaultOpt = document.createElement('option');
        defaultOpt.value = ""; defaultOpt.innerText = "-- Select Match Candidate --";
        selector.appendChild(defaultOpt);

        const lowerBlueprint = categoryLabel.toLowerCase();
        travelSpots.forEach(spot => {
            const spotCat = (spot.category || "").toLowerCase();
            if (spotCat.includes(lowerBlueprint) || (lowerBlueprint.includes("activity") && spotCat.includes("shop"))) {
                const opt = document.createElement('option');
                opt.value = spot.rowid; opt.innerText = `[${spot.city || 'Global'}] ${spot.spot_name || 'Unnamed'}`;
                selector.appendChild(opt);
            }
        });
        
        rowWrapper.appendChild(selector);
        container.appendChild(rowWrapper);
    });
}

function saveGeneratedWizardSequenceToActiveDay() {
    if (!itineraryItems[activeItineraryDayTracker]) itineraryItems[activeItineraryDayTracker] = [];
    let injectionCounter = 0;

    finalGeneratedSequenceRowIds.forEach(rowId => {
        if (rowId && !itineraryItems[activeItineraryDayTracker].includes(rowId)) {
            itineraryItems[activeItineraryDayTracker].push(rowId);
            injectionCounter++;
        }
    });

    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    toggleItineraryWizardModalTray(false);
    renderItineraryMasterDashboardWorkspace();
    alert(`Surgically compiled matrix track. Injecting ${injectionCounter} sequence units into Day ${activeItineraryDayTracker}.`);
}

function toggleItineraryCreationDrawerForm(show) {
    const modal = document.getElementById('itineraryCreationDrawerModal');
    if (modal) modal.classList.toggle('hidden', !show);
}

function openItineraryCreationDrawerForm() {
    toggleItineraryCreationDrawerForm(true);
    resetItineraryTitleValidationUI();
    itinSelectedCategorySequence = [];
    
    let defaultFoodCategory = 'Food Spot'; 
    if (travelSpots && travelSpots.length > 0) {
        let uniqueCategories = new Set();
        travelSpots.forEach(spot => { if (spot.category) spot.category.split(',').forEach(c => uniqueCategories.add(c.trim())); });
        for (let cat of uniqueCategories) {
            if (cat.toLowerCase().includes('food')) {
                defaultFoodCategory = cat;
                break;
            }
        }
    }
    itinSelectedCategorySequence = [defaultFoodCategory];
    
    const selectCity = document.getElementById('itin-new-city');
    if (selectCity) {
        selectCity.innerHTML = '';
        let citySet = new Set();
        travelSpots.forEach(spot => { if (spot.city) citySet.add(spot.city.trim()); });
        citySet.forEach(city => {
            const opt = document.createElement('option');
            opt.value = city; opt.innerText = city;
            selectCity.appendChild(opt);
        });
    }
    
    updateMultiDateUILabel();
    renderItineraryFormCategoriesAndQueryRows();
}

function setItinPacingMode(mode) {
    itinPacingMode = mode;
    const maxBtn = document.getElementById('itinPacingToggleMax');
    const relBtn = document.getElementById('itinPacingToggleRelaxed');
    if(mode === 'max') {
        maxBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-amber-400 bg-amber-500/10 flex items-center justify-center gap-1.5 transition-colors";
        relBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-slate-500 flex items-center justify-center gap-1.5 transition-colors bg-transparent";
    } else {
        maxBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-slate-500 flex items-center justify-center gap-1.5 transition-colors bg-transparent";
        relBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-amber-400 bg-amber-500/10 flex items-center justify-center gap-1.5 transition-colors";
    }
}

function openMultiDatePickerModal() {
    document.getElementById('itinCalendarModal').classList.remove('hidden');
    renderMultiDateCalendarGrid();
}

function changeMultiCalendarMonth(offset) {
    calMonth += offset;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    else if (calMonth > 11) { calMonth = 0; calYear++; }
    renderMultiDateCalendarGrid();
}

function renderMultiDateCalendarGrid() {
    const grid = document.getElementById('calendarDaysGrid');
    const title = document.getElementById('calendarMonthTitle');
    if (!grid) return;
    grid.innerHTML = ''; 
    title.innerText = `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][calMonth]} ${calYear}`;

    for (let i = 0; i < new Date(calYear, calMonth, 1).getDay(); i++) {
        grid.innerHTML += `<div></div>`;
    }

    for (let i = 1; i <= new Date(calYear, calMonth + 1, 0).getDate(); i++) {
        let dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
        let isSelected = selectedMultiDatesArray.includes(dateStr);
        let btnClass = isSelected 
            ? "w-8 h-8 rounded-full bg-pink-600 text-white font-bold text-xs flex items-center justify-center mx-auto shadow-lg shadow-pink-600/30 transform scale-110 transition-transform" 
            : "w-8 h-8 rounded-full bg-slate-900 text-slate-300 font-medium text-xs flex items-center justify-center mx-auto border border-slate-800 hover:bg-slate-800 hover:text-white cursor-pointer transition-colors";
        
        grid.innerHTML += `<div onclick="toggleMultiDateSelection('${dateStr}')" class="${btnClass}">${i}</div>`;
    }
}

function toggleMultiDateSelection(dateStr) {
    if (selectedMultiDatesArray.includes(dateStr)) {
        selectedMultiDatesArray = selectedMultiDatesArray.filter(d => d !== dateStr);
    } else {
        selectedMultiDatesArray.push(dateStr);
    }
    renderMultiDateCalendarGrid();
}

function checkSequentialDates(dates) {
    if(dates.length <= 1) return true;
    let sorted = [...dates].sort(); 
    for(let i=1; i<sorted.length; i++) {
        let d1 = new Date(sorted[i-1]);
        d1.setDate(d1.getDate() + 1);
        let nextDayStr = d1.toISOString().split('T')[0];
        if (nextDayStr !== sorted[i]) return false;
    }
    return true;
}

function closeMultiDatePickerModal() {
    document.getElementById('itinCalendarModal').classList.add('hidden');
    updateMultiDateUILabel();
}

function updateMultiDateUILabel() {
    const display = document.getElementById('itin-date-display');
    const meta = document.getElementById('itin-date-meta');
    
    if (selectedMultiDatesArray.length === 0) {
        display.innerText = "Select Dates";
        meta.classList.add('hidden');
    } else if (selectedMultiDatesArray.length === 1) {
        display.innerText = selectedMultiDatesArray[0];
        meta.classList.add('hidden');
    } else {
        display.innerText = `${selectedMultiDatesArray.length} Days Selected`;
        let isSeq = checkSequentialDates(selectedMultiDatesArray);
        if (!isSeq) {
            meta.innerText = "Non-sequential days";
            meta.classList.remove('hidden');
        } else {
            meta.classList.add('hidden');
        }
    }
}

function renderItineraryFormCategoriesAndQueryRows() {
    const gridContainer = document.getElementById('itinModalCategoryGridContainer');
    const rowBox = document.getElementById('itinModalSequenceQueryRowBox');
    if (!gridContainer || !rowBox) return;

    gridContainer.innerHTML = '';
    rowBox.innerHTML = '';

    let countsMap = {};
    itinSelectedCategorySequence.forEach(cat => { countsMap[cat] = (countsMap[cat] || 0) + 1; });

    let uniqueCategories = new Set();
    travelSpots.forEach(spot => { if (spot.category) spot.category.split(',').forEach(c => uniqueCategories.add(c.trim())); });

    uniqueCategories.forEach(catName => {
        if (!catName) return;
        const count = countsMap[catName] || 0;
        const isSelected = count > 0;

        const btn = document.createElement('button');
        btn.type = "button";
        if (isSelected) {
            btn.className = "px-2 py-1.5 rounded-lg text-[10px] font-black flex items-center justify-between min-h-[30px] bg-pink-500/10 border border-dashed border-pink-500 text-pink-400 shadow-sm transition-all";
        } else {
            btn.className = "px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-between min-h-[30px] bg-slate-950/60 border border-dashed border-slate-700 text-slate-400 hover:bg-slate-900 transition-all";
        }

        btn.onclick = function() {
            itinSelectedCategorySequence.push(catName);
            renderItineraryFormCategoriesAndQueryRows();
        };

        btn.innerHTML = `
            <span class="truncate pr-1.5">${catName}</span>
            ${isSelected ? `<span class="text-[8px] bg-pink-600 text-white font-mono px-1 py-0.5 rounded shrink-0">x${count}</span>` : `<i class="fa-solid fa-plus text-[8px] opacity-40 shrink-0"></i>`}
        `;
        gridContainer.appendChild(btn);
    });

    if (itinSelectedCategorySequence.length === 0) {
        rowBox.innerHTML = ''; 
    } else {
        itinSelectedCategorySequence.forEach((cat, idx) => {
            const pill = document.createElement('div');
            pill.className = "flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg py-1.5 px-2 shrink-0 text-[10px] font-bold text-slate-300 shadow";
            pill.innerHTML = `
                <span>${cat}</span>
                <button onclick="removeCategoryFromSequenceByIndex(${idx})" class="w-4 h-4 bg-red-950/40 border border-red-500/30 rounded-full flex items-center justify-center text-red-400 text-[8px] hover:bg-red-900/60 transition-colors"><i class="fa-solid fa-xmark"></i></button>
            `;
            rowBox.appendChild(pill);

            if (idx < itinSelectedCategorySequence.length - 1) {
                const separator = document.createElement('span');
                separator.className = "text-pink-500 font-black text-[14px] shrink-0 mx-0.5 drop-shadow-[0_0_5px_rgba(236,72,153,0.5)]";
                separator.innerText = "→";
                rowBox.appendChild(separator);
            }
        });
    }
    validateItineraryForm();
}

function removeCategoryFromSequenceByIndex(index) {
    itinSelectedCategorySequence.splice(index, 1);
    renderItineraryFormCategoriesAndQueryRows();
}

function compileItineraryFromSequencePatternForm() {
    const chosenCity = document.getElementById('itin-new-city').value;
    if (!chosenCity) { alert("Please assign a valid target city boundary first."); return; }
    if (itinSelectedCategorySequence.length === 0) { alert("Please select at least one pattern category element to construct the timeline matrix."); return; }

    let calculatedTrackIds = [];
    let utilizedRowIds = new Set();

    itinSelectedCategorySequence.forEach(searchCategory => {
        const matchedRecord = travelSpots.find(spot => {
            if (utilizedRowIds.has(spot.rowid)) return false;
            if ((spot.city || "").trim() !== chosenCity.trim()) return false;
            
            const spotCats = (spot.category || "").split(',').map(c => c.trim().toLowerCase());
            return spotCats.includes(searchCategory.toLowerCase());
        });

        if (matchedRecord) {
            calculatedTrackIds.push(parseInt(matchedRecord.rowid));
            utilizedRowIds.add(matchedRecord.rowid);
        }
    });

    if (calculatedTrackIds.length === 0) {
        alert(`No database assets found inside ${chosenCity} matching your precise sequence blueprint.`);
        return;
    }

    itineraryItems[activeItineraryDayTracker] = calculatedTrackIds;
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    toggleItineraryCreationDrawerForm(false);
    renderItineraryMasterDashboardWorkspace();
    alert(`Surgically compiled matrix track sequence pattern mapping. Injected ${calculatedTrackIds.length} path targets.`);
}

function openThematicConfirm(title, desc, confirmText, callback, theme = 'pink') {
    document.getElementById('thematicConfirmTitle').innerText = title;
    document.getElementById('thematicConfirmDesc').innerText = desc;
    const btn = document.getElementById('thematicConfirmActionBtn');
    const icon = document.getElementById('thematicConfirmIcon');
    btn.innerText = confirmText;
    
    if (theme === 'pink') {
        btn.className = "w-full max-w-[200px] py-3.5 bg-gradient-to-r from-pink-600 to-purple-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-pink-600/20 active:scale-95 transition-transform";
        icon.className = "w-16 h-16 rounded-full bg-pink-500/10 flex items-center justify-center text-pink-500 text-2xl mx-auto mb-2 border border-pink-500/20";
        icon.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    } else {
        btn.className = "flex-1 py-3.5 bg-gradient-to-r from-red-600 to-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-red-600/20 active:scale-95 transition-transform";
        icon.className = "w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 text-2xl mx-auto mb-2 border border-red-500/20";
        icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
    }

    pendingConfirmCallback = callback;
    const modal = document.getElementById('thematicConfirmModal');
    const box = document.getElementById('thematicConfirmBox');
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0', 'pointer-events-none');
        box.classList.remove('scale-95'); box.classList.add('scale-100');
    }, 10);
}

function closeThematicConfirm() {
    const modal = document.getElementById('thematicConfirmModal');
    const box = document.getElementById('thematicConfirmBox');
    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('scale-100'); box.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
    pendingConfirmCallback = null;
}

document.getElementById('thematicConfirmActionBtn').addEventListener('click', () => {
    if (pendingConfirmCallback) pendingConfirmCallback();
    closeThematicConfirm();
});

function promptDeleteItinerary() {
    openThematicConfirm("Delete Itinerary", "Are you sure you want to delete this specific itinerary?", "Delete", () => {
        savedItineraries = savedItineraries.filter(i => i.id !== activeItineraryId);
        localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
        syncItineraryToCloud({id: activeItineraryId}, 'delete');
        activeItineraryId = null;
        closeItineraryDetailView();
    }, 'red');
}

/**
 * Toggles the starred state of an itinerary, then persists it locally and
 * fires a cloud sync so the ItineraryVault sheet's `starred` column is updated.
 * Works from both the master card and the expanded detail view.
 */
function toggleItineraryStar(itinId) {
    const itin = savedItineraries.find(i => i.id === itinId);
    if (!itin) return;
    itin.starred = !itin.starred;
    syncItineraryToCloud(itin, 'save');   // updates localStorage + fires cloud POST

    // renderItineraryMasterDashboardWorkspace() unconditionally hides the detail
    // view as its first action, so we must not call it while the detail view is
    // open — doing so would collapse the expanded tray.  Only call it when the
    // user is actually looking at the master list.
    const detailView = document.getElementById('itineraryDetailView');
    const inDetailView = detailView && !detailView.classList.contains('hidden');
    if (inDetailView) {
        // Just update the star icon in the header — leave everything else alone
        _syncDetailViewStarBtn(itin);
    } else {
        renderItineraryMasterDashboardWorkspace();
    }
}

/** Syncs the star button icon/colour in the expanded detail view header. */
function _syncDetailViewStarBtn(itin) {
    const btn = document.getElementById('detailItinStarBtn');
    if (!btn || !itin) return;
    const icon = btn.querySelector('i');
    if (!icon) return;
    if (itin.starred) {
        icon.className = 'fa-solid fa-star text-[11px] text-amber-400';
        btn.classList.replace('text-slate-300', 'text-amber-400');
    } else {
        icon.className = 'fa-regular fa-star text-[11px]';
        btn.classList.replace('text-amber-400', 'text-slate-300');
    }
}

function renderItineraryMasterDashboardWorkspace() {
    const masterList  = document.getElementById('itineraryMasterListScroll');
    const container   = document.getElementById('itineraryMasterListView');
    const headerBar   = document.getElementById('itineraryMasterListHeader');
    const emptyState  = document.getElementById('itineraryEmptyStateLanding');
    const detailView  = document.getElementById('itineraryDetailView');

    if (container)  container.classList.remove('hidden');
    if (detailView) detailView.classList.add('hidden');

    if (!masterList) return;

    if (!savedItineraries || savedItineraries.length === 0) {
        // Show the static landing page, hide the data header
        if (headerBar)  headerBar.classList.add('hidden');
        if (emptyState) emptyState.classList.remove('hidden');
        // Remove any previously rendered itinerary cards
        Array.from(masterList.children).forEach(el => {
            if (el.id !== 'itineraryEmptyStateLanding') el.remove();
        });
        return;
    }

    // At least one itinerary — show header, hide empty state
    if (headerBar)  headerBar.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    // Clear previous cards (keep the emptyState node in DOM so toggle is cheap)
    Array.from(masterList.children).forEach(el => {
        if (el.id !== 'itineraryEmptyStateLanding') el.remove();
    });

    savedItineraries.forEach(itin => {
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(itin.city)) {
            return; 
        }

        let doneCount  = 0;
        let totalCount = 0;
        itin.days.forEach(d => d.timeline.forEach(s => { totalCount++; if (s.isDone) doneCount++; }));
        const allDone    = totalCount > 0 && doneCount === totalCount;
        const coverageColor = allDone ? 'text-emerald-400' : 'text-slate-300';
        const coverageIcon  = allDone
            ? '<i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>'
            : '<i class="fa-solid fa-map-pin text-pink-400 mr-1"></i>';
        const isStarred = !!itin.starred;

        const card = document.createElement('div');
        card.className = "bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col gap-2 cursor-pointer active:scale-[0.98] transition-transform shadow-lg";
        card.onclick = () => openItineraryDetailView(itin.id);
        card.innerHTML = `
            <div class="flex justify-between items-start">
                <h3 class="text-sm font-black text-slate-200 flex-1 min-w-0 pr-2 flex items-center gap-1.5">
                    <i class="fa-solid ${itin.config?.pacing === 'relaxed' ? 'fa-mug-hot text-sky-400' : 'fa-rocket text-amber-400'} text-[10px] shrink-0"></i>
                    <span class="truncate">${itin.title}</span>
                </h3>
                <div class="flex items-center gap-2 shrink-0">
                    <button onclick="event.stopPropagation(); toggleItineraryStar('${itin.id}')"
                            class="w-6 h-6 flex items-center justify-center transition-colors active:scale-90">
                        <i class="fa-${isStarred ? 'solid' : 'regular'} fa-star text-sm ${isStarred ? 'text-amber-400' : 'text-slate-600'}"></i>
                    </button>
                    <span class="text-[9px] font-bold px-2 py-1 bg-slate-800 border border-slate-700 rounded-md text-slate-400 shadow-inner">${itin.days.length} Day${itin.days.length !== 1 ? 's' : ''}</span>
                </div>
            </div>
            <div class="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                <i class="fa-solid fa-location-dot text-pink-500"></i> ${itin.city}
            </div>
            <div class="mt-1 overflow-hidden rounded-lg bg-slate-950/60 border border-slate-800/60" style="height:22px">
                <div id="itinWeatherStrip-${itin.id}" class="h-full flex items-center px-2">
                    <span class="text-[9px] text-slate-700 font-bold tracking-wide flex items-center gap-1.5">
                        <i class="fa-solid fa-cloud-sun text-slate-700 text-[8px]"></i> Loading forecast…
                    </span>
                </div>
            </div>
            <div class="mt-2 flex items-center justify-between border-t border-slate-800 pt-3">
                <span class="text-[10px] font-black ${coverageColor}">${coverageIcon}${doneCount}/${totalCount} Spots Covered</span>
                <i class="fa-solid fa-chevron-right text-slate-600"></i>
            </div>
        `;
        masterList.appendChild(card);
    });

    const footer = document.createElement('div');
    footer.className = "text-center py-8 text-[10px] font-black text-slate-600 tracking-widest opacity-60 border-t border-slate-800/50 mt-4";
    footer.textContent = "End of Filtered Itinerary List";
    masterList.appendChild(footer);

    // Populate weather strips async — runs after the DOM is painted
    savedItineraries.forEach(itin => {
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(itin.city)) return;
        if (itin.city) _populateItineraryWeatherStrip(itin.id, itin.city, itin.days);
    });
}

// ── Weather: master card consolidated summary strip ──────────────────────────
/**
 * Fetches forecast for `city`, then renders a single-line consolidated summary:
 *   Oct 14 (Tue) → Oct 16 (Thu)  ☀ → 🌧  12°C – 22°C
 * Icons come from the days with the highest and lowest temperatures.
 * Falls back to a greyed-out cloud + "No forecast" on any failure.
 */
async function _populateItineraryWeatherStrip(itinId, city, days) {
    const el = document.getElementById(`itinWeatherStrip-${itinId}`);
    if (!el) return;

    // ── Error/fallback renderer ───────────────────────────────────────────────
    const _noData = () => {
        el.innerHTML = `
            <span class="inline-flex items-center gap-1.5 text-[9px] text-slate-700 font-bold">
                <i class="fa-solid fa-cloud text-slate-700 text-[8px]"></i>
                <span>No forecast</span>
            </span>`;
    };

    const forecast = await fetchItineraryForecast(city);
    if (!forecast || !forecast.days || forecast.days.length === 0) { _noData(); return; }

    // Normalise trip dates to YYYY-MM-DD strings
    const _toYMD = (d) => {
        if (d instanceof Date) {
            const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
            return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
        return String(d).slice(0, 10);
    };

    // Safe local-time Date constructor (avoids UTC midnight off-by-one)
    const _parseDate = (d) => {
        if (d instanceof Date) return d;
        const p = String(d).slice(0, 10).split('-').map(Number);
        return new Date(p[0], p[1] - 1, p[2]);
    };

    const tripDates  = (days || []).map(d => _toYMD(d.date));
    const matched    = forecast.days.filter(fd => tripDates.includes(fd.date));
    // Fall back to using the first N available forecast days when dates don't overlap
    const pool       = matched.length > 0 ? matched : forecast.days.slice(0, Math.max((days || []).length, 1));

    const valid = pool.filter(d => d.temp !== undefined && d.temp !== null);
    if (valid.length === 0) { _noData(); return; }

    // Days with extreme temperatures
    const maxDay = valid.reduce((a, b) => a.temp >= b.temp ? a : b);
    const minDay = valid.reduce((a, b) => a.temp <= b.temp ? a : b);

    // Format itinerary start → end date labels
    const _fmtDate = (d) => {
        if (!d || isNaN(d.getTime())) return '';
        const month   = d.toLocaleDateString('en-US', { month: 'short' });
        const dayNum  = d.getDate();
        const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
        return `${month} ${dayNum} (${weekday})`;
    };

    const itinDays    = days || [];
    const startLabel  = itinDays.length > 0 ? _fmtDate(_parseDate(itinDays[0].date)) : '';
    const endLabel    = itinDays.length > 1  ? _fmtDate(_parseDate(itinDays[itinDays.length - 1].date)) : '';
    const dateRange   = startLabel && endLabel
        ? `<span class="text-slate-600">${startLabel}</span>
           <span class="text-slate-700 mx-1">→</span>
           <span class="text-slate-600">${endLabel}</span>
           <span class="text-slate-800 mx-1.5">·</span>`
        : startLabel
            ? `<span class="text-slate-600">${startLabel}</span><span class="text-slate-800 mx-1.5">·</span>`
            : '';

    // Temperatures always use text-slate-300 (readable on dark bg regardless of
    // weather condition).  Tying temp colour to the icon class caused overcast
    // entries to render as uniform grey — visually identical to the no-data state.
    el.innerHTML = `
        <span class="inline-flex items-center text-[9px] font-bold whitespace-nowrap">
            ${dateRange}
            <i class="fa-solid ${maxDay.iconClass} text-[9px] mr-0.5"></i>
            <span class="text-slate-300 opacity-90 mr-1">${Math.round(maxDay.temp)}°</span>
            <span class="text-slate-700 mr-1">→</span>
            <i class="fa-solid ${minDay.iconClass} text-[9px] mr-0.5"></i>
            <span class="text-slate-300 opacity-90">${Math.round(minDay.temp)}°</span>
        </span>`;
}

// ── Weather: expanded view day badge ─────────────────────────────────────────
/**
 * Updates the #detailDayWeatherBadge for the currently displayed day.
 *
 * Strategy: try to match the forecast by exact date first (most accurate). If
 * the itinerary dates fall outside OWM's 5-day window (very common for future
 * trips), fall back to using dayIndex to pick from available forecast days so
 * the expanded view is always consistent with the master card.
 *
 * @param {string}         city     – itinerary city name
 * @param {string|Date}    dateStr  – date of the active day
 * @param {number}         dayIndex – 0-based index of the active day (fallback)
 */
async function _fetchAndRenderDetailDayWeather(city, dateStr, dayIndex) {
    const badge = document.getElementById('detailDayWeatherBadge');
    if (!badge) return;

    badge.innerHTML = `<i class="fa-solid fa-ellipsis text-slate-700 text-[9px] animate-pulse"></i>`;

    if (!city) { badge.innerHTML = ''; return; }

    const forecast = await fetchItineraryForecast(city);
    if (!forecast || !forecast.days || forecast.days.length === 0) {
        badge.innerHTML = `<i class="fa-solid fa-cloud text-slate-700 text-[9px]"></i>`;
        return;
    }

    // Normalise target date to YYYY-MM-DD
    const targetDate = (dateStr instanceof Date)
        ? (() => {
            const d = dateStr;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          })()
        : String(dateStr).slice(0, 10);

    // 1st: exact date match
    let match = forecast.days.find(fd => fd.date === targetDate);

    // 2nd: day-index fallback (same pool the master card uses)
    if (!match && typeof dayIndex === 'number') {
        match = forecast.days[Math.min(dayIndex, forecast.days.length - 1)];
    }

    if (!match) {
        badge.innerHTML = `<i class="fa-solid fa-cloud text-slate-700 text-[9px]"></i>`;
        return;
    }

    const temp = match.temp !== undefined ? `${Math.round(match.temp)}°C` : '';
    badge.innerHTML = `
        <i class="fa-solid ${match.iconClass} text-[11px]"></i>
        ${temp ? `<span class="text-slate-300 opacity-90 font-bold text-[9px]">${temp}</span>` : ''}`;
}

// ── Weather: per-activity badge in the expanded timeline ─────────────────────
/**
 * Fills the compact weather badge (`#wba-*`) that sits next to each activity's
 * time slot.  Re-uses the same city forecast cache so no extra network call is
 * made when the day's weather was already fetched for the header badge.
 *
 * Strategy mirrors _fetchAndRenderDetailDayWeather: exact-date match first,
 * then dayIndex fallback so badges always show something meaningful.
 *
 * Matching the Saved Spots badge style:
 *   container  bg-sky-500/10 text-sky-300  (set at render time, kept here)
 *   icon       uses its own colour from iconClass  (e.g. text-yellow-400)
 *   temp       inherits text-sky-300 from container — same as Saved Spots
 *
 * @param {string}      badgeId  – element id of the badge span
 * @param {string}      city     – itinerary city name
 * @param {string|Date} dateStr  – date of the active day
 * @param {number}      dayIndex – 0-based day index (fallback selector)
 */
/**
 * @param {string}      badgeId   – element id of the per-activity weather span
 * @param {string}      city      – itinerary city (city-level forecast fallback)
 * @param {string|Date} dateStr   – calendar date of the active day
 * @param {number}      dayIndex  – 0-based day index (fallback selector)
 * @param {object}      [spotObj] – activity spot; when the date is today and the
 *                                   spot has valid coordinates, real-time per-location
 *                                   weather is fetched so each spot on the same day
 *                                   can show different conditions.
 */
async function _populateItinActivityWeatherBadge(badgeId, city, dateStr, dayIndex, spotObj) {
    const el = document.getElementById(badgeId);
    if (!el) return;

    if (!city) { el.innerHTML = ''; return; }

    // Normalise target date → YYYY-MM-DD
    const targetDate = (dateStr instanceof Date)
        ? (() => {
            const d = dateStr;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          })()
        : String(dateStr).slice(0, 10);

    // Today's date string — used to decide whether real-time fetch makes sense
    const todayStr = (() => {
        const t = new Date();
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    })();

    // ── Path A: today's activity with valid coordinates ───────────────────────
    // Uses fetchWeatherForCoords (current weather, per-location) so activities
    // at different parts of the city can show genuinely different conditions.
    // The result is cached by coordinate key, so N spots → max N unique fetches.
    if (targetDate === todayStr && spotObj && typeof fetchWeatherForCoords === 'function') {
        const lat = spotObj._lat  || (spotObj.latitude  ? parseFloat(spotObj.latitude)  : null);
        const lng = spotObj._lng  || (spotObj.longitude ? parseFloat(spotObj.longitude) : null);
        if (lat && lng && lat !== 0 && lng !== 0) {
            const w = await fetchWeatherForCoords(lat, lng);
            if (w) {
                el.innerHTML = `<i class="fa-solid ${w.iconClass} text-[8px]"></i>${w.temp ? `<span>${w.temp}°</span>` : ''}`;
                return;
            }
        }
    }

    // ── Path B: future date or no coordinates → city-level daily forecast ─────
    // All activities on the same future day will share the same daily snapshot;
    // 3-hour granularity would require a backend change to get_forecast.
    const forecast = await fetchItineraryForecast(city);
    if (!forecast || !forecast.days || forecast.days.length === 0) {
        el.innerHTML = `<i class="fa-solid fa-cloud text-[8px] opacity-30"></i>`;
        return;
    }

    let match = forecast.days.find(fd => fd.date === targetDate);
    if (!match && typeof dayIndex === 'number') {
        match = forecast.days[Math.min(dayIndex, forecast.days.length - 1)];
    }

    if (!match) {
        el.innerHTML = `<i class="fa-solid fa-cloud text-[8px] opacity-30"></i>`;
        return;
    }

    const temp = match.temp !== undefined ? `${Math.round(match.temp)}°` : '';
    el.innerHTML = `<i class="fa-solid ${match.iconClass} text-[8px]"></i>${temp ? `<span>${temp}</span>` : ''}`;
}

// ── Open map-style info tray from the itinerary expanded view ─────────────────
/**
 * Opens the standard mapDetailTrayHUD populated with the given spot's data,
 * exactly as it appears when tapping a map pin.  The FAB is already hidden
 * while the itinerary is open; we monkey-patch dismissMapDetailTrayHUDCard
 * once so it re-hides the FAB after any dismissal path (X button on either
 * face, done-button dismiss).  The patch restores itself on first invocation.
 */
function openSpotTrayFromItinerary(spotObj) {
    if (typeof revealMapItemDetailTrayHUD !== 'function') return;

    const plusBtn      = document.getElementById('globalFloatingActionPlusButton');
    const fabWasHidden = plusBtn && plusBtn.classList.contains('hidden');

    const isStarred = ['high', '🔥', 'must do', 'starred']
        .includes((spotObj.priority || '').toLowerCase());

    // Compute distStr using the same logic as the Saved Spots list render so the
    // tray shows: distance in km/m when GPS is on, GPS Off icon when GPS is off,
    // or "Missing Location" when the spot has no coordinate data.
    const _lat = spotObj.latitude  ? String(spotObj.latitude).trim()  : '';
    const _lng = spotObj.longitude ? String(spotObj.longitude).trim() : '';
    const _hasCoords = _lat !== '' && _lat !== '0' && _lng !== '' && _lng !== '0';

    let _distStr;
    if (!_hasCoords) {
        _distStr = 'Missing Location';
    } else if (!gpsStatusCachedBool) {
        _distStr = "<i class='fa-solid fa-location-dot mr-1'></i>GPS Off";
    } else if (typeof calculateDistance === 'function') {
        const _d = calculateDistance(userLat, userLon, parseFloat(_lat), parseFloat(_lng));
        _distStr = _d < 1 ? `${Math.round(_d * 1000)}m` : `${_d.toFixed(1)}km`;
    } else {
        _distStr = 'GPS Off';
    }

    const safeSpot = { ...spotObj, distStr: _distStr };

    revealMapItemDetailTrayHUD(safeSpot, isStarred);

    // Restore FAB to its pre-tray state (hidden) when tray is closed.
    // All dismissal paths (both X buttons, done-button) call the global
    // dismissMapDetailTrayHUDCard by name, so patching window-level is enough.
    if (fabWasHidden && typeof window.dismissMapDetailTrayHUDCard === 'function') {
        const _orig = window.dismissMapDetailTrayHUDCard;
        window.dismissMapDetailTrayHUDCard = function () {
            _orig();                                       // hides tray, shows FAB
            if (plusBtn) plusBtn.classList.add('hidden');  // re-hide for itinerary
            window.dismissMapDetailTrayHUDCard = _orig;    // restore for map use
        };
    }
}

function openItineraryDetailView(itinId) {
    activeItineraryId = itinId;
    activeItineraryDayTracker = 0;
    document.getElementById('itineraryMasterListView').classList.add('hidden');
    document.getElementById('itineraryDetailView').classList.remove('hidden');
    renderDetailViewTimeline();
}

function closeItineraryDetailView() {
    document.getElementById('itineraryDetailView').classList.add('hidden');
    document.getElementById('itineraryMasterListView').classList.remove('hidden');
    renderItineraryMasterDashboardWorkspace();
}

function navigateItineraryDay(offset) {
    const itin = getActiveItinerary();
    if(!itin) return;
    activeItineraryDayTracker += offset;
    if (activeItineraryDayTracker < 0) activeItineraryDayTracker = 0;
    if (activeItineraryDayTracker >= itin.days.length) activeItineraryDayTracker = itin.days.length - 1;
    renderDetailViewTimeline();
}

function renderDetailViewTimeline() {
    const container = document.getElementById('itineraryTimelineScrollContainer');
    const itin = getActiveItinerary();
    if (!itin) return;

    const _pacingIconHtml = (itin.config?.pacing === 'relaxed')
        ? '<i class="fa-solid fa-mug-hot text-sky-400 text-[11px] shrink-0"></i>'
        : '<i class="fa-solid fa-rocket  text-amber-400 text-[11px] shrink-0"></i>';
    const _safeTitle = (itin.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    document.getElementById('detailItineraryTitle').innerHTML =
        `${_pacingIconHtml}<span class="truncate min-w-0">${_safeTitle}</span>`;
    document.getElementById('detailDayLabel').innerText = `Day ${activeItineraryDayTracker + 1} of ${itin.days.length}`;

    const prevBtn     = document.getElementById('itinNavPrevBtn');
    const nextBtn     = document.getElementById('itinNavNextBtn');
    if (prevBtn) prevBtn.classList.toggle('invisible', activeItineraryDayTracker === 0);
    if (nextBtn) nextBtn.classList.toggle('invisible', activeItineraryDayTracker >= itin.days.length - 1);

    _syncDetailViewStarBtn(itin);

    const activeDay = itin.days[activeItineraryDayTracker];
    document.getElementById('detailDateLabel').innerText = new Date(activeDay.date)
        .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    _fetchAndRenderDetailDayWeather(itin.city, activeDay.date, activeItineraryDayTracker);

    container.innerHTML = '';

    // ── Layout constants ──────────────────────────────────────────────────────
    const PX_PER_MIN  = 2.0;   // 120 px per hour
    const RULER_W     = 46;    // left time-column width in px
    const MIN_BLOCK_H = 140;   // minimum block height — ensures card always fits
    const CARD_TOP    = 2;     // px from block top to card top — flush with time mark

    // ── Empty-day state ───────────────────────────────────────────────────────
    if (activeDay.timeline.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:80px 16px;text-align:center;';
        emptyDiv.innerHTML = `
            <div style="font-size:2.5rem;opacity:0.2;color:rgb(148 163 184);">
                <i class="fa-solid fa-mug-hot"></i>
            </div>
            <p style="font-size:11px;font-weight:600;color:rgb(71 85 105);">No activities scheduled for this day.</p>`;
        container.appendChild(emptyDiv);
        return;
    }

    // ── Helper: format a minutes value into a label object ───────────────────
    // Returns { main, ampm, isMid } — e.g. 570 → { main:"9:30", ampm:"AM", isMid:false }
    const _fmtLabel = (mins) => {
        const h    = Math.floor(mins / 60) % 24;
        const m    = mins % 60;
        const h12  = h === 0 ? 12 : h <= 12 ? h : h - 12;
        const ampm = h < 12 ? 'AM' : 'PM';
        const main = m === 0 ? String(h12) : `${h12}:${String(m).padStart(2, '0')}`;
        return { main, ampm, isMid: mins === 0 || mins === 720 };
    };

    // ── Helper: add a horizontal time mark to a block element ────────────────
    // isStart marks are always rendered as a solid line (they anchor the block).
    // Internal hour marks are solid; internal half-hour marks are dotted.
    // All lines span left:0 → right:0 (full block width, behind the card).
    const _addMark = (block, mins, offsetPx, isStart) => {
        const onHour     = mins % 60 === 0;
        const renderSolid = isStart || onHour;
        const lbl        = _fmtLabel(mins);

        const wrap = document.createElement('div');
        wrap.style.cssText = `position:absolute;left:0;right:0;top:${offsetPx}px;height:0;z-index:0;pointer-events:none;`;

        if (renderSolid) {
            const lineCol = lbl.isMid ? 'rgba(71,85,105,0.6)' : 'rgba(30,41,59,1)';
            const lblCol  = lbl.isMid ? 'rgba(148,163,184,0.65)'
                          : isStart    ? 'rgba(100,116,139,0.95)'
                          :              'rgba(71,85,105,0.8)';
            wrap.innerHTML = `
                <div style="position:absolute;left:0;right:0;top:0;height:1px;background:${lineCol};"></div>
                <span style="
                    position:absolute;left:4px;top:-8px;
                    font-size:7.5px;font-weight:800;color:${lblCol};
                    white-space:nowrap;line-height:1;letter-spacing:0.02em;">
                    ${lbl.main}<span style="font-size:6px;margin-left:1px;">${lbl.ampm}</span>
                </span>`;
        } else {
            // Half-hour mark: full-width dashed line using a repeating gradient
            // (4 px dash / 6 px gap) — readable at any screen density
            wrap.innerHTML = `
                <div style="
                    position:absolute;left:0;right:0;top:0;height:1px;
                    background:repeating-linear-gradient(
                        to right,
                        rgba(30,41,59,0.9) 0px,
                        rgba(30,41,59,0.9) 4px,
                        transparent 4px,
                        transparent 10px
                    );"></div>`;
        }

        block.appendChild(wrap);
    };

    // ── Helper: append a proportional ruler section (preamble / gap / postamble)
    // Renders hour (solid) and half-hour (dotted) marks over the time range
    // [fromMins, toMins].  The last mark (toMins) is suppressed unless it is
    // exactly midnight (1440) so it is never double-drawn with the next block's
    // start mark.
    const _appendRulerSection = (fromMins, toMins) => {
        if (toMins <= fromMins) return;
        const sectionH = Math.round((toMins - fromMins) * PX_PER_MIN);
        if (sectionH <= 0) return;

        const section = document.createElement('div');
        section.style.cssText = `position:relative;height:${sectionH}px;`;

        // Ruler spine
        const spine = document.createElement('div');
        spine.style.cssText = `position:absolute;left:${RULER_W - 1}px;top:0;bottom:0;width:1px;background:rgba(20,30,40,1);z-index:0;pointer-events:none;`;
        section.appendChild(spine);

        // Draw marks for every 30-min boundary within [fromMins, toMins]
        const startMark = (fromMins % 30 === 0) ? fromMins : Math.ceil(fromMins / 30) * 30;
        for (let m = startMark; m <= toMins; m += 30) {
            // Suppress the closing boundary mark except at true midnight (end of day)
            if (m === toMins && toMins !== 1440) continue;
            const offsetPx = Math.round((m - fromMins) * PX_PER_MIN);
            // Use m % 1440 so 1440 displays as "12 AM" via _fmtLabel
            _addMark(section, m % 1440, offsetPx, false);
        }

        container.appendChild(section);
    };

    // ── Render blocks ─────────────────────────────────────────────────────────
    const timeline = activeDay.timeline;

    // Preamble ruler: 12 AM → first activity start
    const firstStart = timeline.length > 0 ? (timeline[0].sch_start || 0) : 1440;
    const lastEnd    = timeline.length > 0
        ? (timeline[timeline.length - 1].sch_end
           || (timeline[timeline.length - 1].sch_start + 60))
        : 0;
    _appendRulerSection(0, firstStart);

    timeline.forEach((spot, spotIndex) => {
        const startMins    = spot.sch_start || 0;
        const endMins      = spot.sch_end   || (startMins + 60);
        const durationMins = Math.max(endMins - startMins, 1);
        // Proportional height drives min-height so time marks stay evenly spaced,
        // but the block can grow beyond this to fit card content.
        const propH = Math.round(durationMins * PX_PER_MIN);

        // ── Gap spacer before this block (skipped for the first entry) ────────
        if (spotIndex > 0) {
            const prevEnd = timeline[spotIndex - 1].sch_end
                         || (timeline[spotIndex - 1].sch_start + 60);
            const gapMins = startMins - prevEnd;

            if (gapMins > 0) {
                // Proportional ruler section for the free-time gap
                _appendRulerSection(prevEnd, startMins);
            }
        }

        // ── Activity block ────────────────────────────────────────────────────
        // Card is in NORMAL FLOW (not absolute) so the block grows to fit its
        // content — cards can never overflow into adjacent blocks.
        // padding-left pushes the card into the right column.
        // min-height keeps proportional time-mark spacing even on short activities.
        const block = document.createElement('div');
        block.style.cssText = `
            position:relative;
            padding:${CARD_TOP}px 16px ${CARD_TOP}px ${RULER_W + 6}px;
            min-height:${Math.max(propH, MIN_BLOCK_H)}px;`;

        // 1px right-border of the ruler column — visual vertical spine
        const spine = document.createElement('div');
        spine.style.cssText = `
            position:absolute;left:${RULER_W - 1}px;top:0;bottom:0;
            width:1px;background:rgba(20,30,40,1);z-index:0;pointer-events:none;`;
        block.appendChild(spine);

        // Start-time solid mark (always at top of block)
        _addMark(block, startMins, 0, true);

        // All hour / half-hour marks that fall strictly inside the activity window
        const firstInternal = Math.ceil((startMins + 1) / 30) * 30;
        for (let m = firstInternal; m < endMins; m += 30) {
            _addMark(block, m, Math.round((m - startMins) * PX_PER_MIN), false);
        }

        // ── Card — normal-flow child; grows to fit its own content ────────────
        const card = document.createElement('div');
        card.className = `bg-slate-900 border border-slate-800 rounded-2xl p-4 relative transition-all cursor-pointer ${spot.isDone ? 'itin-done-card border-slate-900' : ''}`;

        // Resolve category icon — same helper used by the Saved Spots list
        const _catIconCls = (typeof getCategoryIconClass === 'function')
            ? getCategoryIconClass(spot.category)
            : 'fa-location-dot text-slate-400';

        card.innerHTML = `
            <div class="absolute top-0 bottom-0 left-0 w-1 bg-gradient-to-b from-pink-500 to-purple-600 opacity-80 rounded-l-2xl"></div>

            <div class="pl-2">
                <!-- Row 1: category pill · time badge · delete -->
                <div class="flex items-center gap-1.5 mb-2">
                    <span class="inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-lg bg-slate-950 text-slate-400 font-bold border border-slate-800 shrink-0">
                        <i class="fa-solid ${_catIconCls} text-[8px]"></i>
                        <span class="uppercase tracking-wider">${spot.category || 'General'}</span>
                        ${spot.isAnchored ? '<i class="fa-solid fa-lock text-amber-400 text-[7px] ml-0.5"></i>' : ''}
                    </span>
                    <span class="text-[9px] font-mono font-bold text-pink-400 bg-pink-500/10 px-1.5 py-0.5 rounded border border-pink-500/20 shadow-inner shrink-0">
                        ${formatMinutesToTime(spot.sch_start)} – ${formatMinutesToTime(spot.sch_end)}
                    </span>
                    <span id="wba-${itin.id}-${activeItineraryDayTracker}-${spotIndex}"
                          class="inline-flex items-center justify-center gap-0.5 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-lg min-w-[2.75rem] bg-sky-500/10 text-sky-300 shrink-0">
                        <i class="fa-solid fa-cloud text-[8px] opacity-25 animate-pulse"></i>
                    </span>
                    <button onclick="removeActivityFromTimeline(${activeItineraryDayTracker}, ${spotIndex})"
                            class="ml-auto w-6 h-6 flex items-center justify-center bg-red-950/20 text-red-500 rounded-lg shrink-0 text-[10px] hover:bg-red-900/60 transition-colors">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>

                <!-- Row 2: spot name -->
                <h3 class="text-[13px] font-black text-slate-200 truncate mb-2 ${spot.isDone ? 'itin-done-text' : ''}">${spot.spot_name}</h3>

                <!-- Notes (optional) -->
                ${spot.notes ? `<div class="mb-3 bg-slate-950/40 p-2.5 rounded-xl border border-slate-900/60"><p class="text-[10px] leading-relaxed font-medium text-slate-400 line-clamp-2 ${spot.isDone ? 'itin-done-text' : ''}">${spot.notes}</p></div>` : ''}

                <!-- Action row: Reference · Directions · Mark Done · Swap -->
                <div class="flex gap-1.5 items-center">
                    <a href="${spot.instagram_url || spot.reference_link || '#'}" target="_blank"
                       class="flex-1 bg-gradient-to-r from-pink-600 to-purple-600 text-center text-[10px] font-bold py-2 rounded-xl text-white flex items-center justify-center gap-1 shadow-md active:opacity-80 transition-opacity ${spot.isDone ? 'opacity-50 pointer-events-none' : ''}">
                        <i class="fa-solid fa-link text-[9px]"></i> Ref
                    </a>
                    <button data-row-id="${spot.rowid}" onclick="handleAdaptiveDirectionClick(this, event)"
                            class="flex-1 bg-slate-950 border border-slate-800 text-slate-300 text-[10px] font-bold py-2 rounded-xl flex items-center justify-center gap-1 active:bg-slate-900 transition-colors ${spot.isDone ? 'opacity-50 pointer-events-none' : ''}">
                        <i class="fa-solid fa-map text-[9px]"></i> Dir
                    </button>
                    <button onclick="toggleActivityDoneState(${activeItineraryDayTracker}, ${spotIndex})"
                            class="flex-1 text-[10px] font-bold py-2 rounded-xl flex items-center justify-center gap-1 border transition-colors
                                   ${spot.isDone ? 'bg-pink-600/10 border-pink-600/20 text-pink-400 active:bg-pink-600/20' : 'bg-slate-950 border-slate-800 text-slate-400 active:bg-slate-900'}">
                        ${spot.isDone
                            ? '<i class="fa-solid fa-arrow-rotate-left text-[9px]"></i> Undo'
                            : '<i class="fa-solid fa-check text-[9px]"></i> Done'}
                    </button>
                    <button onclick="swapActivityInTimeline(${activeItineraryDayTracker}, ${spotIndex})"
                            class="flex-1 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] font-bold py-2 rounded-xl flex items-center justify-center gap-1 active:bg-indigo-500/20 transition-colors ${spot.isDone ? 'opacity-50 pointer-events-none' : ''}">
                        <i class="fa-solid fa-arrows-rotate text-[9px]"></i> Swap
                    </button>
                </div>
            </div>`;

        // Tap on the card body (not a button or link) → open full map info tray
        card.addEventListener('click', function (e) {
            if (e.target.closest('button, a')) return;
            openSpotTrayFromItinerary(spot);
        });

        block.appendChild(card);
        container.appendChild(block);
    });

    // Postamble ruler: last activity end → midnight
    _appendRulerSection(lastEnd, 1440);

    // Per-activity weather badges — deferred so the DOM is painted first.
    // Uses the already-warm forecast cache; no extra network round-trips.
    const _actWeatherJobs = timeline.map((spot, idx) => ({
        badgeId:  `wba-${itin.id}-${activeItineraryDayTracker}-${idx}`,
        date:     activeDay.date,
        dayIndex: activeItineraryDayTracker,
        spot,                // passed so coord-based weather can be used for today
    }));
    setTimeout(() => {
        _actWeatherJobs.forEach(job =>
            _populateItinActivityWeatherBadge(job.badgeId, itin.city, job.date, job.dayIndex, job.spot)
        );
    }, 0);

    // Auto-scroll: snap to ~30 min before the first activity
    if (timeline.length > 0) {
        const scrollTarget = Math.max(0, Math.round((firstStart - 30) * PX_PER_MIN));
        requestAnimationFrame(() => { container.scrollTop = scrollTarget; });
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const tlFooter = document.createElement('div');
    tlFooter.style.cssText = 'margin:24px 16px 0;padding:20px 0;text-align:center;font-size:9px;font-weight:900;color:rgb(51 65 85);letter-spacing:0.12em;opacity:0.6;border-top:1px solid rgba(30,41,59,0.8);';
    tlFooter.textContent = 'End of Selected Day Itinerary List';
    container.appendChild(tlFooter);
}

function toggleActivityDoneState(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    if(!itin) return;
    itin.days[dayIndex].timeline[spotIndex].isDone = !itin.days[dayIndex].timeline[spotIndex].isDone;
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    syncItineraryToCloud(itin, 'save');
    renderDetailViewTimeline();
}

function removeActivityFromTimeline(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    if(!itin) return;
    itin.days[dayIndex].timeline.splice(spotIndex, 1);
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    renderDetailViewTimeline();
}

function swapActivityInTimeline(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    const currentSpot = itin.days[dayIndex].timeline[spotIndex];
    
    let allUsedIds = new Set();
    itin.days.forEach(d => d.timeline.forEach(s => allUsedIds.add(s.rowid)));

    let candidates = travelSpots.filter(s => s.city === itin.city && !allUsedIds.has(s.rowid) && (s.category || "").toLowerCase().includes(currentSpot.category.toLowerCase()));
    
    if (candidates.length > 0) {
        const replacement = candidates[Math.floor(Math.random() * candidates.length)];
        itin.days[dayIndex].timeline[spotIndex] = {
            ...replacement,
            sch_start: currentSpot.sch_start,
            sch_end: currentSpot.sch_end, // Lock into identical time slot
            isDone: false,
            isAnchored: false
        };
        localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
        renderDetailViewTimeline();
        if(typeof showFormErrorSpeechBubble === 'function') showFormErrorSpeechBubble([`Swapped for: ${replacement.spot_name}`]);
    } else {
        if(typeof showFormErrorSpeechBubble === 'function') showFormErrorSpeechBubble(["No unused alternatives found for this category!"]);
    }
}

function promptRecalculateItinerary() {
    openThematicConfirm(
        "Recalculate Flow",
        "This will scan past days and roll over unfinished activities into today's timeline. Are you sure?",
        "Recalculate",
        () => { executeRecalculateEngine(); },
        false 
    );
}

function executeRecalculateEngine() {
    document.getElementById('buildingItineraryLoaderPopup').classList.remove('hidden');
    
    setTimeout(() => {
        const itin = getActiveItinerary();
        let missedSpots = [];
        
        for (let i = 0; i < activeItineraryDayTracker; i++) {
            let day = itin.days[i];
            for (let j = day.timeline.length - 1; j >= 0; j--) {
                if (!day.timeline[j].isDone) {
                    missedSpots.push(day.timeline[j]);
                    day.timeline.splice(j, 1); 
                }
            }
        }

        if (missedSpots.length > 0) {
            let currentDay = itin.days[activeItineraryDayTracker];
            let currentStart = parseTimeToMinutes("09:00"); 
            
            missedSpots.reverse().forEach(spot => {
                spot.sch_start = currentStart;
                spot.sch_end = currentStart + spot.logicDur;
                currentStart = spot.sch_end + 15;
                currentDay.timeline.unshift(spot);
            });

            currentDay.timeline.sort((a, b) => a.sch_start - b.sch_start);
            let recalcTime = parseTimeToMinutes("09:00");
            currentDay.timeline.forEach(s => {
                s.sch_start = recalcTime;
                s.sch_end = recalcTime + s.logicDur;
                recalcTime = s.sch_end + 15;
            });

            localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
            renderDetailViewTimeline();
            if(typeof showFormErrorSpeechBubble === 'function') showFormErrorSpeechBubble(["Recalculation Complete: Missed items rolled over!"]);
        } else {
            if(typeof showFormErrorSpeechBubble === 'function') showFormErrorSpeechBubble(["No missed activities found to roll over!"]);
        }
        
        document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
    }, 1000);
}

function parseTimeToMinutes(timeStr) {
    if (!timeStr || !timeStr.includes(':')) return 0;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function formatMinutesToTime(mins) {
    let h = Math.floor(mins / 60); let m = mins % 60;
    const period = h >= 12 && h < 24 ? 'PM' : 'AM';
    if (h > 12) h -= 12; if (h === 0) h = 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

function minutesToHHMM(mins) {
    let h = Math.floor(mins / 60);
    let m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function detectAnchoredTime(bookingText) {
    if (!bookingText) return null;
    const match = bookingText.match(/\b([0-1]?[0-9]|2[0-3]):[0-5][0-9]\b/);
    return match ? parseTimeToMinutes(match[0]) : null;
}

function getCategoryLogic(catString) {
    if (!catString) return CATEGORY_DEFAULTS['default'];
    const lower = catString.toLowerCase();
    for (let key in CATEGORY_DEFAULTS) { if (lower.includes(key)) return CATEGORY_DEFAULTS[key]; }
    return CATEGORY_DEFAULTS['default'];
}

function showFormErrorSpeechBubble(missingFieldsArray) {
    const bubble = document.getElementById('globalToastSpeechBubbleHUD');
    const textNode = document.getElementById('speechBubbleTextContainer');
    const btn = document.getElementById('buildItinerarySubmitBtn');
    
    let msg = "<span class='text-pink-400'>Missing Information:</span><br><div class='text-left mt-1 space-y-0.5 ml-2 text-[10px]'>";
    missingFieldsArray.forEach(field => msg += `<div><i class="fa-solid fa-circle-exclamation text-amber-500 mr-1"></i> ${field}</div>`);
    msg += "</div>";
    
    textNode.innerHTML = msg;
    
    const rect = btn.getBoundingClientRect();
    bubble.style.left = "50%";
    bubble.style.transform = "translateX(-50%)";
    bubble.style.bottom = (window.innerHeight - rect.top + 15) + "px";
    bubble.style.top = "auto";
    
    bubble.classList.remove('hidden');
    setTimeout(() => bubble.classList.add('hidden'), 4000);
}

function generateIntelligentItinerary() {
    const title      = document.getElementById('itin-new-name').value.trim();
    const chosenCity = document.getElementById('itin-new-city').value;
    const startMins  = parseTimeToMinutes(document.getElementById('itin-new-start').value || "09:00");
    const endMins    = parseTimeToMinutes(document.getElementById('itin-new-end').value   || "21:00");

    // ── Validate ──────────────────────────────────────────────────────────────
    const missing = [];
    if (!title)                                    missing.push("Itinerary Name");
    if (!chosenCity)                               missing.push("City Selection");
    if (selectedMultiDatesArray.length  === 0)     missing.push("Travel Dates");
    if (itinSelectedCategorySequence.length === 0) missing.push("Category Sequence");
    if (missing.length > 0) { showFormErrorSpeechBubble(missing); return; }

    document.getElementById('buildingItineraryLoaderPopup').classList.remove('hidden');

    setTimeout(() => {
        try {
            // ── Config ────────────────────────────────────────────────────────
            const isMax       = itinPacingMode === 'max';
            const bufferMins  = isMax ? 15 : 40;          // travel + transition gap
            const durationKey = isMax ? 'durationMax' : 'durationRelaxed';

            // ── Build enriched spot pool for this city ────────────────────────
            // Each pool entry is immutable — per-day scheduling reads from it but
            // only usedSpotIds tracks what has already been placed.
            const cityPool = (travelSpots || [])
                .filter(s => s.city === chosenCity)
                .map(s => {
                    const logic        = getCategoryLogic(s.category);
                    const anchoredMins = detectAnchoredTime(s.booking_requirement);
                    return {
                        ...s,
                        isAnchored:   anchoredMins !== null,
                        anchoredTime: anchoredMins,
                        logicDur:     logic[durationKey],
                        logicOpen:    logic.open  * 60,
                        logicClose:   logic.close * 60,
                        _lat:         parseFloat(s.latitude)  || null,
                        _lng:         parseFloat(s.longitude) || null,
                    };
                });

            // ── Inner helpers (defined once, shared across all days) ───────────

            /**
             * Haversine great-circle distance in kilometres between two points.
             * Returns a large sentinel (9999) when either coordinate is missing.
             */
            function _distKm(lat1, lng1, lat2, lng2) {
                if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 9999;
                const R    = 6371;
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLng = (lng2 - lng1) * Math.PI / 180;
                const a    = Math.sin(dLat / 2) ** 2
                           + Math.cos(lat1 * Math.PI / 180)
                           * Math.cos(lat2 * Math.PI / 180)
                           * Math.sin(dLng / 2) ** 2;
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            }

            /**
             * Returns true when a spot's comma-separated category list contains
             * the sequence target (or vice-versa).  Case-insensitive.
             */
            function _catMatches(spotCategory, target) {
                if (!spotCategory || !target) return false;
                const t  = target.trim().toLowerCase();
                return spotCategory.toLowerCase()
                    .split(',')
                    .some(c => { const cc = c.trim(); return cc.includes(t) || t.includes(cc); });
            }

            /**
             * From the city pool, finds the closest unplaced spot that:
             *   - matches the target category
             *   - is open during the requested slot
             *   - finishes before slotEnd (the window boundary)
             * Returns null when nothing qualifies.
             */
            function _pickClosest(usedIds, targetCat, slotStart, slotEnd, refLat, refLng) {
                let best      = null;
                let bestDist  = Infinity;

                for (const s of cityPool) {
                    if (usedIds.has(s.rowid))                        continue;
                    if (!_catMatches(s.category, targetCat))         continue;
                    if (slotStart < s.logicOpen)                     continue;  // venue not open yet
                    if (slotStart + s.logicDur > s.logicClose)       continue;  // venue closes before we finish
                    if (slotStart + s.logicDur > slotEnd)            continue;  // overruns the window

                    const d = _distKm(refLat, refLng, s._lat, s._lng);
                    if (d < bestDist) { bestDist = d; best = s; }
                }
                return best;
            }

            // ── Build itinerary skeleton ──────────────────────────────────────
            const newItinerary = {
                id:     isEditingMode ? editingItinId : Date.now().toString(),
                title,
                city:   chosenCity,
                user:   (typeof currentUser !== 'undefined') ? currentUser : null,
                days:   [],
                config: {
                    dates:      [...selectedMultiDatesArray],
                    categories: [...itinSelectedCategorySequence],
                    pacing:     itinPacingMode,
                    start:      startMins,
                    end:        endMins,
                },
            };

            const usedSpotIds = new Set();
            const sortedDates = [...selectedMultiDatesArray].sort();

            // ── Per-day scheduling ────────────────────────────────────────────
            sortedDates.forEach(dateStr => {
                const dailyTimeline = [];

                // ── Phase 1: reserve anchored (booked-time) spots ─────────────
                // These become fixed time pillars around which the rest of the day
                // is filled.  Two anchored spots whose windows overlap are both
                // eligible but a conflict check skips the later one if needed.
                const anchoredCandidates = cityPool
                    .filter(s =>
                        s.isAnchored &&
                        !usedSpotIds.has(s.rowid) &&
                        s.anchoredTime >= startMins &&
                        s.anchoredTime + s.logicDur <= endMins &&
                        s.anchoredTime >= s.logicOpen &&
                        s.anchoredTime + s.logicDur <= s.logicClose
                    )
                    .sort((a, b) => a.anchoredTime - b.anchoredTime);

                // Insert anchored spots, skipping any that overlap a prior one
                let lastAnchorEnd = -1;
                for (const s of anchoredCandidates) {
                    if (s.anchoredTime < lastAnchorEnd) continue;  // overlap — skip
                    dailyTimeline.push({
                        ...s,
                        sch_start:  s.anchoredTime,
                        sch_end:    s.anchoredTime + s.logicDur,
                        isDone:     false,
                        isAnchored: true,
                    });
                    usedSpotIds.add(s.rowid);
                    lastAnchorEnd = s.anchoredTime + s.logicDur;
                }

                // ── Phase 2: derive free-time segments around the anchors ──────
                // Segments are [segStart, segEnd) windows where non-anchored spots
                // can be placed.  Each edge of an anchor gets a bufferMins gap so
                // the traveller has time to get there and settle in.
                const segments = [];
                let   cursor   = startMins;

                for (const entry of dailyTimeline) {  // already sorted by sch_start
                    const gapEnd = entry.sch_start - bufferMins;
                    if (gapEnd > cursor + 30) {        // only worth filling if >30 min free
                        segments.push([cursor, gapEnd]);
                    }
                    cursor = entry.sch_end + bufferMins;
                }
                if (cursor < endMins - 30) {
                    segments.push([cursor, endMins]);
                }

                // ── Phase 3: fill each free segment with sequence-guided spots ─
                // seqIdx resets per day so every day starts fresh from the top of
                // the category sequence (e.g., always breakfast → attraction →
                // lunch → … regardless of what happened on previous days).
                let seqIdx  = 0;
                let refLat  = null;
                let refLng  = null;

                // Seed proximity reference from the first anchored spot, if any
                if (dailyTimeline.length > 0) {
                    refLat = dailyTimeline[0]._lat;
                    refLng = dailyTimeline[0]._lng;
                }

                for (const [segStart, segEnd] of segments) {
                    let t = segStart;

                    // Allow one full rotation through the sequence before giving up
                    // on this segment — prevents an exhausted category from
                    // blocking the entire remainder of the day.
                    let consecutiveSkips = 0;
                    const maxSkips       = itinSelectedCategorySequence.length;

                    while (t + 30 <= segEnd && consecutiveSkips < maxSkips) {
                        const targetCat = itinSelectedCategorySequence[seqIdx % itinSelectedCategorySequence.length];
                        const pick      = _pickClosest(usedSpotIds, targetCat, t, segEnd, refLat, refLng);

                        if (pick) {
                            dailyTimeline.push({
                                ...pick,
                                sch_start:  t,
                                sch_end:    t + pick.logicDur,
                                isDone:     false,
                                isAnchored: false,
                            });
                            usedSpotIds.add(pick.rowid);
                            t           += pick.logicDur + bufferMins;
                            refLat       = pick._lat;
                            refLng       = pick._lng;
                            seqIdx++;
                            consecutiveSkips = 0;      // success — reset skip counter
                        } else {
                            // No spot available for this category right now —
                            // advance the sequence rather than burning the whole
                            // loop retrying an exhausted / closed category.
                            seqIdx++;
                            consecutiveSkips++;
                        }
                    }
                }

                // Final sort: anchored + free slots ordered by start time
                dailyTimeline.sort((a, b) => a.sch_start - b.sch_start);
                newItinerary.days.push({ date: dateStr, timeline: dailyTimeline });
            });

            // ── Phase 4: day-balance top-up pass ─────────────────────────────
            // After primary scheduling, days that ended up significantly lighter
            // than average (e.g. because early days consumed most of the pool)
            // get a second-chance fill using any remaining unplaced spots.
            const totalPlaced = newItinerary.days.reduce((s, d) => s + d.timeline.length, 0);
            const avgPerDay   = totalPlaced / Math.max(1, newItinerary.days.length);

            newItinerary.days.forEach(day => {
                // Only top-up days below 60 % of average (and only if avg > 1)
                if (avgPerDay <= 1 || day.timeline.length >= Math.ceil(avgPerDay * 0.6)) return;

                let t      = day.timeline.length > 0
                               ? day.timeline[day.timeline.length - 1].sch_end + bufferMins
                               : startMins;
                let refLat = day.timeline.length > 0 ? day.timeline[day.timeline.length - 1]._lat : null;
                let refLng = day.timeline.length > 0 ? day.timeline[day.timeline.length - 1]._lng : null;

                for (const cat of itinSelectedCategorySequence) {
                    if (t + 30 > endMins) break;
                    const pick = _pickClosest(usedSpotIds, cat, t, endMins, refLat, refLng);
                    if (pick) {
                        day.timeline.push({
                            ...pick,
                            sch_start:  t,
                            sch_end:    t + pick.logicDur,
                            isDone:     false,
                            isAnchored: false,
                        });
                        usedSpotIds.add(pick.rowid);
                        t     += pick.logicDur + bufferMins;
                        refLat = pick._lat;
                        refLng = pick._lng;
                    }
                }
                day.timeline.sort((a, b) => a.sch_start - b.sch_start);
            });

            // ── Guard: nothing was scheduled ─────────────────────────────────
            if (newItinerary.days.every(d => d.timeline.length === 0)) {
                document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
                if (typeof showFormErrorSpeechBubble === 'function') {
                    showFormErrorSpeechBubble([`No matching spots found in ${newItinerary.city} for the selected categories.`]);
                }
                return;
            }

            // ── Persist locally + fire cloud sync ─────────────────────────────
            if (isEditingMode) {
                const idx = savedItineraries.findIndex(i => i.id === editingItinId);
                if (idx > -1) savedItineraries[idx] = newItinerary;
                else          savedItineraries.push(newItinerary);
            } else {
                savedItineraries.push(newItinerary);
            }
            // syncItineraryToCloud updates localStorage as its first step, then
            // fires a no-cors POST to the ItineraryVault sheet (fire-and-forget).
            syncItineraryToCloud(newItinerary, 'save');

            // ── Reset transient form state ────────────────────────────────────
            isEditingMode                = false;
            editingItinId                = null;
            selectedMultiDatesArray      = [];
            itinSelectedCategorySequence = [];

            document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
            toggleItineraryCreationDrawerForm(false);
            renderItineraryMasterDashboardWorkspace();

            const totalSpots = newItinerary.days.reduce((sum, d) => sum + d.timeline.length, 0);
            if (typeof showFormErrorSpeechBubble === 'function') {
                showFormErrorSpeechBubble([
                    `"${newItinerary.title}" created — ${newItinerary.days.length} ` +
                    `day${newItinerary.days.length > 1 ? 's' : ''}, ` +
                    `${totalSpots} spot${totalSpots !== 1 ? 's' : ''}!`
                ]);
            }

        } catch (err) {
            // Safety net: never leave the loading overlay stuck on screen
            console.error('[ItineraryEngine] generation failed:', err);
            document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
            if (typeof showFormErrorSpeechBubble === 'function') {
                showFormErrorSpeechBubble(['Something went wrong while building the itinerary. Please try again.']);
            }
        }
    }, 800);
}