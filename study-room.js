(() => {
  const apiBase = String(window.STUDY_RESOURCE_API_BASE || "").replace(/\/$/, "");
  const $ = (selector) => document.querySelector(selector);
  const storage = { get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }, set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} } };
  const roomKey = "study-room-profile-v2";
  const focusKey = "study-room-focus-v1";
  const profile = storage.get(roomKey, { id: "", examType: "公务员", stage: "基础", region: "未选择", task: "刷题", seatId: "" });
  if (!profile.id) profile.id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!profile.seatId) profile.seatId = "";
  let duration = 25 * 60, remaining = duration, running = false, timer = 0;
  const el = { time: $("#pomodoroTime"), status: $("#pomodoroStatus"), start: $("#pomodoroStart"), reset: $("#pomodoroReset"), task: $("#studyTask"), exam: $("#examType"), stage: $("#studyStage"), region: $("#studyRegion"), connection: $("#roomConnection"), seats: $("#classroomSeats"), seatNote: $("#seatSelectionNote"), seat: $("#studySeat") };
  [[el.task, "task"], [el.exam, "examType"], [el.stage, "stage"], [el.region, "region"]].forEach(([node, key]) => { node.value = profile[key]; node.addEventListener("change", () => { profile[key] = node.value; storage.set(roomKey, profile); reportPresence(); }); });
  el.seat?.addEventListener("change", async () => { const oldSeat = profile.seatId; profile.seatId = el.seat.value || ""; storage.set(roomKey, profile); const ok = await reportPresence(); if (!ok) { profile.seatId = oldSeat; storage.set(roomKey, profile); el.seat.value = oldSeat; reportPresence(); } });
  function todayKey() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }); }
  function focusCount() { const data = storage.get(focusKey, {}); return Number(data[todayKey()] || 0); }
  function renderFocusCount() { $("#todayFocusCount").textContent = `今日 ${focusCount()} 次`; }
  function renderTimer() { const minutes = String(Math.floor(remaining / 60)).padStart(2, "0"), seconds = String(remaining % 60).padStart(2, "0"); el.time.textContent = `${minutes}:${seconds}`; updateText("#referenceTimerMini", `${minutes}:${seconds}`); el.status.textContent = running ? "正在专注中" : remaining === duration ? "准备开始" : "已暂停"; el.start.textContent = running ? "暂停" : (remaining === duration ? "开始专注" : "继续专注"); document.title = running ? `${minutes}:${seconds}｜上岸自习室` : "上岸自习室｜学习资源库"; }
  function finishFocus() { running = false; clearInterval(timer); const data = storage.get(focusKey, {}); data[todayKey()] = focusCount() + 1; storage.set(focusKey, data); remaining = duration; renderFocusCount(); renderTimer(); reportPresence(); window.alert("这一轮专注完成，休息一下，再继续向上岸靠近。"); }
  function toggleTimer() { running = !running; if (running) timer = window.setInterval(() => { remaining -= 1; if (remaining <= 0) finishFocus(); else renderTimer(); }, 1000); else clearInterval(timer); renderTimer(); reportPresence(); }
  el.start.addEventListener("click", toggleTimer); el.reset.addEventListener("click", () => { running = false; clearInterval(timer); remaining = duration; renderTimer(); reportPresence(); });
  document.querySelectorAll("[data-minutes]").forEach((button) => button.addEventListener("click", () => { if (running) return; duration = Number(button.dataset.minutes) * 60; remaining = duration; document.querySelectorAll("[data-minutes]").forEach((item) => item.classList.toggle("is-active", item === button)); renderTimer(); }));

  const ambienceKey = "study-room-ambience-v2";
  const ambienceLabels = { rain: "雨声", cafe: "咖啡馆", waves: "海浪" };
  const ambience = { context: null, master: null, nodes: [], playing: false, muted: false, volume: Math.min(100, Math.max(0, Number(storage.get("study-room-noise-volume-v1", 28)) || 28)), scene: ambienceLabels[storage.get(ambienceKey, "rain")] ? storage.get(ambienceKey, "rain") : "rain" };
  const noiseEl = { toggle: $("#noiseToggle"), mute: $("#noiseMute"), volume: $("#noiseVolume"), output: $("#noiseVolumeValue"), status: $("#noiseStatus"), scenes: document.querySelectorAll("[data-ambience]") };
  function renderAmbience() {
    const value = Math.round(ambience.volume);
    if (noiseEl.volume) noiseEl.volume.value = String(value);
    if (noiseEl.output) noiseEl.output.textContent = `${value}%`;
    if (noiseEl.toggle) { noiseEl.toggle.textContent = ambience.playing ? "Ⅱ 暂停播放" : "▶ 开始播放"; noiseEl.toggle.setAttribute("aria-pressed", String(ambience.playing)); }
    if (noiseEl.status) noiseEl.status.textContent = ambience.playing ? `${ambienceLabels[ambience.scene]}播放中` : "已关闭";
    if (noiseEl.mute) { noiseEl.mute.textContent = ambience.muted ? "取消静音" : "静音"; noiseEl.mute.setAttribute("aria-pressed", String(ambience.muted)); }
    noiseEl.scenes.forEach((button) => { const active = button.dataset.ambience === ambience.scene; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
  }
  function applyAmbienceGain() { if (ambience.master) ambience.master.gain.value = ambience.muted ? 0 : ambience.volume / 100 * 0.32; }
  function makeNoiseBuffer(context, color = "white") {
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate), data = buffer.getChannelData(0); let brown = 0;
    for (let i = 0; i < data.length; i += 1) { const white = Math.random() * 2 - 1; brown = (brown + white * .06) / 1.06; data[i] = color === "brown" ? brown * 3.4 : white; }
    return buffer;
  }
  function addNoiseLayer(context, color, filterType, frequency, q, amount, destination = ambience.master) {
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain(); source.buffer = makeNoiseBuffer(context, color); source.loop = true; filter.type = filterType; filter.frequency.value = frequency; filter.Q.value = q; gain.gain.value = amount; source.connect(filter).connect(gain).connect(destination); source.start(); ambience.nodes.push(source, filter, gain); return gain;
  }
  function addMurmur(context, frequency, amount, phase) {
    const oscillator = context.createOscillator(), gain = context.createGain(), lfo = context.createOscillator(), lfoGain = context.createGain(); oscillator.type = "sine"; oscillator.frequency.value = frequency; gain.gain.value = amount; lfo.frequency.value = .07 + phase * .025; lfoGain.gain.value = amount * .7; lfo.connect(lfoGain).connect(gain.gain); oscillator.connect(gain).connect(ambience.master); oscillator.start(); lfo.start(); ambience.nodes.push(oscillator, gain, lfo, lfoGain);
  }
  function createAmbience() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("当前浏览器不支持环境声");
    ambience.context = ambience.context || new AudioContext(); ambience.master = ambience.context.createGain(); ambience.master.connect(ambience.context.destination); applyAmbienceGain();
    if (ambience.scene === "rain") { addNoiseLayer(ambience.context, "white", "bandpass", 2600, .45, .46); addNoiseLayer(ambience.context, "brown", "highpass", 480, .3, .08); }
    if (ambience.scene === "cafe") { addNoiseLayer(ambience.context, "brown", "bandpass", 640, .4, .17); addNoiseLayer(ambience.context, "white", "bandpass", 1500, .25, .055); [150, 205, 274].forEach((frequency, index) => addMurmur(ambience.context, frequency, .009, index)); }
    if (ambience.scene === "waves") { const swell = ambience.context.createGain(), lfo = ambience.context.createOscillator(), lfoGain = ambience.context.createGain(); swell.gain.value = .3; lfo.frequency.value = .075; lfoGain.gain.value = .2; lfo.connect(lfoGain).connect(swell.gain); swell.connect(ambience.master); lfo.start(); ambience.nodes.push(swell, lfo, lfoGain); addNoiseLayer(ambience.context, "brown", "lowpass", 620, .25, .78, swell); addNoiseLayer(ambience.context, "white", "bandpass", 1000, .22, .08, swell); }
  }
  function stopAmbience() { ambience.nodes.forEach((node) => { try { if (typeof node.stop === "function") node.stop(); } catch (_) {} try { node.disconnect(); } catch (_) {} }); ambience.nodes = []; ambience.master?.disconnect(); ambience.master = null; ambience.playing = false; }
  async function toggleAmbience() {
    if (ambience.playing) { stopAmbience(); renderAmbience(); return; }
    try { createAmbience(); if (ambience.context.state === "suspended") await ambience.context.resume(); ambience.playing = true; renderAmbience(); }
    catch (error) { if (noiseEl.status) noiseEl.status.textContent = error.message || "暂不支持"; if (noiseEl.toggle) noiseEl.toggle.disabled = true; }
  }
  noiseEl.toggle?.addEventListener("click", toggleAmbience);
  noiseEl.mute?.addEventListener("click", () => { ambience.muted = !ambience.muted; applyAmbienceGain(); renderAmbience(); });
  noiseEl.volume?.addEventListener("input", () => { ambience.volume = Number(noiseEl.volume.value); storage.set("study-room-noise-volume-v1", ambience.volume); applyAmbienceGain(); renderAmbience(); });
  noiseEl.scenes.forEach((button) => button.addEventListener("click", async () => { const nextScene = button.dataset.ambience; if (!ambienceLabels[nextScene] || nextScene === ambience.scene) return; const wasPlaying = ambience.playing; if (wasPlaying) stopAmbience(); ambience.scene = nextScene; storage.set(ambienceKey, nextScene); if (wasPlaying) { try { createAmbience(); if (ambience.context.state === "suspended") await ambience.context.resume(); ambience.playing = true; } catch (_) {} } renderAmbience(); }));
  renderAmbience();
  function updateText(id, value) { const node = $(id); if (node) node.textContent = String(value); }
  const seatRows = 6, seatColumns = 6, seatTotal = seatRows * seatColumns;
  const seatPortraits = ['assets/study-room-learner-clean-green-01-crop.png', 'assets/study-room-learner-clean-green-02-crop.png', 'assets/study-room-learner-clean-girl-03-crop.png', 'assets/study-room-learner-clean-boy-04-crop.png', 'assets/study-room-learner-clean-girl-05-crop.png'];
  function seatLabel(index) { return `${String.fromCharCode(65 + Math.floor(index / seatColumns))}${(index % seatColumns) + 1}`; }
  function seatTaskLabel(task) { return task === "安静自习" ? "自习中" : `${task}中`; }  function renderSeatOptions(seats = []) {
    if (!el.seat) return;
    const occupied = new Map((Array.isArray(seats) ? seats : []).map((item) => [item.seatId, item]));
    el.seat.innerHTML = `<option value="">暂不入座</option>` + Array.from({ length: seatTotal }, (_, index) => { const id = `seat-${index + 1}`, person = occupied.get(id), mine = profile.seatId === id; return `<option value="${id}" ${person && !mine ? "disabled" : ""}>${seatLabel(index)}${person && !mine ? "（已有人）" : ""}</option>`; }).join("");
    el.seat.value = profile.seatId || "";
  }
  function renderClassroomSeats(seats = []) {
    if (!el.seats) return;
    const occupied = new Map((Array.isArray(seats) ? seats : []).map((item) => [item.seatId, item]));
    renderSeatOptions(seats);
    el.seats.innerHTML = Array.from({ length: seatTotal }, (_, index) => {
      const seatId = `seat-${index + 1}`, mine = profile.seatId === seatId, person = occupied.get(seatId) || (mine ? { visitorId: profile.id, task: profile.task } : null);
      const status = person ? (mine ? seatTaskLabel(profile.task) : seatTaskLabel(person.task)) : "空座"; const label = seatLabel(index), portrait = seatPortraits[index % seatPortraits.length], portraitClass = `portrait-${(index % seatPortraits.length) + 1}`;
      return `<button type="button" class="classroom-seat ${person ? "is-occupied" : ""} ${mine ? "is-mine" : ""}" data-seat="${seatId}" aria-label="${label} 座位，${status}" ${person && !mine ? "disabled" : ""}><span class="seat-number">${label}</span><span class="seat-person"><img class="seat-portrait ${portraitClass}" src="${portrait}" alt="" aria-hidden="true" /></span><span class="seat-task">${status}</span></button>`;
    }).join("");
    el.seats.querySelectorAll("[data-seat]").forEach((button) => button.addEventListener("click", async () => {
      const oldSeat = profile.seatId;
      profile.seatId = button.dataset.seat || "";
      storage.set(roomKey, profile);
      const ok = await reportPresence();
      if (!ok) { profile.seatId = oldSeat; storage.set(roomKey, profile); reportPresence(); }
    }));
    if (el.seatNote && !el.seatNote.classList.contains("is-error")) el.seatNote.textContent = profile.seatId ? `你已入座 ${profile.seatId.replace("seat-", "") } 号位；离开页面 2 分钟后座位会自动释放。` : "请选择一个空座入座；离开页面 2 分钟后座位会自动释放。";
  }
  function renderPresence(data) {
    updateText("#studyRoomOnline", data.onlineCount ?? "--"); updateText("#classroomOnline", data.onlineCount ?? "--"); updateText("#referenceOnline", data.onlineCount ?? "--"); updateText("#boardOnlineCount", data.onlineCount ?? "--"); updateText("#liveBrushCount", data.taskCounts?.["刷题"] ?? 0); updateText("#liveEssayCount", data.taskCounts?.["申论"] ?? 0); updateText("#boardBrushCount", data.taskCounts?.["刷题"] ?? 0); updateText("#boardEssayCount", data.taskCounts?.["申论"] ?? 0);
    updateText("#matchExam", data.match?.sameExam ?? 0); updateText("#matchStage", data.match?.sameStage ?? 0); updateText("#matchRegion", data.match?.sameRegion ?? 0);
    const hasRegion = data.match?.hasRegion; $("#matchNote").textContent = hasRegion ? "只显示人数，不展示任何同学的身份或联系方式。" : "如果愿意选择省份，还会显示同省份的匿名同学人数。";
    el.seatNote?.classList.remove("is-error"); renderClassroomSeats(data.seats); el.connection.textContent = "自习室已连接 · 仅统计活跃匿名座位";
  }
  async function reportPresence() {
    if (!apiBase || document.hidden) return false;
    const payload = { visitorId: profile.id, examType: profile.examType, stage: profile.stage, region: profile.region, task: running ? profile.task : "安静自习", seatId: profile.seatId };
    try {
      const response = await fetch(`${apiBase}/api/study-room/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "连接失败"); renderPresence(data); return true;
    } catch (error) {
      el.connection.textContent = "自习室暂时离线，番茄钟仍可正常使用";
      if (el.seatNote && profile.seatId) { el.seatNote.textContent = error?.message || "座位连接失败，请稍后重试。"; el.seatNote.classList.add("is-error"); }
      return false;
    }
  }
  function renderWallClock() { const now = new Date(), hour = now.getHours() % 12, minute = now.getMinutes(), second = now.getSeconds(); const hourHand = $(".clock-hour"), minuteHand = $(".clock-minute"), secondHand = $(".clock-second"); if (hourHand) hourHand.style.transform = `translateX(-50%) rotate(${hour * 30 + minute * .5}deg)`; if (minuteHand) minuteHand.style.transform = `translateX(-50%) rotate(${minute * 6 + second * .1}deg)`; if (secondHand) secondHand.style.transform = `translateX(-50%) rotate(${second * 6}deg)`; }
  renderWallClock(); window.setInterval(renderWallClock, 1000);
  function openPanel(type) { document.body.classList.remove("focus-open", "match-open"); document.body.classList.add(type === "focus" ? "focus-open" : "match-open"); $("#roomModalVeil").hidden = false; }
  function closePanel() { document.body.classList.remove("focus-open", "match-open", "tools-open"); const veil = $("#roomModalVeil"); if (veil) veil.hidden = true; }
  $("#focusToggle")?.addEventListener("click", () => openPanel("focus"));
  $("#matchToggle")?.addEventListener("click", () => openPanel("match")); $("#toolsToggle")?.addEventListener("click", () => { document.body.classList.add("tools-open"); const veil = $("#roomModalVeil"); if (veil) veil.hidden = false; });
  $("#roomModalVeil")?.addEventListener("click", closePanel);
  // Homepage entry cards lead to the real room controls.  Keep the requested tool
  // visible on arrival instead of making visitors find it again in the room UI.
  const requestedTool = new URLSearchParams(window.location.search).get("tool");
  if (["timer", "focus", "partner"].includes(requestedTool || "")) {
    const veil = $("#roomModalVeil");
    document.body.classList.add("tools-open");
    if (veil) veil.hidden = false;
    const target = requestedTool === "partner" ? $(".partner-card") : $(".focus-card");
    window.setTimeout(() => target?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
  }
  $("#continuePortrait")?.addEventListener("click", () => document.body.classList.add("portrait-continue"));
  $("#inviteShare")?.addEventListener("click", async () => {
    const button = $("#inviteShare"), shareUrl = `${location.origin}${location.pathname}`;
    const payload = { title: "上岸自习室", text: "一起进上岸自习室刷题、专注学习吧。", url: shareUrl };
    try { if (navigator.share) await navigator.share(payload); else { await navigator.clipboard.writeText(shareUrl); button.textContent = "链接已复制，发给好友吧"; window.setTimeout(() => { button.textContent = "⌯ 邀请好友一起学习"; }, 2200); } } catch (_) {}
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePanel(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reportPresence(); });
  window.setInterval(reportPresence, 45000); renderClassroomSeats(); renderFocusCount(); renderTimer(); reportPresence();
})();
