/* Hirthcrea — Muse status dashboard.
   Loads data.json (written by collect.py) and renders all views.
   All code here is original. */
(function () {
  "use strict";

  var state = { data: null, range: "24h", view: "overview", query: "" };

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function num(v, d) { return (v === null || v === undefined || isNaN(v)) ? "–" : Number(v).toFixed(d); }
  function fmtBytes(b) {
    if (b === null || b === undefined) return "–";
    var units = ["B", "KiB", "MiB", "GiB", "TiB"];
    var i = 0, v = b;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)) + " " + units[i];
  }
  function fmtTime(ts) {
    return new Date(ts * 1000).toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }
  function fmtClock(ts) {
    return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  function fmtDay(ts) {
    return new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function countUp(el, target, decimals) {
    if (!el || target === null || target === undefined || isNaN(target)) { if (el) el.textContent = "–"; return; }
    var start = null, dur = 900;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      el.textContent = (target * easeOut(p)).toFixed(decimals);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function setRing(circle, pct, r) {
    if (!circle) return;
    var c = 2 * Math.PI * r;
    var p = Math.max(0, Math.min(100, pct || 0));
    circle.style.strokeDasharray = c.toFixed(1);
    circle.style.strokeDashoffset = c.toFixed(1);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        circle.style.strokeDashoffset = (c * (1 - p / 100)).toFixed(1);
      });
    });
  }

  function sparkline(container, values, color) {
    if (!container) return;
    if (!values || values.length === 0) { container.innerHTML = ""; return; }
    var pts = values.slice(-24);
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    var range = (max - min) || 1;
    var w = 100, h = 30, pad = 2;
    var coords = pts.map(function (v, i) {
      var x = pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w;
      var y = h - pad - ((v - min) / range) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var line = coords.length === 1 ? coords[0] + " " + coords[0] : coords.join(" ");
    container.innerHTML =
      '<svg viewBox="0 0 100 30" preserveAspectRatio="none">' +
      '<polyline points="' + line + '" fill="none" stroke="' + color +
      '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>";
  }

  /* ---------- chart (lollipop bars) ---------- */
  function filterByRange(history, range) {
    var now = Date.now() / 1000;
    var span = range === "24h" ? 86400 : range === "7d" ? 7 * 86400 : 30 * 86400;
    return history.filter(function (p) { return p.ts >= now - span; });
  }

  function buildChart(container, points, opts) {
    if (!container) return;
    if (!points || points.length === 0) {
      container.innerHTML = '<div class="chart-empty">' + (opts.emptyText || "No snapshots in this range yet.") + "</div>";
      return;
    }
    var maxPts = 30;
    var shown = points.length > maxPts
      ? points.filter(function (_, i) { return i % Math.ceil(points.length / maxPts) === 0; })
      : points;
    var gridHtml = '<div class="chart-grid">';
    [100, 75, 50, 25, 0].forEach(function (g) {
      gridHtml += '<div class="chart-grid-line" style="bottom:' + g + '%"><span>' + g + "%</span></div>";
    });
    gridHtml += "</div>";
    var barsHtml = '<div class="chart-bars">';
    shown.forEach(function (p, i) {
      var v = Math.max(0, Math.min(100, p.weekly_pct == null ? 0 : p.weekly_pct));
      var isLast = i === shown.length - 1;
      barsHtml += '<div class="bar-col' + (isLast ? " latest" : "") + '" style="transition-delay:' + (i * 35) + 'ms">' +
        '<div class="bar-stem" style="height:' + Math.max(v, 1.5) + '%;transition-delay:' + (i * 35) + 'ms" title="' +
        esc(fmtTime(p.ts)) + " — " + num(p.weekly_pct, 0) + '%"></div>' +
        '<div class="bar-dot"></div></div>';
    });
    barsHtml += "</div>";
    var labelEvery = Math.max(1, Math.ceil(shown.length / 10));
    var labelsHtml = '<div class="bar-label">';
    shown.forEach(function (p, i) {
      var label = (i % labelEvery === 0 || i === shown.length - 1)
        ? (opts.labelDay ? fmtDay(p.ts) : fmtClock(p.ts)) : "";
      labelsHtml += "<span>" + esc(label) + "</span>";
    });
    labelsHtml += "</div>";
    container.innerHTML = gridHtml + barsHtml + labelsHtml;
    requestAnimationFrame(function () {
      container.querySelectorAll(".bar-col").forEach(function (el) { el.classList.add("shown"); });
    });
  }

  /* ---------- render: overview ---------- */
  function renderOverview() {
    var d = state.data, vm = d.vm, sub = d.subscription, hist = d.history || [];
    var weekly = sub.weekly_pct;

    var depPart = d.deployments && d.deployments.length
      ? d.deployments.length + " deployments"
      : "deployments unavailable";
    $("ovSub").textContent =
      num(weekly, 0) + "% of the free weekly token limit used · " + depPart +
      " · GitHub & Vercel connected";

    countUp($("kpiCpu"), vm.load1, 2);
    $("kpiCpuSub").textContent = "1 min average · " + (vm.cpus || "–") + " CPUs · load " +
      num(vm.load5, 2) + " / " + num(vm.load15, 2) + " (5m / 15m)";
    sparkline($("kpiCpuSpark"), hist.map(function (p) { return p.load1; }).filter(function (v) { return v != null; }), "#FFFFFF");

    countUp($("kpiMem"), vm.mem_pct, 1);
    $("kpiMemSub").textContent = fmtBytes(vm.mem_used_bytes) + " of " + fmtBytes(vm.mem_total_bytes) + " used";
    sparkline($("kpiMemSpark"), hist.map(function (p) { return p.mem_pct; }).filter(function (v) { return v != null; }), "#FF6B35");

    countUp($("kpiDisk"), vm.disk_pct, 1);
    $("kpiDiskSub").textContent = fmtBytes(vm.disk_used_bytes) + " of " + fmtBytes(vm.disk_total_bytes) + " used";
    sparkline($("kpiDiskSpark"), hist.map(function (p) { return p.disk_pct; }).filter(function (v) { return v != null; }), "#FF6B35");

    $("kpiUp").textContent = vm.uptime_human || "–";
    $("kpiUpSub").textContent = "since last boot" + (vm.hostname ? " · " + vm.hostname : "");
    sparkline($("kpiUpSpark"), hist.map(function (p) { return p.uptime_s; }).filter(function (v) { return v != null; }), "#FF6B35");

    var pts = filterByRange(hist, state.range);
    var peak = pts.reduce(function (m, p) { return Math.max(m, p.weekly_pct || 0); }, 0);
    $("csNow").textContent = num(weekly, 0) + "%";
    $("csPeak").textContent = num(peak, 0) + "%";
    $("csCount").textContent = String(pts.length);
    buildChart($("ovChart"), pts, { labelDay: state.range !== "24h" });
    $("ovChartNote").textContent = hist.length < 8
      ? "History builds over time — " + hist.length + " snapshot" + (hist.length === 1 ? "" : "s") +
        " so far, first taken " + (hist.length ? fmtTime(hist[0].ts) : "today") + "."
      : hist.length + " snapshots, first taken " + fmtTime(hist[0].ts) + ".";

    $("subPlan").textContent = sub.plan || "Free";
    countUp($("subWeeklyPct"), weekly, 0);
    var bar = $("subWeeklyBar");
    bar.style.width = "0%";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { bar.style.width = Math.min(100, weekly || 0) + "%"; });
    });
    $("subReset").textContent = sub.reset || "–";
    $("subAdditional").textContent = (sub.additional_left || "–") +
      (sub.additional_pct != null ? " · " + num(sub.additional_pct, 0) + "% used" : "");

    setRing($("ringBig"), weekly, 58);
    $("ringBigPct").textContent = num(weekly, 0) + "%";
    $("ringSub").textContent = "of free weekly limit";
    $("ringFoot").textContent = "Resets " + (sub.reset || "soon") + " · plan " + (sub.plan || "Free");

    setRing($("sideRing"), weekly, 18);
    $("sideRingPct").textContent = num(weekly, 0) + "%";
    $("sideWeeklySub").textContent = "of free limit used";
  }

  /* ---------- render: VM ---------- */
  function renderVm() {
    var vm = state.data.vm;
    var cpuPct = (vm.load1 != null && vm.cpus) ? (vm.load1 / vm.cpus) * 100 : null;
    countUp($("vmCpuPct"), cpuPct, 0);
    var cpuBar = $("vmCpuBar");
    cpuBar.style.width = "0%";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { cpuBar.style.width = Math.min(100, cpuPct || 0) + "%"; });
    });
    $("vmLoadNums").textContent = "Load " + num(vm.load1, 2) + " · " + num(vm.load5, 2) + " · " + num(vm.load15, 2) + "  (1m / 5m / 15m)";

    countUp($("vmMemPct"), vm.mem_pct, 1);
    var memBar = $("vmMemBar");
    memBar.style.width = "0%";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { memBar.style.width = Math.min(100, vm.mem_pct || 0) + "%"; });
    });
    $("vmMemNums").textContent = fmtBytes(vm.mem_used_bytes) + " used · " + fmtBytes(vm.mem_avail_bytes) + " available";

    countUp($("vmDiskPct"), vm.disk_pct, 1);
    var diskBar = $("vmDiskBar");
    diskBar.style.width = "0%";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { diskBar.style.width = Math.min(100, vm.disk_pct || 0) + "%"; });
    });
    $("vmDiskNums").textContent = fmtBytes(vm.disk_used_bytes) + " used · " + fmtBytes(vm.disk_free_bytes) + " free";

    $("vmUp").textContent = vm.uptime_human || "–";
    $("vmHost").textContent = vm.hostname ? "Host " + vm.hostname : "";
    $("vmCpus").textContent = (vm.cpus || "–") + " CPU cores";

    var items = [
      ["Hostname", vm.hostname || "–"],
      ["CPU cores", vm.cpus != null ? String(vm.cpus) : "–"],
      ["Load average", num(vm.load1, 2) + " / " + num(vm.load5, 2) + " / " + num(vm.load15, 2)],
      ["Memory total", fmtBytes(vm.mem_total_bytes)],
      ["Memory used", fmtBytes(vm.mem_used_bytes)],
      ["Memory available", fmtBytes(vm.mem_avail_bytes)],
      ["Disk total", fmtBytes(vm.disk_total_bytes)],
      ["Disk used", fmtBytes(vm.disk_used_bytes)],
      ["Disk free", fmtBytes(vm.disk_free_bytes)],
      ["Uptime", vm.uptime_human || "–"]
    ];
    $("vmDetail").innerHTML = items.map(function (it) {
      return '<div class="detail-item"><span>' + esc(it[0]) + "</span><strong>" + esc(it[1]) + "</strong></div>";
    }).join("");
  }

  /* ---------- render: tokens ---------- */
  function renderTokens() {
    var hist = state.data.history || [];
    var pts = filterByRange(hist, state.range);
    buildChart($("tokChart"), pts, { labelDay: state.range !== "24h" });
    $("tokNote").textContent = hist.length < 8
      ? "History builds over time — snapshots are taken at most once per hour, and the first one was " + (hist.length ? fmtTime(hist[0].ts) : "today") + "."
      : hist.length + " snapshots in total.";
    var rows = hist.slice().reverse().map(function (p) {
      return "<tr><td>" + esc(fmtTime(p.ts)) + "</td><td><strong>" + num(p.weekly_pct, 0) +
        "%</strong></td><td>" + esc(p.additional_left || "–") + "</td><td>" + num(p.load1, 2) +
        "</td><td>" + num(p.mem_pct, 1) + "%</td></tr>";
    }).join("");
    $("tokTableBody").innerHTML = rows || '<tr><td colspan="5" class="muted">No snapshots yet.</td></tr>';
    $("tokFirst").textContent = hist.length
      ? "First snapshot: " + fmtTime(hist[0].ts) + " · snapshots are kept for history and refresh with each data update."
      : "";
  }

  /* ---------- render: deployments ---------- */
  function stateClass(s) {
    s = (s || "").toUpperCase();
    if (s === "READY") return "ready";
    if (s === "ERROR" || s === "FAILED" || s === "CANCELED") return "error";
    if (s === "BUILDING" || s === "QUEUED" || s === "INITIALIZING") return "building";
    return "other";
  }

  function renderDeployments() {
    var d = state.data;
    var list = $("depList"), empty = $("depEmpty");
    var deps = (d.deployments || []).filter(function (dep) {
      if (!state.query) return true;
      var hay = ((dep.name || "") + " " + (dep.url || "") + " " + (dep.state || "") + " " + (dep.target || "")).toLowerCase();
      return hay.indexOf(state.query.toLowerCase()) !== -1;
    });
    $("depBadge").textContent = d.deployments ? String(d.deployments.length) : "–";
    if (!d.deployments || d.deployments.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      var scope = "";
      if (d.deployments_error) {
        var m = d.deployments_error.match(/scope\s+"([^"]+)"/);
        if (m) scope = " The Vercel connection is not authorised for the team scope “" + m[1] + "” yet.";
      }
      $("depEmptyText").textContent = "Vercel could not list deployments for this connection." + scope;
      return;
    }
    empty.hidden = true;
    if (deps.length === 0) {
      list.innerHTML = '<div class="card empty-state"><p>No deployments match “' + esc(state.query) + '”.</p></div>';
      return;
    }
    list.innerHTML = deps.map(function (dep) {
      var created = dep.created_at
        ? new Date(dep.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
        : "–";
      return '<div class="dep-row">' +
        '<span class="dep-state ' + stateClass(dep.state) + '">' + esc(dep.state || "unknown") + "</span>" +
        '<div><div class="dep-name">' + esc(dep.name || "deployment") + "</div>" +
        '<div class="dep-meta">' + esc(dep.target || "preview") + " · " + esc(created) + "</div></div>" +
        (dep.url ? '<a class="dep-link" href="https://' + esc(dep.url) + '" target="_blank" rel="noopener">Open ↗</a>' : "") +
        "</div>";
    }).join("");
  }

  /* ---------- render: connectors ---------- */
  function renderConnectors() {
    var c = state.data.connectors || {};
    var gh = c.github || {}, vc = c.vercel || {};
    $("ghLogin").textContent = gh.login ? "@" + gh.login : "–";
    $("ghStatus").innerHTML = gh.connected
      ? '<span class="dot green"></span>Connected'
      : "Not connected";
    $("vcLogin").textContent = (vc.username ? "@" + vc.username : "–") +
      (vc.plan ? " · " + vc.plan + " plan" : "");
    $("vcStatus").innerHTML = vc.connected
      ? '<span class="dot green"></span>Connected'
      : "Not connected";
    $("vcNote").textContent = state.data.deployments_error
      ? "Projects, deployments and logs through Vercel's official MCP server. Deployment listing needs team access for now."
      : "Projects, deployments and logs through Vercel's official MCP server.";
    var first = (gh.login || "A").charAt(0).toUpperCase();
    $("avatar").textContent = first;
  }

  /* ---------- view switching ---------- */
  var renderers = {
    overview: renderOverview,
    vm: renderVm,
    tokens: renderTokens,
    deployments: renderDeployments,
    connectors: renderConnectors
  };

  function switchView(name) {
    state.view = name;
    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === name);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + name);
    });
    if (renderers[name]) renderers[name]();
  }

  function setRange(range) {
    state.range = range;
    document.querySelectorAll(".tabs .tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-range") === range);
    });
    renderOverview();
    renderTokens();
  }

  /* ---------- boot ---------- */
  function boot() {
    $("topDate").textContent = new Date().toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long"
    });
    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.addEventListener("click", function () { switchView(b.getAttribute("data-view")); });
    });
    document.querySelectorAll(".tabs .tab").forEach(function (t) {
      t.addEventListener("click", function () { setRange(t.getAttribute("data-range")); });
    });
    var search = $("searchInput");
    search.addEventListener("input", function () {
      state.query = search.value.trim();
      if (state.query && state.view !== "deployments") switchView("deployments");
      else renderDeployments();
    });
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.focus();
      }
    });

    fetch("data.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        state.data = data;
        var gen = new Date(data.generated_at);
        var when = gen.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        $("updatedAt").textContent = "Updated " + when;
        $("footUpdated").textContent = "Data updated " + when + " · refreshes daily";
        renderOverview();
        renderVm();
        renderTokens();
        renderDeployments();
        renderConnectors();
      })
      .catch(function () {
        $("ovSub").textContent = "Could not load status data. The next scheduled refresh will update this page.";
        $("updatedAt").textContent = "Updated –";
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
