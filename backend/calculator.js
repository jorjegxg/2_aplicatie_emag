/*
 * Calculatorul de profit din "CALCULATOR INFINITE VENTURES.xlsx" (foaia ALL), 1:1 cu formulele Excel.
 * Folosit de backend (recalcul pret_cumparare) si de browser (servit la /api/calculator.js → window.Calculator).
 * Procentele din parametri sunt in procente (21 = 21%), ca restul aplicatiei.
 * Literele din comentarii sunt coloanele din Excel.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Calculator = api;
})(typeof self !== "undefined" ? self : this, function () {
  const REGIM_PROFIT_NEPLATITOR = "profit_neplatitor";
  const REGIM_PROFIT_PLATITOR = "profit_platitor";
  const REGIM_MICRO_NEPLATITOR = "micro_neplatitor";
  const REGIM_MICRO_PLATITOR = "micro_platitor";

  const REGIMURI = [
    { value: REGIM_PROFIT_NEPLATITOR, label: "Impozit pe profit neplătitor de TVA" },
    { value: REGIM_PROFIT_PLATITOR, label: "Impozit pe profit plătitor de TVA" },
    { value: REGIM_MICRO_NEPLATITOR, label: "Microîntreprindere (un angajat minim) neplătitor de TVA" },
    { value: REGIM_MICRO_PLATITOR, label: "Microîntreprindere (un angajat minim) plătitor de TVA" },
  ];

  const DEFAULT_PARAMS = {
    regim: REGIM_PROFIT_NEPLATITOR,
    curs_rmb: 0.67, // C8
    curs_usd: 4.44, // C9
    transport_aer_usd_kg: 8, // C11
    transport_tren_usd_kg: 3.6, // C13
    transport_fabrica_agent: 1, // C17 (%)
    comision_agent: 3, // C18 (%)
    tva: 21, // C19 (%)
    taxe_vamale: 6.5, // C20 (%)
    impozit_profit: 16, // C21 la "Impozit pe profit ..." (%)
    impozit_micro: 1, // C21 la "Microintreprindere ..." (%)
    consumabile: 5.5, // C23 (lei, cu TVA)
    curierat_contract: 19.2, // C26 (lei, cu TVA)
    curierat_client: 15.9, // C29 (lei, cu TVA)
    transport_cumparare: "tren", // care cost final devine "Pret cumparare": "tren" (P) sau "aer" (O)
  };

  const NUMERIC_KEYS = Object.keys(DEFAULT_PARAMS).filter(
    (k) => typeof DEFAULT_PARAMS[k] === "number"
  );

  function num(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Completeaza/valideaza parametrii salvati peste valorile implicite. */
  function normalizeParams(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = { ...DEFAULT_PARAMS };
    for (const key of NUMERIC_KEYS) {
      const n = num(src[key]);
      if (n != null) out[key] = n;
    }
    if (REGIMURI.some((r) => r.value === src.regim)) out.regim = src.regim;
    if (src.transport_cumparare === "aer" || src.transport_cumparare === "tren") {
      out.transport_cumparare = src.transport_cumparare;
    }
    return out;
  }

  function isPlatitorTva(regim) {
    return regim === REGIM_PROFIT_PLATITOR || regim === REGIM_MICRO_PLATITOR;
  }

  function isMicro(regim) {
    return regim === REGIM_MICRO_NEPLATITOR || regim === REGIM_MICRO_PLATITOR;
  }

  function greutateVolumetrica(latime, lungime, inaltime) {
    const w = num(latime);
    const l = num(lungime);
    const h = num(inaltime);
    if (![w, l, h].every((n) => n != null && n > 0)) return null;
    return (w * l * h) / 5000;
  }

  /** Rotunjire in sus la 0,1 kg (epsilon-ul evita 1.1*10 = 11.000000000000002 → 1.2). */
  function rotunjesteInSus(kg) {
    return Math.ceil(kg * 10 - 1e-9) / 10;
  }

  /** H: valoarea mai mare dintre greutatea fizica si cea volumetrica, rotunjita in sus la 0,1 kg. */
  function greutateCalcul(greutate, latime, lungime, inaltime, rotunjire = true) {
    const g = num(greutate);
    const vol = greutateVolumetrica(latime, lungime, inaltime);
    if (g == null && vol == null) return null;
    const max = Math.max(g ?? 0, vol ?? 0);
    return rotunjire ? rotunjesteInSus(max) : max;
  }

  /** Cost achizitie pe o ruta (Aer sau Tren/Mare): I|J, K|L, M|N, O|P. */
  function costRuta(pretChina, greutate, transportRonKg, p) {
    const transport = greutate * transportRonKg;
    const taxe = (pretChina + transport) * (p.taxe_vamale / 100);
    const tvaImport = (pretChina + transport + taxe) * (p.tva / 100);
    return { transport, taxe, tvaImport, costFinal: pretChina + transport + taxe + tvaImport };
  }

  /** Impozit (X|Y), TVA colectat (Z|AA), profit (AB|AD), break-even (AF|AG) pentru un cost final. */
  function rezultatRuta(cost, tvaImport, ctx) {
    const { regim, U, V, W, T, tva, imp, cc, cct, cons } = ctx;
    const cheltuieliFaraTva = V + (cost - tvaImport) + (cct + cons) / (1 + tva);
    const venitFaraTva = U + cc / (1 + tva);
    const profitBrutNeplatitor = U + cc - (V + W + cost + cct + cons);

    let impozit;
    if (regim === REGIM_PROFIT_NEPLATITOR) impozit = profitBrutNeplatitor * imp;
    else if (regim === REGIM_PROFIT_PLATITOR) impozit = (venitFaraTva - cheltuieliFaraTva) * imp;
    else if (regim === REGIM_MICRO_NEPLATITOR) impozit = (U + cc) * imp;
    else impozit = venitFaraTva * imp;

    const tvaColectat = isPlatitorTva(regim)
      ? U * tva + (cc - cc / (1 + tva)) - (W + tvaImport + (cct + cons - (cct + cons) / (1 + tva)))
      : 0;

    const profit = isPlatitorTva(regim)
      ? venitFaraTva - cheltuieliFaraTva - impozit
      : profitBrutNeplatitor - impozit;

    let breakEven;
    if (regim === REGIM_PROFIT_NEPLATITOR) {
      breakEven = (cost + cons + cct - cc + T * cc * (1 + tva)) / (1 - T * (1 + tva));
    } else if (regim === REGIM_PROFIT_PLATITOR) {
      breakEven = (cost + cons + cct) / (1 - T) - cc;
    } else if (regim === REGIM_MICRO_NEPLATITOR) {
      breakEven = (cost + cons + cct + cc * (T * (1 + tva) + imp - 1)) / (1 - T * (1 + tva) - imp);
    } else {
      breakEven = (cost + cons + cct + imp * cc + T * cc - cc) / (1 - T - imp);
    }

    return { impozit, tvaColectat, profit, breakEven };
  }

  /**
   * @param {object} input
   *   pret_fabrica, moneda ("USD"|"RMB"), greutate, latime, lungime, inaltime,
   *   pret_vanzare (S), comision_emag (T, in %), nr_bucati (AH),
   *   rotunjire_greutate (implicit true; false = greutatea exacta, ca in coloana H din Excel)
   * @param {object} params parametrii globali (vezi DEFAULT_PARAMS)
   * @returns {object|null} null daca lipsesc pretul de fabrica sau greutatea
   */
  function calcProduct(input, params) {
    const p = normalizeParams(params);
    const pretFabrica = num(input?.pret_fabrica);
    const greutate = greutateCalcul(
      input?.greutate,
      input?.latime,
      input?.lungime,
      input?.inaltime,
      input?.rotunjire_greutate !== false
    );
    if (pretFabrica == null || greutate == null) return null;

    const curs = String(input?.moneda || "USD").toUpperCase() === "RMB" ? p.curs_rmb : p.curs_usd;
    // G
    const pretChina =
      pretFabrica * curs * (1 + p.transport_fabrica_agent / 100) * (1 + p.comision_agent / 100);

    const aer = costRuta(pretChina, greutate, p.transport_aer_usd_kg * p.curs_usd, p);
    const tren = costRuta(pretChina, greutate, p.transport_tren_usd_kg * p.curs_usd, p);

    const nrBucati = num(input?.nr_bucati) ?? 0;
    const out = {
      greutate,
      pret_achiz_china: pretChina,
      transport_aer: aer.transport,
      transport_tren: tren.transport,
      taxe_vamale_aer: aer.taxe,
      taxe_vamale_tren: tren.taxe,
      tva_import_aer: aer.tvaImport,
      tva_import_tren: tren.tvaImport,
      cost_final_aer: aer.costFinal,
      cost_final_tren: tren.costFinal,
      diferenta_aer_tren: aer.costFinal - tren.costFinal, // Q
      cat_salvezi: aer.costFinal > 0 ? 1 - tren.costFinal / aer.costFinal : null, // R (fractie)
      cost_comanda_aer: p.curs_usd ? (nrBucati * aer.costFinal) / p.curs_usd : null, // AI ($)
      cost_comanda_tren: p.curs_usd ? (nrBucati * tren.costFinal) / p.curs_usd : null, // AJ ($)
      pret_cumparare: p.transport_cumparare === "aer" ? aer.costFinal : tren.costFinal,
      pret_vanzare_fara_tva: null,
      comision_valoare: null,
      comision_tva: null,
      impozit_aer: null,
      impozit_tren: null,
      tva_colectat_aer: null,
      tva_colectat_tren: null,
      profit_aer: null,
      profit_tren: null,
      procent_profit_aer: null,
      procent_profit_tren: null,
      break_even_aer: null,
      break_even_tren: null,
    };

    const T = (num(input?.comision_emag) ?? 0) / 100;
    const tva = p.tva / 100;
    const imp = (isMicro(p.regim) ? p.impozit_micro : p.impozit_profit) / 100;
    const cc = p.curierat_client;
    const cct = p.curierat_contract;
    const cons = p.consumabile;

    // Break-even nu depinde de pretul de vanzare.
    const ctxBase = { regim: p.regim, T, tva, imp, cc, cct, cons, U: 0, V: 0, W: 0 };
    out.break_even_aer = rezultatRuta(aer.costFinal, aer.tvaImport, ctxBase).breakEven;
    out.break_even_tren = rezultatRuta(tren.costFinal, tren.tvaImport, ctxBase).breakEven;

    const S = num(input?.pret_vanzare);
    if (S == null || S <= 0) return out;

    const U = isPlatitorTva(p.regim) ? S / (1 + tva) : S;
    const V = isPlatitorTva(p.regim) ? (U + cc / (1 + tva)) * T : (U + cc) * T;
    const W = V * tva;
    const ctx = { ...ctxBase, U, V, W };
    const rAer = rezultatRuta(aer.costFinal, aer.tvaImport, ctx);
    const rTren = rezultatRuta(tren.costFinal, tren.tvaImport, ctx);

    out.pret_vanzare_fara_tva = U;
    out.comision_valoare = V;
    out.comision_tva = W;
    out.impozit_aer = rAer.impozit;
    out.impozit_tren = rTren.impozit;
    out.tva_colectat_aer = rAer.tvaColectat;
    out.tva_colectat_tren = rTren.tvaColectat;
    out.profit_aer = rAer.profit;
    out.profit_tren = rTren.profit;
    // Ca in Excel: % Aer = AB/S (cu TVA), % Tren/Mare = AD/U (fara TVA). Difera doar la platitor de TVA.
    out.procent_profit_aer = rAer.profit / S;
    out.procent_profit_tren = rTren.profit / U;
    return out;
  }

  return {
    REGIMURI,
    DEFAULT_PARAMS,
    normalizeParams,
    isPlatitorTva,
    greutateVolumetrica,
    greutateCalcul,
    calcProduct,
  };
});
