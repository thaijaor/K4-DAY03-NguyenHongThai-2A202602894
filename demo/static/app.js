/* SmashHub demo UI — chat với ReAct Agent, lịch sân live, trace waterfall */
(() => {
  "use strict";

  // ------------------------------------------------------------------ utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, html) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    if (html !== undefined) node.innerHTML = html;
    return node;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage bị chặn */ } },
  };
  const fmtMs = (ms) => (ms == null ? "…" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
  const fmtPrice = (p) => `${Math.round(p / 1000)}k`;
  const fmtVnd = (p) => `${Number(p).toLocaleString("vi-VN")}đ`;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2) + Date.now().toString(16));

  function md(text) {
    const inline = (s) => s
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    const lines = esc(text).split(/\r?\n/);
    let html = "", list = false, para = [];
    const flush = () => { if (para.length) { html += `<p>${inline(para.join("<br>"))}</p>`; para = []; } };
    const close = () => { if (list) { html += "</ul>"; list = false; } };
    for (const line of lines) {
      const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
      if (m) { flush(); if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(m[1])}</li>`; }
      else if (!line.trim()) { close(); flush(); }
      else { close(); para.push(line); }
    }
    close(); flush();
    return html;
  }

  function jsonHtml(value) {
    const json = esc(JSON.stringify(value, null, 2));
    return json.replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g, (m, str, colon, bool, num) => {
      if (str) return colon ? `<span class="jk">${str}</span>${colon}` : `<span class="js">${str}</span>`;
      if (bool) return `<span class="jb">${bool}</span>`;
      return `<span class="jn">${num}</span>`;
    });
  }

  function toast(html, kind = "") {
    const t = el("div", { class: `toast ${kind}` }, html);
    $("#toasts").append(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 4200);
  }

  // ------------------------------------------------------------------ court drawing
  const COURT_COLORS = {
    free: ["#1f8a55", "#17693f"],
    seed: ["#7f8c85", "#66726b"],
    ui: ["#3f6fd8", "#2f59b8"],
    agent: ["#7446d6", "#5b31b5"],
  };
  function courtSVG(kind, { players = false } = {}) {
    const [surface, apron] = COURT_COLORS[kind] || COURT_COLORS.free;
    const L = "#f7f5ea";
    const player = (x, y) => `<circle cx="${x}" cy="${y}" r="4.2" fill="#fff" opacity=".92"/><circle cx="${x}" cy="${y}" r="2" fill="${apron}"/>`;
    return `
<svg viewBox="0 0 160 80" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
  <rect width="160" height="80" fill="${apron}"/>
  <rect x="13" y="9.5" width="134" height="61" fill="${surface}"/>
  <g stroke="${L}" stroke-width=".9" fill="none">
    <rect x="13" y="9.5" width="134" height="61"/>
    <line x1="13" y1="14.1" x2="147" y2="14.1"/><line x1="13" y1="65.9" x2="147" y2="65.9"/>
    <line x1="60.2" y1="9.5" x2="60.2" y2="70.5"/><line x1="99.8" y1="9.5" x2="99.8" y2="70.5"/>
    <line x1="20.6" y1="9.5" x2="20.6" y2="70.5"/><line x1="139.4" y1="9.5" x2="139.4" y2="70.5"/>
    <line x1="13" y1="40" x2="60.2" y2="40"/><line x1="99.8" y1="40" x2="147" y2="40"/>
  </g>
  <line x1="80" y1="6.5" x2="80" y2="73.5" stroke="#fff" stroke-width="1.8" stroke-dasharray="1.6 1"/>
  <circle cx="80" cy="6.5" r="1.8" fill="#e5e7eb"/><circle cx="80" cy="73.5" r="1.8" fill="#e5e7eb"/>
  ${players ? player(38, 27) + player(46, 54) + player(118, 30) + player(126, 52) : ""}
</svg>`;
  }

  // ------------------------------------------------------------------ state
  const SESSION_KEY = "smashhub_session";
  const state = {
    info: null,
    date: null,
    hour: null,
    schedule: null,
    sessionId: store.get(SESSION_KEY) || newId(),
    turns: [],
    liveTurn: null,
    selectedTurnId: null,
    selectedStep: null,
    busy: false,
    flash: new Set(),   // "date|hour|court" vừa được đặt
    tab: "booking",
  };
  store.set(SESSION_KEY, state.sessionId);

  const api = {
    async get(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); },
    async post(url, body) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { ok: r.ok, status: r.status, data: await r.json() };
    },
  };

  // ------------------------------------------------------------------ tabs
  function setTab(tab) {
    state.tab = tab === "trace" ? "trace" : "booking";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === state.tab));
    $("#view-booking").hidden = state.tab !== "booking";
    $("#view-trace").hidden = state.tab !== "trace";
    if (state.tab === "trace") renderTrace();
  }
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));

  // ------------------------------------------------------------------ board
  function slotKind(court, slot) {
    if (court.status === "free") return slot.past ? "past" : "free";
    return court.booking ? court.booking.source : "seed";
  }

  async function loadSchedule(date = state.date) {
    const data = await api.get(`/api/schedule?date=${encodeURIComponent(date)}`);
    state.schedule = data;
    state.date = data.date;
    if (state.hour == null || !data.slots.some((s) => s.hour === state.hour)) {
      const evening = data.slots.find((s) => s.hour === 19 && !s.past);
      state.hour = (evening || data.slots.find((s) => !s.past) || data.slots[data.slots.length - 1]).hour;
    }
    renderDates(data.days);
    renderBoard();
  }

  function renderDates(days) {
    const strip = $("#date-strip");
    strip.replaceChildren(...days.map((d) => el("button", {
      class: `date-chip${d.date === state.date ? " is-active" : ""}`,
      title: `${d.weekday} ${d.date} · đã kín ${Math.round(d.occupancy * 100)}%`,
      onclick: () => { state.hour = null; loadSchedule(d.date); },
    }, `<span class="wd">${d.is_today ? "Hôm nay" : esc(d.weekday)}</span><span class="dd">${d.day}/${d.month}</span><span class="occ"><i style="width:${Math.max(d.occupancy * 100, d.occupancy ? 6 : 0)}%"></i></span>`)));
  }

  function renderBoard() {
    const sch = state.schedule;
    if (!sch) return;
    $("#board-date-label").textContent = `${sch.weekday}, ${sch.date}`;
    const slot = sch.slots.find((s) => s.hour === state.hour);

    // hour strip
    $("#hour-strip").replaceChildren(...sch.slots.map((s) => el("button", {
      class: `hour-btn${s.hour === state.hour ? " is-active" : ""}${s.past ? " past" : ""}`,
      onclick: () => { state.hour = s.hour; renderBoard(); },
      title: `${s.time} · ${s.courts.filter((c) => c.status === "free").length}/4 sân trống`,
    }, `${s.time}<span class="cap">${s.courts.map((c) => `<i class="${c.status === "free" ? "" : "b"}"></i>`).join("")}</span>`)));
    $("#hour-strip .is-active")?.scrollIntoView({ block: "nearest", inline: "center" });

    // hall
    $("#hall-hour-label").textContent = `${slot.time} – ${String(slot.hour + 1).padStart(2, "0")}:00`;
    $("#hall-price").textContent = `${fmtVnd(slot.price)}/giờ`;
    $("#hall").replaceChildren(...slot.courts.map((c) => {
      const kind = slotKind(c, slot);
      const booked = c.status !== "free";
      const flashing = state.flash.has(`${sch.date}|${slot.hour}|${c.court_id}`);
      const stateText = kind === "free" ? "Trống · bấm để đặt"
        : kind === "past" ? "Đã qua giờ"
        : kind === "agent" ? `🤖 Agent đặt <small>${esc(c.booking.booking_id)}</small>`
        : kind === "ui" ? `🧑 Đặt trên UI <small>${esc(c.booking.phone)}</small>`
        : c.booking ? `Khách đã đặt trước <small>${esc(c.booking.booking_id)}</small>`
        : "Khách đã đặt trước";
      const card = el("button", {
        class: `court-card ${kind}${booked && kind !== "past" ? "" : ""}${flashing ? " flash" : ""}`,
        disabled: kind === "past" || (booked && !c.booking),
        "aria-label": `Sân ${c.court_id} ${slot.time}: ${stateText.replace(/<[^>]+>/g, "")}`,
        onclick: () => (booked ? openCancel(c, slot) : openBooking(c.court_id, slot)),
      }, courtSVG(kind === "past" ? (booked ? "seed" : "free") : kind, { players: booked }) +
        `<span class="court-label">${esc(c.court_id)}</span><span class="court-state">${stateText}</span>`);
      return card;
    }));

    // timetable
    const head = el("tr", {}, `<th class="time"></th>${sch.courts.map((c) => `<th>Sân ${esc(c)}</th>`).join("")}`);
    const rows = sch.slots.map((s) => {
      const tr = el("tr", { class: s.hour === state.hour ? "is-active" : "" });
      tr.append(el("th", { class: "time" }, s.time));
      for (const c of s.courts) {
        const kind = slotKind(c, s);
        const label = kind === "free" ? fmtPrice(s.price)
          : kind === "past" ? "—"
          : kind === "agent" ? "🤖 Agent"
          : kind === "ui" ? `🧑 ${esc(c.booking.phone)}`
          : "Đã đặt";
        const flashing = state.flash.has(`${sch.date}|${s.hour}|${c.court_id}`);
        const td = el("td");
        const cancellable = c.status !== "free" && c.booking && !s.past;
        td.append(el("button", {
          class: `slot ${kind}${cancellable ? " cancellable" : ""}${flashing ? " flash" : ""}`,
          title: kind === "free" ? `Đặt sân ${c.court_id} lúc ${s.time} (${fmtVnd(s.price)})` : (c.booking ? `${c.booking.booking_id} · bấm để hủy` : ""),
          onclick: () => {
            state.hour = s.hour; renderBoard();
            if (kind === "free") openBooking(c.court_id, s);
            else if (cancellable) openCancel(c, s);
          },
        }, label));
        tr.append(td);
      }
      return tr;
    });
    $("#timetable").replaceChildren(el("thead"), el("tbody"));
    $("#timetable thead").append(head);
    $("#timetable tbody").append(...rows);
  }

  // ------------------------------------------------------------------ booking dialog
  let pendingBooking = null;
  function openBooking(courtId, slot) {
    pendingBooking = { court_id: courtId, hour: slot.hour, date: state.date, price: slot.price };
    $("#book-court").textContent = courtId;
    $("#book-date").textContent = state.date;
    $("#book-time").textContent = `${slot.time}–${String(slot.hour + 1).padStart(2, "0")}:00`;
    $("#book-price").textContent = fmtVnd(slot.price);
    $("#book-court-visual").innerHTML = courtSVG("free");
    $("#book-error").hidden = true;
    $("#book-phone").value = store.get("smashhub_phone") || "";
    $("#book-dialog").showModal();
    $("#book-phone").focus();
  }

  $("#book-form").addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    const phone = $("#book-phone").value.trim();
    if (!/^0\d{9}$/.test(phone)) {
      $("#book-error").textContent = "Số điện thoại cần 10 chữ số và bắt đầu bằng 0.";
      $("#book-error").hidden = false;
      return;
    }
    $("#book-submit").disabled = true;
    try {
      const { ok, data } = await api.post("/api/book", { ...pendingBooking, phone });
      if (!ok) {
        $("#book-error").textContent = data.result?.message || data.error || "Không đặt được sân.";
        $("#book-error").hidden = false;
        loadSchedule();
        return;
      }
      store.set("smashhub_phone", phone);
      $("#book-dialog").close();
      toast(`✅ Đã đặt <b>${esc(data.result.court_id)}</b> · ${esc(data.result.datetime)}<br><small>${esc(data.result.booking_id)} · JSON-RPC id ${data.id}</small>`);
    } catch (err) {
      $("#book-error").textContent = `Lỗi kết nối: ${err.message}`;
      $("#book-error").hidden = false;
    } finally {
      $("#book-submit").disabled = false;
    }
  });

  // ------------------------------------------------------------------ cancel dialog
  let pendingCancel = null;
  function openCancel(court, slot) {
    if (!court.booking) return;
    pendingCancel = { booking_id: court.booking.booking_id };
    $("#cancel-court").textContent = court.court_id;
    $("#cancel-id").textContent = court.booking.booking_id;
    $("#cancel-date").textContent = state.date;
    $("#cancel-time").textContent = `${slot.time}–${String(slot.hour + 1).padStart(2, "0")}:00`;
    $("#cancel-phone-hint").textContent = court.booking.phone ? `(${court.booking.phone})` : "";
    $("#cancel-court-visual").innerHTML = courtSVG(court.booking.source, { players: true });
    $("#cancel-error").hidden = true;
    $("#cancel-phone").value = "";
    $("#cancel-dialog").showModal();
    $("#cancel-phone").focus();
  }

  $("#cancel-form").addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    const phone = $("#cancel-phone").value.trim();
    $("#cancel-submit").disabled = true;
    try {
      const { ok, data } = await api.post("/api/cancel", { ...pendingCancel, phone });
      if (!ok) {
        const r = data.result || {};
        $("#cancel-error").textContent = `${r.status || "Lỗi"}: ${r.message || data.error || "Không hủy được."}`;
        $("#cancel-error").hidden = false;
        return;
      }
      $("#cancel-dialog").close();
      toast(`🗑️ Đã hủy <b>${esc(data.result.booking_id)}</b> · ${esc(data.result.datetime)}<br><small>JSON-RPC id ${data.id}</small>`);
    } catch (err) {
      $("#cancel-error").textContent = `Lỗi kết nối: ${err.message}`;
      $("#cancel-error").hidden = false;
    } finally {
      $("#cancel-submit").disabled = false;
    }
  });

  // ------------------------------------------------------------------ live events
  function connectLive() {
    const pill = $("#pill-live");
    const setLive = (on) => { pill.classList.toggle("on", on); pill.classList.toggle("off", !on); pill.lastElementChild.textContent = on ? "Live" : "Mất kết nối"; };
    const source = new EventSource("/api/events");
    source.addEventListener("hello", () => setLive(true));
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (msg) => {
      const ev = JSON.parse(msg.data);
      if (ev.type === "booking") onBooking(ev.booking);
      if (ev.type === "cancel") onCancel(ev.booking);
      if (ev.type === "reset") onReset(false);
    };
  }

  function onBooking(b) {
    const key = `${b.date}|${b.hour}|${b.court_id}`;
    state.flash.add(key);
    setTimeout(() => { state.flash.delete(key); }, 3200);
    if (b.date === state.date) { state.hour = b.hour; loadSchedule(); }
    else api.get(`/api/schedule?date=${encodeURIComponent(state.date)}`).then((d) => renderDates(d.days));

    const feed = $("#feed");
    feed.querySelector(".feed-empty")?.remove();
    const time = `${String(b.hour).padStart(2, "0")}:00`;
    feed.prepend(el("li", {}, `
      <div class="src ${esc(b.source)}">${b.source === "agent" ? "🤖" : "🧑"}</div>
      <div><div class="t">Sân ${esc(b.court_id)} · ${time} · ${esc(b.date.slice(0, 5))}</div>
      <div class="s">${b.source === "agent" ? "Agent đặt qua chat" : "Đặt trực tiếp trên UI"} · ${esc(b.booking_id)} · ${fmtVnd(b.price)}</div></div>`));
    if (b.source === "agent") {
      toast(`🤖 Agent vừa đặt <b>sân ${esc(b.court_id)}</b> lúc ${time} ngày ${esc(b.date)}`, "agent");
      if (b.date !== state.date) { state.hour = b.hour; loadSchedule(b.date); }
    }
  }

  function onCancel(b) {
    const key = `${b.date}|${b.hour}|${b.court_id}`;
    state.flash.add(key);
    setTimeout(() => { state.flash.delete(key); }, 3200);
    state.hour = b.hour;
    loadSchedule(b.source === "agent" ? b.date : state.date);

    const feed = $("#feed");
    feed.querySelector(".feed-empty")?.remove();
    const time = `${String(b.hour).padStart(2, "0")}:00`;
    feed.prepend(el("li", {}, `
      <div class="src cancel">🗑️</div>
      <div><div class="t">Hủy sân ${esc(b.court_id)} · ${time} · ${esc(b.date.slice(0, 5))}</div>
      <div class="s">${b.source === "agent" ? "Agent hủy qua chat" : "Hủy trực tiếp trên UI"} · ${esc(b.booking_id)}</div></div>`));
    if (b.source === "agent") toast(`🤖 Agent vừa hủy <b>${esc(b.booking_id)}</b>: sân ${esc(b.court_id)} lúc ${time} ngày ${esc(b.date)} đã trống lại`, "agent");
  }

  // ------------------------------------------------------------------ chat
  const SUGGESTIONS = [
    "Sân mở cửa mấy giờ, giá thuê bao nhiêu?",
    "Tối thứ Sáu 18/09 sau 19h còn sân nào trống?",
    "Đặt sân S2 lúc 20:00 ngày 18/09/2026, SĐT 0912345678",
    "Tối thứ Sáu 18/09 tìm sân trống sau 19h rồi đặt luôn sân đầu tiên, SĐT 0912345678",
    "Đặt giúp tôi 1 sân lúc 18:00 thứ Bảy 19/09, SĐT 0912345678",
    "Hủy giúp tôi booking BK-1909-S1-001, SĐT 0912345678",
    "Tối nay còn sân trống không?",
  ];

  function renderSuggestions() {
    $("#suggestions").replaceChildren(...SUGGESTIONS.map((s) => el("button", {
      class: "suggestion", type: "button",
      onclick: () => { $("#chat-input").value = s; sendMessage(); },
    }, esc(s))));
  }

  function scrollChat() { const log = $("#chat-log"); log.scrollTop = log.scrollHeight; }

  function addUserMessage(text) {
    $("#chat-log").append(el("div", { class: "msg user" }, `<div class="bubble">${esc(text).replace(/\n/g, "<br>")}</div>`));
    scrollChat();
  }

  function addBotShell() {
    const wrap = el("div", { class: "msg bot" });
    const steps = el("div", { class: "steps" });
    const bubble = el("div", { class: "bubble" }, `<span class="dots"><i></i><i></i><i></i></span>`);
    const meta = el("div", { class: "msg-meta" });
    wrap.append(steps, bubble, meta);
    $("#chat-log").append(wrap);
    scrollChat();
    return { wrap, steps, bubble, meta, chips: new Map(), thinking: null };
  }

  function argsText(args) {
    return Object.entries(args || {}).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
  }

  function addFinishedTurn(turn) {
    addUserMessage(turn.message);
    const ui = addBotShell();
    for (const e of turn.trace) if (e.action_type === "TOOL_EXECUTION") {
      ui.steps.append(el("div", { class: "step-chip tool" },
        `<span class="ico">🛠</span><b>${esc(e.tool_name)}</b><span class="args">${esc(argsText(e.arguments))}</span><span class="status-badge ${esc(e.observation?.status)}">${esc(e.observation?.status || "")}</span>`));
    }
    ui.bubble.innerHTML = md(turn.answer || "");
    fillMeta(ui, turn);
  }

  function fillMeta(ui, turn) {
    const tools = turn.trace.filter((e) => e.action_type === "TOOL_EXECUTION").length;
    ui.meta.replaceChildren();
    ui.meta.append(document.createTextNode(`${tools} tool call · ${fmtMs(turn.total_ms)}`));
    if (turn.fallback) ui.meta.append(el("span", { class: "badge warn" }, "Mock fallback"));
    ui.meta.append(el("a", { onclick: () => { state.selectedTurnId = turn.turn_id; state.selectedStep = null; location.hash = "trace"; setTab("trace"); } }, "Xem trace →"));
  }

  async function sendMessage() {
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = "";
    autosize();
    state.busy = true;
    $("#chat-send").disabled = true;

    addUserMessage(text);
    const ui = addBotShell();
    const live = { turn_id: `live-${Date.now()}`, message: text, events: [], trace: [], running: true, t0: performance.now(), provider: state.info?.provider, model: state.info?.model };
    state.liveTurn = live;
    state.selectedTurnId = live.turn_id;
    state.selectedStep = null;
    renderTurnList();

    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: state.sessionId, message: text }) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) handleChatEvent(JSON.parse(line), ui, live);
        }
      }
    } catch (err) {
      ui.bubble.innerHTML = `<span style="color:var(--danger)">Không kết nối được tới agent: ${esc(err.message)}</span>`;
      state.liveTurn = null;
      renderTurnList();
    } finally {
      state.busy = false;
      $("#chat-send").disabled = false;
      input.focus();
    }
  }

  function handleChatEvent(ev, ui, live) {
    if (ev.event !== "turn_end") live.events.push(ev);

    switch (ev.event) {
      case "turn_start": {
        const oldId = live.turn_id;
        live.turn_id = ev.turn_id;
        live.provider = ev.provider; live.model = ev.model;
        if (state.selectedTurnId === oldId) state.selectedTurnId = ev.turn_id;
        break;
      }
      case "step_start": {
        ui.thinking?.remove();
        ui.thinking = el("div", { class: "step-chip thinking" }, `<span class="ico">🧠</span>Bước ${ev.step} · LLM đang suy luận <span class="dots"><i></i><i></i><i></i></span>`);
        ui.steps.append(ui.thinking);
        break;
      }
      case "llm_fallback":
        ui.steps.append(el("div", { class: "step-chip warn" }, `<span class="ico">⚠️</span>LLM API lỗi, đang dùng Mock: <span class="args">${esc(ev.error)}</span>`));
        live.fallback = true;
        break;
      case "action": {
        ui.thinking?.remove(); ui.thinking = null;
        const chip = el("div", { class: "step-chip tool" }, `<span class="ico">🛠</span><b>${esc(ev.tool_name)}</b><span class="args">${esc(argsText(ev.arguments))}</span><span class="status-badge">MCP <span class="dots"><i></i><i></i><i></i></span></span>`);
        ui.chips.set(ev.step, chip);
        ui.steps.append(chip);
        break;
      }
      case "trace": {
        const e = ev.entry;
        live.trace.push(e);
        if (e.action_type === "TOOL_EXECUTION") {
          const badge = ui.chips.get(e.step)?.querySelector(".status-badge");
          if (badge) { badge.className = `status-badge ${e.observation?.status || ""}`; badge.textContent = e.observation?.status || "OK"; }
        } else {
          ui.thinking?.remove(); ui.thinking = null;
          ui.bubble.innerHTML = md(e.output);
        }
        break;
      }
      case "turn_end": {
        const turn = ev.turn;
        state.turns.push(turn);
        state.liveTurn = null;
        if (state.selectedTurnId === live.turn_id) state.selectedTurnId = turn.turn_id;
        ui.thinking?.remove();
        if (turn.error) ui.bubble.innerHTML = `${md(turn.answer)}<br><small style="color:var(--danger)">${esc(turn.error)}</small>`;
        fillMeta(ui, turn);
        $("#trace-count").textContent = state.turns.length;
        break;
      }
    }
    scrollChat();
    scheduleTraceRender();
  }

  function autosize() {
    const ta = $("#chat-input");
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }
  $("#chat-input").addEventListener("input", autosize);
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });

  // ------------------------------------------------------------------ trace
  let traceRaf = 0;
  function scheduleTraceRender() {
    renderTurnList();
    if (state.tab !== "trace" || traceRaf) return;
    traceRaf = requestAnimationFrame(() => { traceRaf = 0; renderTrace(); });
  }
  setInterval(() => { if (state.liveTurn && state.tab === "trace" && state.selectedTurnId === state.liveTurn.turn_id) renderTrace(); }, 250);

  function allTurns() {
    return state.liveTurn ? [...state.turns, state.liveTurn] : state.turns;
  }

  function renderTurnList() {
    const list = $("#turn-list");
    const turns = allTurns();
    $("#trace-count").textContent = state.turns.length + (state.liveTurn ? 1 : 0);
    if (!turns.length) {
      list.innerHTML = `<li class="feed-empty">Chưa có hội thoại. Hãy chat với trợ lý ở tab “Đặt sân &amp; Chat”.</li>`;
      return;
    }
    if (!state.selectedTurnId || !turns.some((t) => t.turn_id === state.selectedTurnId)) state.selectedTurnId = turns[turns.length - 1].turn_id;
    list.replaceChildren(...turns.slice().reverse().map((t, i) => {
      const tools = t.trace.filter((e) => e.action_type === "TOOL_EXECUTION").length;
      return el("li", {
        class: `turn-item${t.turn_id === state.selectedTurnId ? " is-active" : ""}`,
        onclick: () => { state.selectedTurnId = t.turn_id; state.selectedStep = null; renderTurnList(); renderTrace(); },
      }, `<div class="q">#${turns.length - i} · ${esc(t.message)}</div>
          <div class="m">${t.running ? `<span class="running">● đang chạy…</span>` : `<span>${fmtMs(t.total_ms)}</span>`}<span>${tools} tool</span>${t.fallback ? `<span class="badge warn">mock</span>` : ""}</div>`);
    }));
  }

  function buildSteps(turn) {
    const steps = new Map();
    let maxReached = null;
    const get = (n) => { if (!steps.has(n)) steps.set(n, { step: n, start: 0 }); return steps.get(n); };
    for (const ev of turn.events) {
      if (ev.event === "step_start") get(ev.step).start = ev.t_ms;
      else if (ev.event === "llm_fallback") get(ev.step).fallback = ev.error;
      else if (ev.event === "action") Object.assign(get(ev.step), { llmEnd: ev.t_ms, tool_name: ev.tool_name, arguments: ev.arguments, thought: ev.thought, kind: "tool" });
      else if (ev.event === "trace") {
        const e = ev.entry;
        if (e.action_type === "MAX_ITERATIONS_REACHED") { maxReached = e; continue; }
        const s = get(e.step);
        s.entry = e;
        if (e.action_type === "TOOL_EXECUTION") { s.toolEnd = ev.t_ms; s.kind = "tool"; }
        else { s.llmEnd = s.llmEnd ?? ev.t_ms; s.kind = "final"; }
      }
    }
    return { steps: [...steps.values()].sort((a, b) => a.step - b.step), maxReached };
  }

  function renderTrace() {
    const main = $("#trace-main");
    const turn = allTurns().find((t) => t.turn_id === state.selectedTurnId);
    if (!turn) {
      main.innerHTML = `<div class="panel trace-empty"><div class="big-emoji">🧭</div><h2>Trace hội thoại</h2>
        <p class="muted">Mỗi tin nhắn gửi cho agent sẽ tạo một trace: LLM suy luận → gọi Tool qua MCP (JSON-RPC 2.0) → Observation → Final Answer, kèm độ trễ từng bước.</p></div>`;
      return;
    }
    const now = turn.running ? performance.now() - turn.t0 : turn.total_ms;
    const { steps, maxReached } = buildSteps(turn);
    const toolSteps = steps.filter((s) => s.kind === "tool");
    const llmMs = steps.reduce((acc, s) => acc + ((s.llmEnd ?? now) - s.start), 0);
    const toolMs = toolSteps.reduce((acc, s) => acc + ((s.toolEnd ?? now) - (s.llmEnd ?? now)), 0);
    const final = steps.find((s) => s.kind === "final")?.entry || maxReached;

    // ---- summary
    const summary = el("div", { class: "panel trace-summary" });
    summary.innerHTML = `
      <div class="q">${esc(turn.message)}</div>
      <div class="stats">
        <div class="stat"><div class="k">Tổng thời gian</div><div class="v">${fmtMs(now)}</div></div>
        <div class="stat"><div class="k">Vòng ReAct</div><div class="v">${steps.length}<small> / ${state.info?.max_iterations ?? 5}</small></div></div>
        <div class="stat"><div class="k">Tool call (MCP)</div><div class="v">${toolSteps.length}</div></div>
        <div class="stat"><div class="k">Thời gian LLM</div><div class="v">${fmtMs(llmMs)}</div></div>
        <div class="stat"><div class="k">Thời gian Tool</div><div class="v">${fmtMs(toolMs)}</div></div>
      </div>
      <div class="trace-actions">
        ${turn.running ? `<span class="badge run">● Đang chạy</span>` : turn.error ? `<span class="badge warn">Lỗi</span>` : `<span class="badge ok">Hoàn tất</span>`}
        ${turn.fallback ? `<span class="badge warn">Có bước fallback Mock</span>` : ""}
        <span class="badge">${esc(turn.provider || "")} · ${esc(turn.model || "")}</span>
        <span class="badge">${esc(state.info?.mcp_server || "")}</span>
        <span style="flex:1"></span>
        <button class="btn ghost small" id="copy-turn" ${turn.running ? "disabled" : ""}>Copy JSON lượt này</button>
        <a class="btn ghost small" href="/api/trace?session_id=${encodeURIComponent(state.sessionId)}&download=1" download>⬇ Tải trace phiên</a>
      </div>`;

    // ---- flow
    const flow = el("div", { class: "panel flow" });
    const nodes = [`<div class="flow-node user"><div class="k">User</div><div class="v">${esc(turn.message.length > 60 ? turn.message.slice(0, 60) + "…" : turn.message)}</div></div>`];
    for (const s of steps) {
      nodes.push(`<div class="flow-node llm"><div class="k">Thought · B${s.step}</div><div class="v">${s.kind === "tool" ? `Gọi ${esc(s.tool_name)}` : s.kind === "final" ? "Trả lời" : "Đang suy luận…"}</div></div>`);
      if (s.kind === "tool") {
        nodes.push(`<div class="flow-node tool"><div class="k">Action</div><div class="v">${esc(s.tool_name)}</div></div>`);
        nodes.push(`<div class="flow-node obs"><div class="k">Observation</div><div class="v">${s.entry ? esc(s.entry.observation?.status || "OK") : "…"}</div></div>`);
      }
    }
    if (final) nodes.push(`<div class="flow-node final"><div class="k">${final.action_type === "FINAL_ANSWER" ? "Final Answer" : "Dừng"}</div><div class="v">${esc((final.output || "").replace(/\*\*/g, "").slice(0, 70))}…</div></div>`);
    flow.innerHTML = `<div class="panel-title" style="padding:0 0 10px">Luồng ReAct</div><div class="flow-row">${nodes.join(`<div class="flow-arrow">→</div>`)}</div>`;

    // ---- waterfall
    const span = Math.max(now, 1);
    const pct = (ms) => `${Math.max(0, Math.min(100, (ms / span) * 100))}%`;
    const rows = [];
    for (const s of steps) {
      const llmEnd = s.llmEnd ?? now;
      rows.push({ step: s.step, kind: "llm", ms: s.entry ? (s.entry.llm_latency_ms ?? s.entry.latency_ms) : null, label: s.kind === "final" ? "LLM → Final Answer" : s.kind === "tool" ? "LLM → chọn tool" : "LLM suy luận…", start: s.start, end: llmEnd, running: s.llmEnd == null && turn.running, barClass: s.kind === "final" ? "final" : "llm" });
      if (s.kind === "tool") {
        const toolEnd = s.toolEnd ?? now;
        rows.push({ step: s.step, kind: "tool", ms: s.entry ? s.entry.tool_latency_ms : null, label: `MCP ${s.tool_name}`, start: llmEnd, end: toolEnd, running: s.toolEnd == null && turn.running, barClass: "tool" });
      }
    }
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span style="left:${f * 100}%">${fmtMs(span * f)}</span>`).join("");
    const wf = el("div", { class: "panel waterfall" });
    wf.innerHTML = `<div class="panel-title" style="padding:0 0 10px">Waterfall độ trễ</div>
      <div class="wf-grid">
        <div></div><div class="wf-axis">${ticks}</div><div></div>
        ${rows.map((r) => `
          <div class="wf-label${state.selectedStep === r.step ? " is-active" : ""}" data-step="${r.step}">
            <span class="kind ${r.kind}">${r.kind === "llm" ? "LLM" : "TOOL"}</span><span class="name">B${r.step} · ${esc(r.label)}</span>
          </div>
          <div class="wf-track" data-step="${r.step}"><div class="wf-bar ${r.barClass}${r.running ? " running" : ""}" style="left:${pct(r.start)};width:calc(${pct(r.end - r.start)})"></div></div>
          <div class="wf-ms">${fmtMs(r.ms ?? (r.end - r.start))}</div>`).join("")}
      </div>`;

    // ---- step details
    const details = el("div", { class: "steps-detail" });
    for (const s of steps) {
      const card = el("article", { class: `panel step-card${state.selectedStep === s.step ? " is-active" : ""}`, id: `step-${s.step}` });
      const e = s.entry;
      const thought = s.thought || e?.thought;
      let body = `<div class="step-block thought"><div class="k">🧠 Thought</div><p>${thought ? esc(thought) : `<span class="dots"><i></i><i></i><i></i></span>`}</p>${s.fallback ? `<p class="book-error">LLM API lỗi → Mock: ${esc(s.fallback)}</p>` : ""}</div>`;
      if (s.kind === "tool") {
        body += `<div class="step-block action"><div class="k">🛠 Action</div><div class="rpc">MCP JSON-RPC 2.0 · id ${e?.jsonrpc_id ?? "…"} · tools/call</div><pre class="json">${jsonHtml({ tool: s.tool_name, arguments: s.arguments })}</pre></div>`;
        body += `<div class="step-block obs"><div class="k">👁 Observation</div>${e ? `<pre class="json">${jsonHtml(e.observation)}</pre>` : `<p class="muted">Đang chờ MCP Server…</p>`}</div>`;
      } else if (s.kind === "final") {
        body += `<div class="step-block final"><div class="k">🏁 Final Answer</div><div class="bubble" style="background:#f3f6f2">${md(e.output)}</div></div>`;
      }
      const lat = s.kind === "tool" && e ? `LLM ${fmtMs(e.llm_latency_ms)} · Tool ${fmtMs(e.tool_latency_ms)}` : e ? `LLM ${fmtMs(e.latency_ms)}` : "đang chạy…";
      card.innerHTML = `<header><span class="step-no">${s.step}</span><span class="title">${s.kind === "tool" ? `Gọi tool <code>${esc(s.tool_name)}</code>` : s.kind === "final" ? "Tổng hợp câu trả lời" : "LLM đang suy luận"}</span>
        ${e?.observation?.status ? `<span class="status-badge ${esc(e.observation.status)}">${esc(e.observation.status)}</span>` : ""}
        <span class="lat">${lat}</span></header><div class="step-body">${body}</div>`;
      details.append(card);
    }
    if (maxReached) details.append(el("article", { class: "panel step-card" }, `<header><span class="step-no">!</span><span class="title">Dừng do vượt MAX_ITERATIONS</span></header><div class="step-body"><div class="step-block final"><p>${esc(maxReached.output)}</p></div></div>`));

    const raw = el("details", { class: "panel", style: "padding:12px 16px" }, `<summary style="cursor:pointer;font-weight:700">Raw trace JSON (định dạng docs/trace_waterfall.json)</summary><pre class="json" style="margin-top:10px;max-height:480px">${jsonHtml(turn.trace)}</pre>`);

    const openRaw = main.querySelector("details")?.open;
    main.replaceChildren(summary, flow, wf, details, raw);
    if (openRaw) raw.open = true;

    main.querySelectorAll("[data-step]").forEach((node) => node.addEventListener("click", () => {
      state.selectedStep = Number(node.dataset.step);
      renderTrace();
      document.getElementById(`step-${state.selectedStep}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    $("#copy-turn", main)?.addEventListener("click", async () => {
      const data = JSON.stringify({ message: turn.message, provider: turn.provider, model: turn.model, total_ms: turn.total_ms, trace: turn.trace }, null, 2);
      try { await navigator.clipboard.writeText(data); toast("📋 Đã copy JSON trace của lượt này"); }
      catch { toast("Không copy được (trình duyệt chặn clipboard)", "error"); }
    });
  }

  // ------------------------------------------------------------------ reset & boot
  async function onReset(fromButton) {
    if (fromButton) {
      if (!confirm("Khôi phục lịch sân mẫu và xóa toàn bộ hội thoại/trace của demo?")) return;
      await api.post("/api/reset", {});
    }
    state.turns = [];
    state.liveTurn = null;
    state.selectedTurnId = null;
    state.sessionId = newId();
    store.set(SESSION_KEY, state.sessionId);
    $("#chat-log").replaceChildren($("#chat-log .intro") || el("div"));
    $("#feed").innerHTML = `<li class="feed-empty">Chưa có lượt đặt mới trong phiên demo.</li>`;
    renderTurnList();
    if (state.tab === "trace") renderTrace();
    await loadSchedule();
    if (fromButton) toast("↺ Đã reset dữ liệu demo");
  }
  $("#btn-reset").addEventListener("click", () => onReset(true));

  async function boot() {
    renderSuggestions();
    try {
      state.info = await api.get("/api/info");
      $("#pill-model").textContent = `${state.info.provider} · ${state.info.model}`;
      $("#pill-mcp").textContent = `MCP ${state.info.mcp_server}`;
      const days = state.info.days.map((d) => d.date);
      state.date = days.includes("18/09/2026") ? "18/09/2026" : state.info.today;
      await loadSchedule(state.date);

      const saved = await api.get(`/api/trace?session_id=${encodeURIComponent(state.sessionId)}`);
      state.turns = saved.turns || [];
      state.turns.forEach(addFinishedTurn);
      renderTurnList();
    } catch (err) {
      toast(`Không tải được dữ liệu demo: ${esc(err.message)}`, "error");
    }
    connectLive();
    setTab(location.hash.slice(1) || "booking");
  }

  boot();
})();
