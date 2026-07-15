/* DJZS site — copy-to-clipboard on every <pre>. Progressive enhancement:
   the page reads fine without JS (see the hero note); this only adds a COPY
   affordance, matching the DST reference surface. No dependencies. */
(function () {
  function enhance(pre) {
    var wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "COPY";
    btn.setAttribute("aria-label", "Copy code to clipboard");

    var reset;
    btn.addEventListener("click", function () {
      var text = pre.innerText.replace(/\s+$/, "");
      var done = function (label, cls) {
        btn.textContent = label;
        if (cls) btn.classList.add(cls);
        clearTimeout(reset);
        reset = setTimeout(function () {
          btn.textContent = "COPY";
          btn.classList.remove("copied");
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { done("COPIED", "copied"); },
          function () { done("PRESS ⌘C"); }
        );
      } else {
        done("PRESS ⌘C");
      }
    });

    wrap.appendChild(btn);
  }

  var run = function () {
    var pres = document.querySelectorAll("pre");
    for (var i = 0; i < pres.length; i++) enhance(pres[i]);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
