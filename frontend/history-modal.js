/*
 * Modal "Istoric pret + comenzi". Isi injecteaza singur markup-ul in <body>,
 * deci o pagina trebuie doar sa includa scriptul si sa apeleze HistoryModal.open().
 * Depinde de pricing.js (escapeHtml, formatPrice, relativeTimeRo).
 */
(function (global) {
  const { escapeHtml, formatPrice, relativeTimeRo } = global.Pricing;

  const ORDER_STATUS_LABELS = {
    0: "Anulat",
    1: "Nou",
    2: "În progres",
    3: "Preparat",
    4: "Finalizat",
    5: "Returnat",
  };

  const MARKUP = `
    <div class="history-modal-overlay" data-close></div>
    <div class="history-modal-card" role="dialog" aria-modal="true" aria-labelledby="history-modal-title">
      <div class="history-modal-header">
        <h2 id="history-modal-title">Istoric preț</h2>
        <button type="button" class="history-modal-close" data-close aria-label="Închide">×</button>
      </div>
      <p class="history-modal-sub" id="history-modal-sub"></p>
      <div class="history-chart-wrap">
        <svg id="history-chart" viewBox="0 0 720 260" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Grafic preț în timp"></svg>
      </div>
      <div class="history-chart-tooltip" id="history-chart-tooltip" hidden></div>
      <h3 class="history-section-title">Comenzi</h3>
      <div class="history-orders-wrap">
        <table class="history-orders-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Comandă</th>
              <th>Cant.</th>
              <th>Preț vânzare</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="history-orders-body"></tbody>
        </table>
      </div>
    </div>`;

  const historyModal = document.createElement("div");
  historyModal.id = "history-modal";
  historyModal.className = "history-modal";
  historyModal.hidden = true;
  historyModal.innerHTML = MARKUP;
  document.body.appendChild(historyModal);

  const historyModalTitle = historyModal.querySelector("#history-modal-title");
  const historyModalSub = historyModal.querySelector("#history-modal-sub");
  const historyChart = historyModal.querySelector("#history-chart");
  const historyChartTooltip = historyModal.querySelector("#history-chart-tooltip");
  const historyOrdersBody = historyModal.querySelector("#history-orders-body");

  function orderStatusLabel(status) {
    const n = Number(status);
    return ORDER_STATUS_LABELS[n] ?? (status == null ? "—" : String(status));
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [k, v] of Object.entries(attrs || {})) {
      el.setAttribute(k, String(v));
    }
    return el;
  }

  // Step-chart: pretul se mentine constant intre schimbari.
  function renderPriceChart(svg, points) {
    svg.innerHTML = "";
    const W = 720;
    const H = 260;
    const pad = { top: 20, right: 20, bottom: 34, left: 56 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const pts = (points || [])
      .map((p) => ({ t: Date.parse(p.recorded_at), y: Number(p.sale_price) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.y))
      .sort((a, b) => a.t - b.t);

    if (pts.length === 0) {
      svg.appendChild(
        svgEl("text", {
          x: W / 2,
          y: H / 2,
          "text-anchor": "middle",
          class: "chart-empty-text",
        })
      ).textContent = "Fără istoric de preț încă.";
      return;
    }

    // Extinde ultimul punct pana la "acum" ca sa vedem cat timp a stat pretul.
    const now = Date.now();
    const tMin = pts[0].t;
    const tMax = Math.max(pts[pts.length - 1].t, now);
    const tSpan = tMax - tMin || 1;
    const yVals = pts.map((p) => p.y);
    let yMin = Math.min(...yVals);
    let yMax = Math.max(...yVals);
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const yPad = (yMax - yMin) * 0.12;
    yMin -= yPad;
    yMax += yPad;
    const ySpan = yMax - yMin || 1;

    const sx = (t) => pad.left + ((t - tMin) / tSpan) * plotW;
    const sy = (y) => pad.top + (1 - (y - yMin) / ySpan) * plotH;

    // Axe.
    svg.appendChild(
      svgEl("line", {
        x1: pad.left,
        y1: pad.top + plotH,
        x2: pad.left + plotW,
        y2: pad.top + plotH,
        class: "chart-axis",
      })
    );
    svg.appendChild(
      svgEl("line", {
        x1: pad.left,
        y1: pad.top,
        x2: pad.left,
        y2: pad.top + plotH,
        class: "chart-axis",
      })
    );

    // Grilaj + etichete Y (3 nivele).
    for (let i = 0; i <= 2; i++) {
      const y = yMin + (ySpan * i) / 2;
      const py = sy(y);
      svg.appendChild(
        svgEl("line", {
          x1: pad.left,
          y1: py,
          x2: pad.left + plotW,
          y2: py,
          class: "chart-grid",
        })
      );
      const label = svgEl("text", {
        x: pad.left - 8,
        y: py + 4,
        "text-anchor": "end",
        class: "chart-tick",
      });
      label.textContent = y.toFixed(2);
      svg.appendChild(label);
    }

    // Etichete X (prima + ultima data).
    const fmtDate = (t) => new Date(t).toLocaleDateString("ro-RO");
    const xFirst = svgEl("text", {
      x: pad.left,
      y: H - 12,
      "text-anchor": "start",
      class: "chart-tick",
    });
    xFirst.textContent = fmtDate(tMin);
    svg.appendChild(xFirst);
    const xLast = svgEl("text", {
      x: pad.left + plotW,
      y: H - 12,
      "text-anchor": "end",
      class: "chart-tick",
    });
    xLast.textContent = fmtDate(tMax);
    svg.appendChild(xLast);

    // Linie in trepte.
    let d = "";
    pts.forEach((p, i) => {
      const x = sx(p.t);
      const y = sy(p.y);
      if (i === 0) {
        d += `M ${x} ${y}`;
      } else {
        const prevY = sy(pts[i - 1].y);
        d += ` L ${x} ${prevY} L ${x} ${y}`;
      }
    });
    // Prelungeste orizontal pana la tMax (acum).
    d += ` L ${sx(tMax)} ${sy(pts[pts.length - 1].y)}`;
    svg.appendChild(svgEl("path", { d, class: "chart-line", fill: "none" }));

    // Markeri la fiecare schimbare + hover.
    pts.forEach((p) => {
      const cx = sx(p.t);
      const cy = sy(p.y);
      const dot = svgEl("circle", { cx, cy, r: 4, class: "chart-dot" });
      dot.addEventListener("mouseenter", () => {
        historyChartTooltip.hidden = false;
        historyChartTooltip.textContent = `${p.y.toFixed(2)} RON · ${new Date(
          p.t
        ).toLocaleString("ro-RO")}`;
        const rect = svg.getBoundingClientRect();
        const scaleX = rect.width / W;
        const scaleY = rect.height / H;
        historyChartTooltip.style.left = `${cx * scaleX}px`;
        historyChartTooltip.style.top = `${cy * scaleY - 12}px`;
      });
      dot.addEventListener("mouseleave", () => {
        historyChartTooltip.hidden = true;
      });
      svg.appendChild(dot);
    });
  }

  function renderHistoryOrders(orders) {
    const list = Array.isArray(orders) ? orders : [];
    if (list.length === 0) {
      historyOrdersBody.innerHTML =
        '<tr><td colspan="5" class="history-orders-empty">Nicio comandă înregistrată pentru acest produs.</td></tr>';
      return;
    }
    historyOrdersBody.innerHTML = list
      .map((o) => {
        const date = o.order_date
          ? escapeHtml(new Date(o.order_date).toLocaleString("ro-RO"))
          : "—";
        return `<tr>
        <td>${date}</td>
        <td>${escapeHtml(o.order_id ?? "—")}</td>
        <td>${escapeHtml(o.quantity ?? "—")}</td>
        <td>${formatPrice(o.sale_price, o.currency || "RON")}</td>
        <td>${escapeHtml(orderStatusLabel(o.status))}</td>
      </tr>`;
      })
      .join("");
  }

  function priceHistorySummary(history) {
    const list = Array.isArray(history) ? history : [];
    if (list.length === 0) return "Fără schimbări de preț înregistrate încă.";
    const last = list[list.length - 1];
    const rel = relativeTimeRo(last.recorded_at);
    const count = list.length;
    return `${count} ${count === 1 ? "înregistrare" : "înregistrări"} · ultima schimbare ${rel} (${formatPrice(
      last.sale_price,
      last.currency || "RON"
    )})`;
  }

  function open(offerId, name) {
    historyModalTitle.textContent = name
      ? `Istoric — ${name}`
      : `Istoric preț — #${offerId}`;
    historyModalSub.textContent = "Se încarcă…";
    historyChart.innerHTML = "";
    historyOrdersBody.innerHTML = "";
    historyChartTooltip.hidden = true;
    historyModal.hidden = false;
    document.body.classList.add("modal-open");

    fetch(`/api/products/${encodeURIComponent(offerId)}/history`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Eroare istoric");
        historyModalSub.textContent = priceHistorySummary(data.price_history);
        renderPriceChart(historyChart, data.price_history);
        renderHistoryOrders(data.orders);
      })
      .catch((err) => {
        historyModalSub.textContent = err.message || "Eroare la încărcare istoric";
      });
  }

  function close() {
    historyModal.hidden = true;
    historyChartTooltip.hidden = true;
    document.body.classList.remove("modal-open");
  }

  historyModal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !historyModal.hidden) close();
  });

  global.HistoryModal = { open, close };
})(window);
