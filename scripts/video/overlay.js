// Recording overlay, injected by scripts/record-demo.ts into every top-level page it films
// (Page.addScriptToEvaluateOnNewDocument). Headless Chrome has no cursor and the video
// needs captions, so this draws them on top of the real app:
//
//   __tbrec.caption({ kicker, title, detail })  lower-third caption (or inside the
//                                               page's [data-record-caption-zone])
//   __tbrec.clearCaption()
//   __tbrec.badge(text | null, tone)            small corner pill ("Draft · simulated renders")
//   __tbrec.cursorTo(x, y, ms)                  glide the fake cursor (resolves when there)
//   __tbrec.press(x, y)                         click ripple + cursor squish
//   __tbrec.highlight(rect | null)              soft ring around a region (viewport px)
//
// Everything is pointer-events:none and lives in one fixed layer at the top z-index.
// Plain ES2017, no dependencies; runs in the top frame only (iframes are skipped).
(function () {
  if (window.top !== window) return;
  if (window.__tbrec) return;

  var Z = 2147483000;
  var FONT = "var(--font-geist-sans), -apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif";
  var layer = null;
  var cursorEl = null;
  var captionEl = null;
  var badgeEl = null;
  var ringEl = null;
  var pos = { x: -60, y: -60 };

  function ensure() {
    if (layer && document.documentElement.contains(layer)) return;
    layer = document.createElement("div");
    layer.id = "tbrec-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:" + Z + ";font-family:" + FONT + ";";
    (document.body || document.documentElement).appendChild(layer);

    var style = document.createElement("style");
    style.textContent =
      "@keyframes tbrec-ripple{from{transform:translate(-50%,-50%) scale(.2);opacity:.55}to{transform:translate(-50%,-50%) scale(1);opacity:0}}" +
      "@keyframes tbrec-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}" +
      "#tbrec-layer .tbrec-cap{animation:tbrec-in .35s cubic-bezier(.2,.7,.2,1) both}";
    layer.appendChild(style);

    ringEl = document.createElement("div");
    ringEl.style.cssText =
      "position:fixed;border-radius:22px;box-shadow:0 0 0 4px rgba(31,95,74,.95),0 0 0 14px rgba(31,95,74,.18);" +
      "opacity:0;transition:opacity .3s ease,left .45s ease,top .45s ease,width .45s ease,height .45s ease;";
    layer.appendChild(ringEl);

    badgeEl = document.createElement("div");
    badgeEl.style.cssText =
      "position:fixed;top:18px;right:22px;display:none;align-items:center;gap:10px;padding:9px 18px;border-radius:999px;" +
      "font-size:19px;font-weight:600;letter-spacing:.01em;box-shadow:0 4px 18px rgba(0,0,0,.18);";
    layer.appendChild(badgeEl);

    captionEl = document.createElement("div");
    captionEl.style.cssText = "position:fixed;display:none;";
    layer.appendChild(captionEl);

    cursorEl = document.createElement("div");
    cursorEl.style.cssText =
      "position:fixed;left:0;top:0;width:34px;height:34px;transform:translate(" + pos.x + "px," + pos.y + "px);" +
      "transition:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.35));";
    cursorEl.innerHTML =
      '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M4 2.5l15.5 9.3-6.9 1.4 4 7.3-3 1.6-4-7.3L4.8 19z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    layer.appendChild(cursorEl);
  }

  function placeCursor() {
    if (!cursorEl) return;
    cursorEl.style.transform = "translate(" + (pos.x - 5) + "px," + (pos.y - 3) + "px)";
  }

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function zoneRect() {
    var z = document.querySelector("[data-record-caption-zone]");
    if (!z) return null;
    var r = z.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var api = {
    caption: function (c) {
      ensure();
      if (!c || !c.title) return api.clearCaption();
      var zone = zoneRect();
      var html =
        '<div class="tbrec-cap" style="display:flex;gap:22px;align-items:stretch;background:rgba(20,19,17,.93);color:#fff;' +
        "border-radius:22px;padding:22px 30px 24px 26px;box-shadow:0 12px 40px rgba(0,0,0,.28);" +
        (zone ? "width:100%;box-sizing:border-box;" : "max-width:1520px;") +
        '">' +
        '<div style="width:7px;border-radius:7px;background:' + (c.accent || "#6cc3a0") + ';flex:none"></div>' +
        '<div style="min-width:0">' +
        (c.kicker
          ? '<div style="font-size:18px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:' +
            (c.accent || "#6cc3a0") + ';margin-bottom:6px">' + esc(c.kicker) + "</div>"
          : "") +
        '<div style="font-size:' + (c.title.length > 70 ? 32 : 36) + 'px;line-height:1.18;font-weight:650;letter-spacing:-.01em">' +
        esc(c.title) + "</div>" +
        (c.detail
          ? '<div style="margin-top:8px;font-size:24px;line-height:1.35;color:#e4e1db">' + esc(c.detail) + "</div>"
          : "") +
        "</div></div>";
      captionEl.innerHTML = html;
      if (zone) {
        captionEl.style.cssText =
          "position:fixed;display:flex;align-items:center;box-sizing:border-box;padding:0 34px;" +
          "left:" + zone.left + "px;top:" + zone.top + "px;width:" + zone.width + "px;height:" + zone.height + "px;";
      } else {
        captionEl.style.cssText =
          "position:fixed;display:flex;justify-content:center;left:60px;right:60px;bottom:46px;";
      }
    },
    clearCaption: function () {
      ensure();
      captionEl.style.display = "none";
      captionEl.innerHTML = "";
    },
    badge: function (text, tone, where) {
      ensure();
      if (!text) {
        badgeEl.style.display = "none";
        return;
      }
      if (where === "top-center") {
        badgeEl.style.left = "50%";
        badgeEl.style.right = "auto";
        badgeEl.style.transform = "translateX(-50%)";
      } else {
        badgeEl.style.left = "auto";
        badgeEl.style.right = "22px";
        badgeEl.style.transform = "none";
      }
      var tones = {
        warn: ["#fbf0dc", "#8a520a", "#e0a74e"],
        ok: ["#e4f2e9", "#24633e", "#2f7d4f"],
        info: ["#e5ecf8", "#22468f", "#2851a3"],
      };
      var t = tones[tone] || tones.warn;
      badgeEl.style.display = "flex";
      badgeEl.style.background = t[0];
      badgeEl.style.color = t[1];
      badgeEl.innerHTML =
        '<span style="width:10px;height:10px;border-radius:99px;background:' + t[2] + '"></span>' + esc(text);
    },
    cursorShow: function (x, y) {
      ensure();
      if (typeof x === "number") pos = { x: x, y: y };
      cursorEl.style.display = "block";
      placeCursor();
    },
    cursorHide: function () {
      ensure();
      cursorEl.style.display = "none";
    },
    cursorPos: function () {
      return { x: pos.x, y: pos.y };
    },
    cursorTo: function (x, y, ms) {
      ensure();
      cursorEl.style.display = "block";
      var from = { x: pos.x, y: pos.y };
      var dur = Math.max(0, ms || 0);
      if (dur === 0) {
        pos = { x: x, y: y };
        placeCursor();
        return Promise.resolve(true);
      }
      return new Promise(function (resolve) {
        var t0 = performance.now();
        function step(now) {
          var t = Math.min(1, (now - t0) / dur);
          var k = ease(t);
          pos = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
          placeCursor();
          if (t < 1) requestAnimationFrame(step);
          else resolve(true);
        }
        requestAnimationFrame(step);
      });
    },
    press: function (x, y) {
      ensure();
      var r = document.createElement("div");
      r.style.cssText =
        "position:fixed;left:" + x + "px;top:" + y + "px;width:84px;height:84px;border-radius:999px;" +
        "background:rgba(31,95,74,.35);border:3px solid rgba(31,95,74,.9);animation:tbrec-ripple .55s ease-out forwards;";
      layer.appendChild(r);
      setTimeout(function () {
        r.remove();
      }, 700);
      cursorEl.animate(
        [{ transform: cursorEl.style.transform + " scale(1)" }, { transform: cursorEl.style.transform + " scale(.82)" }, { transform: cursorEl.style.transform + " scale(1)" }],
        { duration: 220 },
      );
      return true;
    },
    highlight: function (rect) {
      ensure();
      if (!rect) {
        ringEl.style.opacity = "0";
        return;
      }
      var pad = rect.pad == null ? 10 : rect.pad;
      ringEl.style.left = rect.x - pad + "px";
      ringEl.style.top = rect.y - pad + "px";
      ringEl.style.width = rect.width + pad * 2 + "px";
      ringEl.style.height = rect.height + pad * 2 + "px";
      ringEl.style.borderRadius = (rect.radius || 22) + "px";
      ringEl.style.opacity = "1";
    },
    fadeOut: function (ms, color) {
      ensure();
      var f = document.createElement("div");
      f.style.cssText =
        "position:fixed;inset:0;background:" + (color || "#f7f5f1") + ";opacity:0;transition:opacity " + (ms || 500) + "ms ease;";
      layer.insertBefore(f, layer.firstChild);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          f.style.opacity = "1";
        });
      });
      return new Promise(function (resolve) {
        setTimeout(resolve, (ms || 500) + 50);
      });
    },
  };

  window.__tbrec = api;
})();
