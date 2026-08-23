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
  };

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
    $("chips").innerHTML = chips
      .map((text, i) => `<span class="chip${i === 6 && o.missingImageCount ? " warn" : ""}">${text}</span>`)
      .join("");
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
    return state.cases.filter((item) => {
      if (split !== "all" && item.split !== split) {
        return false;
      }
      if (unlabeledOnly && !item.unlabeled) {
        return false;
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
      li.innerHTML = `
        <strong>${item.id}</strong>
        <div class="meta">
          <span class="chip">${item.split}</span>
          <span class="chip">${item.goldLabel}</span>
          ${img}
        </div>
        <div class="preview">${item.preview || ""}</div>`;
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
    state.path = body.path;
    state.mtimeMs = body.mtimeMs;
    state.overview = body.overview;
    state.cases = body.cases;
    state.nsfwTags = body.nsfwTags ?? [];
    state.nsfw = Boolean(body.overview?.nsfw);
    $("suite-path").textContent = body.path;
    $("suite-path").title = body.path;
    document.title = `${body.overview.id} — Suite Viewer`;
    renderPickers();
    renderChips();
    fillSeverityFilter();
    renderList();
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
    state.overview = body.suite.overview;
    state.cases = body.suite.cases;
    renderChips();
    fillSeverityFilter();
    renderList();
    setStatus("Saved.", "ok");
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
