#!/usr/bin/env python3
"""Collect Muse/VM status metrics and write site/data.json.

Sources (all local, read-only):
  - /proc + shutil for VM metrics (uptime, load, CPU count, memory, disk)
  - `subscription-status status` for the Muse subscription / token usage
  - /opt/hatch/bin/github (status, accounts) for the GitHub connector
  - /opt/hatch/bin/vercel (status, get_auth_user, list_deployments) for Vercel

Also appends one token/VM snapshot per hour to history.json so the
dashboard's history charts build up over time. Never fails hard: a broken
section is recorded as an error string and the rest still ships.
"""

import json
import os
import re
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone

BASE = "/home/hatch/workspace/muse-dashboard"
SITE = os.path.join(BASE, "site")
DATA_PATH = os.path.join(SITE, "data.json")
HISTORY_PATH = os.path.join(BASE, "history.json")
HISTORY_INTERVAL_S = 3600  # max one snapshot per hour
HISTORY_MAX = 2000

GITHUB_BIN = "/opt/hatch/bin/github"
VERCEL_BIN = "/opt/hatch/bin/vercel"


def run(cmd, timeout=60):
    """Run a command, return (ok, stdout). Never raises."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return proc.returncode == 0, proc.stdout.strip()
    except Exception as exc:  # timeout, missing binary, ...
        return False, str(exc)


def mcp_text_output(bin_path, tool, args, timeout=90):
    """Call a hatch MCP CLI read tool and return the parsed inner JSON.

    The CLI wraps the MCP result as {"ok": ..., "result": {"content":
    [{"text": "<json string>"}]}}. Returns (parsed_dict_or_None, error_str).
    """
    ok, out = run(
        [bin_path, "call-tool", "--name", tool,
         "--arguments-json", json.dumps(args)],
        timeout=timeout,
    )
    if not ok:
        return None, "command failed: " + out[:200]
    try:
        outer = json.loads(out)
    except json.JSONDecodeError:
        return None, "unparsable CLI output"
    try:
        inner = json.loads(outer["result"]["content"][0]["text"])
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        return None, "unparsable MCP result"
    if isinstance(inner, dict) and "error" in inner:
        err = inner["error"]
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        return None, msg[:300]
    return inner, ""


def human_duration(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return "%d sec" % seconds
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return "%d min" % minutes
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return "%d h %d min" % (hours, minutes)
    days, hours = divmod(hours, 24)
    return "%d d %d h" % (days, hours)


def collect_vm():
    vm = {}
    try:
        with open("/proc/uptime") as f:
            vm["uptime_s"] = float(f.read().split()[0])
    except Exception:
        vm["uptime_s"] = None
    try:
        with open("/proc/loadavg") as f:
            parts = f.read().split()
        vm["load1"], vm["load5"], vm["load15"] = (
            float(parts[0]), float(parts[1]), float(parts[2]))
    except Exception:
        vm["load1"] = vm["load5"] = vm["load15"] = None
    vm["cpus"] = os.cpu_count()
    try:
        meminfo = {}
        with open("/proc/meminfo") as f:
            for line in f:
                key, _, val = line.partition(":")
                meminfo[key] = int(val.split()[0]) * 1024  # kB -> bytes
        total = meminfo.get("MemTotal")
        avail = meminfo.get("MemAvailable")
        if total and avail is not None:
            vm["mem_total_bytes"] = total
            vm["mem_avail_bytes"] = avail
            vm["mem_used_bytes"] = total - avail
            vm["mem_pct"] = round((total - avail) / total * 100, 1)
    except Exception:
        pass
    try:
        du = shutil.disk_usage("/home/hatch")
        vm["disk_total_bytes"] = du.total
        vm["disk_used_bytes"] = du.used
        vm["disk_free_bytes"] = du.free
        vm["disk_pct"] = round(du.used / du.total * 100, 1) if du.total else None
    except Exception:
        pass
    try:
        vm["hostname"] = socket.gethostname()
    except Exception:
        vm["hostname"] = None
    if vm.get("uptime_s") is not None:
        vm["uptime_human"] = human_duration(vm["uptime_s"])
    return vm


def collect_subscription():
    sub = {"plan": None, "weekly_pct": None, "reset": None,
           "additional_pct": None, "additional_left": None, "error": None}
    ok, out = run(["subscription-status", "status"], timeout=30)
    if not ok or not out:
        sub["error"] = "subscription-status unavailable"
        return sub
    if "does not have a subscription" in out:
        sub["plan"] = "Free"
    m = re.search(r"Usage:\s*([\d.]+)% of free weekly limit", out)
    if m:
        sub["weekly_pct"] = float(m.group(1))
    m = re.search(r"Weekly limit resets\s+(.+)", out)
    if m:
        sub["reset"] = m.group(1).strip()
    m = re.search(r"Additional tokens:\s*([\d.]+)% used\s*\((.+?)\s+left\)", out)
    if m:
        sub["additional_pct"] = float(m.group(1))
        sub["additional_left"] = m.group(2).strip()
    if sub["weekly_pct"] is None and sub["plan"] is None:
        sub["error"] = "could not parse subscription output"
    return sub


def collect_github():
    gh = {"connected": False, "login": None, "error": None}
    ok, out = run([GITHUB_BIN, "status"], timeout=60)
    if ok:
        try:
            st = json.loads(out)
            gh["connected"] = bool(st.get("authenticated"))
        except json.JSONDecodeError:
            gh["error"] = "unparsable github status"
    else:
        gh["error"] = "github status failed"
    if gh["connected"]:
        ok, out = run([GITHUB_BIN, "accounts"], timeout=60)
        if ok:
            try:
                accs = json.loads(out).get("accounts", [])
                default = next((a for a in accs if a.get("is_default")), None)
                chosen = default or (accs[0] if accs else None)
                if chosen:
                    gh["login"] = chosen.get("display_name")
            except json.JSONDecodeError:
                gh["error"] = "unparsable github accounts"
    return gh


def collect_vercel():
    vc = {"connected": False, "username": None, "plan": None, "error": None}
    ok, out = run([VERCEL_BIN, "status"], timeout=60)
    if ok:
        try:
            st = json.loads(out)
            vc["connected"] = bool(st.get("authenticated"))
        except json.JSONDecodeError:
            vc["error"] = "unparsable vercel status"
    else:
        vc["error"] = "vercel status failed"
    if vc["connected"]:
        inner, err = mcp_text_output(VERCEL_BIN, "get_auth_user", {})
        if inner:
            user = inner.get("result", {}).get("user", {})
            vc["username"] = user.get("username")
            billing = user.get("billing") or {}
            vc["plan"] = billing.get("plan")
        elif err:
            vc["error"] = err[:200]
    return vc


def collect_deployments():
    """Latest Vercel deployments (max 10). Returns (list, error_str)."""
    inner, err = mcp_text_output(
        VERCEL_BIN, "list_deployments", {"limit": 10})
    if inner is None:
        return [], err
    raw = inner.get("result", {}).get("deployments", [])
    deployments = []
    for d in raw[:10]:
        created = d.get("createdAt")
        created_iso = None
        if isinstance(created, (int, float)):
            created_iso = datetime.fromtimestamp(
                created / 1000, tz=timezone.utc).isoformat()
        deployments.append({
            "name": d.get("name"),
            "url": d.get("url"),
            "state": d.get("state"),
            "target": d.get("target"),
            "created_at": created_iso,
        })
    return deployments, ""


def load_history():
    try:
        with open(HISTORY_PATH) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def maybe_append_history(history, snapshot):
    now = snapshot["ts"]
    if history and now - history[-1].get("ts", 0) < HISTORY_INTERVAL_S:
        return history, False
    history.append(snapshot)
    if len(history) > HISTORY_MAX:
        history = history[-HISTORY_MAX:]
    try:
        with open(HISTORY_PATH, "w") as f:
            json.dump(history, f)
    except OSError:
        pass
    return history, True


def main():
    vm = collect_vm()
    sub = collect_subscription()
    gh = collect_github()
    vc = collect_vercel()
    deployments, dep_error = collect_deployments()

    now = int(time.time())
    snapshot = {
        "ts": now,
        "weekly_pct": sub.get("weekly_pct"),
        "additional_left": sub.get("additional_left"),
        "load1": vm.get("load1"),
        "mem_pct": vm.get("mem_pct"),
        "disk_pct": vm.get("disk_pct"),
        "uptime_s": vm.get("uptime_s"),
    }
    history = load_history()
    history, appended = maybe_append_history(history, snapshot)

    data = {
        "generated_at": datetime.fromtimestamp(
            now, tz=timezone.utc).isoformat(),
        "vm": vm,
        "subscription": sub,
        "connectors": {"github": gh, "vercel": vc},
        "deployments": deployments,
        "deployments_error": dep_error or None,
        "history": history,
        "history_points": len(history),
        "snapshot_appended": appended,
    }
    os.makedirs(SITE, exist_ok=True)
    with open(DATA_PATH, "w") as f:
        json.dump(data, f, indent=1)
    print("wrote %s (history points: %d, appended: %s)"
          % (DATA_PATH, len(history), appended))
    if dep_error:
        print("deployments unavailable:", dep_error[:160])


if __name__ == "__main__":
    main()
