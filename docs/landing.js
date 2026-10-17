(function () {
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  var meta = document.querySelector('meta[name="theme-color"]');

  function apply(theme) {
    root.dataset.theme = theme;
    if (meta) meta.setAttribute("content", theme === "night" ? "#201E1A" : "#F7F5F0");
  }

  apply(localStorage.getItem("manet_site_theme") || "light");

  if (btn) {
    btn.addEventListener("click", function () {
      var next = root.dataset.theme === "night" ? "light" : "night";
      localStorage.setItem("manet_site_theme", next);
      apply(next);
    });
  }

  var items = document.querySelectorAll(".reveal");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!("IntersectionObserver" in window) || reduced) {
    items.forEach(function (el) { el.classList.add("in"); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      io.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });

  items.forEach(function (el) { io.observe(el); });
})();
