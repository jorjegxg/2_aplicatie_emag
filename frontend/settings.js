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
const notifCheckbox = document.getElementById("notif-orders-browser");
const notifBadge = document.getElementById("notif-badge");
const notifStatus = document.getElementById("notif-status");
const btnNotifTest = document.getElementById("btn-notif-test");

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

function syncNotifUi(message) {
  const ON = window.OrderNotifications;
  if (!ON || !notifCheckbox) return;
  const enabled = ON.isEnabled();
  notifCheckbox.checked = enabled;
  const label = ON.permissionLabel();
  if (notifBadge) {
    const pushOk = enabled && typeof ON.isPushSubscribed === "function" && ON.isPushSubscribed();
    notifBadge.textContent = pushOk ? "Push activ" : enabled && label === "Activ" ? "Activ" : label;
    notifBadge.classList.toggle("is-ok", enabled && (pushOk || label === "Activ" || label === "Push activ"));
    notifBadge.classList.toggle(
      "is-missing",
      !enabled || label === "Blocat" || label === "Nepermis" || label === "indisponibil"
    );
  }
  if (notifStatus) {
    notifStatus.textContent = message || "";
  }
}

async function onNotifToggle() {
  const ON = window.OrderNotifications;
  if (!ON || !notifCheckbox) return;
  if (notifCheckbox.checked) {
    notifStatus.textContent = "Se cere permisiunea…";
    const result = await ON.enable();
    if (!result.ok) {
      notifCheckbox.checked = false;
      syncNotifUi(result.message || "Nu s-a putut activa.");
      return;
    }
    syncNotifUi(result.message || "Notificările pentru comenzi noi sunt active.");
    return;
  }
  await ON.disable();
  syncNotifUi("Notificările sunt dezactivate.");
}

if (notifCheckbox) {
  notifCheckbox.addEventListener("change", onNotifToggle);
  if (window.OrderNotifications && typeof window.OrderNotifications.refreshPushState === "function") {
    window.OrderNotifications.refreshPushState().finally(() => syncNotifUi(""));
  } else {
    syncNotifUi("");
  }
}

if (btnNotifTest) {
  btnNotifTest.addEventListener("click", async () => {
    const ON = window.OrderNotifications;
    if (!ON) return;
    if (!ON.isEnabled() || typeof Notification === "undefined" || Notification.permission !== "granted") {
      const result = await ON.enable();
      if (!result.ok) {
        notifCheckbox.checked = false;
        syncNotifUi(result.message || "Nu s-a putut activa.");
        return;
      }
      syncNotifUi("");
    }
    const test = await ON.sendTestNotification();
    syncNotifUi(test.message || (test.ok ? "OK" : "Eșuat"));
  });
}

formEmag.addEventListener("submit", saveEmag);
formTrendyol.addEventListener("submit", saveTrendyol);

loadCredentials().then(() => {
  const hash = (location.hash || "").replace(/^#/, "");
  if (hash === "emag" || hash === "trendyol" || hash === "notificari") {
    const el = document.getElementById(hash);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("is-target");
    }
  }
});
