(() => {
  "use strict";

  const $ = s => document.querySelector(s);
  const state = { token: localStorage.getItem("ghost_access_token") || "", bulk: [] };

  $("#themeToggle").addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("ghost_theme", document.body.classList.contains("dark") ? "dark" : "light");
  });
  if (localStorage.getItem("ghost_theme") === "dark") document.body.classList.add("dark");

  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    $("#" + btn.dataset.tab).classList.add("active");
  }));

  function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
  }

  function badge(label) {
    const cls = label.startsWith("Excellent") ? "excellent" : label.startsWith("Good") ? "good" : "poor";
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  }

  async function analyze(keyword, country) {
    if (!state.token) throw new Error("Premium access is required.");
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.token}` },
      body: JSON.stringify({ keyword, country })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "Live analysis failed");
    return data.data;
  }

  $("#singleForm").addEventListener("submit", async e => {
    e.preventDefault();
    const button = e.currentTarget.querySelector("button");
    const spinner = button.querySelector(".spinner");
    button.disabled = true; spinner.classList.remove("hidden");
    try {
      const data = await analyze($("#keyword").value, $("#country").value);
      const r = $("#singleResult"); r.classList.remove("hidden");
      r.innerHTML = `
        <div class="metric"><span>Keyword</span><b>${escapeHtml(data.keyword)}</b></div>
        <div class="metric"><span>Real Search Volume</span><b>${data.searchVolume.toLocaleString()}</b></div>
        <div class="metric"><span>Amazon Product Count</span><b>${data.amazonProductCount.toLocaleString()}</b></div>
        <div class="metric"><span>Ghost Score</span><b>${data.ghostScore.score} <small>${badge(data.ghostScore.label)}</small></b></div>`;
    } catch (err) {
      alert(err.message);
    } finally {
      button.disabled = false; spinner.classList.add("hidden");
    }
  });

  function renderBulk() {
    $("#bulkBody").innerHTML = state.bulk.map(r => `
      <tr><td>${escapeHtml(r.keyword)}</td><td>${Number(r.searchVolume).toLocaleString()}</td><td>${Number(r.amazonProductCount).toLocaleString()}</td><td>${r.ghostScore.score}</td><td>${badge(r.ghostScore.label)}</td></tr>
    `).join("");
    $("#exportCsv").disabled = state.bulk.length === 0;
  }

  $("#bulkRun").addEventListener("click", async () => {
    const keywords = [...new Set($("#bulkKeywords").value.split(/\r?\n/).map(x => x.trim()).filter(Boolean))].slice(0, 100);
    if (!state.token) return alert("Premium access is required.");
    if (!keywords.length) return alert("Enter at least one keyword.");
    state.bulk = []; renderBulk();
    $("#bulkStatus").textContent = `Analyzing ${keywords.length} keywords with live providers...`;
    for (const keyword of keywords) {
      try {
        const row = await analyze(keyword, $("#bulkCountry").value);
        state.bulk.push(row);
      } catch (err) {
        state.bulk.push({ keyword, searchVolume: 0, amazonProductCount: 0, ghostScore: { score: 0, label: err.message } });
      }
      renderBulk();
    }
    $("#bulkStatus").textContent = `Completed ${state.bulk.length} rows.`;
  });

  $("#exportCsv").addEventListener("click", () => {
    if (!state.bulk.length) return;
    const headers = ["Keyword","Marketplace","Search Volume","Amazon Product Count","Ghost Score","Opportunity","Fetched At"];
    const rows = state.bulk.map(r => [r.keyword,r.marketplace,r.searchVolume,r.amazonProductCount,r.ghostScore.score,r.ghostScore.label,r.fetchedAt]);
    const csv = [headers,...rows].map(row => row.map(v => `"${String(v ?? "").replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ghost-product-finder.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  window.ghostProductFinder = {
    setAccessToken(token) {
      if (typeof token !== "string" || token.length < 20) throw new Error("Invalid access token");
      localStorage.setItem("ghost_access_token", token);
      state.token = token;
      $("#bulkLock").classList.add("hidden");
      $("#bulkApp").classList.remove("hidden");
    }
  };

  if (state.token) {
    $("#bulkLock").classList.add("hidden");
    $("#bulkApp").classList.remove("hidden");
  }
})();