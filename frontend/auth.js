(function () {
  "use strict";

  var STATUS_URL = "/api/auth/status";
  var LOGIN_PATH = "/login.html";

  function isLoginPage() {
    return /\/login\.html$/i.test(window.location.pathname);
  }

  function redirectToLogin() {
    var next = window.location.pathname + window.location.search + window.location.hash;
    if (next === LOGIN_PATH || next.indexOf(LOGIN_PATH) === 0) next = "/";
    window.location.replace(
      LOGIN_PATH + "?next=" + encodeURIComponent(next || "/")
    );
  }

  function unlockBody() {
    document.documentElement.classList.remove("auth-pending");
  }

  // Ascunde UI până verificăm sesiunea (evită flash de conținut).
  if (!isLoginPage()) {
    document.documentElement.classList.add("auth-pending");
  }

  fetch(STATUS_URL, { credentials: "same-origin", cache: "no-store" })
    .then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, data: data || {} };
      });
    })
    .then(function (result) {
      var data = result.data;
      if (!data.required) {
        unlockBody();
        return;
      }
      if (data.ok) {
        if (isLoginPage()) {
          window.location.replace("/");
          return;
        }
        unlockBody();
        return;
      }
      if (isLoginPage()) {
        unlockBody();
        return;
      }
      redirectToLogin();
    })
    .catch(function () {
      // Dacă API-ul e jos, pe login lăsăm formularul; altfel trimitem la login.
      if (isLoginPage()) unlockBody();
      else redirectToLogin();
    });
})();
