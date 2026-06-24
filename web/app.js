/**
 * AMIPI Inventory Recommender - Application Client Logic
 */

// Application State
let rawInventory = [];
let multipliers = {};
let calculatedResults = [];
let activeFilters = {
    search: '',
    event: '',
    priority: 'ALL'
};

// UI Elements
const els = {
    totalItems: document.getElementById('kpi-total-items'),
    totalOrder: document.getElementById('kpi-total-order'),
    highUrgency: document.getElementById('kpi-high-urgency'),
    totalEvents: document.getElementById('kpi-total-events'),
    
    aiToggle: document.getElementById('ai-toggle'),
    apiKeyContainer: document.getElementById('api-key-container'),
    apiKey: document.getElementById('api-key'),
    
    btnAddStyle: document.getElementById('btn-add-style'),
    btnRecalculate: document.getElementById('btn-recalculate'),
    btnSaveData: document.getElementById('btn-save-data'),
    btnSaveMultipliers: document.getElementById('btn-save-multipliers'),
    
    multipliersContainer: document.getElementById('multipliers-container'),
    
    searchInput: document.getElementById('search-input'),
    filterEvent: document.getElementById('filter-event'),
    tabButtons: document.querySelectorAll('.tab-btn'),
    
    tableBody: document.getElementById('inventory-table-body'),
    
    modalAddStyle: document.getElementById('modal-add-style'),
    addStyleForm: document.getElementById('add-style-form'),
    formEventSelect: document.getElementById('form-event'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    btnCancelModal: document.getElementById('btn-cancel-modal'),
    
    loadingOverlay: document.getElementById('loading-overlay'),
    overlayTitle: document.getElementById('overlay-title'),
    overlaySubtitle: document.getElementById('overlay-subtitle'),
    
    exportCsv: document.getElementById('export-csv'),
    exportJson: document.getElementById('export-json'),
    toastContainer: document.getElementById('toast-container')
};

// Initialize Application
window.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await loadInitialData();
});

// Event Listeners Setup
function setupEventListeners() {
    // AI Toggle
    els.aiToggle.addEventListener('change', (e) => {
        els.apiKeyContainer.style.display = e.target.checked ? 'block' : 'none';
    });

    // Run Analysis Button
    els.btnRecalculate.addEventListener('click', () => runRemoteAnalysis(true));

    // Save Inventory
    els.btnSaveData.addEventListener('click', saveInventoryData);

    // Save Multipliers
    els.btnSaveMultipliers.addEventListener('click', saveMultipliersData);

    // Search and Filter Events
    els.searchInput.addEventListener('input', (e) => {
        activeFilters.search = e.target.value.toLowerCase().trim();
        renderTable();
    });

    els.filterEvent.addEventListener('change', (e) => {
        activeFilters.event = e.target.value;
        renderTable();
    });

    // Tab Filters
    els.tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            els.tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilters.priority = btn.getAttribute('data-priority');
            renderTable();
        });
    });

    // Modal Events
    els.btnAddStyle.addEventListener('click', () => {
        // Pop event options in modal form
        els.formEventSelect.innerHTML = '';
        Object.keys(multipliers).forEach(event => {
            const opt = document.createElement('option');
            opt.value = event;
            opt.textContent = event;
            els.formEventSelect.appendChild(opt);
        });
        els.modalAddStyle.classList.add('active');
    });

    const closeModal = () => {
        els.modalAddStyle.classList.remove('active');
        els.addStyleForm.reset();
    };
    els.btnCloseModal.addEventListener('click', closeModal);
    els.btnCancelModal.addEventListener('click', closeModal);

    // Form Submission
    els.addStyleForm.addEventListener('submit', (e) => {
        e.preventDefault();
        addNewStyle();
        closeModal();
    });

    // Export Dropdowns
    els.exportCsv.addEventListener('click', (e) => {
        e.preventDefault();
        exportData('csv');
    });
    els.exportJson.addEventListener('click', (e) => {
        e.preventDefault();
        exportData('json');
    });

    // Dropdown Toggle Click logic (replaces hover behavior to prevent hover-gap bugs)
    const dropdownToggle = document.querySelector('.dropdown-toggle');
    const dropdownMenu = document.querySelector('.dropdown-menu');
    if (dropdownToggle && dropdownMenu) {
        dropdownToggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropdownMenu.classList.toggle('active');
        });
        document.addEventListener('click', () => {
            dropdownMenu.classList.remove('active');
        });
    }
}

// Load Data from Server
async function loadInitialData() {
    showOverlay('Loading Engine', 'Reading CSV data files from backend server...');
    try {
        // Fetch multipliers
        const multRes = await fetch('/api/multipliers');
        const multData = await multRes.json();
        
        multipliers = {};
        multData.forEach(item => {
            multipliers[item.event.trim()] = parseFloat(item.event_multiplier);
        });

        // Fetch inventory
        const invRes = await fetch('/api/inventory');
        rawInventory = await invRes.json();

        // Populate event dropdown filters
        populateEventFilters();

        // Calculate recommendations locally using default multipliers
        calculateRecommendationsLocally();
        
        // Render view
        renderMultipliers();
        renderTable();
        
        showToast('Inventory and multipliers loaded successfully.', 'success');
        
        // Trigger automatic remote calculations using Gemini API
        await runRemoteAnalysis(true);
    } catch (err) {
        console.error(err);
        showToast('Error loading data from server. Ensure server.py is running.', 'error');
    } finally {
        hideOverlay();
    }
}

// Populate Event Select Options
function populateEventFilters() {
    els.filterEvent.innerHTML = '<option value="">All Events</option>';
    Object.keys(multipliers).forEach(event => {
        const opt = document.createElement('option');
        opt.value = event;
        opt.textContent = event;
        els.filterEvent.appendChild(opt);
    });
}

// Local Calculation Engine (matches Python mathematical formulas exactly)
function calculateRecommendationsLocally() {
    calculatedResults = rawInventory.map(row => {
        const currentStock = parseInt(row.current_stock) || 0;
        const onOrder = parseInt(row.on_order) || 0;
        const sales90 = parseInt(row.last_90_day_sales) || 0;
        const days = parseInt(row.days_until_event) || 0;
        const eventName = (row.event || '').trim();
        const multiplier = multipliers[eventName] !== undefined ? multipliers[eventName] : 1.0;

        const available = currentStock + onOrder;
        const monthlyRate = sales90 / 3;
        const projectedDemand = monthlyRate * (days / 30);
        const needed = projectedDemand * multiplier;
        const suggestedQty = Math.max(0, Math.round(needed - available));

        // Priority Logic
        let priority = 'Low';
        let recommendation = 'Monitor';

        if (sales90 <= 3 && currentStock >= 8) {
            priority = 'Do Not Reorder';
            recommendation = 'Hold';
        } else if (suggestedQty >= 5 || (currentStock <= 2 && sales90 >= 10)) {
            priority = 'High';
            recommendation = 'Reorder Urgently';
        } else if ((suggestedQty >= 2 && suggestedQty <= 4) || (currentStock <= 3 && sales90 >= 6)) {
            priority = 'Medium';
            recommendation = 'Reorder';
        }

        // Generate local reason if backend hasn't generated one yet
        const reason = row.reason || getFallbackReasonString(priority, sales90, currentStock, eventName);

        return {
            ...row,
            current_stock: currentStock,
            on_order: onOrder,
            last_90_day_sales: sales90,
            days_until_event: days,
            available_inventory: available,
            monthly_sales_rate: Math.round(monthlyRate * 100) / 100,
            projected_demand_until_event: Math.round(projectedDemand * 100) / 100,
            event_multiplier: multiplier,
            recommended_stock_needed: Math.round(needed * 100) / 100,
            suggested_order_qty: suggestedQty,
            priority,
            recommendation,
            reason
        };
    });

    renderMetrics();
    updateTabBadges();
}

// Fallback Reason Generator (JS mirror of Python code)
function getFallbackReasonString(priority, sales, stock, event) {
    if (priority === 'Do Not Reorder') {
        return `Slow 90-day movement (${sales} units) with ample stock (${stock}) — hold position ahead of ${event}.`;
    }
    if (priority === 'High') {
        return `Strong sales velocity and limited availability require urgent restocking before ${event}.`;
    }
    if (priority === 'Medium') {
        return `Moderate demand with lean inventory warrants replenishment ahead of ${event}.`;
    }
    return `Current stock is sufficient; monitor sell-through approaching ${event}.`;
}

// Calculate and Render KPIs
function renderMetrics() {
    els.totalItems.textContent = calculatedResults.length;
    
    const totalOrderQty = calculatedResults.reduce((acc, item) => acc + item.suggested_order_qty, 0);
    els.totalOrder.textContent = totalOrderQty;

    const highPriorityCount = calculatedResults.filter(item => item.priority === 'High').length;
    els.highUrgency.textContent = highPriorityCount;

    const activeEventsCount = Object.keys(multipliers).length;
    els.totalEvents.textContent = activeEventsCount;
}

// Update badges on Tab Headers
function updateTabBadges() {
    const counts = { ALL: calculatedResults.length, High: 0, Medium: 0, Low: 0, 'Do Not Reorder': 0 };
    calculatedResults.forEach(item => {
        if (counts[item.priority] !== undefined) {
            counts[item.priority]++;
        }
    });

    document.getElementById('badge-all').textContent = counts.ALL;
    document.getElementById('badge-high').textContent = counts.High;
    document.getElementById('badge-medium').textContent = counts.Medium;
    document.getElementById('badge-low').textContent = counts.Low;
    document.getElementById('badge-hold').textContent = counts['Do Not Reorder'];
}

// Render Multipliers sidebar
function renderMultipliers() {
    els.multipliersContainer.innerHTML = '';
    
    Object.entries(multipliers).forEach(([event, val]) => {
        const card = document.createElement('div');
        card.className = 'multiplier-item';
        
        card.innerHTML = `
            <div class="mult-label-row">
                <span class="mult-name">${event}</span>
                <span class="mult-value-badge" id="badge-mult-${escapeId(event)}">${val.toFixed(1)}x</span>
            </div>
            <div class="mult-slider-container">
                <input type="range" min="1.0" max="4.0" step="0.1" value="${val}" id="slide-${escapeId(event)}">
                <input type="number" min="1.0" max="4.0" step="0.1" value="${val}" class="mult-number-input" id="num-${escapeId(event)}">
            </div>
        `;
        
        els.multipliersContainer.appendChild(card);
        
        // Link slider and number inputs
        const slider = card.querySelector(`#slide-${escapeId(event)}`);
        const numInput = card.querySelector(`#num-${escapeId(event)}`);
        const badge = card.querySelector(`#badge-mult-${escapeId(event)}`);
        
        const updateVal = (newVal) => {
            let floatVal = parseFloat(newVal);
            if (isNaN(floatVal)) floatVal = 1.0;
            floatVal = Math.min(4.0, Math.max(1.0, floatVal));
            
            multipliers[event] = floatVal;
            slider.value = floatVal;
            numInput.value = floatVal.toFixed(1);
            badge.textContent = floatVal.toFixed(1) + 'x';
            
            // Recalculate locally instantly
            calculateRecommendationsLocally();
            renderTable();
        };
        
        slider.addEventListener('input', (e) => updateVal(e.target.value));
        numInput.addEventListener('change', (e) => updateVal(e.target.value));
    });
}

// Render Recommendations Table
function renderTable() {
    els.tableBody.innerHTML = '';
    
    // Filter the items
    const filtered = calculatedResults.filter(item => {
        // Search query filter
        const matchSearch = !activeFilters.search || 
            item.style_number.toLowerCase().includes(activeFilters.search) ||
            (item.category || '').toLowerCase().includes(activeFilters.search) ||
            (item.metal || '').toLowerCase().includes(activeFilters.search) ||
            (item.stone_type || '').toLowerCase().includes(activeFilters.search);
            
        // Event filter
        const matchEvent = !activeFilters.event || item.event === activeFilters.event;
        
        // Priority filter
        const matchPriority = activeFilters.priority === 'ALL' || item.priority === activeFilters.priority;
        
        return matchSearch && matchEvent && matchPriority;
    });
    
    if (filtered.length === 0) {
        els.tableBody.innerHTML = `
            <tr>
                <td colspan="11" class="loading-state">No matching inventory items found.</td>
            </tr>
        `;
        return;
    }
    
    filtered.forEach(item => {
        const row = document.createElement('tr');
        
        // Highlight rows containing local changes
        const original = rawInventory.find(ri => ri.style_number === item.style_number);
        const hasChanges = original && (
            original.current_stock !== item.current_stock ||
            original.on_order !== item.on_order ||
            original.last_90_day_sales !== item.last_90_day_sales
        );
        
        if (hasChanges) {
            row.classList.add('row-changed');
        }
        
        row.innerHTML = `
            <td>
                <span class="style-code-label">${item.style_number}</span>
            </td>
            <td>
                <div class="spec-cell">
                    <span class="spec-cat">${item.category || 'N/A'}</span>
                    <span class="spec-details">${item.metal} | ${item.stone_type}</span>
                </div>
            </td>
            <td>
                <div class="event-cell">
                    <span class="event-name-lbl">${item.event}</span>
                    <span class="event-days-lbl">in ${item.days_until_event} days</span>
                </div>
            </td>
            <td class="num-col">
                <input type="number" class="editable-cell-input val-sales" min="0" value="${item.last_90_day_sales}" data-style="${item.style_number}">
            </td>
            <td class="num-col">
                <input type="number" class="editable-cell-input val-stock" min="0" value="${item.current_stock}" data-style="${item.style_number}">
            </td>
            <td class="num-col">
                <input type="number" class="editable-cell-input val-order" min="0" value="${item.on_order}" data-style="${item.style_number}">
            </td>
            <td class="num-col">
                <span class="available-badge">${item.available_inventory}</span>
            </td>
            <td class="num-col">
                <span class="suggested-qty-value ${item.suggested_order_qty > 0 ? 'highlight-qty' : ''}">${item.suggested_order_qty}</span>
            </td>
            <td>
                <span class="priority-badge ${item.priority}">${item.priority}</span>
            </td>
            <td>
                <p class="reason-text">${item.reason}</p>
            </td>
            <td class="num-col">
                <button class="btn-delete-row" data-style="${item.style_number}">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                </button>
            </td>
        `;
        
        els.tableBody.appendChild(row);
        
        // Attach interactive keystroke events to fields
        const salesInput = row.querySelector('.val-sales');
        const stockInput = row.querySelector('.val-stock');
        const orderInput = row.querySelector('.val-order');
        const deleteBtn = row.querySelector('.btn-delete-row');
        
        const handleCellEdit = (field, val) => {
            let intVal = parseInt(val);
            if (isNaN(intVal) || intVal < 0) {
                const fieldFriendly = field.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                showToast(`Invalid input for ${fieldFriendly}. Must be a non-negative integer.`, 'error');
                intVal = 0;
            }
            
            // Find in raw inventory and update
            const targetItem = rawInventory.find(ri => ri.style_number === item.style_number);
            if (targetItem) {
                targetItem[field] = intVal;
                calculateRecommendationsLocally();
                renderTable();
            }
        };
        
        salesInput.addEventListener('change', (e) => handleCellEdit('last_90_day_sales', e.target.value));
        stockInput.addEventListener('change', (e) => handleCellEdit('current_stock', e.target.value));
        orderInput.addEventListener('change', (e) => handleCellEdit('on_order', e.target.value));
        
        deleteBtn.addEventListener('click', () => {
            if (confirm(`Remove style ${item.style_number} from session?`)) {
                rawInventory = rawInventory.filter(ri => ri.style_number !== item.style_number);
                calculateRecommendationsLocally();
                renderTable();
                showToast(`Removed ${item.style_number}`, 'success');
            }
        });
    });
}

// Trigger Calculations and AI reasoning in Backend Server
async function runRemoteAnalysis(triggerAiReason = true) {
    const useAi = true;
    const apiKeyVal = null;
    
    showOverlay(
        'AI Reason Engine Active', 
        'Contacting Gemini API for professional jewelry merchandising reasons...'
    );

    try {
        const payload = {
            multipliers,
            use_ai: useAi,
            api_key: useAi ? apiKeyVal : null,
            inventory: rawInventory // Pass manual overrides
        };

        const res = await fetch('/api/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errBody = await res.json();
            throw new Error(errBody.error || 'Backend calculation error');
        }

        const data = await res.json();
        
        // Sync our local rawInventory state (so changes don't get lost)
        data.forEach(item => {
            const raw = rawInventory.find(r => r.style_number === item.style_number);
            if (raw) {
                raw.reason = item.reason;
                raw.current_stock = item.current_stock;
                raw.on_order = item.on_order;
                raw.last_90_day_sales = item.last_90_day_sales;
            }
        });

        calculateRecommendationsLocally();
        renderTable();
        showToast('Analysis completed successfully.', 'success');
    } catch (err) {
        console.error(err);
        showToast(`Calculation failed: ${err.message}`, 'error');
    } finally {
        hideOverlay();
    }
}

// Save Multipliers to CSV
async function saveMultipliersData() {
    showOverlay('Saving Config', 'Updating event multipliers CSV file on server...');
    try {
        const payload = Object.entries(multipliers).map(([event, val]) => ({
            event: event,
            event_multiplier: val
        }));

        const res = await fetch('/api/save_multipliers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('Failed to save event_multipliers.csv');

        showToast('Event multipliers CSV updated successfully.', 'success');
    } catch (err) {
        console.error(err);
        showToast('Failed to save multipliers: ' + err.message, 'error');
    } finally {
        hideOverlay();
    }
}

// Save Inventory to CSV
async function saveInventoryData() {
    showOverlay('Saving Catalog', 'Updating inventory sales CSV file on server...');
    try {
        // Send rawInventory (keeps all original columns)
        const res = await fetch('/api/save_inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawInventory)
        });

        if (!res.ok) throw new Error('Failed to save inventory_sales.csv');

        // Reset state indicator by reloading
        const invRes = await fetch('/api/inventory');
        rawInventory = await invRes.json();
        calculateRecommendationsLocally();
        renderTable();
        
        showToast('Inventory CSV updated successfully.', 'success');
    } catch (err) {
        console.error(err);
        showToast('Failed to save inventory: ' + err.message, 'error');
    } finally {
        hideOverlay();
    }
}

// Add New Style logic
function addNewStyle() {
    const styleNum = document.getElementById('form-style').value.toUpperCase().trim();
    
    // Check duplication
    if (rawInventory.some(r => r.style_number === styleNum)) {
        showToast(`Style number ${styleNum} already exists!`, 'error');
        return;
    }

    const eventName = document.getElementById('form-event').value;
    const days = parseInt(document.getElementById('form-days').value) || 30;
    const category = document.getElementById('form-category').value.trim() || 'Ring';
    const metal = document.getElementById('form-metal').value.trim() || '14W';
    const stone = document.getElementById('form-stone').value.trim() || 'Natural Diamond';
    const sales = parseInt(document.getElementById('form-sales').value) || 0;
    const stock = parseInt(document.getElementById('form-stock').value) || 0;
    const order = parseInt(document.getElementById('form-order').value) || 0;

    const newRow = {
        style_number: styleNum,
        category,
        metal,
        stone_type: stone,
        last_30_day_sales: Math.round(sales / 3),
        last_90_day_sales: sales,
        current_stock: stock,
        on_order: order,
        event: eventName,
        days_until_event: days,
        season: 'Trade Show',
        reason: '' // Filled by formula
    };

    rawInventory.unshift(newRow); // Add to beginning of grid
    calculateRecommendationsLocally();
    renderTable();
    showToast(`Added style ${styleNum} successfully. Save to write to disk.`, 'success');
}

// Exporters (CSV and JSON)
function exportData(format) {
    // Export currently filtered items
    const filtered = calculatedResults.filter(item => {
        const matchSearch = !activeFilters.search || 
            item.style_number.toLowerCase().includes(activeFilters.search) ||
            (item.category || '').toLowerCase().includes(activeFilters.search) ||
            (item.metal || '').toLowerCase().includes(activeFilters.search) ||
            (item.stone_type || '').toLowerCase().includes(activeFilters.search);
        const matchEvent = !activeFilters.event || item.event === activeFilters.event;
        const matchPriority = activeFilters.priority === 'ALL' || item.priority === activeFilters.priority;
        return matchSearch && matchEvent && matchPriority;
    });

    if (filtered.length === 0) {
        showToast('No items to export.', 'error');
        return;
    }

    const filename = `AMIPI_Restock_Plan_${new Date().toISOString().slice(0,10)}`;

    if (format === 'json') {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(filtered, null, 2));
        const dlAnchorElem = document.createElement('a');
        dlAnchorElem.setAttribute("href", dataStr);
        dlAnchorElem.setAttribute("download", `${filename}.json`);
        dlAnchorElem.click();
        showToast('Downloaded JSON report.', 'success');
    } else if (format === 'csv') {
        // Build CSV content
        const headers = [
            "style_number", "category", "metal", "stone_type", "event", 
            "days_until_event", "last_90_day_sales", "current_stock", 
            "on_order", "available_inventory", "monthly_sales_rate", 
            "projected_demand_until_event", "event_multiplier", 
            "recommended_stock_needed", "suggested_order_qty", 
            "priority", "recommendation", "reason"
        ];
        
        let csvContent = headers.join(",") + "\n";
        
        filtered.forEach(item => {
            const row = headers.map(header => {
                let cell = item[header] === undefined ? "" : item[header];
                // Escape strings containing commas
                if (typeof cell === 'string' && (cell.includes(',') || cell.includes('"') || cell.includes('\n'))) {
                    cell = `"${cell.replace(/"/g, '""')}"`;
                }
                return cell;
            });
            csvContent += row.join(",") + "\n";
        });
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `${filename}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('Downloaded CSV report.', 'success');
    }
}

// Helpers
function escapeId(str) {
    return str.replace(/[^a-zA-Z0-9]/g, '_');
}

function showOverlay(title, subtitle) {
    els.overlayTitle.textContent = title;
    els.overlaySubtitle.textContent = subtitle;
    els.loadingOverlay.classList.add('active');
}

function hideOverlay() {
    els.loadingOverlay.classList.remove('active');
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    toast.innerHTML = `
        <span>${message}</span>
        <button class="toast-close">&times;</button>
    `;
    
    els.toastContainer.appendChild(toast);
    
    // Auto-remove toast after 4s
    const timeout = setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
    
    toast.querySelector('.toast-close').addEventListener('click', () => {
        clearTimeout(timeout);
        toast.remove();
    });
}
