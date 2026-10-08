/* LUNA restaurant page. Intentionally dumb: it submits the form and shows plain-language progress.
   No agent reasoning, tool calls, JSON or internals are ever rendered here. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FIELDS = ["food_name", "food_category", "quantity", "prepared_at", "storage_method", "storage_temperature"];
  const DEFAULT_TEMP = { refrigerated: 4, hot_held: 65, room_temp: 25, frozen: -18 };
  let imageDataUrl = null, timer = null;

  // ---- defaults
  function localNow(minusMin = 0) {
    const d = new Date(Date.now() - minusMin * 60000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  $("prepared_at").value = localNow(90);
  $("storage_method").onchange = () => { $("storage_temperature").value = DEFAULT_TEMP[$("storage_method").value]; };

  fetch("/api/luna/info").then((r) => r.json()).then((i) => {
    const b = $("modeBadge");
    b.textContent = i.mode === "DEMO" ? "DEMO MODE" : "LIVE";
    b.classList.toggle("live", i.mode !== "DEMO");
    b.classList.remove("hidden");
    b.title = i.mode === "DEMO" ? "Demo: simulated NGO partners" : "Live";
  }).catch(() => {});

  // ---- image: pick / drop / resize
  const drop = $("drop");
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("image").click(); } });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) loadImage(f); });
  $("image").onchange = (e) => { const f = e.target.files[0]; if (f) loadImage(f); };

  function loadImage(file) {
    $("err-image").textContent = "";
    drop.classList.remove("invalid");
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { setErr("image", "Please choose a JPEG, PNG or WebP photo."); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1280, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      imageDataUrl = c.toDataURL("image/jpeg", 0.85);
      $("preview").src = imageDataUrl;
      $("preview").classList.remove("hidden");
      $("dropEmpty").classList.add("hidden");
      URL.revokeObjectURL(url);
    };
    img.onerror = () => setErr("image", "That image could not be read. Please try another photo.");
    img.src = url;
  }

  // ---- validation helpers
  function setErr(field, msg) {
    const el = $("err-" + field);
    if (el) el.textContent = msg || "";
    if (field === "image") drop.classList.toggle("invalid", !!msg);
    else if ($(field)) $(field).classList.toggle("invalid", !!msg);
  }
  function clearErrors() { ["image", ...FIELDS, "form"].forEach((f) => setErr(f, "")); }

  function validate() {
    const e = {};
    if (!imageDataUrl) e.image = "Please add a photo of the food.";
    if (!$("food_name").value.trim()) e.food_name = "Please tell us what the food is.";
    const q = parseFloat($("quantity").value);
    if (!(q >= 1 && q <= 5000)) e.quantity = "Please enter how many portions (1–5000).";
    if (!$("prepared_at").value) e.prepared_at = "Please enter when the food was prepared.";
    else if (new Date($("prepared_at").value) > new Date(Date.now() + 5 * 60000)) e.prepared_at = "Preparation time can't be in the future.";
    if ($("storage_temperature").value === "" || isNaN(parseFloat($("storage_temperature").value))) e.storage_temperature = "Please enter the storage temperature in °C.";
    return e;
  }

  // ---- submit
  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearErrors();
    const errs = validate();
    if (Object.keys(errs).length) {
      Object.entries(errs).forEach(([k, v]) => setErr(k, v));
      const first = document.querySelector(".invalid, #drop.invalid");
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    $("submit").disabled = true;
    const body = {
      image: imageDataUrl, food_name: $("food_name").value.trim(), food_category: $("food_category").value,
      quantity: parseFloat($("quantity").value), prepared_at: new Date($("prepared_at").value).toISOString(),
      storage_method: $("storage_method").value, storage_temperature: parseFloat($("storage_temperature").value),
      ingredients: $("ingredients").value, allergens: $("allergens").value,
    };
    try {
      const r = await fetch("/api/luna/submissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 422 && j.errors) { Object.entries(j.errors).forEach(([k, v]) => setErr(k, v)); $("submit").disabled = false; return; }
      if (!r.ok) throw new Error();
      showResult(); poll(j.submission_id);
    } catch {
      setErr("form", "We couldn't reach Luna. Please check your connection and try again.");
      $("submit").disabled = false;
    }
  });

  function showResult() {
    $("form").classList.add("hidden");
    $("result").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
    render({ headline: "Analyzing your food…", message: "We're checking the photo and details.", done: false, stage: "ANALYZING_FOOD",
      steps: [["food", "Food checked", "active"], ["approved", "Approved for rescue", "pending"], ["ngo_found", "NGO found", "pending"], ["ngo_confirmed", "NGO confirmed", "pending"]]
        .map(([key, label, state]) => ({ key, label, state })), ngos: [], rescue_score: null });
  }

  function poll(id) {
    let fails = 0;
    clearInterval(timer);
    timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/luna/submissions/${id}`);
        if (!r.ok) throw new Error();
        fails = 0;
        const v = await r.json();
        render(v);
        if (v.done) clearInterval(timer);
      } catch {
        if (++fails > 20) { clearInterval(timer); render({ headline: "Something went wrong", message: "We lost the connection. Please try again.", done: true, stage: "ERROR", steps: [], ngos: [] }); }
      }
    }, 700);
  }

  const ICONS = { MATCHED: "🌙", PARTIAL: "🌓", NOT_ELIGIBLE: "🚫", NEEDS_REVIEW: "🔍", NO_NGO: "⏳", ERROR: "⚠️" };
  function render(v) {
    $("headline").textContent = v.headline;
    $("message").textContent = v.message || "";
    const icon = $("resultIcon");
    icon.textContent = ICONS[v.stage] || "🌙";
    icon.classList.toggle("spin", !v.done);
    $("steps").innerHTML = (v.steps || []).map((s) =>
      `<li class="${s.state}"><span class="dot">${s.state === "done" ? "✓" : s.state === "failed" ? "✕" : ""}</span>${esc(s.label)}</li>`).join("");
    const nb = $("ngoBox");
    if (v.ngos && v.ngos.length) {
      nb.innerHTML = v.ngos.map((n) => `<div class="ngo-row"><b>${esc(n.name)}</b><span>${n.portions} portions · about ${n.eta_minutes} min away</span></div>`).join("");
      nb.classList.remove("hidden");
    } else nb.classList.add("hidden");
    const sb = $("scoreBox");
    if (v.rescue_score != null) { $("score").textContent = v.rescue_score; sb.classList.remove("hidden"); } else sb.classList.add("hidden");
    $("again").classList.toggle("hidden", !v.done);
  }

  $("again").onclick = () => {
    clearInterval(timer);
    $("result").classList.add("hidden");
    $("form").classList.remove("hidden");
    $("form").reset();
    $("prepared_at").value = localNow(90);
    $("storage_temperature").value = 4;
    $("quantity").value = 80;
    imageDataUrl = null;
    $("preview").classList.add("hidden");
    $("dropEmpty").classList.remove("hidden");
    $("submit").disabled = false;
    clearErrors();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
})();
