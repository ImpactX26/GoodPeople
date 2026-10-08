/* LUNA NGO Matching Agent dashboard. Plain JS, no build step.
   All data comes from the API; nothing here makes decisions. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TERMINAL = ["MATCHED", "PARTIALLY_MATCHED", "NO_FEASIBLE_MATCH", "NEEDS_INFORMATION", "WINDOW_EXPIRED", "FAILED"];
  const FAILED_STATES = ["REJECTED", "UNAVAILABLE", "NO_RESPONSE", "EXCLUDED"];
  const FACTOR_LABELS = { demand_urgency: "Demand urgency", capacity_fit: "Capacity fit", travel_time: "Travel time",
    food_compatibility: "Food compatibility", receiving_hours: "Receiving hours", reliability: "Reliability", current_load: "Current load" };
  const STATE_LABEL = { AWAITING_CONFIRMATION: "⏳ Awaiting confirmation", ACCEPTED: "✅ Accepted", REJECTED: "❌ Rejected",
    UNAVAILABLE: "⚠️ Became unavailable", NO_RESPONSE: "⏱️ No response", EXCLUDED: "Excluded", CANDIDATE: "Candidate" };
  const FEED_ICON = { system: "•", step: "›", thought: "💭", decision: "★", confirmation: "✉", replan: "↻", warning: "!",
    guardrail: "🛡", error: "✖", result: "◉", simulation: "🧪" };

  let mode = "DEMO", matchId = null, lastEvent = 0, view = null, timer = null, openCards = new Set(), weights = {};
  let visitedReplan = false;

  // ------------------------------------------------------------------ boot
  async function boot() {
    const sys = await (await fetch("/api/system")).json();
    weights = sys.weights;
    const b = sys.brain;
    const badge = $("brainBadge");
    badge.textContent = b.llm_configured ? `🧠 ${b.label}` : `⚙️ No LLM configured — rule-based fallback`;
    badge.className = "badge brain " + (b.llm_configured ? "llm" : "rules");
    const sel = $("scenarioSelect");
    sel.innerHTML = sys.scenarios.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join("");
    const pick = sys.scenarios.find((s) => s.id === "best_rejects") ? "best_rejects" : sys.scenarios[0]?.id;
    sel.value = pick;
    const desc = () => { const s = sys.scenarios.find((x) => x.id === sel.value); $("scenarioDesc").textContent = s ? `${s.description}  Expected: ${s.expected}` : ""; };
    sel.onchange = desc; desc();
    setInterval(tickCountdown, 1000);
    const q = new URLSearchParams(location.search);
    if (q.get("match")) { if (q.get("mode") === "LIVE") setMode("LIVE"); watch(q.get("match")); }
  }

  // ------------------------------------------------------------------ mode
  document.querySelectorAll(".mode-btn").forEach((btn) => btn.onclick = () => setMode(btn.dataset.mode));
  function setMode(m) {
    mode = m;
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    const banner = $("modeBanner");
    if (m === "DEMO") {
      banner.className = "mode-banner demo";
      banner.innerHTML = "<strong>DEMO MODE</strong> — synthetic NGO database, simulated NGO responses and controlled failures. Nothing on this screen is a real NGO.";
    } else {
      banner.className = "mode-banner live";
      banner.innerHTML = "<strong>LIVE MODE</strong> — real NGO database, configured LLM, real calculations and real NGO confirmations. No simulated responses.";
      loadRecent();
    }
    $("demoLauncher").classList.toggle("hidden", m !== "DEMO");
    $("liveLauncher").classList.toggle("hidden", m !== "LIVE");
  }

  async function loadRecent() {
    const rows = await (await fetch("/api/ngo-agent/matches?mode=LIVE")).json();
    $("recentMatches").innerHTML = `<option value="">Recent live matches…</option>` +
      rows.map((r) => `<option value="${esc(r.match_id)}">${esc(r.match_id)} · ${esc(r.status)}</option>`).join("");
  }
  $("recentMatches").onchange = (e) => e.target.value && watch(e.target.value);

  // ------------------------------------------------------------------ start runs
  $("runScenario").onclick = async () => {
    $("runScenario").disabled = true;
    try {
      const r = await fetch(`/api/demo/scenarios/${$("scenarioSelect").value}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brain: $("brainSelect").value }) });
      const j = await r.json();
      if (!r.ok) { alertFeed(j.detail || "Could not start"); return; }
      watch(j.match_id);
    } finally { setTimeout(() => ($("runScenario").disabled = false), 1500); }
  };

  $("openPassport").onclick = () => {
    const now = new Date();
    $("passportText").value = JSON.stringify({
      passport_id: "PASS-LUNA-F" + Math.floor(1000 + Math.random() * 8999), food_id: "LUNA-F0000", restaurant_id: "REST-0091",
      food_name: "Vegetable Rice", food_category: "cooked_meal", quantity: 80, issued_at: now.toISOString(),
      prepared_at: new Date(now - 90 * 60000).toISOString(), storage_method: "refrigerated", storage_temperature: 4,
      ingredients: ["rice", "carrot", "peas", "beans"], allergens: [], dietary_tags: ["vegetarian"],
      eligibility: { decision: "ELIGIBLE", risk_level: "LOW", risk_score: 8 }, rescue_window: { remaining_minutes: 120 },
      restaurant_location: { latitude: 12.9716, longitude: 77.5946 } }, null, 2);
    $("passportError").textContent = "";
    $("passportDialog").showModal();
  };
  $("submitPassport").onclick = async (e) => {
    e.preventDefault();
    let p;
    try { p = JSON.parse($("passportText").value); } catch { $("passportError").textContent = "Invalid JSON"; return; }
    const r = await fetch("/api/ngo-agent/match", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ food_passport: p, mode: "LIVE", brain: "auto" }) });
    const j = await r.json();
    if (!r.ok) { $("passportError").textContent = j.detail || "Failed"; return; }
    $("passportDialog").close();
    watch(j.match_id);
  };

  // ------------------------------------------------------------------ polling
  function watch(id) {
    matchId = id; lastEvent = 0; view = null; openCards = new Set(); visitedReplan = false;
    delete $("excludedBox").dataset.autoOpened; $("excludedBox").open = false; delete $("countdown").dataset.total;
    $("feed").innerHTML = ""; $("landing").classList.add("hidden"); $("dashboard").classList.remove("hidden");
    $("resultCard").classList.add("hidden");
    clearInterval(timer);
    poll();
    timer = setInterval(poll, 700);
  }

  async function poll() {
    if (!matchId) return;
    let r;
    try { r = await fetch(`/api/ngo-agent/match/${matchId}?after_event=${lastEvent}`); } catch { return; }
    if (!r.ok) return;
    const v = await r.json();
    view = v;
    for (const e of v.events) { addFeed(e); lastEvent = Math.max(lastEvent, e.id); }
    render(v);
    if (!v.running && TERMINAL.includes(v.status)) { clearInterval(timer); timer = null; }
  }

  function addFeed(e) {
    const li = document.createElement("li");
    li.className = e.kind + (e.kind === "result" && !/MATCH COMPLETE/.test(e.message) ? " neg" : "");
    const t = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    li.innerHTML = `<span class="t">${t}</span><span>${FEED_ICON[e.kind] || "•"}</span><span class="m">${esc(e.message)}</span>`;
    const feed = $("feed");
    feed.appendChild(li);
    feed.scrollTop = feed.scrollHeight;
  }
  function alertFeed(msg) { $("landing").classList.add("hidden"); $("dashboard").classList.remove("hidden"); addFeed({ kind: "error", ts: new Date().toISOString(), message: msg }); }

  // ------------------------------------------------------------------ render
  function render(v) {
    const s = v.state || {};
    renderFood(s.food, v.result);
    renderStatus(v, s);
    renderCandidates(s, v);
    renderDecision(s, v);
    renderRadar(s);
    renderResult(v);
  }

  function renderFood(f, result) {
    if (!f) { $("foodName").textContent = "Validating passport…"; return; }
    $("foodName").textContent = f.food_name;
    $("foodQty").textContent = f.quantity;
    $("foodUnit").textContent = f.unit;
    const chips = [`<span class="chip">${esc(f.food_category.replace(/_/g, " "))}</span>`];
    (f.dietary_tags || []).filter((t) => !t.startsWith("possibly")).forEach((t) => chips.push(`<span class="chip ok">${esc(t.replace(/_/g, " "))}</span>`));
    if (f.allergens === "UNKNOWN") chips.push(`<span class="chip warn">allergens unknown</span>`);
    else if (!f.allergens.length) chips.push(`<span class="chip ok">no declared allergens</span>`);
    else f.allergens.forEach((a) => chips.push(`<span class="chip bad">${esc(a)}</span>`));
    chips.push(`<span class="chip ok">Food Agent: ELIGIBLE</span>`);
    $("foodChips").innerHTML = chips.join("");
    $("countdown").dataset.deadline = f.rescue_deadline;
    $("countdown").dataset.total = $("countdown").dataset.total || f.remaining_rescue_minutes;
    $("foodMeta").textContent = `Passport ${f.passport_id}` + (f.dietary_source === "derived_from_ingredients" ? " · dietary info derived from ingredients" : "");
    tickCountdown();
  }

  function tickCountdown() {
    const el = $("countdown");
    if (!el.dataset.deadline) return;
    const ms = new Date(el.dataset.deadline) - new Date();
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(sec / 3600)).padStart(2, "0"), m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0"), s = String(sec % 60).padStart(2, "0");
    el.textContent = `${h}:${m}:${s}`;
    el.classList.toggle("urgent", sec < 30 * 60);
    const total = parseFloat(el.dataset.total || "120") * 60;
    $("countdownBar").style.width = Math.max(0, Math.min(100, (sec / total) * 100)) + "%";
  }

  function renderStatus(v, s) {
    const st = v.status;
    const pill = $("statusPill");
    const map = { MATCHED: ["done", "✅ MATCH COMPLETE"], PARTIALLY_MATCHED: ["partial", "🟡 PARTIALLY MATCHED"],
      NO_FEASIBLE_MATCH: ["fail", "⛔ NO FEASIBLE MATCH"], NEEDS_INFORMATION: ["partial", "❓ NEEDS INFORMATION"],
      WINDOW_EXPIRED: ["fail", "⌛ WINDOW EXPIRED"], FAILED: ["fail", "✖ STOPPED SAFELY"],
      AWAITING_CONFIRMATION: ["waiting", "AWAITING NGO CONFIRMATION"], REPLANNING: ["replan", "RE-PLANNING"] };
    const [cls, label] = map[st] || ["running", "MATCHING IN PROGRESS"];
    pill.className = "status-pill " + cls;
    $("statusText").textContent = label;
    if (st === "REPLANNING" || (s.replans || 0) > 0) visitedReplan = true;
    const order = ["VALIDATING", "SEARCHING", "EVALUATING", "AWAITING_CONFIRMATION", "REPLANNING", "FINAL"];
    let cur = TERMINAL.includes(st) ? "FINAL" : st === "RECEIVED" ? "VALIDATING" : st;
    const ci = order.indexOf(cur);
    document.querySelectorAll("#phases li").forEach((li) => {
      const p = li.dataset.p, i = order.indexOf(p);
      li.className = "";
      if (p === cur) li.classList.add("current");
      else if (p === "REPLANNING") { if (visitedReplan) li.classList.add("visited-replan"); }
      else if (i < ci || (cur === "REPLANNING" && i <= 3)) li.classList.add("done");
    });
    const feasible = (s.candidates || []).filter((c) => c.feasible).length;
    $("stFound").textContent = s.candidates_found || 0;
    $("stFeasible").textContent = feasible;
    $("stReplans").textContent = s.replans || 0;
    $("stPlaced").textContent = `${s.accepted_quantity || 0}${s.food ? "/" + s.food.quantity : ""}`;
    const brain = s.brain || "";
    $("brainLine").innerHTML = brain ? `Reasoning engine: <b>${esc(brain)}</b>` + ((s.brain_history || []).length > 1 ? ` · switched: ${esc(s.brain_history.join(" → "))}` : "") : "";
  }

  function candidateCard(c, idx, bestId) {
    const ms = c.match_status;
    const failed = FAILED_STATES.includes(ms);
    const medal = failed ? "✖" : ["🥇", "🥈", "🥉"][idx] || `#${idx + 1}`;
    const m = c.metrics, rel = c.reliability;
    const cls = ["cand", c.ngo_id === bestId ? "best" : "", failed ? "failed" : "", ms === "ACCEPTED" ? "accepted" : "",
      ms === "AWAITING_CONFIRMATION" ? "awaiting" : "", openCards.has(c.ngo_id) ? "open" : ""].join(" ");
    const tick = (ok) => ok ? `<span style="color:var(--green)">✓</span>` : `<span style="color:var(--red)">✗</span>`;
    const factors = Object.entries(c.factors).map(([k, val]) => `
      <div class="frow"><span>${FACTOR_LABELS[k] || k} <span class="muted">(${Math.round((weights[k] || 0) * 100)}%)</span></span>
      <div class="fbar"><div style="width:${Math.round(val * 100)}%"></div></div><span>+${(c.contributions[k] || 0).toFixed(1)}</span></div>`).join("");
    const why = c.strengths.map((x) => `<li>${esc(x)}</li>`).join("") + c.concerns.map((x) => `<li class="c">${esc(x)}</li>`).join("");
    const relTxt = rel.insufficient_history ? "n/a (new)" : `${Math.round(rel.acceptance_rate * 100)}%`;
    const demoAction = (view?.mode === "DEMO" && !failed && ms !== "ACCEPTED" && !TERMINAL.includes(view.status))
      ? `<div class="cand-actions"><button data-offline="${esc(c.ngo_id)}" title="Demo control: simulate this NGO going offline">⚡ Simulate going offline</button></div>` : "";
    return `<div class="${cls}" data-id="${esc(c.ngo_id)}">
      <div class="medal">${medal}<small>${failed ? "" : "rank"}</small></div>
      <div>
        <div class="cand-name">${esc(c.name)}</div>
        <div class="cand-sub">${esc(c.ngo_id)} · ${failed && c.match_exclusion ? esc(c.match_exclusion) : esc(c.checks.status)}</div>
        <div class="kv">
          <span>Demand: <b>${esc(m.demand_urgency)}</b> (${m.meals_needed} needed)</span>
          <span>Capacity: <b>${m.available_capacity}</b> meals</span>
          <span>Distance: <b>${m.distance_km.toFixed(1)} km</b></span>
          <span>ETA: <b>${Math.round(m.travel_minutes)} min</b></span>
          <span>Compatibility: ${tick(!c.checks.compatibility || c.checks.compatibility === "Compatible")}</span>
          <span>Receiving hours: ${tick(!(c.exclusion_reasons || []).some((r) => r.includes("receiving hours")))}</span>
          <span>Reliability: <b>${relTxt}</b></span>
          <span>Spare time: <b>${Math.round(m.slack_minutes)} min</b></span>
        </div>
        ${ms && ms !== "CANDIDATE" ? `<span class="cstate ${ms}">${STATE_LABEL[ms] || ms}</span>` : ""}
        ${demoAction}
      </div>
      <div class="score"><div class="num">${Math.round(c.raw_score)}</div><div class="lbl">MATCH SCORE</div>
        <button class="ghost small" data-toggle="${esc(c.ngo_id)}" style="margin-top:8px;font-size:11px;padding:3px 8px">${openCards.has(c.ngo_id) ? "Hide" : "Why?"}</button></div>
      <div class="factors">${factors}<ul class="why">${why}</ul>
        ${(rel.notes || []).map((n) => `<div class="muted small">Memory: ${esc(n)}${rel.baseline_source === "synthetic" ? " (synthetic demo data)" : ""}</div>`).join("")}</div>
    </div>`;
  }

  function renderCandidates(s, v) {
    const list = $("candidateList");
    const cands = s.candidates || [];
    const active = cands.filter((c) => c.feasible || ["REJECTED", "UNAVAILABLE", "NO_RESPONSE", "ACCEPTED", "AWAITING_CONFIRMATION"].includes(c.match_status));
    const excluded = cands.filter((c) => !active.includes(c));
    const bestId = s.proposal?.allocations?.find((a) => ["PROPOSED", "AWAITING_CONFIRMATION", "ACCEPTED"].includes(a.status))?.ngo_id
      || active.find((c) => !FAILED_STATES.includes(c.match_status))?.ngo_id;
    if (!cands.length) {
      list.innerHTML = `<div class="empty">${s.candidates_found ? "Evaluating candidates…" : "Searching for NGOs…"}</div>`;
    } else if (!active.length) {
      list.innerHTML = `<div class="empty">No NGO passes the feasibility checks for this food.</div>`;
    } else {
      let rank = 0;
      list.innerHTML = active.map((c) => { const html = candidateCard(c, FAILED_STATES.includes(c.match_status) ? -1 : rank, bestId); if (!FAILED_STATES.includes(c.match_status)) rank++; return html; }).join("");
    }
    const funnel = s.funnel || [];
    const removed = funnel.filter((f) => f.removed);
    $("funnel").textContent = !funnel.length ? "" : removed.length
      ? `${s.candidates_found} found → ` + removed.map((f) => `${f.remaining} after ${f.label.split(" (")[0]}`).join(" → ")
      : `${s.candidates_found} found → all pass the hard filters`;
    $("excludedBox").classList.toggle("hidden", !excluded.length);
    if (!active.length && excluded.length && !$("excludedBox").dataset.autoOpened) { $("excludedBox").open = true; $("excludedBox").dataset.autoOpened = "1"; }
    $("excludedCount").textContent = excluded.length;
    $("excludedList").innerHTML = excluded.map((c) => `<div class="exrow"><span><b>${esc(c.name)}</b> <span class="muted">${esc(c.ngo_id)}</span></span><span class="r">${esc((c.exclusion_reasons || []).join("; "))}</span></div>`).join("");
    list.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = () => { const id = b.dataset.toggle; openCards.has(id) ? openCards.delete(id) : openCards.add(id); render(view); });
    list.querySelectorAll("[data-offline]").forEach((b) => b.onclick = async () => {
      b.disabled = true;
      await fetch(`/api/ngos/${encodeURIComponent(b.dataset.offline)}/status?mode=DEMO`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "UNAVAILABLE" }) });
    });
  }

  function renderDecision(s, v) {
    const el = $("decision");
    const r = v.result || {};
    const allocs = (s.proposal?.allocations || []).filter((a) => !FAILED_STATES.includes(a.status));
    if (TERMINAL.includes(v.status) && !s.accepted?.length) {
      const reasons = (r.reasoning || []).slice(0, 8);
      el.innerHTML = `<div class="best-name" style="color:var(--red)">${v.status === "NEEDS_INFORMATION" ? "More information needed" : v.status === "FAILED" ? "Stopped safely" : "No feasible NGO"}</div>
        <div class="muted small">Luna returns this to the Orchestrator instead of guessing.</div>
        <ul class="neg">${reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
      return;
    }
    if (!allocs.length) { el.innerHTML = `<div class="empty">${s.replans ? "Re-planning after a failed confirmation…" : "Evaluating candidates…"}</div>`; return; }
    const strategy = allocs.length > 1 || s.proposal.strategy === "SPLIT_DONATION" ? "Split donation" : "Best match";
    const lines = allocs.map((a) => `<div class="alloc"><span><b>${esc(a.name)}</b></span><span>${a.quantity} meals · ${STATE_LABEL[a.status] || "Proposed"}</span></div>`).join("");
    const reasons = (s.decision_reasoning || []).filter(Boolean);
    el.innerHTML = `<div class="muted small">${strategy}</div>
      <div class="best-name">${esc(allocs.map((a) => a.name).join(" + "))}</div>${lines}
      ${reasons.length ? `<div class="muted small" style="margin-top:10px">Why?</div><ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="source">Explanation by: ${esc(s.brain || "")}</div>`;
  }

  function renderRadar(s) {
    const svg = $("radar");
    const f = s.food;
    if (!f) { svg.innerHTML = ""; return; }
    const lat0 = f.restaurant_location.latitude, lon0 = f.restaurant_location.longitude;
    const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
    const pts = (s.candidates || []).map((c) => ({ c, x: (c.location.longitude - lon0) * kx, y: (c.location.latitude - lat0) * ky }));
    const maxD = Math.max(3, ...pts.map((p) => Math.hypot(p.x, p.y))) * 1.08;
    // square-root radial scale: keeps nearby NGOs readable while still showing far ones
    const R = 135, cx = 150, cy = 150;
    const rad = (d) => Math.sqrt(d / maxD) * R;
    const proj = (x, y) => { const d = Math.hypot(x, y) || 1e-9, r = rad(d); return [cx + (x / d) * r, cy - (y / d) * r]; };
    let html = "";
    [1, 3, 5, 10, 15].filter((r) => r < maxD).forEach((r) => {
      html += `<circle cx="${cx}" cy="${cy}" r="${rad(r)}" fill="none" stroke="#24304f" stroke-dasharray="3 4"/>
               <text x="${cx + 3}" y="${cy - rad(r) + 10}" fill="#5d6a8a" font-size="8">${r} km</text>`;
    });
    pts.forEach(({ c, x, y }) => {
      const [px, py] = proj(x, y);
      const ms = c.match_status;
      let color = c.feasible ? "#6ea8ff" : "#4a5575";
      if (FAILED_STATES.includes(ms)) color = "#ff6b6b";
      if (ms === "AWAITING_CONFIRMATION") color = "#ffb547";
      if (ms === "ACCEPTED") color = "#3ddc97";
      if (ms === "ACCEPTED" || ms === "AWAITING_CONFIRMATION")
        html += `<line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" stroke="${color}" stroke-width="2" ${ms === "AWAITING_CONFIRMATION" ? 'stroke-dasharray="5 4"' : ""}/>`;
      html += `<circle cx="${px}" cy="${py}" r="${ms === "ACCEPTED" ? 7 : 5}" fill="${color}" opacity="${c.feasible || ms ? 1 : .6}"><title>${esc(c.name)} — ${c.metrics.distance_km} km</title></circle>`;
      if (ms === "ACCEPTED" || ms === "AWAITING_CONFIRMATION" || ((ms === "REJECTED" || ms === "UNAVAILABLE" || ms === "NO_RESPONSE")))
        html += `<text x="${px + 8}" y="${py + 3}" fill="#aab4cc" font-size="9">${esc(c.name.split(" ")[0])}</text>`;
    });
    html += `<circle cx="${cx}" cy="${cy}" r="8" fill="#f5c96a"/><text x="${cx}" y="${cy + 3}" text-anchor="middle" font-size="9" fill="#1b1404">R</text>`;
    svg.innerHTML = html;
  }

  function renderResult(v) {
    const r = v.result;
    if (!r || !TERMINAL.includes(v.status)) { $("resultCard").classList.add("hidden"); return; }
    $("resultCard").classList.remove("hidden");
    const cls = r.status === "MATCHED" ? "ok" : r.status === "PARTIALLY_MATCHED" || r.status === "NEEDS_INFORMATION" ? "warn" : "bad";
    const sel = r.selected_ngos.map((s) => `<li><b>${esc(s.name)}</b> — ${s.allocated_quantity} meals (score ${Math.round(s.match_score)}, ~${Math.round(s.estimated_travel_minutes)} min)</li>`).join("");
    const attempts = r.attempts.map((a) => `<li>${esc(a.name || a.ngo_id)}: ${esc(a.outcome)}${a.reason ? " — " + esc(a.reason) : ""}</li>`).join("");
    const h = r.logistics_handoff;
    $("resultBody").innerHTML = `<div class="result-grid">
      <div class="rbox"><h4>Outcome</h4><div class="rbig ${cls}">${esc(r.status.replace(/_/g, " "))}</div>
        <div class="muted small">Strategy: ${esc(r.strategy.replace(/_/g, " "))} · ${r.allocated_quantity}/${r.total_quantity ?? "?"} meals placed</div></div>
      <div class="rbox"><h4>Selected NGOs</h4>${sel ? `<ul class="rlist">${sel}</ul>` : `<div class="muted">None</div>`}</div>
      <div class="rbox"><h4>Confirmation attempts</h4>${attempts ? `<ul class="rlist">${attempts}</ul>` : `<div class="muted">None</div>`}</div>
      <div class="rbox"><h4>Next action</h4><div class="rbig" style="font-size:15px">${esc(r.next_action.replace(/_/g, " "))}</div>
        ${h ? `<div class="muted small">Logistics hand-off: pickup at ${esc(h.pickup.restaurant_name || h.pickup.restaurant_id)}, ${h.dropoffs.length} drop-off(s), deliver by ${new Date(h.deliver_by).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>` : ""}
        ${r.missing_fields?.length ? `<div class="muted small">Missing: ${esc(r.missing_fields.join(", "))}</div>` : ""}</div>
    </div>`;
  }

  $("downloadJson").onclick = () => {
    if (!view?.result) return;
    const blob = new Blob([JSON.stringify(view.result, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${view.result.match_id}.json`;
    a.click();
  };

  boot();
})();
