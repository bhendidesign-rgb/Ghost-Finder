(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const state = { token: localStorage.getItem("ghost_session") || "", plan: localStorage.getItem("ghost_plan") || "free", bulk: [] };
  const setSession = (token, plan) => { state.token=token||""; state.plan=plan||"free"; if(token){localStorage.setItem("ghost_session",token);localStorage.setItem("ghost_plan",state.plan);} else {localStorage.removeItem("ghost_session");localStorage.removeItem("ghost_plan");} updatePremiumUI(); };
  const clearSession = () => setSession("","free");
  function updatePremiumUI(){
    const paid=state.plan==="paid"||state.plan==="owner";
    $("#bulkLock")?.classList.toggle("hidden",paid); $("#bulkApp")?.classList.toggle("hidden",!paid);
    if($("#planStatus")) $("#planStatus").textContent=state.plan==="owner"?"Owner · Unlimited":state.plan==="paid"?"Premium · Unlimited":"Free · 5 analyses/day";
  }
  $("#themeToggle").addEventListener("click",()=>{document.body.classList.toggle("dark");localStorage.setItem("ghost_theme",document.body.classList.contains("dark")?"dark":"light")});
  if(localStorage.getItem("ghost_theme")==="dark") document.body.classList.add("dark");
  document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));btn.classList.add("active");$("#"+btn.dataset.tab).classList.add("active")}));
  function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
  function badge(label){const cls=label.startsWith("Excellent")?"excellent":label.startsWith("Good")?"good":"poor";return `<span class="badge ${cls}">${escapeHtml(label)}</span>`}
  async function api(url, body, auth=true){const headers={"Content-Type":"application/json"};if(auth&&state.token)headers.Authorization=`Bearer ${state.token}`;const response=await fetch(url,{method:"POST",headers,body:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(data.error||"Request failed");return data;}
  async function analyze(keyword,country,mode="single"){return (await api("/api/search",{keyword,country,mode},true)).data}
  $("#singleForm").addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector("button"),spinner=button.querySelector(".spinner");button.disabled=true;spinner.classList.remove("hidden");try{const data=await analyze($("#keyword").value,$("#country").value,"single");const r=$("#singleResult");r.classList.remove("hidden");r.innerHTML=`<div class="metric"><span>Keyword</span><b>${escapeHtml(data.keyword)}</b></div><div class="metric"><span>Real Search Volume</span><b>${data.searchVolume.toLocaleString()}</b></div><div class="metric"><span>Amazon Product Count</span><b>${data.amazonProductCount.toLocaleString()}</b></div><div class="metric"><span>Ghost Score</span><b>${data.ghostScore.score} <small>${badge(data.ghostScore.label)}</small></b></div>`}catch(err){alert(err.message)}finally{button.disabled=false;spinner.classList.add("hidden")}});
  function renderBulk(){
    $("#bulkBody").innerHTML=state.bulk.map(r=>`<tr><td>${escapeHtml(r.keyword)}</td><td>${Number(r.searchVolume).toLocaleString()}</td><td>${Number(r.amazonProductCount).toLocaleString()}</td><td>${r.ghostScore.score}</td><td>${badge(r.ghostScore.label)}</td></tr>`).join("");
    $("#exportCsv").disabled=state.bulk.length===0;
  }
  $("#bulkRun").addEventListener("click",async()=>{if(state.plan!=="paid"&&state.plan!=="owner")return alert("Premium access is required.");const keywords=[...new Set($("#bulkKeywords").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))].slice(0,100);if(!keywords.length)return alert("Enter at least one keyword.");state.bulk=[];renderBulk();$("#bulkStatus").textContent=`Analyzing ${keywords.length} keywords...`;for(const keyword of keywords){try{state.bulk.push(await analyze(keyword,$("#bulkCountry").value,"bulk"))}catch(err){state.bulk.push({keyword,searchVolume:0,amazonProductCount:0,ghostScore:{score:0,label:err.message}})}renderBulk()}$("#bulkStatus").textContent=`Completed ${state.bulk.length} rows.`});
  $("#exportCsv").addEventListener("click",()=>{if((state.plan!=="paid"&&state.plan!=="owner")||!state.bulk.length)return;const headers=["Keyword","Marketplace","Search Volume","Amazon Product Count","Ghost Score","Opportunity","Fetched At"],rows=state.bulk.map(r=>[r.keyword,r.marketplace,r.searchVolume,r.amazonProductCount,r.ghostScore.score,r.ghostScore.label,r.fetchedAt]),csv=[headers,...rows].map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n"),blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="ghost-product-finder.csv";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)});
  $("#activateForm")?.addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector("button");button.disabled=true;try{const data=await api("/api/activate",{licenseKey:$("#licenseKey").value.trim()},false);setSession(data.token,"paid");$("#licenseModal").classList.add("hidden");alert("Premium activated successfully.")}catch(err){alert(err.message)}finally{button.disabled=false}});
  $("#ownerForm")?.addEventListener("submit",async e=>{e.preventDefault();const button=e.currentTarget.querySelector("button");button.disabled=true;try{const data=await api("/api/owner-login",{password:$("#ownerPassword").value},false);setSession(data.token,"owner");$("#ownerModal").classList.add("hidden");alert("Owner access activated.")}catch(err){alert(err.message)}finally{button.disabled=false}});
  $("#activatePremium")?.addEventListener("click",()=>$("#licenseModal").classList.remove("hidden"));
  $("#ownerAccess")?.addEventListener("click",()=>$("#ownerModal").classList.remove("hidden"));
  document.querySelectorAll("[data-close-modal]").forEach(x=>x.addEventListener("click",()=>$(x.dataset.closeModal).classList.add("hidden")));
  $("#logout")?.addEventListener("click",()=>{clearSession();state.bulk=[];renderBulk()});
  updatePremiumUI();
})();
