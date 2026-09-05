const statusEl = document.getElementById("status");
const formEmag = document.getElementById("form-emag");
const formTrendyol = document.getElementById("form-trendyol");
const emagBadge = document.getElementById("emag-badge");
const trendyolBadge = document.getElementById("trendyol-badge");
const emagEmail = document.getElementById("emag-email");
const emagPassword = document.getElementById("emag-password");
const emagApiCode = document.getElementById("emag-api-code");
const tySupplierId = document.getElementById("ty-supplier-id");
const tyApiKey = document.getElementById("ty-api-key");
const tyApiSecret = document.getElementById("ty-api-secret");
const btnSaveEmag = document.getElementById("btn-save-emag");
const btnSaveTrendyol = document.getElementById("btn-save-trendyol");

function setStatus(message, kind = "") {
  statusEl.textContent = message || "";
  statusEl.className = "status";
  if (kind) statusEl.classList.add(`is-${kind}`);
}

function setBadge(el, configured) {
  el.textContent = configured ? "Configurat" : "Neconfigurat";
  el.classList.toggle("is-ok", configured);
  el.classList.toggle("is-missing", !configured);
}

function fillForm(data) {
  const emag = data.emag || {};
  const ty = data.trendyol || {};
  emagEmail.value = emag.email || "";
  emagPassword.value = "";
  emagPassword.placeholder = emag.hasPassword
    ? "•••• (neschimbat dacă lași gol)"
    : "Parolă cont";
  emagPassword.required = !emag.hasPassword;
  emagApiCode.value = "";
  emagApiCode.placeholder = emag.hasApiCode
    ? "•••• (neschimbat dacă lași gol)"
    : "API code (opțional)";
  setBadge(emagBadge, Boolean(emag.configured));

  tySupplierId.value = ty.supplierId || "";
  tyApiKey.value = "";
  tyApiKey.placeholder = ty.hasApiKey ? "•••• (neschimbat dacă lași gol)" : "API Key";
  tyApiKey.required = !ty.hasApiKey;
  tyApiSecret.value = "";
  tyApiSecret.placeholder = ty.hasApiSecret
    ? "•••• (neschimbat dacă lași gol)"
    : "API Secret";
  tyApiSecret.required = !ty.hasApiSecret;
  setBadge(trendyolBadge, Boolean(ty.configured));
}

async function loadCredentials() {
  setStatus("Se încarcă…", "loading");
  try {
    const res = await fetch("/api/credentials");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    fillForm(data);
    setStatus("");
  } catch (err) {
    setStatus(err.message || "Eroare la citire", "error");
  }
}

async function saveEmag(e) {
  e.preventDefault();
  if (btnSaveEmag.disabled) return;
  btnSaveEmag.disabled = true;
  setStatus("Se salvează eMAG…", "loading");
  try {
    const body = {
      emag: {
        email: emagEmail.value.trim(),
        password: emagPassword.value,
        apiCode: emagApiCode.value,
      },
    };
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    fillForm(data);
    setStatus("Credentiale eMAG salvate.", "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la salvare", "error");
  } finally {
    btnSaveEmag.disabled = false;
  }
}

async function saveTrendyol(e) {
  e.preventDefault();
  if (btnSaveTrendyol.disabled) return;
  btnSaveTrendyol.disabled = true;
  setStatus("Se salvează Trendyol…", "loading");
  try {
    const body = {
      trendyol: {
        supplierId: tySupplierId.value.trim(),
        apiKey: tyApiKey.value,
        apiSecret: tyApiSecret.value,
      },
    };
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    fillForm(data);
    setStatus("Credentiale Trendyol salvate.", "ok");
  } catch (err) {
    setStatus(err.message || "Eroare la salvare", "error");
  } finally {
    btnSaveTrendyol.disabled = false;
  }
}

formEmag.addEventListener("submit", saveEmag);
formTrendyol.addEventListener("submit", saveTrendyol);

loadCredentials().then(() => {
  const hash = (location.hash || "").replace(/^#/, "");
  if (hash === "emag" || hash === "trendyol") {
    const el = document.getElementById(hash);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("is-target");
    }
  }
});
