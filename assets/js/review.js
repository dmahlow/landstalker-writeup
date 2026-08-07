// Review mode: open the page with ?review=1 and tap any sentence to flag it.
// Flags persist in localStorage; the Copy button puts them on the clipboard as
// plain text, one per line, ready to paste back. No effect without the param.
(function () {
  var params = new URLSearchParams(location.search);
  if (params.get("review") !== "1") return;

  var KEY = "ls3d.review.flags";
  var flags = new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));

  // Split on sentence boundaries, but never inside an abbreviation, a decimal,
  // or a hex literal (0x80. would otherwise split).
  var SPLIT = /(?<=[.!?])\s+(?=["“(]?[A-Z])/;

  function wrap(el) {
    var parts = [];
    el.childNodes.forEach(function (node) {
      if (node.nodeType !== 3) { parts.push(node); return; }
      var chunks = node.textContent.split(SPLIT);
      chunks.forEach(function (c, i) {
        if (!c.trim()) return;
        var span = document.createElement("span");
        span.className = "rv";
        span.textContent = c + (i < chunks.length - 1 ? " " : "");
        parts.push(span);
      });
    });
    el.replaceChildren.apply(el, parts);
  }

  document.querySelectorAll("p, li").forEach(function (el) {
    if (el.closest("figure, pre, blockquote, .rv-bar")) return;
    if (!el.textContent.trim()) return;
    wrap(el);
  });

  function label(span) {
    return span.textContent.trim().replace(/\s+/g, " ");
  }

  var bar = document.createElement("div");
  bar.className = "rv-bar";
  bar.innerHTML =
    '<span class="rv-count"></span>' +
    '<button class="rv-copy">Copy</button>' +
    '<button class="rv-clear">Clear</button>';
  document.body.appendChild(bar);

  var count = bar.querySelector(".rv-count");
  function refresh() {
    count.textContent = flags.size + (flags.size === 1 ? " flagged" : " flagged");
    localStorage.setItem(KEY, JSON.stringify(Array.from(flags)));
  }

  document.querySelectorAll("span.rv").forEach(function (span) {
    if (flags.has(label(span))) span.classList.add("rv-on");
    span.addEventListener("click", function (e) {
      e.stopPropagation();
      var t = label(span);
      if (flags.has(t)) { flags.delete(t); span.classList.remove("rv-on"); }
      else { flags.add(t); span.classList.add("rv-on"); }
      refresh();
    });
  });

  bar.querySelector(".rv-copy").addEventListener("click", function () {
    var text = Array.from(flags).join("\n\n");
    function done() { count.textContent = "copied " + flags.size; setTimeout(refresh, 1200); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove(); done();
    }
  });

  bar.querySelector(".rv-clear").addEventListener("click", function () {
    flags.clear();
    document.querySelectorAll("span.rv-on").forEach(function (s) { s.classList.remove("rv-on"); });
    refresh();
  });

  refresh();
})();
