/* ============================================================
   survey.js — logic only; edit experiment content in config.js.

   Principle: "randomize the presentation, keep the record deterministic"
   1) participant ID → seed → question order & side assignment fully reproducible
   2) triple-redundant ground truth per response row:
      ours_side flag / resolved values / actual A·B filenames
   3) a manifest row (full assignment table) is logged at start
   ============================================================ */
(function () {
  "use strict";
  const C = window.SURVEY_CONFIG;

  /* ---------- deterministic RNG ---------- */
  function hashString(s) { // FNV-1a 32bit
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededShuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------- pair construction (pure data, no randomness) ---------- */
  function videoUrl(base, prompt, method) {
    return C.video_url
      .replace("{base}", base).replace("{prompt}", prompt).replace("{method}", method);
  }
  function buildPairs() {
    const pairs = [];
    for (const b of C.bases) {
      for (const p of b.prompts) {
        for (const m of C.baselines) {
          pairs.push({
            pair_id: `${b.id}__${p}__${m}`,
            base: b.id, base_label: b.label,
            prompt: p, baseline: m,
            ours_file: videoUrl(b.id, p, C.ours_id),
            baseline_file: videoUrl(b.id, p, m)
          });
        }
      }
    }
    return pairs;
  }

  /* ---------- state ---------- */
  let participant = "", seed = 0, assignment = [], idx = 0;
  let results = [], sendQueue = [], failCount = 0;
  let watchedA = false, watchedB = false, tStart = 0;

  const $ = (id) => document.getElementById(id);

  /* ---------- assignment: fully reproducible from participant ID ----------
     Ordering = round-robin rotation, not a pure shuffle:
     pairs are grouped into cells (base×prompt, i.e., same source videos).
     Each round shows every cell exactly once, so two questions sharing the
     same cell are always exactly (#cells) apart — the same videos reappear
     as late and as evenly as possible. Cell order (fixed across rounds) and
     the baseline order within each cell are seeded-shuffled per participant. */
  function makeAssignment(pid) {
    seed = hashString(C.study_id + "::" + pid);
    const rng = mulberry32(seed);
    const cells = new Map();
    for (const p of buildPairs()) {
      const k = p.base + "/" + p.prompt;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(p);
    }
    const cellOrder = seededShuffle([...cells.keys()], rng);
    const rotated = new Map();
    for (const k of cellOrder) rotated.set(k, seededShuffle(cells.get(k), rng));
    const rounds = Math.max(...[...cells.values()].map(v => v.length));
    const ordered = [];
    for (let r = 0; r < rounds; r++)
      for (const k of cellOrder)
        if (rotated.get(k)[r]) ordered.push(rotated.get(k)[r]);
    return ordered.map((p, i) => {
      const ours_side = rng() < 0.5 ? "A" : "B";
      return {
        ...p,
        position: i + 1,
        ours_side,
        video_a_file: ours_side === "A" ? p.ours_file : p.baseline_file,
        video_b_file: ours_side === "B" ? p.ours_file : p.baseline_file
      };
    });
  }

  /* ---------- logging ---------- */
  function post(record) {
    results.push(record);
    if (!C.endpoint) return;
    const body = JSON.stringify(record);
    fetch(C.endpoint, { method: "POST", mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, body })
      .catch(() => { failCount++; sendQueue.push(record); });
  }
  function logManifest() {
    post({
      type: "manifest", study_id: C.study_id,
      participant, seed, ts: new Date().toISOString(),
      assignment: assignment.map(a => ({
        position: a.position, pair_id: a.pair_id, ours_side: a.ours_side,
        video_a_file: a.video_a_file, video_b_file: a.video_b_file
      }))
    });
  }

  /* ---------- UI: entry ---------- */
  $("totalPairs").textContent = buildPairs().length;
  $("startBtn").addEventListener("click", () => {
    // 이메일을 참가자 ID로 사용: 정규화(공백 제거+소문자)로 표기 편차에 의한
    // 시드/중복 문제를 방지하고, 간단한 형식 검증을 거친다.
    const pid = $("pid").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pid)) {
      $("pidError").classList.remove("hidden"); $("pid").focus(); return;
    }
    $("pidError").classList.add("hidden");
    participant = pid;
    assignment = makeAssignment(pid);
    logManifest();
    $("entry").classList.add("hidden");
    $("question").classList.remove("hidden");
    renderAxes();
    showPair(0);
  });

  /* ---------- UI: axes (compact rows, segmented A/B) ---------- */
  function renderAxes() {
    $("axes").innerHTML = C.axes.map(ax => `
      <div class="axis" role="radiogroup" aria-label="${ax.label}">
        <div class="ax-info">
          <div class="name">${ax.label}</div>
          <div class="q">${ax.question}</div>
        </div>
        <div class="opts">
          <label><input type="radio" name="ax_${ax.id}" value="A" disabled>A</label>
          <label><input type="radio" name="ax_${ax.id}" value="B" disabled>B</label>
        </div>
      </div>`).join("");
    $("axes").addEventListener("change", updateSubmitState);
  }
  function setAxesEnabled(on) {
    document.querySelectorAll('#axes input[type=radio]').forEach(r => { r.disabled = !on; });
  }
  function clearAxes() {
    document.querySelectorAll('#axes input[type=radio]').forEach(r => { r.checked = false; });
  }
  function readAxes() {
    const out = {};
    for (const ax of C.axes) {
      const sel = document.querySelector(`input[name=ax_${ax.id}]:checked`);
      if (!sel) return null;
      out[ax.id] = sel.value; // "A" | "B"
    }
    return out;
  }
  function updateSubmitState() {
    const complete = !!readAxes();
    const watched = watchedA && watchedB;
    $("submitBtn").disabled = !(complete && watched);
    $("submitHint").classList.toggle("hidden", complete || !watched);
  }

  /* ---------- UI: pair ---------- */
  const vidA = () => $("vidA"), vidB = () => $("vidB");
  function showPair(i) {
    idx = i;
    const a = assignment[i];
    $("qIdx").textContent = i + 1;
    $("qTotal").textContent = assignment.length;
    $("trackfill").style.width = `${(i / assignment.length) * 100}%`;
    $("progress").innerHTML = `<b>${i + 1}</b> / ${assignment.length} · ${participant}`;
    const pt = (C.prompt_texts || {})[`${a.base}/${a.prompt}`] || "";
    $("promptText").textContent = pt ? `“${pt}”` : "";

    loadWithRetry(vidA(), a.video_a_file, $("stateA"));
    loadWithRetry(vidB(), a.video_b_file, $("stateB"));
    watchedA = !C.require_full_watch;
    watchedB = !C.require_full_watch;
    $("watchNote").textContent = C.require_full_watch
      ? "Answers unlock after both videos have played to the end."
      : "Watch both videos, then answer below.";
    $("watchNote").classList.remove("done");
    clearAxes();
    setAxesEnabled(!C.require_full_watch);
    updateSubmitState();
    tStart = Date.now();
    window.scrollTo({ top: 0 });
  }
  /* HF CDN이 간헐적으로 503을 반환할 수 있어, 영상 로드 실패 시
     지수 백오프로 최대 3회 자동 재시도한다. */
  const MAX_RETRY = 3;
  function loadWithRetry(videoEl, url, stateEl) {
    videoEl._retries = 0;
    videoEl._srcUrl = url;
    videoEl.onerror = () => {
      if (videoEl._retries < MAX_RETRY) {
        videoEl._retries += 1;
        stateEl.textContent = `Retrying (${videoEl._retries}/${MAX_RETRY})…`;
        const delay = 1500 * videoEl._retries;
        setTimeout(() => {
          videoEl.src = url + (url.includes("?") ? "&" : "?") + "r=" + videoEl._retries;
          videoEl.load();
        }, delay);
      } else {
        stateEl.textContent = "Load failed";
        $("watchNote").textContent =
          "A video failed to load after several retries — press \"Replay from start\" to try again, or reload the page.";
      }
    };
    videoEl.onloadeddata = () => { stateEl.textContent = "Ready"; };
    stateEl.textContent = "Loading…";
    videoEl.src = url;
    videoEl.load();
  }

  function markWatched(which) {
    if (which === "A") { watchedA = true; $("stateA").textContent = "Watched ✓"; }
    else { watchedB = true; $("stateB").textContent = "Watched ✓"; }
    if (watchedA && watchedB) {
      setAxesEnabled(true);
      $("watchNote").textContent = "Both videos watched — please answer below. (Replay anytime.)";
      $("watchNote").classList.add("done");
    }
    updateSubmitState();
  }
  $("vidA").addEventListener("ended", () => markWatched("A"));
  $("vidB").addEventListener("ended", () => markWatched("B"));
  $("playBtn").addEventListener("click", () => {
    vidA().play(); vidB().play();
    if ($("stateA").textContent === "Ready") $("stateA").textContent = "Playing";
    if ($("stateB").textContent === "Ready") $("stateB").textContent = "Playing";
  });
  $("replayBtn").addEventListener("click", () => {
    for (const [v, st] of [[vidA(), $("stateA")], [vidB(), $("stateB")]]) {
      if (v.error || st.textContent === "Load failed") {
        loadWithRetry(v, v._srcUrl, st);          // 실패한 쪽은 처음부터 재로드
      } else {
        v.currentTime = 0; v.play();
      }
    }
  });

  /* ---------- submit (once per pair) ---------- */
  $("submitBtn").addEventListener("click", () => {
    const raw = readAxes();
    if (!raw) return;
    const a = assignment[idx];
    const rec = {
      type: "response", study_id: C.study_id,
      participant, seed, ts: new Date().toISOString(),
      position: a.position, pair_id: a.pair_id,
      base: a.base, prompt: a.prompt, baseline: a.baseline,
      ours_side: a.ours_side,
      video_a_file: a.video_a_file, video_b_file: a.video_b_file,
      elapsed_ms: Date.now() - tStart
    };
    for (const ax of C.axes) {
      rec[`${ax.id}_raw`] = raw[ax.id];                                   // "A"|"B"
      rec[`${ax.id}_resolved`] = raw[ax.id] === a.ours_side ? "ours" : "baseline";
    }
    post(rec);
    if (idx + 1 < assignment.length) showPair(idx + 1);
    else finish();
  });

  /* ---------- done ---------- */
  function finish() {
    $("question").classList.add("hidden");
    $("done").classList.remove("hidden");
    $("trackfill").style.width = "100%";
    $("progress").innerHTML = `Done · ${participant}`;
    $("doneCount").textContent = results.filter(r => r.type === "response").length;
    if (C.endpoint && !failCount) {
      // normal path: everything uploaded, no backup step for participants
      $("sendstate").textContent = "All responses uploaded successfully.";
    } else {
      // fallback only: no endpoint configured, or some uploads failed
      $("sendstate").textContent = C.endpoint
        ? `${failCount} upload(s) failed — please press Retry, then download the backup and send it to the organizer.`
        : "No server configured — please download the backup and send it to the organizer.";
      $("dlBtn").classList.remove("hidden");
      if (failCount) $("retryBtn").classList.remove("hidden");
    }
  }
  $("dlBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${C.study_id}_${participant}.json`;
    a.click();
  });
  $("retryBtn").addEventListener("click", () => {
    const q = sendQueue.splice(0); failCount = 0;
    q.forEach(r => post(r));
    $("sendstate").textContent = "Retry attempted. If this message persists, please send the JSON backup.";
  });

  /* warn before leaving mid-survey */
  window.addEventListener("beforeunload", (e) => {
    if (results.length && $("done").classList.contains("hidden")) {
      e.preventDefault(); e.returnValue = "";
    }
  });
})();
