// No analytics, no cookies, no network requests.
// The orbit (the API and its twin), the card switch, the chaos switches, the copy box, tabs, entrances.
(() => {
  document.documentElement.classList.add("js");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const copyText = async (text) => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      // clipboard API blocked (permissions, older browsers): fall back to a hidden textarea
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.append(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    const l = document.getElementById("live"); if (l && ok) l.textContent = `Copied: ${text}`;
    return ok;
  };

  // ---- copy buttons (hero, install tabs, API table, SDK tiles) ----
  for (const b of $$("button[data-copy]")) {
    b.addEventListener("click", async () => {
      if (!(await copyText(b.dataset.copy))) return;
      const act = $(".cmd-act, .lu-act, .tile-act", b);
      const before = act ? act.innerHTML : "";
      b.classList.add("done");
      if (act) act.textContent = act.classList.contains("tile-act") ? `Copied ${b.dataset.copy}` : "Copied";
      setTimeout(() => { b.classList.remove("done"); if (act) act.innerHTML = before; }, 1600);
    });
  }

  // ---- phone menu ----
  const menu = $(".menu-btn"), top = $(".top");
  if (menu && top) {
    const setOpen = (open) => { top.classList.toggle("open", open); menu.setAttribute("aria-expanded", String(open)); menu.setAttribute("aria-label", open ? "Close menu" : "Menu"); };
    menu.addEventListener("click", () => setOpen(!top.classList.contains("open")));
    for (const a of $$(".nav a")) a.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && top.classList.contains("open")) { setOpen(false); menu.focus(); } });
  }

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
        select(next); next.focus();
      });
    });
  }

  // ---- the card switch: the twin's real answers for two documented test cards ----
  const show = $("#answers");
  if (show) {
    const radios = $$('[role="radio"]', show);
    const verdict = $("#verdict"), resp = $("#resp code");
    const answers = {
      ok: { word: "approves", text: 'POST /v1/payment_intents  amount=4200\n→ 200  "status": "succeeded"' },
      bad: { word: "declines", text: 'POST /v1/payment_intents  amount=4200\n→ 402  "code": "card_declined"' },
    };
    const pick = (r, focus) => {
      for (const x of radios) { const on = x === r; x.setAttribute("aria-checked", String(on)); x.tabIndex = on ? 0 : -1; }
      const a = answers[r.dataset.card];
      show.dataset.field = r.dataset.card;
      verdict.textContent = a.word;
      resp.textContent = a.text;
      if (focus) r.focus();
    };
    radios.forEach((r, i) => {
      r.addEventListener("click", () => pick(r));
      r.addEventListener("keydown", (e) => {
        if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        pick(radios[(i + 1) % radios.length], true);
      });
    });
  }

  // ---- chaos: switches drive a simulated request log (same modes as the twin; nothing leaves the page) ----
  const log = $("#cl-log"), stats = $("#cl-stats");
  const modes = {};
  let seed = 42, sent = 0, failed = 0, nextId = 1000;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const CALLS = ["POST /v1/payment_intents", "GET  /v1/customers/cus_8Hk2", "POST /v1/refunds", "GET  /v1/payment_intents/pi_3Jd7", "POST /v1/customers"];
  const line = (cls, text) => {
    if (!log) return;
    const li = document.createElement("li");
    li.className = cls; li.textContent = text;
    log.prepend(li);
    while (log.children.length > 9) log.lastElementChild.remove();
    if (stats) stats.textContent = `${sent} requests · ${failed} failed`;
  };
  const request = (force) => {
    const call = CALLS[Math.floor(rnd() * CALLS.length)];
    const on = ["timeout", "5xx", "429"].filter((m) => modes[m]);
    const mode = force ?? (on.length && rnd() < 0.35 ? on[Math.floor(rnd() * on.length)] : null);
    sent++;
    if (mode === "timeout") { failed++; return line("bad", `${call}  → 504 after 30 s (timeout)`); }
    if (mode === "5xx") { failed++; return line("bad", `${call}  → ${[500, 502, 503][Math.floor(rnd() * 3)]} api_error`); }
    if (mode === "429") { failed++; return line("warn", `${call}  → 429 rate_limit, Retry-After: 1`); }
    line("ok", `${call}  → 200  ${40 + Math.floor(rnd() * 60)} ms`);
  };
  const webhook = (force) => {
    const id = `evt_${(nextId++).toString(36)}`;
    const dup = force === "dup" || (modes.dup && rnd() < 0.5);
    const order = force === "order" || (modes.order && rnd() < 0.5);
    if (order) {
      line("warn", `webhook payment_intent.succeeded  ${id}  (arrived first)`);
      line("warn", `webhook payment_intent.created    ${id}  (arrived second)`);
    } else line("hook", `webhook payment_intent.succeeded  ${id}`);
    if (dup) line("warn", `webhook payment_intent.succeeded  ${id}  (duplicate)`);
  };
  const tickChaos = () => (rnd() < 0.7 ? request() : webhook());
  for (const band of $$(".band")) {
    const sw = $(".sw", band);
    const set = (on, demo) => {
      sw.setAttribute("aria-checked", String(on)); band.classList.toggle("on", on); modes[band.dataset.mode] = on;
      if (on && demo) { const m = band.dataset.mode; if (m === "dup" || m === "order") webhook(m); else request(m); }
    };
    set(sw.getAttribute("aria-checked") === "true", false);
    sw.addEventListener("click", (e) => { e.stopPropagation(); set(sw.getAttribute("aria-checked") !== "true", true); });
    band.addEventListener("click", () => sw.click());
  }
  if (log) {
    for (let i = 0; i < 6; i++) tickChaos();
    if (!reduce && "IntersectionObserver" in window) {
      let timer = 0;
      new IntersectionObserver(([e]) => {
        clearInterval(timer);
        if (e.isIntersecting) timer = setInterval(() => { if (!document.hidden) tickChaos(); }, 900);
      }).observe(log);
    }
  }

  // ---- the sentence with a blank ----
  const form = $("#blank");
  if (form) {
    const input = $("#api-name"), out = $("#blank-cmd"), btn = $("button", form);
    const clean = () => (input.value.trim().toLowerCase().replace(/[^a-z0-9._\-/:]/g, "") || "stripe");
    const sync = () => { out.textContent = `npx @shipatmidnight/mockanything ${clean()}`; };
    input.addEventListener("input", sync);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      sync();
      if (!(await copyText(out.textContent))) return;
      btn.textContent = "Copied"; btn.classList.add("done");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
    });
  }

  // ---- entrances: parts of each section arrive in reading order, once ----
  const parts = $$("[data-r]");
  const groups = new Map();
  for (const p of parts) {
    const sec = p.closest("section, footer") ?? document.body;
    const list = groups.get(sec) ?? [];
    p.style.setProperty("--d", `${list.length * 80}ms`);
    list.push(p); groups.set(sec, list);
  }
  const bars = $(".bars");
  $$("li", bars ?? document.createElement("ol")).forEach((li, i) => li.style.setProperty("--d", `${i * 16}ms`));
  const stage = $("#stage"), video = $(".stage-video");
  if (reduce || !("IntersectionObserver" in window)) {
    parts.forEach((p) => p.classList.add("in"));
    bars?.classList.add("in"); stage?.classList.add("is-in");
  } else {
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add(e.target === stage ? "is-in" : "in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px 8% 0px", threshold: 0 });
    parts.forEach((p) => io.observe(p));
    if (bars) io.observe(bars);
    if (stage) requestAnimationFrame(() => setTimeout(() => stage.classList.add("is-in"), 250));
  }
  // the dashboard clip plays only while it is on screen, and never under reduced motion
  // plays only while on screen, never under reduced motion, and the visitor can pause it
  if (video && !reduce && "IntersectionObserver" in window) {
    const ctl = $(".vid-ctl");
    let userPaused = false;
    const label = () => { if (ctl) ctl.textContent = video.paused ? "Play" : "Pause"; };
    video.addEventListener("play", label); video.addEventListener("pause", label);
    label();
    // autoplay can be blocked (low-power mode, data saver): the button then says Play and starts it on click
    const play = () => video.play().catch(() => label());
    if (ctl) { ctl.hidden = false; ctl.addEventListener("click", () => { userPaused = !video.paused; if (userPaused) video.pause(); else play(); }); }
    new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting && !userPaused) play(); else video.pause(); } }, { threshold: 0.2 }).observe(video);
  }

  // ---- the orbit: the real API (white) and its twin (orange) on one orbit ----
  // taste-skill-ignore: the hero sky is the owner's chosen signature picture, drawn in code
  const canvas = $("#sky");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    let w = 0, h = 0, stars = [], raf = 0, visible = true;
    const t0 = performance.now();
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      stars = Array.from({ length: Math.round((w * h) / 4200) }, () => ({ x: rnd() * w, y: rnd() * h, r: rnd() * 1.1 + 0.2, p: rnd() * Math.PI * 2, s: 0.4 + rnd() * 1.2 }));
      draw(performance.now());
    };
    const body = (x, y, rgb, size) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, size * 7); // taste-skill-ignore: light falloff around a body in the sky
      g.addColorStop(0, `rgba(${rgb},0.5)`); g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, size * 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgb(${rgb})`; ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    };
    const draw = (now) => {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, w, h);
      for (const st of stars) {
        ctx.fillStyle = `rgba(236,235,231,${reduce ? 0.55 : 0.3 + 0.35 * Math.sin(st.p + t * st.s)})`;
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
      }
      const wide = w > 1000;
      const cx = wide ? w * 0.7 : w * 0.62, cy = wide ? h * 0.3 : h * 0.22, R = Math.min(w, h) * (wide ? 0.5 : 0.62), tilt = 0.3;
      ctx.lineWidth = 1;
      for (const [k, a] of [[1, 0.18], [0.7, 0.1], [1.34, 0.07]]) {
        ctx.strokeStyle = `rgba(236,235,231,${a})`;
        ctx.beginPath(); ctx.ellipse(cx, cy, R * k, R * k * tilt, 0, 0, Math.PI * 2); ctx.stroke();
      }
      const ang = reduce ? 0.6 : t * 0.16;
      const ax = cx + Math.cos(ang) * R, ay = cy + Math.sin(ang) * R * tilt;
      const bx = cx + Math.cos(ang + Math.PI) * R, by = cy + Math.sin(ang + Math.PI) * R * tilt;
      ctx.strokeStyle = "rgba(236,235,231,0.22)"; ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      body(ax, ay, "236,235,231", 3.4);
      body(bx, by, "255,90,31", 3.4);
      const mx = cx + Math.cos(-ang * 1.7 + 1) * R * 0.7, my = cy + Math.sin(-ang * 1.7 + 1) * R * 0.7 * tilt;
      body(mx, my, "166,165,159", 1.5);
    };
    const loop = (now) => { draw(now); raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0; };
    const start = () => { if (!reduce && !raf && visible && !document.hidden) raf = requestAnimationFrame(loop); };
    new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); start(); }).observe(canvas);
    document.addEventListener("visibilitychange", start);
    let rt = 0;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 120); });
    resize(); start();
  }
})();
