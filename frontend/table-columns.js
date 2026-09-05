/*
 * Coloane de tabel: ascundere, reordonare prin drag si meniul "Coloane".
 * Folosit de tabelul de produse (index.html) si de cel de preturi (sync.html).
 * Ordinea implicita, etichetele si sursele vin din <th data-col data-src> din thead.
 */
(function (global) {
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * @param {object} opts
   * @param {HTMLTableElement} opts.table
   * @param {HTMLElement} opts.tbody
   * @param {HTMLElement} opts.menuEl   container-ul meniului de coloane
   * @param {HTMLElement} opts.buttonEl butonul care deschide meniul
   * @param {string} opts.hiddenKey     cheia localStorage pentru coloanele ascunse
   * @param {string} opts.orderKey      cheia localStorage pentru ordine
   * @param {(cols: string[]) => string[]} [opts.migrate] normalizeaza valorile vechi salvate
   */
  function create({ table, tbody, menuEl, buttonEl, hiddenKey, orderKey, migrate }) {
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
      cellClass,
      applyVisibility,
      applyOrder,
      buildMenu,
      setMenuOpen,
    };
  }

  global.TableColumns = { create };
})(window);
