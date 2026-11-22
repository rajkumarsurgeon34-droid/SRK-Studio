/* SRK Studio — make pictures and short videos from a prompt.
 * Free pictures use Pollinations' public image service (no key). With the person's own Pollinations key,
 * premium picture models and video are used through gen.pollinations.ai. Everything made is kept on this
 * device (IndexedDB); the key is stored only here and sent only to Pollinations. */
(() => {
  "use strict";
  const FREE_BASE = "https://image.pollinations.ai";
  const GEN_BASE = "https://gen.pollinations.ai";
  const CF_BASE = "https://api.cloudflare.com/client/v4/accounts";
  /** Cloudflare Workers AI picture models on the free daily allowance (10,000 neurons, resets 00:00 UTC). */
  const CF_MODELS = [
    { id: "flux-1-schnell", path: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 Schnell — square only", squareOnly: true },
    { id: "sdxl-lightning", path: "@cf/bytedance/stable-diffusion-xl-lightning", label: "SDXL Lightning — any shape", squareOnly: false },
  ];
  const $ = (id) => document.getElementById(id);

  const RATIOS = [
    { id: "1:1", w: 1024, h: 1024 },
    { id: "16:9", w: 1344, h: 768 },
    { id: "9:16", w: 768, h: 1344 },
    { id: "4:3", w: 1152, h: 864 },
    { id: "3:4", w: 864, h: 1152 },
  ];
  const VIDEO_RATIOS = ["16:9", "9:16"];
  const FREE_FALLBACK = ["flux", "turbo"];
  const VIDEO_FALLBACK = ["veo", "seedance-2.0", "wan"];
  const PREMIUM_IMAGE_FALLBACK = ["flux", "gptimage", "seedream", "kontext"];

  const state = {
    mode: "image",
    ratio: "1:1",
    key: localStore("srkstudio.key") || "",
    cfAccount: localStore("srkstudio.cfAccount") || "",
    cfToken: localStore("srkstudio.cfToken") || "",
    freeModels: FREE_FALLBACK.slice(),
    premiumImages: [],
    videos: [],
    startFrame: null, // { url, thumb } — a public picture URL used as the video's first frame
    busy: null,       // AbortController while creating
    items: [],
    viewing: null,
  };

  // ---------- storage ----------
  function localStore(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch { /* storage unavailable: settings last for this session only */ }
    return null;
  }
  let dbp = null;
  function db() {
    dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("srkstudio", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("items", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("items", mode);
      const out = fn(t.objectStore("items"));
      t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  const putItem = (item) => tx("readwrite", (s) => s.put(item));
  const deleteItem = (id) => tx("readwrite", (s) => s.delete(id));
  const allItems = () => tx("readonly", (s) => s.getAll());

  // ---------- models ----------
  const durationsFor = (model) => {
    if (/veo/.test(model)) return [4, 6, 8];
    if (/seedance-2\.5/.test(model)) return [4];
    if (/seedance/.test(model)) return [4, 5, 6, 8, 10, 15];
    if (/wan/.test(model)) return [2, 4, 5, 6, 8, 10, 15];
    return [4, 5, 6, 8];
  };
  const looksLikeVideo = (id) => /video|veo|seedance|wan-|^wan$|reel|minimax|happyhorse|omni/i.test(id);

  /** Reads Pollinations' model list, whatever shape each entry has (a name, or an object with name/id and outputs). */
  function parseModels(json) {
    const list = Array.isArray(json) ? json : (json && (json.data || json.models)) || [];
    const images = [], videos = [];
    for (const m of list) {
      const id = typeof m === "string" ? m : (m && (m.name || m.id || m.model));
      if (!id || typeof id !== "string") continue;
      const outs = typeof m === "object" ? [].concat(m.output_modalities || m.outputs || m.output || m.type || []).map(String) : [];
      const video = outs.length ? outs.some((o) => /video/i.test(o)) : looksLikeVideo(id);
      const label = typeof m === "object" && typeof m.description === "string" && m.description.length < 60 ? `${id} — ${m.description}` : id;
      (video ? videos : images).push({ id, label });
    }
    return { images, videos };
  }

  /** Puts the dependable free models first, so the default works even when a newer listed model is down. */
  const orderFree = (ids) => [...FREE_FALLBACK.filter((id) => ids.includes(id)), ...ids.filter((id) => !FREE_FALLBACK.includes(id))];

  async function loadFreeModels() {
    try {
      const r = await fetch(`${FREE_BASE}/models`);
      if (!r.ok) throw new Error(String(r.status));
      const { images } = parseModels(await r.json());
      if (images.length) state.freeModels = orderFree(images.map((m) => m.id));
    } catch { /* keep the built-in list */ }
  }
  async function loadPremiumModels() {
    const cached = localStore("srkstudio.models");
    if (cached) { try { Object.assign(state, JSON.parse(cached)); } catch { /* ignore a bad cache */ } }
    try {
      const r = await fetch(`${GEN_BASE}/image/models`);
      if (!r.ok) throw new Error(String(r.status));
      const { images, videos } = parseModels(await r.json());
      if (images.length) state.premiumImages = images;
      if (videos.length) state.videos = videos;
      localStore("srkstudio.models", JSON.stringify({ premiumImages: state.premiumImages, videos: state.videos }));
    } catch { /* keep cached or built-in lists */ }
    if (!state.premiumImages.length) state.premiumImages = PREMIUM_IMAGE_FALLBACK.map((id) => ({ id, label: id }));
    if (!state.videos.length) state.videos = VIDEO_FALLBACK.map((id) => ({ id, label: id }));
  }

  // ---------- UI: composer ----------
  function renderRatios() {
    const box = $("ratios");
    box.innerHTML = "";
    const allowed = state.mode === "video" ? RATIOS.filter((r) => VIDEO_RATIOS.includes(r.id)) : RATIOS;
    if (!allowed.some((r) => r.id === state.ratio)) state.ratio = allowed[0].id;
    for (const r of allowed) {
      const b = document.createElement("button");
      b.className = "chip";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(r.id === state.ratio));
      const scale = 16 / Math.max(r.w, r.h);
      b.innerHTML = `<i style="width:${Math.round(r.w * scale)}px;height:${Math.round(r.h * scale)}px"></i>${r.id}`;
      b.onclick = () => { state.ratio = r.id; renderRatios(); renderNote(); };
      box.appendChild(b);
    }
  }

  function renderModels() {
    const sel = $("model");
    const prev = sel.value;
    sel.innerHTML = "";
    const add = (id, label, group) => {
      const o = document.createElement("option");
      o.value = id; o.textContent = label;
      (group || sel).appendChild(o);
    };
    if (state.mode === "image") {
      if (hasCloudflare()) {
        const cf = document.createElement("optgroup");
        cf.label = "Cloudflare (free daily)";
        CF_MODELS.forEach((m) => add(`cf:${m.id}`, m.label, cf));
        sel.appendChild(cf);
      }
      const free = document.createElement("optgroup");
      free.label = "Free";
      state.freeModels.forEach((id) => add(`free:${id}`, id, free));
      sel.appendChild(free);
      if (state.key) {
        const prem = document.createElement("optgroup");
        prem.label = "With your key";
        state.premiumImages.forEach((m) => add(`key:${m.id}`, m.label, prem));
        sel.appendChild(prem);
      }
    } else {
      state.videos.forEach((m) => add(`key:${m.id}`, m.label));
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    renderDurations();
    renderNote();
  }
  const hasCloudflare = () => Boolean(state.cfAccount && state.cfToken);
  const cfModel = (id) => CF_MODELS.find((m) => m.id === id);

  function renderDurations() {
    const sel = $("duration");
    const model = $("model").value.replace(/^key:/, "");
    const prev = Number(sel.value);
    sel.innerHTML = "";
    for (const d of durationsFor(model)) {
      const o = document.createElement("option");
      o.value = String(d); o.textContent = String(d);
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => Number(o.value) === prev)) sel.value = String(prev);
  }

  function setMode(mode) {
    state.mode = mode;
    $("tab-image").setAttribute("aria-selected", String(mode === "image"));
    $("tab-video").setAttribute("aria-selected", String(mode === "video"));
    const video = mode === "video";
    $("count-wrap").classList.toggle("hidden", video);
    $("enhance-wrap").classList.toggle("hidden", video);
    $("duration-wrap").classList.toggle("hidden", !video);
    $("audio-wrap").classList.toggle("hidden", !video);
    $("start-frame").classList.toggle("hidden", !(video && state.startFrame));
    $("prompt").placeholder = video
      ? "Waves rolling onto a quiet beach at sunset, slow camera push-in"
      : "A lighthouse on a cliff at dawn, mist over the sea, soft golden light";
    renderRatios();
    renderModels();
    renderNote();
  }

  function renderNote() {
    const note = $("mode-note");
    const create = $("btn-create");
    if (state.mode === "video" && !state.key) {
      note.textContent = "Video needs your own Pollinations key. Add it in Settings — new accounts get a small free daily allowance.";
      create.textContent = "Add a key to make videos";
    } else {
      const picked = $("model").value;
      const square = picked.startsWith("cf:") && cfModel(picked.slice(3))?.squareOnly;
      note.textContent = state.mode === "video" ? "A video takes one to a few minutes. Keep the app open while it's made."
        : square && state.ratio !== "1:1" ? "FLUX.1 Schnell makes square pictures. Pick SDXL Lightning for other shapes."
        : picked.startsWith("free:") && !hasCloudflare() ? "Without a key, Pollinations allows only a few pictures an hour. Add Cloudflare in Settings for many free pictures a day." : "";
      create.textContent = state.mode === "video" ? "Create video" : "Create";
    }
  }

  // ---------- creating ----------
  const ratioOf = (id) => RATIOS.find((r) => r.id === id) || RATIOS[0];
  const randomSeed = () => Math.floor(Math.random() * 2_000_000_000);

  function freeImageUrl(prompt, model, r, seed, enhance) {
    const q = new URLSearchParams({ width: r.w, height: r.h, seed, model, nologo: "true", private: "true", enhance: String(enhance) });
    return `${FREE_BASE}/prompt/${encodeURIComponent(prompt)}?${q}`;
  }

  async function explain(res, auth = true) {
    let detail = "";
    try { const t = await res.text(); try { const j = JSON.parse(t); detail = j.error?.message || j.message || j.error || ""; } catch { detail = t.slice(0, 160); } } catch { /* no body */ }
    if (res.status === 401 || res.status === 403) return "Your Pollinations key wasn't accepted. Check it in Settings.";
    if (res.status === 402 && !auth) return "The free no-key pictures are used up for now. Add Cloudflare in Settings for many free pictures a day, or try again in an hour.";
    if (res.status === 402) return "Your Pollinations balance is used up. Wait for tomorrow's free allowance or add credit at enter.pollinations.ai.";
    if (res.status === 429) return "Too many requests right now. Wait a minute and try again.";
    if (res.status >= 500) return "Pollinations is busy or having a problem. Try again in a moment.";
    return `Pollinations said no (${res.status})${detail ? ": " + String(detail).slice(0, 140) : "."}`;
  }

  async function fetchMedia(url, { auth, signal }) {
    const headers = auth ? { Authorization: `Bearer ${state.key}` } : {};
    let res;
    try { res = await fetch(url, { headers, signal }); }
    catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Couldn't reach Pollinations. Check your internet connection.");
    }
    if (!res.ok) { const err = new Error(await explain(res, auth)); err.status = res.status; throw err; }
    const blob = await res.blob();
    if (!/^(image|video)\//.test(blob.type) && blob.size < 2048) throw new Error("Pollinations sent back something that isn't a picture or video. Try again.");
    return blob;
  }

  let timer = null;
  function startStage(r, label) {
    $("stage").classList.remove("hidden");
    $("frame").classList.remove("hidden");
    $("stage-media").innerHTML = "";
    $("develop").classList.remove("hidden");
    $("frame").style.setProperty("--ar", `${r.w} / ${r.h}`);
    const started = Date.now();
    clearInterval(timer);
    const tick = () => { $("stage-status").textContent = `${label} ${Math.round((Date.now() - started) / 1000)}s`; };
    tick(); timer = setInterval(tick, 1000);
    $("btn-cancel").classList.remove("hidden");
    $("stage").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  }
  function endStage(text) {
    clearInterval(timer);
    $("stage-status").textContent = text;
    $("btn-cancel").classList.add("hidden");
  }

  async function create() {
    if (state.busy) return;
    const prompt = $("prompt").value.trim();
    if (state.mode === "video" && !state.key) { openSettings(); return; }
    if (!prompt) { toast("Describe what you want first."); $("prompt").focus(); return; }
    const [kind, model] = $("model").value.split(/:(.*)/s);
    const r = ratioOf(state.ratio);
    const ctrl = new AbortController();
    state.busy = ctrl;
    $("btn-create").disabled = true;

    try {
      if (state.mode === "video") {
        startStage(r, "Making your video…");
        const q = new URLSearchParams({ model, duration: $("duration").value, aspectRatio: state.ratio, audio: String($("audio").checked) });
        if (state.startFrame) q.set("image", state.startFrame.url);
        const blob = await fetchMedia(`${GEN_BASE}/video/${encodeURIComponent(prompt)}?${q}`, { auth: true, signal: ctrl.signal });
        const item = { id: crypto.randomUUID(), kind: "video", prompt, model, ratio: state.ratio, created: Date.now(), blob };
        await putItem(item);
        showOnStage([item]);
        endStage("Done. It's saved in Your work.");
      } else {
        const count = Number($("count").value) || 1;
        const enhance = $("enhance").checked;
        startStage(r, count > 1 ? `Making ${count} pictures…` : "Making your picture…");
        const made = [];
        for (let i = 0; i < count; i++) {
          const seed = randomSeed();
          let blob, sourceUrl = null, usedModel = model, usedRatio = state.ratio;
          if (kind === "cf") {
            const m = cfModel(model);
            const size = m.squareOnly ? ratioOf("1:1") : r;
            blob = await cloudflareImage(m, prompt, size, seed, ctrl.signal);
            usedRatio = m.squareOnly ? "1:1" : state.ratio;
          } else if (kind === "free") {
            sourceUrl = freeImageUrl(prompt, model, r, seed, enhance);
            try {
              blob = await fetchMedia(sourceUrl, { auth: false, signal: ctrl.signal });
            } catch (e) {
              const backup = FREE_FALLBACK.find((id) => id !== model && state.freeModels.includes(id)) || (model !== "flux" ? "flux" : null);
              if (e.name === "AbortError" || !backup || e.status === 402 || e.status === 429) throw e;
              $("stage-status").textContent = `${model} isn't working right now, trying ${backup}…`;
              sourceUrl = freeImageUrl(prompt, backup, r, seed, enhance);
              blob = await fetchMedia(sourceUrl, { auth: false, signal: ctrl.signal });
              usedModel = backup;
            }
          } else {
            const q = new URLSearchParams({ model, width: r.w, height: r.h, seed });
            blob = await fetchMedia(`${GEN_BASE}/image/${encodeURIComponent(prompt)}?${q}`, { auth: true, signal: ctrl.signal });
          }
          const item = { id: crypto.randomUUID(), kind: "image", prompt, model: usedModel, ratio: usedRatio, created: Date.now(), blob, sourceUrl };
          await putItem(item);
          made.push(item);
          showOnStage(made);
          if (count > 1) $("stage-status").textContent = `${made.length} of ${count} ready…`;
        }
        endStage(made.length > 1 ? `${made.length} pictures saved in Your work.` : "Done. It's saved in Your work.");
      }
      await refreshGallery();
    } catch (e) {
      endStage(e.name === "AbortError" ? "Cancelled." : (e.message || String(e)));
      $("develop").classList.add("hidden");
      if (!$("stage-media").children.length) $("frame").classList.add("hidden");
      await refreshGallery();
    } finally {
      state.busy = null;
      $("btn-create").disabled = false;
    }
  }

  // ---------- Cloudflare Workers AI ----------
  const b64ToBlob = (b64, type) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  };
  function cloudflareProblem(status, body) {
    let detail = "", code = 0;
    try { const j = typeof body === "string" ? JSON.parse(body) : body; const e = (j && j.errors && j.errors[0]) || {}; detail = e.message || ""; code = e.code || 0; } catch { /* not JSON */ }
    if (status === 401 || status === 403 || code === 10000) return "Cloudflare didn't accept your token. In Settings, check the account ID and that the token has Workers AI permission.";
    if (status === 429 || code === 3036 || /neuron|daily|allocation|limit/i.test(detail)) return "Today's free Cloudflare allowance is used up. It resets at 5:30 AM India time.";
    if (status === 404) return "Cloudflare couldn't find that account or model. Check the account ID in Settings.";
    if (status >= 500) return "Cloudflare is having a problem. Try again in a moment.";
    return `Cloudflare said no (${status})${detail ? ": " + String(detail).slice(0, 140) : "."}`;
  }
  /** Calls a Workers AI model. Inside the Android app the request goes through the native HTTP layer, because
   * api.cloudflare.com does not allow requests from a web page (no CORS). */
  async function cloudflareImage(m, prompt, size, seed, signal) {
    const url = `${CF_BASE}/${encodeURIComponent(state.cfAccount)}/ai/run/${m.path}`;
    const body = m.squareOnly ? { prompt, steps: 4, seed } : { prompt, width: size.w, height: size.h, seed };
    const headers = { Authorization: `Bearer ${state.cfToken}`, "Content-Type": "application/json" };
    const binary = !m.squareOnly; // FLUX answers JSON with a base64 image; SDXL answers with the PNG itself
    const native = plugins().CapacitorHttp;
    if (signal.aborted) throw aborted();
    let status, data, type;
    if (native) {
      let res;
      try { res = await native.request({ url, method: "POST", headers, data: body, responseType: binary ? "blob" : "json", connectTimeout: 30000, readTimeout: 120000 }); }
      catch { throw new Error("Couldn't reach Cloudflare. Check your internet connection."); }
      if (signal.aborted) throw aborted();
      status = res.status; data = res.data;
      type = (res.headers && (res.headers["Content-Type"] || res.headers["content-type"])) || "";
      if (status < 200 || status >= 300) {
        let text = data;
        if (binary && typeof data === "string") { try { text = atob(data); } catch { /* leave as is */ } }
        throw new Error(cloudflareProblem(status, text));
      }
      if (binary) return b64ToBlob(String(data), /jpe?g/.test(type) ? "image/jpeg" : "image/png");
    } else {
      let res;
      try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal }); }
      catch (e) { if (e.name === "AbortError") throw e; throw new Error("Couldn't reach Cloudflare. Check your internet connection."); }
      status = res.status;
      if (!res.ok) throw new Error(cloudflareProblem(status, await res.text()));
      if (binary) return await res.blob();
      data = await res.json();
    }
    const j = typeof data === "string" ? JSON.parse(data) : data;
    const b64 = j && ((j.result && j.result.image) || j.image);
    if (!b64) throw new Error("Cloudflare answered without a picture. Try again.");
    return b64ToBlob(b64, "image/jpeg");
  }

  const urls = new Map();
  const urlFor = (item) => { if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(item.blob)); return urls.get(item.id); };

  function mediaEl(item, { controls = false, cls = "" } = {}) {
    if (item.kind === "video") {
      const v = document.createElement("video");
      v.src = urlFor(item); v.playsInline = true; v.muted = !controls; v.loop = true; v.preload = "metadata";
      if (controls) { v.controls = true; v.autoplay = true; }
      if (cls) v.className = cls;
      return v;
    }
    const img = document.createElement("img");
    img.src = urlFor(item); img.alt = item.prompt;
    if (cls) img.className = cls;
    return img;
  }

  function showOnStage(items) {
    $("develop").classList.add("hidden");
    const box = $("stage-media");
    box.innerHTML = "";
    if (items.length === 1) { const el = mediaEl(items[0], { controls: items[0].kind === "video", cls: "developing" }); el.onclick = () => openViewer(items[0]); box.appendChild(el); return; }
    const row = document.createElement("div");
    row.className = "row";
    for (const it of items) { const el = mediaEl(it, { cls: "developing" }); el.onclick = () => openViewer(it); row.appendChild(el); }
    box.appendChild(row);
  }

  // ---------- gallery ----------
  async function refreshGallery() {
    try { state.items = (await allItems()).sort((a, b) => b.created - a.created); }
    catch { state.items = []; }
    const grid = $("grid");
    grid.innerHTML = "";
    for (const it of state.items) {
      const b = document.createElement("button");
      b.className = "slide";
      b.setAttribute("aria-label", `${it.kind === "video" ? "Video" : "Picture"}: ${it.prompt}`);
      b.appendChild(mediaEl(it));
      if (it.kind === "video") { const s = document.createElement("span"); s.className = "badge"; s.textContent = "Video"; b.appendChild(s); }
      b.onclick = () => openViewer(it);
      grid.appendChild(b);
    }
    $("empty").classList.toggle("hidden", state.items.length > 0);
    $("gal-count").textContent = state.items.length ? `${state.items.length}` : "";
  }

  function openViewer(item) {
    state.viewing = item;
    const box = $("viewer-media");
    box.innerHTML = "";
    box.appendChild(mediaEl(item, { controls: true }));
    $("viewer-prompt").textContent = item.prompt;
    $("viewer-meta").textContent = `${item.kind === "video" ? "Video" : "Picture"}, ${item.model}, ${item.ratio}, ${new Date(item.created).toLocaleString()}`;
    $("v-animate").classList.toggle("hidden", !(item.kind === "image" && item.sourceUrl));
    $("viewer").classList.remove("hidden");
  }
  function closeViewer() {
    $("viewer").classList.add("hidden");
    const v = $("viewer-media").querySelector("video");
    if (v) v.pause();
    state.viewing = null;
  }

  // ---------- save & share ----------
  const ext = (item) => (item.kind === "video" ? "mp4" : /png/.test(item.blob.type) ? "png" : "jpg");
  const fileName = (item) => `srk-studio-${new Date(item.created).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext(item)}`;
  const plugins = () => (window.Capacitor && window.Capacitor.Plugins) || {};
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  async function saveItem(item) {
    const { Filesystem } = plugins();
    if (Filesystem) {
      try {
        await Filesystem.writeFile({ path: `SRK Studio/${fileName(item)}`, data: await toBase64(item.blob), directory: "DOCUMENTS", recursive: true });
        toast("Saved to Documents › SRK Studio.");
        return;
      } catch { /* fall through to sharing, which lets the person pick Photos or Files */ }
      await shareItem(item, "Choose where to save it.");
      return;
    }
    const a = document.createElement("a");
    a.href = urlFor(item); a.download = fileName(item);
    document.body.appendChild(a); a.click(); a.remove();
    toast("Downloaded.");
  }

  async function shareItem(item, hint) {
    const { Filesystem, Share } = plugins();
    try {
      if (Filesystem && Share) {
        const written = await Filesystem.writeFile({ path: fileName(item), data: await toBase64(item.blob), directory: "CACHE" });
        await Share.share({ title: "SRK Studio", text: item.prompt, files: [written.uri], dialogTitle: hint || "Share" });
        return;
      }
      const file = new File([item.blob], fileName(item), { type: item.blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: item.prompt }); return; }
      await saveItem(item);
    } catch (e) {
      if (!/cancel|abort/i.test(String(e && (e.message || e.name)))) toast("Couldn't share it. Try Save to phone.");
    }
  }

  // ---------- settings ----------
  function openSettings() {
    $("s-key").value = state.key;
    $("s-cf-account").value = state.cfAccount;
    $("s-cf-token").value = state.cfToken;
    $("s-result").textContent = "";
    $("settings").classList.remove("hidden");
    $("s-key").focus();
  }
  async function saveSettings() {
    const key = $("s-key").value.trim();
    const cfAccount = $("s-cf-account").value.trim(), cfToken = $("s-cf-token").value.trim();
    if (key && !/^(sk|pk)_[A-Za-z0-9_-]{8,}$/.test(key)) { $("s-result").textContent = "That doesn't look like a Pollinations key. It starts with sk_."; return; }
    if (cfAccount && !/^[0-9a-f]{32}$/i.test(cfAccount)) { $("s-result").textContent = "The Cloudflare account ID is 32 letters and numbers, as shown on your Cloudflare dashboard."; return; }
    if (Boolean(cfAccount) !== Boolean(cfToken)) { $("s-result").textContent = "For Cloudflare, fill in both the account ID and the token."; return; }
    const cfAdded = cfAccount && !hasCloudflare();
    state.cfAccount = cfAccount; state.cfToken = cfToken;
    localStore("srkstudio.cfAccount", cfAccount || null);
    localStore("srkstudio.cfToken", cfToken || null);
    state.key = key;
    localStore("srkstudio.key", key || null);
    if (key) await loadPremiumModels();
    renderModels();
    if (cfAdded) $("model").value = `cf:${CF_MODELS[0].id}`;
    renderNote();
    $("settings").classList.add("hidden");
    toast(cfAdded ? "Cloudflare saved. Free daily pictures are ready." : "Settings saved.");
  }

  // ---------- misc ----------
  let toastTimer = null;
  function toast(text) {
    const t = $("toast");
    t.textContent = text; t.classList.remove("hidden");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
  }

  function wire() {
    $("tab-image").onclick = () => setMode("image");
    $("tab-video").onclick = () => setMode("video");
    $("model").onchange = () => { renderDurations(); renderNote(); };
    $("btn-create").onclick = create;
    $("btn-cancel").onclick = () => state.busy && state.busy.abort();
    $("btn-settings").onclick = openSettings;
    $("s-save").onclick = saveSettings;
    $("s-close").onclick = () => $("settings").classList.add("hidden");
    $("v-close").onclick = closeViewer;
    $("v-save").onclick = () => state.viewing && saveItem(state.viewing);
    $("v-share").onclick = () => state.viewing && shareItem(state.viewing);
    $("v-reuse").onclick = () => {
      if (!state.viewing) return;
      $("prompt").value = state.viewing.prompt;
      closeViewer(); window.scrollTo({ top: 0 }); $("prompt").focus();
    };
    $("v-animate").onclick = () => {
      const it = state.viewing;
      if (!it || !it.sourceUrl) return;
      state.startFrame = { url: it.sourceUrl };
      $("start-frame-img").src = urlFor(it);
      if (!$("prompt").value.trim()) $("prompt").value = it.prompt;
      closeViewer(); setMode("video"); window.scrollTo({ top: 0 });
    };
    $("btn-clear-start").onclick = () => { state.startFrame = null; $("start-frame").classList.add("hidden"); };
    $("v-delete").onclick = async () => {
      const it = state.viewing;
      if (!it || !confirm("Delete this from SRK Studio? This can't be undone.")) return;
      await deleteItem(it.id);
      if (urls.has(it.id)) { URL.revokeObjectURL(urls.get(it.id)); urls.delete(it.id); }
      closeViewer(); await refreshGallery(); toast("Deleted.");
    };
    for (const id of ["viewer", "settings"]) $(id).addEventListener("click", (e) => { if (e.target.id === id) (id === "viewer" ? closeViewer() : $(id).classList.add("hidden")); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeViewer(); $("settings").classList.add("hidden"); } });
    $("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) create(); });
  }

  async function init() {
    wire();
    setMode("image");
    await refreshGallery();
    await Promise.all([loadFreeModels(), state.key ? loadPremiumModels() : Promise.resolve()]);
    if (!state.key) { state.premiumImages = []; state.videos = state.videos.length ? state.videos : VIDEO_FALLBACK.map((id) => ({ id, label: id })); }
    renderModels();
  }

  window.SRKStudio = { parseModels, freeImageUrl, durationsFor, state };
  init();
})();
