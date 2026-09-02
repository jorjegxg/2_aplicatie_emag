(function () {
  var KEY = "emag-theme";
  var root = document.documentElement;

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (err) {
      return null;
    }
  }

  function apply(theme) {
    if (theme === "dark") root.setAttribute("data-theme", "dark");
    else root.setAttribute("data-theme", "light");
  }

  var initial = stored();
  if (initial !== "dark" && initial !== "light") {
    initial =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  apply(initial);

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("btn-theme");
    if (!btn) return;
    var label = btn.querySelector(".theme-toggle-label");

    function sync() {
      var dark = root.getAttribute("data-theme") === "dark";
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.title = dark ? "Comută pe temă deschisă" : "Comută pe temă întunecată";
      if (label) label.textContent = dark ? "Dark" : "Light";
    }

    sync();
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(KEY, next);
      } catch (err) {
        /* ignore */
      }
      sync();
    });
  });
})();
