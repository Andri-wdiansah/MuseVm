#!/usr/bin/env python3
"""Collect fresh metrics and deploy the dashboard to Vercel.

Steps:
  1. Run collect.py (refreshes site/data.json + history.json).
  2. Ensure the Vercel project exists (get_project, else create_project).
     If project lookup is blocked (e.g. team-scope 403), proceed anyway:
     create_deployment creates the project implicitly from `name`.
  3. Deploy the site files inline via the Vercel MCP create_deployment
     (target: production, no custom domain, no purchase).
  4. Poll get_deployment until READY and print the live URL.

Safe to run from cron: all subprocess calls have timeouts, output is
logged to deploy.log, exit code 0 means the deployment reached READY.

Writes to Vercel may require the user's approval on the approval card;
the CLI call waits for that decision (bounded by WRITE_TIMEOUT_S).
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

BASE = "/home/hatch/workspace/muse-dashboard"
SITE = os.path.join(BASE, "site")
LOG_PATH = os.path.join(BASE, "deploy.log")
VERCEL_BIN = "/opt/hatch/bin/vercel"
PROJECT_NAME = "muse-status-dashboard"
SITE_FILES = ["index.html", "styles.css", "app.js", "data.json"]

READ_TIMEOUT_S = 90
WRITE_TIMEOUT_S = 600
POLL_INTERVAL_S = 15
POLL_MAX_WAIT_S = 600


def log(msg):
    line = "[%s] %s" % (
        datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), msg)
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def run(cmd, timeout):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode == 0, proc.stdout.strip()
    except subprocess.TimeoutExpired:
        return False, "timed out after %ss" % timeout
    except Exception as exc:
        return False, str(exc)


def vercel_tool(tool, args, timeout):
    """Call a Vercel MCP tool. Returns (inner_dict_or_None, error_str)."""
    ok, out = run(
        [VERCEL_BIN, "call-tool", "--name", tool,
         "--arguments-json", json.dumps(args)],
        timeout=timeout,
    )
    if not ok:
        return None, "command failed: " + out[:300]
    try:
        outer = json.loads(out)
    except json.JSONDecodeError:
        return None, "unparsable CLI output: " + out[:200]
    try:
        inner = json.loads(outer["result"]["content"][0]["text"])
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        return None, "unparsable MCP result: " + out[:200]
    if isinstance(inner, dict) and "error" in inner:
        err = inner["error"]
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        code = err.get("code") if isinstance(err, dict) else None
        return None, "%s%s" % (("[" + code + "] ") if code else "", msg[:400])
    return inner, ""


def ensure_project():
    """Return True when the project exists or was created.

    A lookup blocked by authorisation (team-scope 403) returns 'unknown'
    so the caller can still attempt the deployment, which creates the
    project implicitly.
    """
    inner, err = vercel_tool(
        "get_project", {"idOrName": PROJECT_NAME}, READ_TIMEOUT_S)
    if inner:
        log("project '%s' already exists" % PROJECT_NAME)
        return True
    log("get_project: %s" % (err or "unknown error"))
    if "404" in (err or "") or "not found" in (err or "").lower():
        inner, err = vercel_tool(
            "create_project", {"requestBody": {"name": PROJECT_NAME}},
            WRITE_TIMEOUT_S)
        if inner:
            log("project '%s' created" % PROJECT_NAME)
            return True
        if "already exists" in (err or "").lower():
            log("project '%s' already exists (create raced)" % PROJECT_NAME)
            return True
        log("create_project failed: %s" % (err or "unknown error"))
        return False
    # Lookup blocked (e.g. 403 team scope): deployment may still work.
    log("project lookup inconclusive; proceeding to deployment "
        "(create_deployment creates the project if missing)")
    return "unknown"


def create_deployment(files):
    args = {
        "requestBody": {
            "name": PROJECT_NAME,
            "target": "production",
            "meta": {"created-by": "muse-dashboard", "source": "hatch"},
            "files": files,
        },
        "skipAutoDetectionConfirmation": "1",
    }
    inner, err = vercel_tool("create_deployment", args, WRITE_TIMEOUT_S)
    if inner is None:
        return None, err
    result = inner.get("result", inner)
    dep_id = result.get("id") or result.get("uid")
    url = result.get("url")
    return {"id": dep_id, "url": url, "raw": result}, ""


def poll_ready(dep_id):
    waited = 0
    last_state = None
    while waited < POLL_MAX_WAIT_S:
        inner, err = vercel_tool(
            "get_deployment", {"idOrUrl": dep_id}, READ_TIMEOUT_S)
        if inner:
            result = inner.get("result", inner)
            state = result.get("state") or result.get("readyState")
            last_state = state
            if state in ("READY", "ready"):
                aliases = result.get("alias") or []
                return True, state, result.get("url"), aliases
            if state in ("ERROR", "error", "CANCELED", "canceled"):
                return False, state, result.get("url"), []
            log("deployment state: %s (waited %ss)" % (state, waited))
        else:
            log("get_deployment: %s" % (err or "unknown error"))
        time.sleep(POLL_INTERVAL_S)
        waited += POLL_INTERVAL_S
    return False, last_state or "timeout", None, []


def main():
    log("=== deploy run started ===")
    ok, out = run([sys.executable, os.path.join(BASE, "collect.py")],
                  timeout=300)
    log("collect.py: " + ("ok" % () if ok else "FAILED: " + out[-300:]))
    if not ok:
        log("aborting: collector failed")
        return 2

    files = []
    for name in SITE_FILES:
        path = os.path.join(SITE, name)
        try:
            with open(path, encoding="utf-8") as f:
                content = f.read()
        except OSError as exc:
            log("cannot read %s: %s" % (path, exc))
            return 2
        files.append({"file": name, "data": content, "encoding": "utf-8"})
    log("bundled %d files (%d bytes total)"
        % (len(files), sum(len(f["data"]) for f in files)))

    project_ok = ensure_project()
    if project_ok is False:
        log("aborting: project could not be ensured")
        return 3

    dep, err = create_deployment(files)
    if dep is None:
        log("create_deployment failed: %s" % (err or "unknown error"))
        return 4
    log("deployment created: id=%s url=%s" % (dep["id"], dep["url"]))
    if not dep["id"]:
        log("no deployment id returned; raw result: %s"
            % json.dumps(dep["raw"])[:500])
        return 4

    ready, state, url, aliases = poll_ready(dep["id"])
    live_url = None
    if aliases:
        live_url = "https://" + aliases[0]
    elif url:
        live_url = "https://" + url if not url.startswith("http") else url
    log("deployment state: %s, live url: %s" % (state, live_url))
    if ready:
        log("=== deploy OK: %s ===" % live_url)
        print("LIVE_URL=" + (live_url or ""))
        return 0
    log("=== deploy did not reach READY (state=%s) ===" % state)
    return 5


if __name__ == "__main__":
    sys.exit(main())
