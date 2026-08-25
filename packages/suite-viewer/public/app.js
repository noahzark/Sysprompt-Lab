/* global document, fetch, confirm */
(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    path: "",
    mtimeMs: 0,
    overview: null,
    cases: [],
    nsfwTags: [],
    selectedId: null,
    detail: null,
    nsfw: false,
    run: null,
    runs: [],
  };

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
    );
  }

  function shortText(text, max = 72) {
    const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
    if (collapsed.length <= max) {
      return collapsed;
    }
    return `${collapsed.slice(0, max - 1)}…`;
  }

  function predictionStatus(item) {
    return item?.prediction?.status || "none";
  }

  function statusLabel(status) {
    if (status === "ok") {
      return "OK";
    }
    if (status === "miss") {
      return "MISS";
    }
    if (status === "error") {
      return "ERROR";
    }
    return "—";
  }

  function setStatus(text, kind) {
    const el = $("status");
    el.textContent = text ?? "";
    el.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function goldToText(gold) {
    if (gold === undefined || gold === null) {
      return "";
    }
    if (typeof gold === "string") {
      return gold;
    }
    return JSON.stringify(gold, null, 2);
  }

  function parseGoldInput(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === "null") {
      return undefined;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }

  function nsfwGoldFromPickers() {
    const severity = document.querySelector("#severity-picker input:checked")?.value;
    const accept = [...document.querySelectorAll("#accept-picker input:checked")].map((el) => el.value);
    if (!severity && accept.length === 0) {
      return undefined;
    }
    const gold = {};
    if (severity) {
      gold.severity = severity;
    }
    if (accept.length > 0) {
      gold.accept = accept;
    }
    return gold;
  }

  function applyPickersToGold() {
    if (!state.nsfw) {
      return;
    }
    $("gold-json").value = goldToText(nsfwGoldFromPickers());
  }

  function applyGoldToPickers(gold) {
    const accept = new Set();
    let severity = "";
    if (typeof gold === "string") {
      severity = gold;
      accept.add(gold);
    } else if (gold && typeof gold === "object") {
      if (typeof gold.severity === "string") {
        severity = gold.severity;
      } else if (Array.isArray(gold.severity) && gold.severity[0]) {
        severity = gold.severity[0];
      }
      const list = Array.isArray(gold.accept)
        ? gold.accept
        : Array.isArray(gold.severity)
          ? gold.severity
          : severity
            ? [severity]
            : [];
      for (const item of list) {
        if (typeof item === "string") {
          accept.add(item);
        }
      }
    }
    for (const input of document.querySelectorAll("#severity-picker input")) {
      input.checked = input.value === severity;
    }
    for (const input of document.querySelectorAll("#accept-picker input")) {
      input.checked = accept.has(input.value);
    }
  }

  function renderPickers() {
    const sev = $("severity-picker");
    const acc = $("accept-picker");
    sev.innerHTML = "";
    acc.innerHTML = "";
    const none = document.createElement("label");
    none.innerHTML = `<input type="radio" name="severity" value="" /> unlabeled`;
    sev.appendChild(none);
    for (const tag of state.nsfwTags) {
      const radio = document.createElement("label");
      radio.innerHTML = `<input type="radio" name="severity" value="${tag}" /> ${tag}`;
      sev.appendChild(radio);
      const box = document.createElement("label");
      box.innerHTML = `<input type="checkbox" value="${tag}" /> ${tag}`;
      acc.appendChild(box);
    }
  }

  $("severity-picker").addEventListener("change", applyPickersToGold);
  $("accept-picker").addEventListener("change", applyPickersToGold);

  function renderChips() {
    const o = state.overview;
    if (!o) {
      $("chips").innerHTML = "";
      return;
    }
    const chips = [
      `${o.id}`,
      o.name,
      `metric ${o.metricId}`,
      `train ${o.trainSize}`,
      `val ${o.valSize}`,
      `unlabeled ${o.unlabeledCount}`,
      `missing images ${o.missingImageCount}`,
    ];
    for (const [key, count] of Object.entries(o.goldHistogram)) {
      chips.push(`${key} ×${count}`);
    }
    const run = state.run;
    if (run && !run.error) {
      if (run.model) {
        chips.push(run.model);
      }
      if (typeof run.meanQuality === "number") {
        chips.push(`run ${run.meanQuality.toFixed(3)}`);
      }
      chips.push(`OK ${run.hitCount ?? 0}`);
      chips.push(`MISS ${run.missCount ?? 0}`);
      if (run.errorCount) {
        chips.push(`errors ${run.errorCount}`);
      }
    }
    $("chips").innerHTML = chips
      .map((text, i) => `<span class="chip${i === 6 && o.missingImageCount ? " warn" : ""}">${esc(text)}</span>`)
      .join("");
  }

  function applySuiteBody(body) {
    state.path = body.path;
    state.mtimeMs = body.mtimeMs;
    state.overview = body.overview;
    state.cases = body.cases;
    state.nsfwTags = body.nsfwTags ?? [];
    state.nsfw = Boolean(body.overview?.nsfw);
    state.run = body.run ?? null;
    state.runs = body.runs ?? [];
    $("suite-path").textContent = body.path;
    $("suite-path").title = body.path;
    document.title = `${body.overview.id} — Suite Viewer`;
    renderPickers();
    renderChips();
    fillSeverityFilter();
    renderRunBar();
    renderList();
  }

  function renderRunBar() {
    const input = $("run-path");
    const meta = $("run-meta");
    const select = $("run-select");
    const wrap = $("run-select-wrap");
    if (document.activeElement !== input) {
      input.value = state.run?.path || "";
    }
    if (state.run?.error) {
      meta.textContent = state.run.error;
      meta.className = "run-meta status err";
    } else if (state.run?.path) {
      const bits = [state.run.kind, state.run.model, typeof state.run.meanQuality === "number" ? state.run.meanQuality.toFixed(3) : ""]
        .filter(Boolean);
      meta.textContent = bits.join(" · ");
      meta.className = "run-meta";
    } else {
      meta.textContent = "No run attached";
      meta.className = "run-meta";
    }
    if (state.runs.length > 0) {
      wrap.hidden = false;
      const current = state.run?.path || "";
      select.innerHTML = [`<option value="">— select —</option>`]
        .concat(
          state.runs.map(
            (item) =>
              `<option value="${esc(item.path)}"${item.path === current ? " selected" : ""}>${esc(item.label)}</option>`,
          ),
        )
        .join("");
    } else {
      wrap.hidden = true;
      select.innerHTML = "";
    }
  }

  function fillSeverityFilter() {
    const select = $("filter-severity");
    const current = select.value || "all";
    const keys = new Set(["all"]);
    for (const item of state.cases) {
      keys.add(item.unlabeled ? "(unlabeled)" : item.severity || item.goldLabel);
    }
    select.innerHTML = [...keys]
      .map((key) => `<option value="${key}">${key}</option>`)
      .join("");
    select.value = keys.has(current) ? current : "all";
  }

  function filteredCases() {
    const split = $("filter-split").value;
    const severity = $("filter-severity").value;
    const unlabeledOnly = $("filter-unlabeled").checked;
    const missesOnly = $("filter-misses").checked;
    return state.cases.filter((item) => {
      if (split !== "all" && item.split !== split) {
        return false;
      }
      if (unlabeledOnly && !item.unlabeled) {
        return false;
      }
      if (missesOnly) {
        const status = predictionStatus(item);
        if (status !== "miss" && status !== "error") {
          return false;
        }
      }
      if (severity !== "all") {
        const key = item.unlabeled ? "(unlabeled)" : item.severity || item.goldLabel;
        if (key !== severity) {
          return false;
        }
      }
      return true;
    });
  }

  function renderList() {
    const list = $("case-list");
    list.innerHTML = "";
    for (const item of filteredCases()) {
      const li = document.createElement("li");
      li.dataset.id = item.id;
      if (item.id === state.selectedId) {
        li.classList.add("active");
      }
      const img = item.hasImage
        ? item.imageResolved
          ? `<span class="chip">image</span>`
          : `<span class="chip warn">missing image</span>`
        : "";
      const pred = item.prediction;
      const status = pred?.status || "";
      const statusChip =
        state.run && !state.run.error && status
          ? `<span class="chip ${status}">${statusLabel(status)}</span>`
          : "";
      const predPreview =
        pred && pred.status !== "none"
          ? `<div class="preview">${esc(shortText(pred.predictedLabel ?? pred.output ?? pred.error ?? ""))}</div>`
          : "";
      li.innerHTML = `
        <strong>${esc(item.id)}</strong>
        <div class="meta">
          <span class="chip">${esc(item.split)}</span>
          <span class="chip">${esc(item.goldLabel)}</span>
          ${statusChip}
          ${img}
        </div>
        <div class="preview">${esc(item.preview || "")}</div>
        ${predPreview}`;
      li.addEventListener("click", () => selectCase(item.id));
      list.appendChild(li);
    }
  }

  async function loadSuite() {
    const res = await fetch("/api/suite");
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    applySuiteBody(body);
  }

  function renderTraj(detail) {
    const section = $("traj");
    const statusChip = $("traj-status");
    const pred = detail?.prediction;
    if (!state.run || state.run.error) {
      section.hidden = true;
      statusChip.hidden = true;
      return;
    }
    section.hidden = false;
    statusChip.hidden = false;
    const status = pred?.status || "none";
    statusChip.textContent = statusLabel(status);
    statusChip.className = `chip ${status}`;
    $("traj-gold").textContent = goldToText(detail.gold);
    if (!pred || status === "none") {
      $("traj-pred").textContent = "(no prediction in this run)";
      $("traj-note").hidden = true;
      $("traj-reasoning").hidden = true;
      return;
    }
    const lines = [];
    if (state.nsfw && pred.predictedLabel) {
      lines.push(pred.predictedLabel);
      if (pred.output && pred.output !== pred.predictedLabel) {
        lines.push(pred.output);
      }
    } else if (pred.output !== undefined) {
      lines.push(pred.output);
    } else if (pred.error) {
      lines.push(pred.error);
    } else {
      lines.push("(no output)");
    }
    $("traj-pred").textContent = lines.join("\n\n");
    const note = pred.note || pred.error || "";
    $("traj-note").hidden = !note;
    $("traj-note").textContent = note;
    const hasReasoning = Boolean(pred.reasoning || pred.finish_reason || pred.reasoning_tokens !== undefined);
    $("traj-reasoning").hidden = !hasReasoning;
    if (hasReasoning) {
      $("traj-finish-wrap").hidden = !pred.finish_reason;
      $("traj-finish").textContent = pred.finish_reason || "";
      $("traj-tokens-wrap").hidden = pred.reasoning_tokens === undefined;
      $("traj-tokens").textContent = pred.reasoning_tokens === undefined ? "" : String(pred.reasoning_tokens);
      $("traj-reasoning-text").textContent = pred.reasoning || "";
      $("traj-reasoning-text").hidden = !pred.reasoning;
    }
  }

  async function selectCase(id) {
    state.selectedId = id;
    renderList();
    const res = await fetch(`/api/cases/${encodeURIComponent(id)}`);
    const body = await res.json();
    if (!res.ok) {
      setStatus(body.error || `HTTP ${res.status}`, "err");
      return;
    }
    state.detail = body.case;
    state.nsfw = Boolean(body.nsfw);
    state.mtimeMs = body.mtimeMs;
    $("empty-detail").hidden = true;
    $("detail").hidden = false;
    $("case-id").textContent = body.case.id;
    $("case-split").textContent = body.case.split;
    $("user-text").textContent = body.case.userText || "";
    $("gold-json").value = goldToText(body.case.gold);
    $("notes").value = body.case.notes || "";
    renderTraj(body.case);
    $("nsfw-controls").hidden = !state.nsfw;
    if (state.nsfw) {
      applyGoldToPickers(body.case.gold);
    }
    const imgChip = $("case-image-chip");
    const wrap = $("image-wrap");
    const img = $("case-image");
    const missing = $("image-missing");
    if (body.case.hasImage && body.case.imageResolved) {
      imgChip.hidden = false;
      imgChip.textContent = "image";
      wrap.hidden = false;
      missing.hidden = true;
      img.alt = `Image for ${body.case.id}`;
      if (body.case.imageRemote && body.case.imageRef) {
        img.src = body.case.imageRef;
      } else {
        img.src = `/api/cases/${encodeURIComponent(id)}/image?t=${Date.now()}`;
      }
      $("image-caption").textContent = body.case.imageRef || "";
    } else if (body.case.hasImage) {
      imgChip.hidden = false;
      imgChip.textContent = "missing image";
      wrap.hidden = true;
      img.removeAttribute("src");
      missing.hidden = false;
    } else {
      imgChip.hidden = true;
      wrap.hidden = true;
      img.removeAttribute("src");
      missing.hidden = true;
    }
    setStatus("");
  }

  async function save(force = false) {
    if (!state.selectedId) {
      return;
    }
    const gold = state.nsfw ? nsfwGoldFromPickers() : parseGoldInput($("gold-json").value);
    const notes = $("notes").value;
    const res = await fetch(`/api/cases/${encodeURIComponent(state.selectedId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gold,
        notes,
        expectedMtimeMs: state.mtimeMs,
        force,
      }),
    });
    const body = await res.json();
    if (res.status === 409 && body.conflict && !force) {
      const ok = confirm("Suite file changed on disk. Overwrite with this case's gold and notes?");
      if (ok) {
        await save(true);
      } else {
        setStatus("Save cancelled — file changed on disk.", "err");
      }
      return;
    }
    if (!res.ok) {
      setStatus(body.error || `HTTP ${res.status}`, "err");
      return;
    }
    state.mtimeMs = body.mtimeMs;
    applySuiteBody(body.suite);
    setStatus("Saved. Suite file only — run overlay unchanged.", "ok");
  }

  async function loadRun(path) {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path || "" }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    applySuiteBody(body);
    if (state.selectedId) {
      await selectCase(state.selectedId);
    }
  }

  $("reload").addEventListener("click", async () => {
    try {
      await loadSuite();
      if (state.selectedId) {
        await selectCase(state.selectedId);
      }
      setStatus("Reloaded.", "ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "err");
    }
  });
  $("filter-split").addEventListener("change", renderList);
  $("filter-severity").addEventListener("change", renderList);
  $("filter-unlabeled").addEventListener("change", renderList);
  $("filter-misses").addEventListener("change", renderList);
  $("load-run").addEventListener("click", async () => {
    try {
      await loadRun($("run-path").value.trim());
      setStatus($("run-path").value.trim() ? "Loaded run overlay." : "Cleared run overlay.", "ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "err");
    }
  });
  $("clear-run").addEventListener("click", async () => {
    try {
      $("run-path").value = "";
      await loadRun("");
      setStatus("Cleared run overlay.", "ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "err");
    }
  });
  $("run-select").addEventListener("change", async () => {
    const path = $("run-select").value;
    if (!path) {
      return;
    }
    try {
      $("run-path").value = path;
      await loadRun(path);
      setStatus("Loaded run overlay.", "ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "err");
    }
  });
  $("run-path").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      $("load-run").click();
    }
  });
  $("save").addEventListener("click", () => {
    void save(false);
  });
  $("gold-json").addEventListener("change", () => {
    if (state.nsfw) {
      applyGoldToPickers(parseGoldInput($("gold-json").value));
    }
  });

  loadSuite().catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error), "err");
  });
})();
