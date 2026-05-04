/**
 * Cloudflare Worker：代理读写 GitHub 仓库中的 config.json / state.json 并提交。
 * 环境变量：GITHUB_TOKEN、GITHUB_OWNER、GITHUB_REPO、GITHUB_BRANCH、WORKER_API_SECRET、ALLOWED_ORIGIN
 */

const STATE_PATH = "state.json";
const CONFIG_PATH = "config.json";

function corsHeaders(env, req) {
  const origin = env.ALLOWED_ORIGIN === "*" ? "*" : env.ALLOWED_ORIGIN || "*";
  const h = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (origin !== "*" && req.headers.get("Origin")) {
    h["Access-Control-Allow-Origin"] = req.headers.get("Origin");
  }
  return h;
}

async function githubFetch(env, path, init = {}) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "app-store-monitor-worker",
    ...init.headers,
  };
  return fetch(url, { ...init, headers });
}

async function getRepoFile(env, path) {
  const res = await githubFetch(env, path);
  if (res.status === 404) return { missing: true };
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub GET ${path}: ${res.status} ${t}`);
  }
  const data = await res.json();
  const b64 = data.content.replace(/\n/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder("utf-8").decode(bytes);
  return { sha: data.sha, json: JSON.parse(text) };
}

async function putRepoFile(env, path, obj, message, sha) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2) + "\n")));
  const body = {
    message,
    content,
    branch: env.GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await githubFetch(env, path, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub PUT ${path}: ${res.status} ${t}`);
  }
  return res.json();
}

function requireAuth(req, env) {
  const secret = env.WORKER_API_SECRET;
  if (!secret) return false;
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1] === secret;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

async function itunesLookup(bundleId) {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "MonitorKitForIOS/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data;
}

function pickArtwork(track) {
  for (const key of ["artworkUrl512", "artworkUrl100", "artworkUrl60"]) {
    if (track[key]) return track[key];
  }
  return null;
}

function formatISO() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function newAppShell(bundleId) {
  return {
    bundleId,
    monitoring: true,
    listingStatus: "not_listed",
    trackName: null,
    artworkUrl100: null,
    storeVersion: null,
    version: null,
    currentVersionReleaseDate: null,
    lastKnownVersion: null,
    versionChangeCount: 0,
    lastCheckedAt: null,
    lastVersionChangeAt: null,
    lastStaleNotifyAt: null,
    history: [],
  };
}

export default {
  async fetch(req, env) {
    const c = corsHeaders(env, req);
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: c });
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      // ---- 诊断端点 ----
      if (path === "/debug" && req.method === "GET") {
        const owner = env.GITHUB_OWNER || "(not set)";
        const repo = env.GITHUB_REPO || "(not set)";
        const branch = env.GITHUB_BRANCH || "(not set)";
        const tokenSet = env.GITHUB_TOKEN ? "yes (length: " + env.GITHUB_TOKEN.length + ")" : "no";
        const secretSet = env.WORKER_API_SECRET ? "yes" : "no";
        const allowedOrigin = env.ALLOWED_ORIGIN || "(not set)";

        let gitHubStatus = "unknown";
        if (env.GITHUB_TOKEN && owner !== "(not set)" && repo !== "(not set)") {
          try {
            const testUrl = `https://api.github.com/repos/${owner}/${repo}`;
            const testRes = await fetch(testUrl, {
              headers: {
                Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                "User-Agent": "app-store-monitor-worker",
              },
            });
            if (testRes.ok) gitHubStatus = "ok (repo accessible)";
            else if (testRes.status === 401) gitHubStatus = "401 Unauthorized - token invalid";
            else if (testRes.status === 403) gitHubStatus = "403 Forbidden - check token permissions";
            else if (testRes.status === 404) gitHubStatus = "404 Not Found - wrong owner/repo?";
            else gitHubStatus = `${testRes.status} ${testRes.statusText}`;
          } catch (e) {
            gitHubStatus = "fetch error: " + e.message;
          }
        }

        let stateExists = "unknown";
        let configExists = "unknown";
        if (owner !== "(not set)" && repo !== "(not set)" && env.GITHUB_TOKEN) {
          try {
            const sRes = await githubFetch(env, STATE_PATH);
            stateExists = sRes.ok ? "yes" : sRes.status === 404 ? "no (404)" : `error (${sRes.status})`;
          } catch (e) { stateExists = "error: " + e.message; }
          try {
            const cRes = await githubFetch(env, CONFIG_PATH);
            configExists = cRes.ok ? "yes" : cRes.status === 404 ? "no (404)" : `error (${cRes.status})`;
          } catch (e) { configExists = "error: " + e.message; }
        }

        return json({
          env: {
            GITHUB_OWNER: owner,
            GITHUB_REPO: repo,
            GITHUB_BRANCH: branch,
            GITHUB_TOKEN: tokenSet,
            WORKER_API_SECRET: secretSet,
            ALLOWED_ORIGIN: allowedOrigin,
          },
          diagnostics: {
            gitHubStatus,
            stateJsonExists: stateExists,
            configJsonExists: configExists,
          },
        }, 200, c);
      }
      // ---- 诊断端点结束 ----

      // 刷新端点：逐个查询 iTunes 更新所有应用信息
      if (path === "/refresh" && req.method === "GET") {
        const cur = await getRepoFile(env, STATE_PATH);
        if (cur.missing) return json({ error: "state.json not found" }, 404, c);
        const state = cur.json;
        const apps = state.apps || [];
        const results = [];
        for (let i = 0; i < apps.length; i++) {
          const app = apps[i];
          const bundleId = app.bundleId;
          if (!bundleId) continue;
          try {
            const raw = await itunesLookup(bundleId);
            if (raw) {
              const items = raw.results || [];
              if (items.length > 0) {
                const track = items[0];
                app.listingStatus = "listed";
                if (track.trackName) app.trackName = track.trackName;
                const art = pickArtwork(track);
                if (art) app.artworkUrl100 = art;
                const storeVer = String(track.version || "").trim();
                if (storeVer) {
                  app.storeVersion = storeVer;
                  app.version = storeVer;
                }
                if (track.currentVersionReleaseDate) {
                  app.currentVersionReleaseDate = track.currentVersionReleaseDate;
                }
                app.lastCheckedAt = formatISO();
                results.push({ bundleId, status: "listed" });
              } else {
                app.listingStatus = "not_listed";
                app.lastCheckedAt = formatISO();
                results.push({ bundleId, status: "not_listed" });
              }
            } else {
              results.push({ bundleId, status: "lookup_failed" });
            }
          } catch {
            results.push({ bundleId, status: "error" });
          }
          // 逐个查询，间隔 200ms 避免被 iTunes API 限流
          if (i < apps.length - 1) {
            await new Promise(r => setTimeout(r, 200));
          }
        }
        state.meta = state.meta || {};
        state.meta.dataUpdatedAt = formatISO();
        await putRepoFile(env, STATE_PATH, state, "chore: refresh all apps via Worker", cur.sha);
        return json({ ok: true, updated: results.length, meta: state.meta }, 200, c);
      }

      if (path === "/state" && req.method === "GET") {
        const r = await getRepoFile(env, STATE_PATH);
        if (r.missing) return json({ error: "state.json not found" }, 404, c);
        return json(r.json, 200, c);
      }

      if (path === "/config" && req.method === "GET") {
        const r = await getRepoFile(env, CONFIG_PATH);
        if (r.missing) return json({ error: "config.json not found" }, 404, c);
        return json(r.json, 200, c);
      }

      if (path === "/api/v1" && req.method === "POST") {
        if (!requireAuth(req, env)) {
          return json({ error: "Unauthorized" }, 401, c);
        }
        let body;
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400, c);
        }
        const action = body.action;

        if (action === "saveConfig") {
          const cfg = body.config;
          if (!cfg || typeof cfg !== "object") return json({ error: "config required" }, 400, c);
          const cur = await getRepoFile(env, CONFIG_PATH);
          await putRepoFile(
            env,
            CONFIG_PATH,
            cfg,
            "chore: update monitor config via Worker",
            cur.missing ? undefined : cur.sha
          );
          return json({ ok: true }, 200, c);
        }

        if (action === "setMonitoring") {
          const bundleId = body.bundleId;
          if (!bundleId) return json({ error: "bundleId required" }, 400, c);
          const cur = await getRepoFile(env, STATE_PATH);
          if (cur.missing) return json({ error: "state missing" }, 404, c);
          const state = cur.json;
          const app = state.apps?.find((a) => a.bundleId === bundleId);
          if (!app) return json({ error: "app not found" }, 404, c);
          app.monitoring = !!body.monitoring;
          await putRepoFile(env, STATE_PATH, state, `chore: toggle monitoring ${bundleId}`, cur.sha);
          return json({ ok: true }, 200, c);
        }

        if (action === "addApp") {
          const bundleId = (body.bundleId || "").trim();
          if (!bundleId) return json({ error: "bundleId required" }, 400, c);
          const cur = await getRepoFile(env, STATE_PATH);
          if (cur.missing) return json({ error: "state missing" }, 404, c);
          const state = cur.json;
          state.apps = state.apps || [];
          if (state.apps.some((a) => a.bundleId === bundleId)) {
            return json({ error: "bundleId already exists" }, 409, c);
          }
          const app = newAppShell(bundleId);
          // 立即查询 iTunes API 获取真实信息（不区分国家地区）
          try {
            const raw = await itunesLookup(bundleId);
            if (raw) {
              const results = raw.results || [];
              if (results.length > 0) {
                const track = results[0];
                app.listingStatus = "listed";
                if (track.trackName) app.trackName = track.trackName;
                const art = pickArtwork(track);
                if (art) app.artworkUrl100 = art;
                const storeVer = String(track.version || "").trim();
                if (storeVer) {
                  app.storeVersion = storeVer;
                  app.version = storeVer;
                  app.lastKnownVersion = storeVer;
                }
                if (track.currentVersionReleaseDate) {
                  app.currentVersionReleaseDate = track.currentVersionReleaseDate;
                }
                app.versionChangeCount = 0;
                app.lastVersionChangeAt = formatISO();
                app.lastCheckedAt = formatISO();
              }
            }
          } catch {
            // iTunes 查询失败则使用默认值，不影响添加
          }
          state.apps.push(app);
          state.meta = state.meta || {};
          state.meta.dataUpdatedAt = formatISO();
          await putRepoFile(env, STATE_PATH, state, `chore: add app ${bundleId}`, cur.sha);
          return json({ ok: true }, 200, c);
        }

        if (action === "deleteApp") {
          const bundleId = body.bundleId;
          if (!bundleId) return json({ error: "bundleId required" }, 400, c);
          const cur = await getRepoFile(env, STATE_PATH);
          if (cur.missing) return json({ error: "state missing" }, 404, c);
          const state = cur.json;
          const before = state.apps?.length || 0;
          state.apps = (state.apps || []).filter((a) => a.bundleId !== bundleId);
          if (state.apps.length === before) return json({ error: "app not found" }, 404, c);
          await putRepoFile(env, STATE_PATH, state, `chore: remove app ${bundleId}`, cur.sha);
          return json({ ok: true }, 200, c);
        }

        return json({ error: "unknown action" }, 400, c);
      }

      return json({ error: "Not found" }, 404, c);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, c);
    }
  },
};
