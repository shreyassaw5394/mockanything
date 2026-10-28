// No analytics, no cookies, no network requests.
// Copy buttons, tabs, scroll reveal, launch countdown, the orbital sky and the mission-control demo.
(() => {
  document.documentElement.classList.add("js");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

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
      cd.textContent = `T-${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
      setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    tick();
  }

  // ---- orbital sky (canvas) ----
  function sky(canvas, opts) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let w = 0, h = 0, dpr = 1, stars = [], raf = 0, visible = true, t0 = performance.now();
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((w * h) / (opts.density || 5200));
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      stars = Array.from({ length: n }, () => ({ x: rnd() * w, y: rnd() * h, r: rnd() * 1.1 + 0.2, p: rnd() * Math.PI * 2, s: 0.4 + rnd() * 1.2 }));
      draw(performance.now());
    };
    const draw = (now) => {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, w, h);
      // stars
      for (const st of stars) {
        const a = reduce ? 0.6 : 0.35 + 0.35 * Math.sin(st.p + t * st.s);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
      }
      if (!opts.orbits) return;
      // the API and its twin, orbiting a shared centre
      const cx = w / 2, cy = h * 0.58, R = Math.min(w, h) * 0.62, tilt = 0.28;
      const glow = ctx.createRadialGradient(cx, cy + R * 0.9, 0, cx, cy + R * 0.9, R * 1.3);
      glow.addColorStop(0, "rgba(100,210,255,0.16)"); glow.addColorStop(1, "rgba(100,210,255,0)");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 1;
      for (const [k, alpha] of [[1, 0.16], [0.72, 0.1], [1.32, 0.07]]) {
        ctx.strokeStyle = `rgba(160,220,255,${alpha})`;
        ctx.beginPath(); ctx.ellipse(cx, cy, R * k, R * k * tilt, 0, 0, Math.PI * 2); ctx.stroke();
      }
      const ang = reduce ? 0.6 : t * 0.16;
      const body = (a, k, color, size) => {
        const x = cx + Math.cos(a) * R * k, y = cy + Math.sin(a) * R * k * tilt;
        const g = ctx.createRadialGradient(x, y, 0, x, y, size * 7);
        g.addColorStop(0, color.replace("A", "0.55")); g.addColorStop(1, color.replace("A", "0"));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, size * 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color.replace("A", "1"); ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
        return [x, y];
      };
      const a = body(ang, 1, "rgba(245,245,247,A)", 3.2);
      const b = body(ang + Math.PI, 1, "rgba(100,210,255,A)", 3.2);
      // the link between them
      const grad = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
      grad.addColorStop(0, "rgba(245,245,247,0.25)"); grad.addColorStop(1, "rgba(100,210,255,0.25)");
      ctx.strokeStyle = grad; ctx.setLineDash([2, 6]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
      body(-ang * 1.7 + 1, 0.72, "rgba(255,214,10,A)", 1.6);
      body(ang * 0.8 + 2.4, 1.32, "rgba(160,220,255,A)", 1.4);
    };
    const loop = (now) => { draw(now); raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0; };
    const start = () => { if (!reduce && !raf && visible && !document.hidden) raf = requestAnimationFrame(loop); };
    new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); start(); }).observe(canvas);
    document.addEventListener("visibilitychange", start);
    let rt = 0;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 120); });
    resize();
    start();
  }
  const s1 = $("#sky"); if (s1) sky(s1, { orbits: true, density: 4200 });
  const s2 = $("#sky2"); if (s2) sky(s2, { orbits: false, density: 3600 });

  // ---- scroll reveal (staggered) ----
  const groups = $$("section:not(.hero) .inner, .cards, .packs, .paths, .proof, .tabs, .facts-list, .modes, .faq, .quote, .chips, .honest, .mission");
  if (!reduce && "IntersectionObserver" in window) {
    for (const g of groups) {
      g.classList.add("reveal");
      $$(":scope > .card, :scope > .pack, :scope > li", g).forEach((c, i) => { c.classList.add("reveal"); c.style.setProperty("--d", `${i * 0.07}s`); });
    }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) {
        en.target.classList.add("in");
        $$(".reveal", en.target).forEach((c) => c.classList.add("in"));
        io.unobserve(en.target);
      }
    }, { rootMargin: "0px 0px -8% 0px" });
    groups.forEach((g) => io.observe(g));
  }

  // ---- chaos modes flicker like a board of warnings ----
  const modes = $$(".modes li");
  if (modes.length && !reduce) {
    let i = 0;
    setInterval(() => {
      if (document.hidden) return;
      modes.forEach((m) => m.classList.remove("flash"));
      modes[(i = (i + 1 + Math.floor(Math.random() * 3)) % modes.length)].classList.add("flash");
    }, 1400);
  }

  // ---- mission-control demo ----
  const demo = $("#demo");
  if (demo) {
    const items = $$("[data-t]", demo);
    const max = Math.max(...items.map((i) => Number(i.dataset.t)));
    const clock = $("#tclock"), req = $("#c-req"), hook = $("#c-hook");
    const reqAt = [0, 0, 0, 1, 2, 2, 2, 4, 5, 5], hookAt = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const show = (step) => {
      items.forEach((it) => it.classList.toggle("on", Number(it.dataset.t) <= step));
      if (clock) clock.textContent = `T+00:${String(Math.max(0, step) * 3).padStart(2, "0")}`;
      if (req) req.textContent = String(reqAt[Math.max(0, Math.min(step, 9))]);
      if (hook) hook.textContent = String(hookAt[Math.max(0, Math.min(step, 9))]);
    };
    if (reduce) { show(max); }
    else {
      let step = -1, timer = 0;
      const run = () => {
        step++;
        show(step);
        timer = setTimeout(step >= max ? () => { step = -1; show(-1); timer = setTimeout(run, 800); } : run, step >= max ? 4500 : step === 0 ? 600 : 900);
      };
      show(-1);
      new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { o.disconnect(); run(); } }, { threshold: 0.35 }).observe(demo);
      void timer;
    }
  }
})();
