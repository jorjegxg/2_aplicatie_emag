/*
 * Coloane de tabel: ascundere, reordonare prin drag, meniul "Coloane" si redimensionare.
 * Folosit de tabelul de produse (index.html) si de cel de preturi (sync.html).
 * Ordinea implicita, etichetele si sursele vin din <th data-col data-src> din thead.
 * enableResize() poate fi folosit si pe tabele fara meniu de coloane.
 */
(function (global) {
  const MIN_COL_WIDTH = 48;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function colKey(th, index) {
    return th?.dataset?.col || String(index);
  }

  /**
   * Redimensionare coloane prin drag pe manerul din antet; latimile se salveaza in localStorage.
   * @param {object} opts
   * @param {HTMLTableElement} opts.table
   * @param {string} opts.storageKey
   * @param {number} [opts.minWidth]
   * @returns {{ applyWidths: () => void, refreshHandles: () => void }}
   */
  function enableResize({ table, storageKey, minWidth = MIN_COL_WIDTH }) {
    if (!table || !storageKey) {
      return { applyWidths() {}, refreshHandles() {} };
    }

    /* Reapel pe acelasi tabel: reutilizeaza API-ul (acelasi closure widths + listener). */
    if (table._colResizeApi && table._colResizeApi.storageKey === storageKey) {
      table._colResizeApi.refreshHandles();
      return table._colResizeApi;
    }

    table.classList.add("is-col-resizable");

    let widths = {};
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        widths = Object.fromEntries(
          Object.entries(parsed).filter(
            ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= minWidth
          )
        );
      }
    } catch {
      widths = {};
    }

    function saveWidths() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(widths));
      } catch {
        /* ignore */
      }
    }

    function headerLabelRow() {
      return (
        table.querySelector("thead tr:not(.filter-row)") ||
        table.querySelector("thead tr")
      );
    }

    function setCellWidth(el, px) {
      if (!el) return;
      if (px == null) {
        el.style.width = "";
        el.style.minWidth = "";
        el.style.maxWidth = "";
        el.classList.remove("is-col-resized");
        return;
      }
      el.style.width = `${px}px`;
      el.style.minWidth = `${px}px`;
      el.style.maxWidth = `${px}px`;
      el.classList.add("is-col-resized");
    }

    function applyWidths() {
      const row = headerLabelRow();
      if (!row) return;
      const cells = [...row.children].filter((el) => el instanceof HTMLTableCellElement);
      const hasSaved = cells.some((th, index) => widths[colKey(th, index)] != null);
      if (hasSaved) {
        table.style.tableLayout = "fixed";
      } else {
        table.style.tableLayout = "";
      }

      cells.forEach((th, index) => {
        const key = colKey(th, index);
        const px = widths[key];
        setCellWidth(th, px ?? null);

        const filterTh =
          key && table.querySelector(`thead tr.filter-row th[data-col="${CSS.escape(key)}"]`);
        if (filterTh) {
          setCellWidth(filterTh, px ?? null);
          const input = filterTh.querySelector(".col-filter");
          if (input) {
            if (px != null) {
              input.style.width = "100%";
              input.style.minWidth = "0";
              input.style.maxWidth = "none";
            } else {
              input.style.width = "";
              input.style.minWidth = "";
              input.style.maxWidth = "";
            }
          }
        }

        const label = th.querySelector(".th-label");
        if (label) {
          label.style.maxWidth = px != null ? "100%" : "";
        }
      });
    }

    /** Completeaza latimile lipsa din layout-ul curent (fara a le rescrie pe cele salvate). */
    function lockCurrentWidths() {
      const row = headerLabelRow();
      if (!row) return;
      [...row.children].forEach((th, index) => {
        if (!(th instanceof HTMLTableCellElement)) return;
        const key = colKey(th, index);
        if (widths[key] != null) return;
        widths[key] = Math.max(minWidth, Math.round(th.getBoundingClientRect().width));
      });
      table.style.tableLayout = "fixed";
    }

    function resetColumnWidth(key) {
      delete widths[key];
      if (Object.keys(widths).length === 0) {
        table.style.tableLayout = "";
      }
      applyWidths();
      saveWidths();
    }

    function ensureHandles() {
      const row = headerLabelRow();
      if (!row) return;
      [...row.children].forEach((th) => {
        if (!(th instanceof HTMLTableCellElement)) return;
        if (th.querySelector(".col-resize-handle")) return;
        const handle = document.createElement("span");
        handle.className = "col-resize-handle";
        handle.setAttribute("aria-hidden", "true");
        handle.title = "Trage pentru a redimensiona · dublu-click resetează";
        th.appendChild(handle);
      });
    }

    function onHandleDown(e) {
      if (e.button !== 0) return;
      const handle = e.target.closest(".col-resize-handle");
      if (!handle || !table.contains(handle)) return;
      const th = handle.closest("th");
      if (!th || !table.contains(th)) return;

      e.preventDefault();
      e.stopPropagation();

      const row = headerLabelRow();
      const index = [...row.children].indexOf(th);
      const key = colKey(th, index);
      lockCurrentWidths();
      applyWidths();

      const startX = e.clientX;
      const startW = widths[key] || Math.round(th.getBoundingClientRect().width);
      let latestW = startW;
      let moved = false;

      th.classList.add("is-col-resizing");
      document.body.classList.add("is-col-resizing");

      function onMove(ev) {
        const next = Math.max(minWidth, Math.round(startW + (ev.clientX - startX)));
        if (next === latestW && moved) return;
        moved = moved || Math.abs(ev.clientX - startX) > 2;
        latestW = next;
        widths[key] = next;
        applyWidths();
      }

      function onUp(ev) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        th.classList.remove("is-col-resizing");
        document.body.classList.remove("is-col-resizing");
        if (moved) {
          saveWidths();
          const blockClick = (clickEv) => {
            clickEv.stopPropagation();
            clickEv.preventDefault();
            document.removeEventListener("click", blockClick, true);
          };
          document.addEventListener("click", blockClick, true);
          setTimeout(() => document.removeEventListener("click", blockClick, true), 0);
        }
        ev.stopPropagation();
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }

    function onHandleDblClick(e) {
      const handle = e.target.closest(".col-resize-handle");
      if (!handle || !table.contains(handle)) return;
      const th = handle.closest("th");
      if (!th) return;
      e.preventDefault();
      e.stopPropagation();
      const row = headerLabelRow();
      const index = [...row.children].indexOf(th);
      resetColumnWidth(colKey(th, index));
    }

    if (!table.dataset.colResizeBound) {
      table.dataset.colResizeBound = "1";
      table.addEventListener("mousedown", onHandleDown);
      table.addEventListener("dblclick", onHandleDblClick);
    }

    ensureHandles();
    applyWidths();
    /* Daca exista latimi salvate partial, completeaza restul dupa layout. */
    if (Object.keys(widths).length > 0) {
      requestAnimationFrame(() => {
        lockCurrentWidths();
        applyWidths();
      });
    }

    const api = {
      storageKey,
      applyWidths,
      refreshHandles() {
        ensureHandles();
        applyWidths();
      },
    };
    table._colResizeApi = api;
    return api;
  }

  /**
   * @param {object} opts
   * @param {HTMLTableElement} opts.table
   * @param {HTMLElement} opts.tbody
   * @param {HTMLElement} opts.menuEl   container-ul meniului de coloane
   * @param {HTMLElement} opts.buttonEl butonul care deschide meniul
   * @param {string} opts.hiddenKey     cheia localStorage pentru coloanele ascunse
   * @param {string} opts.orderKey      cheia localStorage pentru ordine
   * @param {string} [opts.widthsKey]   cheia localStorage pentru latimile coloanelor
   * @param {(cols: string[]) => string[]} [opts.migrate] normalizeaza valorile vechi salvate
   * @param {() => void} [opts.onVisibilityChange] apelat cand userul bifeaza/debifeaza din meniu
   */
  function create({
    table,
    tbody,
    menuEl,
    buttonEl,
    hiddenKey,
    orderKey,
    widthsKey,
    migrate,
    onVisibilityChange,
  }) {
    const headerLabelRow = table.querySelector("thead tr:not(.filter-row)");
    const headerCells = [...headerLabelRow.querySelectorAll("th[data-col]")];
    const defaultOrder = headerCells.map((th) => th.dataset.col);
    const labels = Object.fromEntries(
      headerCells.map((th) => [th.dataset.col, th.textContent.trim()])
    );
    const sources = Object.fromEntries(
      headerCells.map((th) => [th.dataset.col, th.dataset.src || ""])
    );

    headerCells.forEach((th) => {
      const label = labels[th.dataset.col] || "";
      if (!label) return;
      th.title = label;
      th.innerHTML = `<span class="th-label">${escapeHtml(label)}</span>`;
    });

    const resizeApi = widthsKey
      ? enableResize({ table, storageKey: widthsKey })
      : { applyWidths() {}, refreshHandles() {} };

    const applyMigrate = (cols) =>
      typeof migrate === "function" ? migrate(cols) : cols;

    function loadHidden() {
      try {
        const raw = localStorage.getItem(hiddenKey);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return applyMigrate(parsed.filter((c) => typeof c === "string"));
      } catch {
        return [];
      }
    }

    function saveHidden() {
      try {
        localStorage.setItem(hiddenKey, JSON.stringify(hidden));
      } catch {
        /* ignore */
      }
    }

    /** Coloanele adaugate in HTML dupa ce userul avea deja o ordine salvata. */
    function insertMissingColumns(order) {
      const result = [...order];
      for (const col of defaultOrder) {
        if (result.includes(col)) continue;
        const defIdx = defaultOrder.indexOf(col);
        let insertAt = result.length;
        for (let i = defIdx - 1; i >= 0; i--) {
          const prevIdx = result.indexOf(defaultOrder[i]);
          if (prevIdx !== -1) {
            insertAt = prevIdx + 1;
            break;
          }
        }
        result.splice(insertAt, 0, col);
      }
      return result;
    }

    function loadOrder() {
      try {
        const raw = localStorage.getItem(orderKey);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!Array.isArray(parsed)) return [...defaultOrder];
        const migrated = applyMigrate(parsed.filter((c) => typeof c === "string"));
        const valid = new Set(defaultOrder);
        /* Fara dedupe o coloana salvata de doua ori randeaza doua <td> pe rand,
           iar antetul ramane cu un singur <th>: tot ce urmeaza se decaleaza. */
        const unique = [...new Set(migrated.filter((c) => valid.has(c)))];
        return insertMissingColumns(unique);
      } catch {
        return [...defaultOrder];
      }
    }

    function saveOrder() {
      try {
        localStorage.setItem(orderKey, JSON.stringify(order));
      } catch {
        /* ignore */
      }
    }

    let hidden = loadHidden();
    const order = loadOrder();
    /* Rescrie ordinea salvata daca a fost reparata (duplicate, coloane vechi). */
    if (localStorage.getItem(orderKey) && localStorage.getItem(orderKey) !== JSON.stringify(order)) {
      try {
        localStorage.setItem(orderKey, JSON.stringify(order));
      } catch {
        /* ignore */
      }
    }
    let dragCol = null;

    function isHidden(col) {
      return hidden.includes(col);
    }

    /** Clasele unei celule generate in HTML, cu vizibilitatea deja aplicata. */
    function cellClass(col, extra = "") {
      const parts = [extra, isHidden(col) ? "is-col-hidden" : ""].filter(Boolean);
      return parts.length ? ` class="${parts.join(" ")}"` : "";
    }

    /** Pune coloanele date primele, in ordinea data; restul raman dupa, in ordinea curenta. */
    function setOrder(cols) {
      const valid = new Set(order);
      const first = [...new Set((cols || []).filter((c) => valid.has(c)))];
      const firstSet = new Set(first);
      const next = [...first, ...order.filter((c) => !firstSet.has(c))];
      order.splice(0, order.length, ...next);
      saveOrder();
      applyOrder();
      buildMenu();
    }

    /** Inlocuieste setul de coloane ascunse (ex. dintr-un preset). */
    function setHidden(cols) {
      const valid = new Set(defaultOrder);
      hidden = [...new Set((cols || []).filter((c) => valid.has(c)))];
      saveHidden();
      applyVisibility();
      buildMenu();
    }

    function applyVisibility() {
      const hiddenSet = new Set(hidden);
      table.querySelectorAll("[data-col]").forEach((el) => {
        el.classList.toggle("is-col-hidden", hiddenSet.has(el.dataset.col));
      });
    }

    function reorderRow(row) {
      if (!row) return;
      const byCol = Object.fromEntries(
        [...row.querySelectorAll("[data-col]")].map((el) => [el.dataset.col, el])
      );
      order.forEach((col) => {
        if (byCol[col]) row.appendChild(byCol[col]);
      });
    }

    function applyOrder() {
      reorderRow(table.querySelector("thead tr:not(.filter-row)"));
      reorderRow(table.querySelector("thead tr.filter-row"));
      tbody?.querySelectorAll("tr:not(.empty-row)").forEach((tr) => reorderRow(tr));
      resizeApi.refreshHandles();
    }

    function buildMenu() {
      menuEl.innerHTML = order
        .map((col) => {
          const checked = isHidden(col) ? "" : "checked";
          const label = labels[col] || col;
          const src = sources[col] || "";
          const srcAttr = src ? ` data-src="${escapeHtml(src)}"` : "";
          return `<div class="col-menu-item"${srcAttr} data-col="${escapeHtml(col)}">
        <span class="col-drag-handle" draggable="true" aria-hidden="true" title="Trage pentru a reordona">⋮⋮</span>
        <label><input type="checkbox" data-col-toggle="${escapeHtml(col)}" ${checked} />${escapeHtml(label)}</label>
      </div>`;
        })
        .join("");
    }

    function setMenuOpen(open) {
      menuEl.hidden = !open;
      buttonEl?.setAttribute("aria-expanded", open ? "true" : "false");
    }

    buttonEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      setMenuOpen(menuEl.hidden);
    });

    menuEl.addEventListener("change", (e) => {
      const input = e.target.closest("input[data-col-toggle]");
      if (!input) return;
      const col = input.dataset.colToggle;
      if (input.checked) {
        hidden = hidden.filter((c) => c !== col);
      } else if (!hidden.includes(col)) {
        hidden.push(col);
      }
      saveHidden();
      applyVisibility();
      if (typeof onVisibilityChange === "function") onVisibilityChange();
    });

    menuEl.addEventListener("dragstart", (e) => {
      const handle = e.target.closest(".col-drag-handle");
      const item = handle?.closest(".col-menu-item");
      if (!item) {
        e.preventDefault();
        return;
      }
      dragCol = item.dataset.col;
      item.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragCol);
    });

    menuEl.addEventListener("dragend", () => {
      dragCol = null;
      menuEl.querySelectorAll(".col-menu-item").forEach((el) => {
        el.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
      });
    });

    menuEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      const item = e.target.closest(".col-menu-item");
      if (!item || !dragCol || item.dataset.col === dragCol) return;
      e.dataTransfer.dropEffect = "move";
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      menuEl.querySelectorAll(".col-menu-item").forEach((el) => {
        el.classList.remove("is-drop-before", "is-drop-after");
      });
      item.classList.add(before ? "is-drop-before" : "is-drop-after");
    });

    menuEl.addEventListener("drop", (e) => {
      e.preventDefault();
      const item = e.target.closest(".col-menu-item");
      if (!item || !dragCol || item.dataset.col === dragCol) return;
      const from = order.indexOf(dragCol);
      const toCol = item.dataset.col;
      let to = order.indexOf(toCol);
      if (from < 0 || to < 0) return;
      const rect = item.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      if (!before) to += 1;
      if (from < to) to -= 1;
      if (from === to) return;
      order.splice(from, 1);
      order.splice(to, 0, dragCol);
      saveOrder();
      applyOrder();
      buildMenu();
    });

    menuEl.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("click", () => {
      if (!menuEl.hidden) setMenuOpen(false);
    });

    return {
      order,
      defaultOrder,
      labels,
      sources,
      isHidden,
      getHidden: () => [...hidden],
      setHidden,
      setOrder,
      cellClass,
      applyVisibility,
      applyOrder,
      applyWidths: resizeApi.applyWidths,
      refreshResizeHandles: resizeApi.refreshHandles,
      buildMenu,
      setMenuOpen,
    };
  }

  /**
   * Selector de preseturi de coloane ("Coloane: personalizat", preseturi incorporate
   * si preseturi salvate de user in localStorage).
   * @param {object} opts
   * @param {ReturnType<typeof create>} opts.columns
   * @param {HTMLSelectElement} opts.selectEl
   * @param {HTMLElement} [opts.deleteBtn]
   * @param {string} opts.presetKey    cheia localStorage pentru presetul curent
   * @param {string} opts.customKey    cheia localStorage pentru preseturile salvate
   * @param {{id: string, label: string, cols: string[] | null, ordered?: boolean}[]} opts.builtins
   * @param {() => void} [opts.onSaved]
   * @returns {{ markCustom: () => void }}
   */
  function createPresets({ columns, selectEl, deleteBtn, presetKey, customKey, builtins, onSaved }) {
    if (!columns || !selectEl) return { markCustom() {} };

    function readJson(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }

    function write(key, value) {
      try {
        localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      } catch {
        /* ignore */
      }
    }

    /** Preseturile salvate de user: [{ id, label, cols }]. */
    function loadCustom() {
      const list = readJson(customKey, []);
      return Array.isArray(list)
        ? list.filter((p) => p && typeof p.id === "string" && Array.isArray(p.cols))
        : [];
    }

    function find(id) {
      return builtins.find((p) => p.id === id) || loadCustom().find((p) => p.id === id) || null;
    }

    function render(selected) {
      const custom = loadCustom();
      const opt = (value, label) =>
        `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
      selectEl.innerHTML = [
        opt("", "Coloane: personalizat"),
        `<optgroup label="Preseturi">${builtins.map((p) => opt(p.id, p.label)).join("")}</optgroup>`,
        custom.length
          ? `<optgroup label="Salvate de tine">${custom.map((p) => opt(p.id, `★ ${p.label}`)).join("")}</optgroup>`
          : "",
        opt("__save__", "+ Salvează coloanele curente ca preset…"),
      ].join("");
      if (deleteBtn) deleteBtn.hidden = !selected.startsWith("custom:");
    }

    function apply(id) {
      const preset = find(id);
      if (!preset) return;
      if (preset.ordered && preset.cols) columns.setOrder(preset.cols);
      const visible = preset.cols ? new Set(preset.cols) : null;
      columns.setHidden(visible ? columns.order.filter((c) => !visible.has(c)) : []);
      write(presetKey, id);
      render(id);
    }

    function markCustom() {
      write(presetKey, "");
      render("");
    }

    function saveCurrent() {
      const name = String(window.prompt("Numele presetului:") || "").trim();
      if (!name) return null;
      const hidden = new Set(columns.getHidden());
      const custom = loadCustom().filter((p) => p.label !== name);
      const preset = {
        id: `custom:${Date.now()}`,
        label: name,
        cols: columns.order.filter((c) => !hidden.has(c)),
      };
      custom.push(preset);
      write(customKey, custom);
      return preset.id;
    }

    function readSavedId() {
      let saved = "";
      try {
        saved = localStorage.getItem(presetKey) || "";
      } catch {
        /* ignore */
      }
      return find(saved) ? saved : "";
    }

    selectEl.addEventListener("change", () => {
      const value = selectEl.value;
      if (value === "__save__") {
        const id = saveCurrent();
        if (id) {
          write(presetKey, id);
          render(id);
          if (typeof onSaved === "function") onSaved();
        } else {
          render(readSavedId());
        }
        return;
      }
      if (value) apply(value);
      else markCustom();
    });

    deleteBtn?.addEventListener("click", () => {
      const id = selectEl.value || "";
      const preset = loadCustom().find((p) => p.id === id);
      if (!preset || !window.confirm(`Ștergi presetul „${preset.label}”?`)) return;
      write(
        customKey,
        loadCustom().filter((p) => p.id !== id)
      );
      markCustom();
    });

    render(readSavedId());
    return { markCustom };
  }

  global.TableColumns = { create, enableResize, createPresets };
})(window);
