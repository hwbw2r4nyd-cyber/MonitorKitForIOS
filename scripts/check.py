#!/usr/bin/env python3
"""
App Store 监听脚本：读取 config.json / state.json，调用 iTunes Lookup，更新 state，按需通过 Resend 发信。
仅使用 Python 标准库。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, time
from pathlib import Path
from zoneinfo import ZoneInfo

# —— 与 README 一致：长期无变动按「自然日」计算（日历日差，按配置的 timezone）——
STALE_NATURAL_DAYS = 15
STALE_NOTIFY_COOLDOWN_NATURAL_DAYS = 15

REPO_ROOT = Path(os.environ.get("GITHUB_WORKSPACE", os.getcwd())).resolve()
CONFIG_PATH = REPO_ROOT / "config.json"
STATE_PATH = REPO_ROOT / "state.json"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def now_utc() -> datetime:
    return datetime.now(tz=ZoneInfo("UTC"))


def parse_iso(dt: str | None) -> datetime | None:
    if not dt:
        return None
    try:
        return datetime.fromisoformat(dt.replace("Z", "+00:00"))
    except ValueError:
        return None


def format_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(ZoneInfo("UTC")).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_hh_mm(s: str) -> time:
    parts = s.strip().split(":")
    h = int(parts[0])
    m = int(parts[1]) if len(parts) > 1 else 0
    return time(h, m, 0)


def within_window(cfg: dict, when_utc: datetime) -> bool:
    tz_name = cfg.get("timezone") or "Asia/Shanghai"
    tz = ZoneInfo(tz_name)
    local = when_utc.astimezone(tz)
    win = cfg.get("window") or {}
    start_s = win.get("start", "09:00")
    end_s = win.get("end", "19:00")
    start_t = parse_hh_mm(start_s)
    end_t = parse_hh_mm(end_s)
    cur = local.time()
    # 区间含起始、不含结束端点与日跨边界简化：假定 start < end 同一天
    return start_t <= cur < end_t


def interval_elapsed(cfg: dict, meta: dict, when_utc: datetime) -> bool:
    interval = int(cfg.get("intervalMinutes") or 60)
    last_s = meta.get("lastScheduledRunAt")
    if not last_s:
        return True
    last = parse_iso(last_s)
    if last is None:
        return True
    delta = when_utc - last.astimezone(ZoneInfo("UTC"))
    return delta >= timedelta(minutes=interval)


def natural_days_between(start: datetime, end: datetime, tz_name: str) -> int:
    """按 timezone 将两个 UTC 时刻映射到日历日后求日序差（end 日期 - start 日期）。"""
    tz = ZoneInfo(tz_name)
    d0 = start.astimezone(tz).date()
    d1 = end.astimezone(tz).date()
    return (d1 - d0).days


def itunes_lookup(bundle_id: str) -> dict | None:
    q = urllib.parse.urlencode({"bundleId": bundle_id})
    url = f"https://itunes.apple.com/lookup?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": "MonitorKitForIOS/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
        data = json.loads(body)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    return data


def pick_artwork(track: dict) -> str | None:
    for key in ("artworkUrl512", "artworkUrl100", "artworkUrl60"):
        if track.get(key):
            return track[key]
    return None


def send_resend(html: str, subject: str, cfg: dict | None = None) -> None:
    api_key = os.environ.get("RESEND_API_KEY")
    from_addr = os.environ.get("RESEND_FROM")
    # 优先从 config.json 读取通知邮箱，否则回退环境变量
    to_addr = (cfg or {}).get("notifyEmail") or os.environ.get("NOTIFY_EMAIL")
    if not api_key or not from_addr or not to_addr:
        return
    payload = json.dumps(
        {"from": from_addr, "to": [to_addr], "subject": subject, "html": html}
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"Resend HTTPError {e.code}: {err_body}", file=sys.stderr)


def main() -> int:
    cfg = load_json(CONFIG_PATH)
    state = load_json(STATE_PATH)
    meta = state.setdefault("meta", {})
    apps = state.setdefault("apps", [])
    utc_now = now_utc()

    if not within_window(cfg, utc_now):
        print("Outside monitoring window; skip.")
        return 0

    if not interval_elapsed(cfg, meta, utc_now):
        print("Interval not elapsed; skip.")
        return 0

    tz_name = cfg.get("timezone") or "Asia/Shanghai"

    for app in apps:
        if not app.get("monitoring", True):
            continue

        bundle_id = app.get("bundleId")
        if not bundle_id:
            continue

        raw = itunes_lookup(bundle_id)
        app["lastCheckedAt"] = format_iso(utc_now)

        if raw is None:
            continue

        results = raw.get("results") or []
        if len(results) == 0:
            app["listingStatus"] = "not_listed"
            continue

        track = results[0]
        app["listingStatus"] = "listed"
        store_version = str(track.get("version") or "").strip()
        track_name = track.get("trackName")
        artwork = pick_artwork(track)
        release_date_raw = track.get("currentVersionReleaseDate")

        if track_name:
            app["trackName"] = track_name
        if artwork:
            app["artworkUrl100"] = artwork
        if store_version:
            app["storeVersion"] = store_version
            app["version"] = store_version
        if release_date_raw:
            app["currentVersionReleaseDate"] = release_date_raw

        last_known = app.get("lastKnownVersion")
        # 首次成功读到版本：基线，不加分、不发更新邮件
        if last_known is None or last_known == "":
            if store_version:
                app["lastKnownVersion"] = store_version
                app.setdefault("versionChangeCount", 0)
                app["lastVersionChangeAt"] = format_iso(utc_now)
                app.setdefault("history", [])
            continue

        if store_version and store_version != last_known:
            app["versionChangeCount"] = int(app.get("versionChangeCount") or 0) + 1
            app["lastKnownVersion"] = store_version
            app["version"] = store_version
            app["lastVersionChangeAt"] = format_iso(utc_now)
            app["lastStaleNotifyAt"] = None
            hist = app.setdefault("history", [])
            hist.append({"version": store_version, "recordedAt": format_iso(utc_now)})

            name = app.get("trackName") or bundle_id
            subject = f"[App Store] 版本更新：{name} ({bundle_id}) → {store_version}"
            html = (
                f"<p>应用：<strong>{name}</strong></p>"
                f"<p>bundleId：<code>{bundle_id}</code></p>"
                f"<p>新版本：<strong>{store_version}</strong></p>"
                f"<p>记录时间（UTC）：{format_iso(utc_now)}</p>"
            )
            send_resend(html, subject, cfg)
            continue

        # 版本未变：长期无变动提醒
        last_change_s = app.get("lastVersionChangeAt")
        last_change = parse_iso(last_change_s) if last_change_s else None
        last_stale_s = app.get("lastStaleNotifyAt")
        last_stale = parse_iso(last_stale_s) if last_stale_s else None

        if (
            store_version
            and last_change
            and natural_days_between(last_change, utc_now, tz_name) >= STALE_NATURAL_DAYS
        ):
            can_notify = last_stale is None or natural_days_between(
                last_stale, utc_now, tz_name
            ) >= STALE_NOTIFY_COOLDOWN_NATURAL_DAYS
            if can_notify:
                name = app.get("trackName") or bundle_id
                subject = f"[App Store] 长期无版本变动：{name} ({bundle_id})"
                html = (
                    f"<p>应用：<strong>{name}</strong></p>"
                    f"<p>bundleId：<code>{bundle_id}</code></p>"
                    f"<p>当前商店版本仍为：<strong>{store_version}</strong></p>"
                    f"<p>自上次版本变动记录起已满 {STALE_NATURAL_DAYS} 个自然日（{tz_name}）。</p>"
                )
                send_resend(html, subject, cfg)
                app["lastStaleNotifyAt"] = format_iso(utc_now)

    meta["lastScheduledRunAt"] = format_iso(utc_now)
    meta["dataUpdatedAt"] = format_iso(utc_now)
    save_json(STATE_PATH, state)
    print("Check completed; state.json updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
