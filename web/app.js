(function () {
  const LS_LOCALE = "monitor_locale";
  const LS_API_BASE = "monitor_api_base";
  const LS_API_SECRET = "monitor_api_secret";

  const T = {
    en: {
      title: "App Store Monitor",
      tabAll: "All",
      tabListed: "Listed",
      tabNotListed: "Not listed",
      dataUpdated: "Data last updated",
      refresh: "Refresh list",
      settings: "Settings",
      list: "Apps",
      addApp: "Add app",
      bundlePlaceholder: "Bundle ID, e.g. com.example.app",
      add: "Add",
      delete: "Remove",
      monitoring: "Monitoring",
      versionHistory: "Version history",
      close: "Close",
      version: "Version",
      versionUpdated: "Version date",
      changeCount: "Version changes",
      listing: "Listing",
      listed: "Listed",
      notListed: "Not listed",
      saveSettings: "Save settings",
      connTitle: "API connection",
      apiBase: "Worker base URL",
      apiSecret: "Worker API secret",
      apiHint: "Bearer token matches WORKER_API_SECRET in Worker.",
      schedTitle: "Schedule",
      timezoneNote: "Window times are in the timezone stored in config (default Asia/Shanghai).",
      windowStart: "Window start",
      windowEnd: "Window end",
      interval: "Interval (minutes)",
      localeTitle: "Language",
      localeEn: "English",
      localeZh: "中文",
      loadFailed: "Failed to load data",
      saved: "Saved",
      unauthorized: "Unauthorized — check API secret",
      conflict: "Bundle ID already exists",
      emptyHistory: "No history yet",
      none: "—",
      needApiBase: "Set Worker base URL in Settings to load data.",
      confirmDelete: "Remove this app from the monitor list?",
    },
    zh: {
      title: "App Store 监控面板",
      tabAll: "全部",
      tabListed: "已上架",
      tabNotListed: "未上架",
      dataUpdated: "数据最后更新时间",
      refresh: "刷新列表",
      settings: "设置",
      list: "应用列表",
      addApp: "添加应用",
      bundlePlaceholder: "Bundle ID，例如 com.example.app",
      add: "添加",
      delete: "移除",
      monitoring: "开启监听",
      versionHistory: "查看版本记录",
      close: "关闭",
      version: "版本号",
      versionUpdated: "版本更新时间",
      changeCount: "版本变动次数",
      listing: "上架状态",
      listed: "已上架",
      notListed: "未上架",
      saveSettings: "保存设置",
      connTitle: "API 连接",
      apiBase: "Worker 根 URL",
      apiSecret: "Worker API 密钥",
      apiHint: "Bearer 需与 Worker 环境变量 WORKER_API_SECRET 一致。",
      schedTitle: "监听时段与间隔",
      timezoneNote: "起止时间使用 config 中的时区（默认北京时间）。",
      windowStart: "开始时间",
      windowEnd: "结束时间",
      interval: "检查间隔（分钟）",
      localeTitle: "语言",
      localeEn: "English",
      localeZh: "中文",
      loadFailed: "加载失败",
      saved: "已保存",
      unauthorized: "未授权，请检查 API 密钥",
      conflict: "Bundle ID 已存在",
      emptyHistory: "暂无版本记录",
      none: "—",
      needApiBase: "请先在设置中填写 Worker 根 URL 以加载数据。",
      confirmDelete: "从监听列表中移除该应用？",
    },
  };

  let locale =
    localStorage.getItem(LS_LOCALE) ||
    (window.APP_CONFIG && window.APP_CONFIG.defaultLocale) ||
    "en";
  if (locale !== "zh" && locale !== "en") locale = "en";

  function tr(key) {
    return (T[locale] && T[locale][key]) || T.en[key] || key;
  }

  let state = null;
  let config = null;
  let filterTab = "all";

  const el = (id) => document.getElementById(id);

  function toast(msg, isErr) {
    const n = document.createElement("div");
    n.className = "toast" + (isErr ? " err" : "");
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 3200);
  }

  function apiBase() {
    const fromLs = localStorage.getItem(LS_API_BASE);
    if (fromLs) return fromLs.replace(/\/$/, "");
    if (window.APP_CONFIG && window.APP_CONFIG.apiBase) {
      return String(window.APP_CONFIG.apiBase).replace(/\/$/, "");
    }
    return "";
  }

  function apiSecret() {
    return localStorage.getItem(LS_API_SECRET) || "";
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async function loadState() {
    const base = apiBase();
    if (!base) throw new Error(tr("loadFailed"));
    return fetchJson(`${base}/state`);
  }

  async function loadConfig() {
    const base = apiBase();
    if (!base) throw new Error(tr("loadFailed"));
    return fetchJson(`${base}/config`);
  }

  async function apiPost(body) {
    const base = apiBase();
    const secret = apiSecret();
    const r = await fetch(`${base}/api/v1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: secret ? `Bearer ${secret}` : "",
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error(tr("unauthorized"));
    if (r.status === 409) throw new Error(tr("conflict"));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  function formatDisplayDate(iso) {
    if (!iso) return tr("none");
    try {
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
    } catch {
      return iso;
    }
  }

  function versionDisplayRow(app) {
    const release = app.currentVersionReleaseDate;
    const changed = app.lastVersionChangeAt;
    const chosen = release || changed;
    const note =
      locale === "zh"
        ? release
          ? "（商店 currentVersionReleaseDate）"
          : changed
            ? "（最近记录的版本变动时间）"
            : ""
        : release
          ? "(store currentVersionReleaseDate)"
          : changed
            ? "(last recorded version change)"
            : "";
    return { text: formatDisplayDate(chosen), note };
  }

  function applyLocaleUi() {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : "en";
    el("nav-list").textContent = tr("list");
    el("nav-settings").textContent = tr("settings");
    el("page-title").textContent = tr("title");
    el("tab-all").textContent = tr("tabAll");
    el("tab-listed").textContent = tr("tabListed");
    el("tab-not").textContent = tr("tabNotListed");
    el("btn-refresh").textContent = tr("refresh");
    el("label-add").textContent = tr("addApp");
    el("input-bundle").placeholder = tr("bundlePlaceholder");
    el("btn-add").textContent = tr("add");
    el("settings-conn-title").textContent = tr("connTitle");
    el("lbl-api-base").textContent = tr("apiBase");
    el("lbl-api-secret").textContent = tr("apiSecret");
    el("api-hint").textContent = tr("apiHint");
    el("settings-sched-title").textContent = tr("schedTitle");
    el("tz-note").textContent = tr("timezoneNote");
    el("lbl-start").textContent = tr("windowStart");
    el("lbl-end").textContent = tr("windowEnd");
    el("lbl-interval").textContent = tr("interval");
    el("settings-locale-title").textContent = tr("localeTitle");
    el("lbl-locale-en").textContent = tr("localeEn");
    el("lbl-locale-zh").textContent = tr("localeZh");
    el("btn-save-settings").textContent = tr("saveSettings");
    el("locale-en").checked = locale === "en";
    el("locale-zh").checked = locale === "zh";
    renderList();
  }

  function filteredApps() {
    if (!state || !state.apps) return [];
    return state.apps.filter((a) => {
      if (filterTab === "listed") return a.listingStatus === "listed";
      if (filterTab === "not_listed") return a.listingStatus === "not_listed";
      return true;
    });
  }

  function renderList() {
    const root = el("card-list");
    root.innerHTML = "";
    const meta = state && state.meta;
    el("meta-updated").textContent = `${tr("dataUpdated")}: ${formatDisplayDate(meta && meta.dataUpdatedAt)}`;

    filteredApps().forEach((app) => {
      const card = document.createElement("div");
      card.className = "card";

      const img = document.createElement("img");
      img.className = "card-icon";
      img.alt = "";
      if (app.artworkUrl100) {
        img.src = app.artworkUrl100;
      } else {
        img.removeAttribute("src");
      }

      const body = document.createElement("div");
      body.className = "card-body";
      const title = document.createElement("h2");
      title.textContent = app.trackName || app.bundleId;
      const bundle = document.createElement("div");
      bundle.className = "bundle";
      bundle.textContent = app.bundleId;

      const chips = document.createElement("div");
      chips.className = "row-chips";
      const st = document.createElement("span");
      st.className =
        "chip " + (app.listingStatus === "listed" ? "status-listed" : "status-not");
      st.textContent =
        app.listingStatus === "listed" ? tr("listed") : tr("notListed");

      const v = document.createElement("span");
      v.className = "chip";
      v.textContent = `${tr("version")}: ${app.version || app.storeVersion || tr("none")}`;

      const vd = versionDisplayRow(app);
      const vdEl = document.createElement("span");
      vdEl.className = "chip";
      vdEl.title = vd.note;
      vdEl.textContent = `${tr("versionUpdated")}: ${vd.text}`;

      const cc = document.createElement("span");
      cc.className = "chip";
      cc.textContent = `${tr("changeCount")}: ${app.versionChangeCount ?? 0}`;

      chips.append(st, v, vdEl, cc);

      body.append(title, bundle, chips);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      const histBtn = document.createElement("button");
      histBtn.className = "btn";
      histBtn.type = "button";
      histBtn.textContent = tr("versionHistory");
      histBtn.addEventListener("click", () => openHistory(app));

      const delBtn = document.createElement("button");
      delBtn.className = "btn";
      delBtn.type = "button";
      delBtn.textContent = tr("delete");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`${tr("confirmDelete")}\n${app.bundleId}`)) return;
        try {
          await apiPost({ action: "deleteApp", bundleId: app.bundleId });
          await reloadAll();
          toast(tr("saved"));
        } catch (e) {
          toast(e.message || String(e), true);
        }
      });

      const sw = document.createElement("label");
      sw.className = "switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!app.monitoring;
      cb.addEventListener("change", async () => {
        try {
          await apiPost({
            action: "setMonitoring",
            bundleId: app.bundleId,
            monitoring: cb.checked,
          });
          app.monitoring = cb.checked;
          toast(tr("saved"));
        } catch (e) {
          cb.checked = !cb.checked;
          toast(e.message || String(e), true);
        }
      });
      const swLabel = document.createElement("span");
      swLabel.textContent = tr("monitoring");
      sw.append(cb, swLabel);

      actions.append(histBtn, delBtn, sw);

      card.append(img, body, actions);
      root.appendChild(card);
    });
  }

  function openHistory(app) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    const h = document.createElement("header");
    const ht = document.createElement("h2");
    ht.textContent = tr("versionHistory");
    const sub = document.createElement("div");
    sub.className = "bundle";
    sub.textContent = app.bundleId;
    h.append(ht, sub);

    const list = document.createElement("div");
    const hist = app.history && app.history.length ? [...app.history].reverse() : [];
    if (!hist.length) {
      const empty = document.createElement("div");
      empty.textContent = tr("emptyHistory");
      empty.style.color = "var(--muted)";
      list.appendChild(empty);
    } else {
      hist.forEach((row) => {
        const item = document.createElement("div");
        item.className = "history-item";
        const v = document.createElement("span");
        v.textContent = row.version;
        const t = document.createElement("span");
        t.style.color = "var(--muted)";
        t.textContent = formatDisplayDate(row.recordedAt);
        item.append(v, t);
        list.appendChild(item);
      });
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn primary";
    closeBtn.style.marginTop = "0.75rem";
    closeBtn.textContent = tr("close");
    closeBtn.addEventListener("click", () => backdrop.remove());

    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) backdrop.remove();
    });

    modal.append(h, list, closeBtn);
    backdrop.append(modal);
    document.body.appendChild(backdrop);
  }

  async function reloadAll() {
    try {
      state = await loadState();
      renderList();
    } catch (e) {
      toast(tr("loadFailed"), true);
    }
  }

  async function refreshAll() {
    const base = apiBase();
    if (!base) {
      toast(tr("loadFailed"), true);
      return;
    }
    try {
      const r = await fetch(`${base}/refresh`, { cache: "no-store" });
      const data = await r.json();
      if (data.ok) {
        toast(tr("saved"));
        await reloadAll();
      } else {
        toast(data.error || tr("loadFailed"), true);
      }
    } catch (e) {
      toast(e.message || String(e), true);
    }
  }

  async function openSettings() {
    try {
      config = await loadConfig();
    } catch (e) {
      config = null;
      toast(tr("loadFailed"), true);
    }
    el("view-list").classList.add("hidden");
    el("view-settings").classList.remove("hidden");
    el("settings-panel").classList.remove("hidden");

    el("input-api-base").value = localStorage.getItem(LS_API_BASE) || "";
    el("input-api-secret").value = localStorage.getItem(LS_API_SECRET) || "";

    el("input-start").value =
      (config && config.window && config.window.start) || "09:00";
    el("input-end").value = (config && config.window && config.window.end) || "19:00";
    el("input-interval").value =
      config && typeof config.intervalMinutes === "number"
        ? config.intervalMinutes
        : 60;
    const dl =
      config && config.defaultLocale === "zh"
        ? "zh"
        : config && config.defaultLocale === "en"
          ? "en"
          : "—";
    el("config-default-locale").textContent = dl;
    applyLocaleUi();
  }

  function closeSettings() {
    el("view-settings").classList.add("hidden");
    el("view-list").classList.remove("hidden");
  }

  function bindNav() {
    el("nav-list").addEventListener("click", () => {
      closeSettings();
    });
    el("nav-settings").addEventListener("click", () => openSettings());
  }

  function bindTabs() {
    function setTab(t) {
      filterTab = t;
      el("tab-all").classList.toggle("active", t === "all");
      el("tab-listed").classList.toggle("active", t === "listed");
      el("tab-not").classList.toggle("active", t === "not_listed");
      renderList();
    }
    el("tab-all").addEventListener("click", () => setTab("all"));
    el("tab-listed").addEventListener("click", () => setTab("listed"));
    el("tab-not").addEventListener("click", () => setTab("not_listed"));
  }

  async function init() {
    bindNav();
    bindTabs();
    el("btn-refresh").addEventListener("click", () => refreshAll());

    el("btn-add").addEventListener("click", async () => {
      const raw = el("input-bundle").value.trim();
      if (!raw) return;
      try {
        await apiPost({ action: "addApp", bundleId: raw });
        el("input-bundle").value = "";
        await reloadAll();
        toast(tr("saved"));
      } catch (e) {
        toast(e.message || String(e), true);
      }
    });

    el("btn-save-settings").addEventListener("click", async () => {
      const base = el("input-api-base").value.trim().replace(/\/$/, "");
      const secret = el("input-api-secret").value;
      localStorage.setItem(LS_API_BASE, base);
      localStorage.setItem(LS_API_SECRET, secret);

      const nextLocale = el("locale-zh").checked ? "zh" : "en";
      locale = nextLocale;
      localStorage.setItem(LS_LOCALE, locale);

      try {
        const cfg = await loadConfig();
        cfg.window = cfg.window || {};
        cfg.window.start = el("input-start").value || "09:00";
        cfg.window.end = el("input-end").value || "19:00";
        cfg.intervalMinutes = parseInt(el("input-interval").value, 10) || 60;
        cfg.defaultLocale = locale === "zh" ? "zh" : "en";
        cfg.timezone = cfg.timezone || "Asia/Shanghai";
        cfg.schemaVersion = cfg.schemaVersion ?? 1;
        await apiPost({ action: "saveConfig", config: cfg });
        toast(tr("saved"));
        applyLocaleUi();
        closeSettings();
        await reloadAll();
      } catch (e) {
        toast(e.message || String(e), true);
      }
    });

    el("locale-en").addEventListener("change", () => {
      if (el("locale-en").checked) {
        locale = "en";
        localStorage.setItem(LS_LOCALE, locale);
        applyLocaleUi();
      }
    });
    el("locale-zh").addEventListener("change", () => {
      if (el("locale-zh").checked) {
        locale = "zh";
        localStorage.setItem(LS_LOCALE, locale);
        applyLocaleUi();
      }
    });

    applyLocaleUi();

    if (!apiBase()) {
      el("meta-updated").textContent = tr("needApiBase");
    } else {
      try {
        state = await loadState();
        try {
          const cfg = await loadConfig();
          if (!localStorage.getItem(LS_LOCALE) && cfg.defaultLocale) {
            locale = cfg.defaultLocale === "zh" ? "zh" : "en";
            localStorage.setItem(LS_LOCALE, locale);
            applyLocaleUi();
          }
        } catch {
          /* ignore */
        }
        renderList();
      } catch {
        el("meta-updated").textContent = tr("loadFailed");
      }
    }

    if (window.APP_CONFIG && window.APP_CONFIG.defaultLocale && !localStorage.getItem(LS_LOCALE)) {
      locale = window.APP_CONFIG.defaultLocale === "zh" ? "zh" : "en";
      localStorage.setItem(LS_LOCALE, locale);
      applyLocaleUi();
    }
  }

  init();
})();
