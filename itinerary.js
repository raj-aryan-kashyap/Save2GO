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

function renderItineraryMasterDashboardWorkspace() {
    const masterList = document.getElementById('itineraryMasterListScroll');
    const container = document.getElementById('itineraryMasterListView');
    
    if (container) container.classList.remove('hidden');
    const detailView = document.getElementById('itineraryDetailView');
    if (detailView) detailView.classList.add('hidden');
    
    if (!masterList) return;
    masterList.innerHTML = '';

    const topHeaderBar = container ? container.querySelector('.flex.justify-between.items-center') : null;

    if (!savedItineraries || savedItineraries.length === 0) {
        if (topHeaderBar) topHeaderBar.classList.add('hidden');

        masterList.innerHTML = `
            <div class="flex flex-col justify-center items-center py-12 text-center px-6">
                <div class="max-w-xs space-y-4">
                    <div class="w-16 h-16 rounded-full bg-pink-500/10 border border-pink-500/20 flex items-center justify-center text-pink-500 text-2xl mx-auto">
                        <i class="fa-solid fa-route"></i>
                    </div>
                    <h2 class="text-lg font-black text-slate-200">Build Your First Itinerary</h2>
                    <p class="text-sm text-slate-400">Create daily schedules using saved spots.</p>
                    <button onclick="toggleItineraryCreationDrawerForm(true)" class="w-full py-3 bg-gradient-to-r from-pink-600 to-purple-600 rounded-xl text-xs font-black uppercase text-white shadow-lg">
                        + New Itinerary
                    </button>
                </div>
            </div>`;
        return;
    }
    if (topHeaderBar) topHeaderBar.classList.remove('hidden');

    savedItineraries.forEach(itin => {
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(itin.city)) {
            return; 
        }

        let pendingCount = 0;
        itin.days.forEach(d => d.timeline.forEach(s => { if(!s.isDone) pendingCount++; }));
        
        const card = document.createElement('div');
        card.className = "bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col gap-2 cursor-pointer active:scale-[0.98] transition-transform shadow-lg";
        card.onclick = () => openItineraryDetailView(itin.id);
        card.innerHTML = `
            <div class="flex justify-between items-start">
                <h3 class="text-sm font-black text-slate-200">${itin.title}</h3>
                <span class="text-[9px] font-bold px-2 py-1 bg-slate-800 border border-slate-700 rounded-md text-slate-400 shadow-inner">${itin.days.length} Days</span>
            </div>
            <div class="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                <i class="fa-solid fa-location-dot text-pink-500"></i> ${itin.city}
            </div>
            <div class="mt-2 flex items-center justify-between border-t border-slate-800 pt-3">
                <span class="text-[10px] font-black ${pendingCount > 0 ? 'text-amber-400' : 'text-emerald-400'}">${pendingCount === 0 ? '<i class="fa-solid fa-check-circle mr-1"></i> Completed' : pendingCount + ' Pending Spots'}</span>
                <i class="fa-solid fa-chevron-right text-slate-600"></i>
            </div>
        `;
        masterList.appendChild(card);
    });

    masterList.innerHTML += `
        <div class="text-center py-8 text-[10px] font-black text-slate-600 tracking-widest opacity-60 border-t border-slate-800/50 mt-4">
            End of Filtered Itinerary List
        </div>`;
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

    document.getElementById('detailItineraryTitle').innerText = itin.title;
    document.getElementById('detailDayLabel').innerText = `Day ${activeItineraryDayTracker + 1} of ${itin.days.length}`;
    
    const activeDay = itin.days[activeItineraryDayTracker];
    document.getElementById('detailDateLabel').innerText = new Date(activeDay.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    container.innerHTML = '';
    
    if (activeDay.timeline.length === 0) {
        container.innerHTML = `<div class="text-center text-slate-600 py-16 text-xs font-medium space-y-3"><div class="text-4xl opacity-30"><i class="fa-solid fa-mug-hot"></i></div><p>No activities scheduled for this day.</p></div>`;
        return;
    }

    activeDay.timeline.forEach((spot, spotIndex) => {
        const card = document.createElement('div');
        card.className = `w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 relative flex items-center gap-3 shrink-0 transition-all ${spot.isDone ? 'itin-done-card border-slate-900' : ''}`;
        
        card.innerHTML = `
            <div class="absolute top-0 bottom-0 left-0 w-1 bg-gradient-to-b from-pink-500 to-purple-600 opacity-80 rounded-l-2xl"></div>
            
            <div class="flex items-start gap-3 w-full">
                <div class="flex flex-col items-center justify-start shrink-0 w-8 pt-1 pl-1">
                    <button onclick="toggleActivityDoneState(${activeItineraryDayTracker}, ${spotIndex})" class="w-7 h-7 rounded-full border-2 flex items-center justify-center transition-colors ${spot.isDone ? 'bg-pink-600 border-pink-600 text-white shadow-[0_0_10px_rgba(236,72,153,0.5)]' : 'border-slate-600 text-transparent hover:border-pink-500'}">
                        <i class="fa-solid fa-check text-[12px]"></i>
                    </button>
                </div>
                <div class="flex-1 min-w-0 pl-1">
                    <div class="flex justify-between items-start gap-2">
                        <div class="flex flex-col min-w-0">
                            <span class="text-[9px] font-mono font-bold text-pink-400 bg-pink-500/10 px-1.5 py-0.5 rounded w-fit mb-1 border border-pink-500/20 shadow-inner">${formatMinutesToTime(spot.sch_start)} - ${formatMinutesToTime(spot.sch_end)}</span>
                            <h3 class="text-[13px] font-black truncate text-slate-200 ${spot.isDone ? 'itin-done-text' : ''}">${spot.spot_name}</h3>
                            <p class="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5 flex items-center gap-1">${spot.category} ${spot.isAnchored ? '<span class="text-amber-400 ml-1 flex items-center gap-0.5"><i class="fa-solid fa-lock text-[8px]"></i> Fixed</span>' : ''}</p>
                        </div>
                        <button onclick="removeActivityFromTimeline(${activeItineraryDayTracker}, ${spotIndex})" class="w-6 h-6 flex items-center justify-center bg-red-950/20 text-red-500 rounded-full shrink-0 text-xs hover:bg-red-900/60 transition-colors"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    ${spot.notes ? `<div class="mt-2.5 bg-slate-950/40 p-2.5 rounded-xl border border-slate-900/60"><p class="text-[10px] leading-relaxed font-medium text-slate-400 line-clamp-2 ${spot.isDone ? 'itin-done-text' : ''}">${spot.notes}</p></div>` : ''}
                    <div class="flex gap-2 mt-3 justify-end items-center">
                        <button onclick="swapActivityInTimeline(${activeItineraryDayTracker}, ${spotIndex})" class="mr-auto px-3 py-1.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-lg text-[10px] font-black tracking-wide active:bg-indigo-500/20 transition-colors ${spot.isDone ? 'opacity-50 pointer-events-none' : ''}"><i class="fa-solid fa-arrows-rotate mr-1"></i> Swap</button>
                        <a href="${spot.instagram_url || spot.reference_link || '#'}" target="_blank" class="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-bold text-slate-300 active:bg-slate-900 transition-colors ${spot.isDone ? 'opacity-50 pointer-events-none' : ''}">Reference</a>
                        <button data-row-id="${spot.rowid}" onclick="handleAdaptiveDirectionClick(this, event)" class="px-3 py-1.5 bg-pink-600/10 border border-pink-500/20 text-pink-400 rounded-lg text-[10px] font-black tracking-wide active:bg-pink-600/20 transition-colors ${spot.isDone ? 'opacity-50 pointer-events-none' : ''}"><i class="fa-solid fa-map mr-1"></i> Directions</button>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    container.innerHTML += `
        <div class="text-center py-8 text-[10px] font-black text-slate-600 tracking-widest opacity-60 border-t border-slate-800/50 mt-4">
            End of Selected Day Itinerary List
        </div>`;
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
    const title = document.getElementById('itin-new-name').value.trim();
    const chosenCity = document.getElementById('itin-new-city').value;
    const startMins = parseTimeToMinutes(document.getElementById('itin-new-start').value || "09:00");
    const endMins = parseTimeToMinutes(document.getElementById('itin-new-end').value || "21:00");

    let missing = [];
    if (!title) missing.push("Itinerary Name");
    if (!chosenCity) missing.push("City Selection");
    if (selectedMultiDatesArray.length === 0) missing.push("Travel Dates");
    if (itinSelectedCategorySequence.length === 0) missing.push("Category Sequence");

    if (missing.length > 0) {
        showFormErrorSpeechBubble(missing);
        return; 
    }

    document.getElementById('buildingItineraryLoaderPopup').classList.remove('hidden');
    
    setTimeout(() => {
        const bufferMins = itinPacingMode === 'max' ? 15 : 45;
        
        let availablePool = travelSpots.filter(s => s.city === chosenCity).map(s => {
            const logic = getCategoryLogic(s.category);
            const anchoredMins = detectAnchoredTime(s.booking_requirement);
            return { 
                ...s, 
                isAnchored: anchoredMins !== null, anchoredTime: anchoredMins,
                logicDur: itinPacingMode === 'max' ? logic.durationMax : logic.durationRelaxed,
                logicOpen: logic.open * 60, logicClose: logic.close * 60
            };
        });

        let newItinerary = { 
            id: isEditingMode ? editingItinId : Date.now().toString(), 
            title: title, 
            city: chosenCity, 
            days: [],
            config: { 
                dates: [...selectedMultiDatesArray], 
                categories: [...itinSelectedCategorySequence], 
                pacing: itinPacingMode,
                start: startMins,
                end: endMins
            }
        };
        let usedSpotIds = new Set();
        let sequenceIndex = 0;

        selectedMultiDatesArray.sort().forEach(dateStr => {
            let dailyTimeline = [];
            let currentTime = startMins;
            let lastCoords = null;
            let sequenceAttempts = 0;
            let maxAttempts = itinSelectedCategorySequence.length * 3