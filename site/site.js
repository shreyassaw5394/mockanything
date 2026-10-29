// No analytics, no cookies, no network requests.
// Copy buttons, tabs, the launch countdown, the demo run (plays once, with replay) and the chaos strip.
(() => {
  document.documentElement.classList.add("js");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const once = (el, fn, threshold = 0.35) => {
    if (!el) return;
    if (!("IntersectionObserver" in window)) { fn(); return; }
    new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { o.disconnect(); fn(); } }, { threshold }).observe(el);
  };

  // ---- copy ----
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy");
    if (!btn) return;
    const text = btn.closest("[data-copy]")?.dataset.copy;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
    } catch { /* clipboard blocked: the text stays selectable */ }
  });

  // ---- tabs ----
  for (const root of $$("[data-tabs]")) {
    const tabs = $$('[role="tab"]', root);
    const select = (tab) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      }
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        select(next);
        next.focus();
      });
    });
  }

  // ---- countdown to launch ----
  const cd = $("#countdown");
  if (cd) {
    const target = new Date(cd.dataset.launch).getTime();
    const pad = (n) => String(n).padStart(2, "0");
    const tick = () => {
      const ms = target - Date.now();
      if (ms <= 0) { cd.textContent = "Live"; return; }
      const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
      cd.textContent = `Launch T−${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
      setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    tick();
  }

  // ---- demo run: plays once when scrolled into view, then offers a replay ----
  const demo = $("#demo");
  if (demo) {
    const fig = demo.closest("figure") ?? demo;
    const items = $$("[data-t]", fig);
    const max = Math.max(...items.map((i) => Number(i.dataset.t)));
    const clock = $("#tclock"), req = $("#c-req"), hook = $("#c-hook");
    const reqAt = [0, 0, 0, 1, 2, 2, 2, 4, 5, 5], hookAt = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const show = (step) => {
      items.forEach((it) => it.classList.toggle("on", Number(it.dataset.t) <= step));
      const k = Math.max(0, Math.min(step, max));
      if (clock) clock.textContent = `T+00:${String(Math.max(0, step) * 3).padStart(2, "0")}`;
      if (req) req.textContent = String(reqAt[k]);
      if (hook) hook.textContent = String(hookAt[k]);
    };
    if (reduce) show(max);
    else {
      const replay = document.createElement("button");
      replay.type = "button";
      replay.className = "copy replay";
      replay.textContent = "Replay";
      replay.hidden = true;
      $(".console-head", demo)?.append(replay);
      let timer = 0;
      const play = () => {
        clearTimeout(timer);
        replay.hidden = true;
        demo.classList.add("playing");
        let step = -1;
        show(step);
        const next = () => {
          step++;
          show(step);
          if (step >= max) { demo.classList.remove("playing"); replay.hidden = false; return; }
          timer = setTimeout(next, step === 0 ? 700 : 950);
        };
        timer = setTimeout(next, 300);
      };
      replay.addEventListener("click", play);
      show(-1);
      once(demo, play);
    }
  }

  // ---- chaos strip: bars rise once ----
  const strip = $(".strip");
  if (strip) {
    if (reduce) strip.classList.add("on");
    else {
      $$("li", strip).forEach((li, i) => { li.style.transitionDelay = `${i * 14}ms`; });
      once(strip, () => strip.classList.add("on"), 0.5);
    }
  }
})();
