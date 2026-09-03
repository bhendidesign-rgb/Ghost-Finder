(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);

  const state = {
    token: localStorage.getItem("ghost_session") || "",
    plan: localStorage.getItem("ghost_plan") || "free",
    bulk: []
  };

  /* --------------------------------
     Session Management
  -------------------------------- */

  const setSession = (token, plan) => {
    state.token = token || "";
    state.plan = plan || "free";

    if (token) {
      localStorage.setItem("ghost_session", token);
      localStorage.setItem("ghost_plan", state.plan);
    } else {
      localStorage.removeItem("ghost_session");
      localStorage.removeItem("ghost_plan");
    }

    updatePremiumUI();
  };

  const clearSession = () => {
    setSession("", "free");
  };

  /* --------------------------------
     Premium UI
  -------------------------------- */

  function updatePremiumUI() {
    const paid =
      state.plan === "paid" ||
      state.plan === "owner";

    $("#bulkLock")?.classList.toggle(
      "hidden",
      paid
    );

    $("#bulkApp")?.classList.toggle(
      "hidden",
      !paid
    );

    if ($("#planStatus")) {
      if (state.plan === "owner") {
        $("#planStatus").textContent =
          "Owner · Unlimited";
      } else if (state.plan === "paid") {
        $("#planStatus").textContent =
          "Premium · Unlimited";
      } else {
        $("#planStatus").textContent =
          "Free · 5 analyses/day";
      }
    }
  }

  /* --------------------------------
     Theme
  -------------------------------- */

  $("#themeToggle")?.addEventListener(
    "click",
    () => {
      document.body.classList.toggle("dark");

      localStorage.setItem(
        "ghost_theme",
        document.body.classList.contains("dark")
          ? "dark"
          : "light"
      );
    }
  );

  if (
    localStorage.getItem("ghost_theme") ===
    "dark"
  ) {
    document.body.classList.add("dark");
  }

  /* --------------------------------
     Tabs
  -------------------------------- */

  document
    .querySelectorAll(".tab")
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          document
            .querySelectorAll(".tab")
            .forEach((item) =>
              item.classList.remove("active")
            );

          document
            .querySelectorAll(".panel")
            .forEach((panel) =>
              panel.classList.remove("active")
            );

          button.classList.add("active");

          const target = $(
            `#${button.dataset.tab}`
          );

          target?.classList.add("active");
        }
      );
    });

  /* --------------------------------
     HTML Escape
  -------------------------------- */

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[character])
    );
  }

  /* --------------------------------
     Opportunity Badge
  -------------------------------- */

  function badge(label, score) {
    const safeLabel = String(label ?? "Unavailable");

    let className = "poor";

    if (
      safeLabel === "Low Competition" ||
      safeLabel === "Excellent Opportunity" ||
      Number(score) >= 80
    ) {
      className = "excellent";
    } else if (
      safeLabel === "Moderate Competition" ||
      safeLabel === "Good" ||
      Number(score) >= 60
    ) {
      className = "good";
    }

    return `
      <span class="badge ${className}">
        ${escapeHtml(safeLabel)}
      </span>
    `;
  }

  /* --------------------------------
     API Helper
  -------------------------------- */

  async function api(
    url,
    body,
    auth = true
  ) {
    const headers = {
      "Content-Type": "application/json"
    };

    if (auth && state.token) {
      headers.Authorization =
        `Bearer ${state.token}`;
    }

    let response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
    } catch (networkError) {
      throw new Error(
        "Network error. Please check your internet connection and try again."
      );
    }

    const data =
      await response
        .json()
        .catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.error ||
        `Request failed (${response.status})`
      );
    }

    return data;
  }

  /* --------------------------------
     Single Keyword Analysis
  -------------------------------- */

  async function analyze(
    keyword,
    country,
    mode = "single"
  ) {
    const result = await api(
      "/api/search",
      {
        keyword,
        country,
        mode
      },
      true
    );

    return result.data;
  }

  /* --------------------------------
     Render Single Result
  -------------------------------- */

  function renderSingleResult(data) {
    const resultBox =
      $("#singleResult");

    if (!resultBox) {
      return;
    }

    const score =
      Number(data?.ghostScore?.score);

    const label =
      data?.ghostScore?.label ||
      "Unavailable";

    const productCount =
      Number(data?.amazonProductCount);

    const searchVolumeText =
      data?.searchVolume !== null &&
      data?.searchVolume !== undefined
        ? Number(
            data.searchVolume
          ).toLocaleString()
        : "Not available";

    resultBox.classList.remove(
      "hidden"
    );

    resultBox.innerHTML = `
      <div class="metric">
        <span>Keyword</span>
        <b>
          ${escapeHtml(data?.keyword)}
        </b>
      </div>

      <div class="metric">
        <span>Search Volume</span>
        <b>
          ${escapeHtml(searchVolumeText)}
        </b>
      </div>

      <div class="metric">
        <span>Amazon Product Count</span>
        <b>
          ${
            Number.isFinite(productCount)
              ? productCount.toLocaleString()
              : "Unavailable"
          }
        </b>
      </div>

      <div class="metric">
        <span>Ghost Score</span>
        <b>
          ${
            Number.isFinite(score)
              ? score
              : "—"
          }
          <small>
            ${badge(label, score)}
          </small>
        </b>
      </div>

      <div class="metric">
        <span>Analysis Type</span>
        <b>
          Competition Estimate
        </b>
      </div>
    `;
  }

  /* --------------------------------
     Single Analysis Form
  -------------------------------- */

  $("#singleForm")?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const form =
        event.currentTarget;

      const button =
        form.querySelector("button");

      const spinner =
        button?.querySelector(".spinner");

      const keyword =
        $("#keyword")?.value?.trim() || "";

      const country =
        $("#country")?.value || "us";

      if (!keyword) {
        alert(
          "Please enter a keyword."
        );
        return;
      }

      if (button) {
        button.disabled = true;
      }

      spinner?.classList.remove(
        "hidden"
      );

      try {
        const data =
          await analyze(
            keyword,
            country,
            "single"
          );

        renderSingleResult(data);

      } catch (error) {
        console.error(
          "Analysis error:",
          error
        );

        alert(
          error.message ||
          "Request failed"
        );

      } finally {
        if (button) {
          button.disabled = false;
        }

        spinner?.classList.add(
          "hidden"
        );
      }
    }
  );

  /* --------------------------------
     Bulk Renderer
  -------------------------------- */

  function renderBulk() {
    const body =
      $("#bulkBody");

    if (!body) {
      return;
    }

    body.innerHTML =
      state.bulk
        .map((row) => {
          const score =
            Number(
              row?.ghostScore?.score
            );

          const label =
            row?.ghostScore?.label ||
            "Unavailable";

          return `
            <tr>
              <td>
                ${escapeHtml(
                  row?.keyword
                )}
              </td>

              <td>
                ${
                  row?.searchVolume !== null &&
                  row?.searchVolume !== undefined
                    ? Number(
                        row.searchVolume
                      ).toLocaleString()
                    : "N/A"
                }
              </td>

              <td>
                ${
                  Number.isFinite(
                    Number(
                      row?.amazonProductCount
                    )
                  )
                    ? Number(
                        row.amazonProductCount
                      ).toLocaleString()
                    : "N/A"
                }
              </td>

              <td>
                ${
                  Number.isFinite(score)
                    ? score
                    : "—"
                }
              </td>

              <td>
                ${badge(
                  label,
                  score
                )}
              </td>
            </tr>
          `;
        })
        .join("");

    const exportButton =
      $("#exportCsv");

    if (exportButton) {
      exportButton.disabled =
        state.bulk.length === 0;
    }
  }

  /* --------------------------------
     Bulk Analysis
  -------------------------------- */

  $("#bulkRun")?.addEventListener(
    "click",
    async () => {
      if (
        state.plan !== "paid" &&
        state.plan !== "owner"
      ) {
        alert(
          "Premium access is required."
        );
        return;
      }

      const raw =
        $("#bulkKeywords")
          ?.value || "";

      const keywords = [
        ...new Set(
          raw
            .split(/\r?\n/)
            .map((item) =>
              item.trim()
            )
            .filter(Boolean)
        )
      ].slice(0, 100);

      if (!keywords.length) {
        alert(
          "Enter at least one keyword."
        );
        return;
      }

      state.bulk = [];

      renderBulk();

      if ($("#bulkStatus")) {
        $("#bulkStatus").textContent =
          `Analyzing ${keywords.length} keywords...`;
      }

      let completed = 0;

      for (const keyword of keywords) {
        try {
          const data =
            await analyze(
              keyword,
              $("#bulkCountry")?.value ||
                "us",
              "bulk"
            );

          state.bulk.push(data);

        } catch (error) {
          console.error(
            `Bulk error for "${keyword}":`,
            error
          );

          state.bulk.push({
            keyword,
            marketplace:
              $("#bulkCountry")?.value ||
              "us",
            searchVolume: null,
            amazonProductCount: null,
            ghostScore: {
              score: null,
              label:
                "Analysis failed"
            },
            fetchedAt:
              new Date().toISOString(),
            error:
              error.message ||
              "Request failed"
          });
        }

        completed++;

        renderBulk();

        if ($("#bulkStatus")) {
          $("#bulkStatus").textContent =
            `Completed ${completed} of ${keywords.length}...`;
        }
      }

      if ($("#bulkStatus")) {
        $("#bulkStatus").textContent =
          `Completed ${state.bulk.length} of ${keywords.length} rows.`;
      }
    }
  );

  /* --------------------------------
     CSV Export
  -------------------------------- */

  $("#exportCsv")?.addEventListener(
    "click",
    () => {
      if (
        state.plan !== "paid" &&
        state.plan !== "owner"
      ) {
        return;
      }

      if (!state.bulk.length) {
        return;
      }

      const headers = [
        "Keyword",
        "Marketplace",
        "Search Volume",
        "Amazon Product Count",
        "Ghost Score",
        "Opportunity",
        "Fetched At"
      ];

      const rows =
        state.bulk.map((row) => [
          row?.keyword || "",
          row?.marketplace || "",

          row?.searchVolume !== null &&
          row?.searchVolume !== undefined
            ? row.searchVolume
            : "N/A",

          row?.amazonProductCount !== null &&
          row?.amazonProductCount !== undefined
            ? row.amazonProductCount
            : "N/A",

          row?.ghostScore?.score !== null &&
          row?.ghostScore?.score !== undefined
            ? row.ghostScore.score
            : "N/A",

          row?.ghostScore?.label ||
            "Unavailable",

          row?.fetchedAt || ""
        ]);

      const csv = [
        headers,
        ...rows
      ]
        .map((row) =>
          row
            .map(
              (value) =>
                `"${String(
                  value ?? ""
                ).replace(
                  /"/g,
                  '""'
                )}"`
            )
            .join(",")
        )
        .join("\n");

      const blob = new Blob(
        ["\ufeff" + csv],
        {
          type:
            "text/csv;charset=utf-8"
        }
      );

      const url =
        URL.createObjectURL(blob);

      const link =
        document.createElement("a");

      link.href = url;
      link.download =
        "ghost-product-finder.csv";

      document.body.appendChild(link);

      link.click();

      link.remove();

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }
  );

  /* --------------------------------
     Gumroad Premium Activation
  -------------------------------- */

  $("#activateForm")?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const form =
        event.currentTarget;

      const button =
        form.querySelector("button");

      const licenseKey =
        $("#licenseKey")
          ?.value
          ?.trim() || "";

      if (!licenseKey) {
        alert(
          "Please enter your license key."
        );
        return;
      }

      if (button) {
        button.disabled = true;
      }

      try {
        const data =
          await api(
            "/api/activate",
            {
              licenseKey
            },
            false
          );

        setSession(
          data.token,
          "paid"
        );

        $("#licenseModal")
          ?.classList.add(
            "hidden"
          );

        alert(
          "Premium activated successfully."
        );

      } catch (error) {
        console.error(
          "Premium activation error:",
          error
        );

        alert(
          error.message ||
          "Premium activation failed."
        );

      } finally {
        if (button) {
          button.disabled = false;
        }
      }
    }
  );

  /* --------------------------------
     Owner Login
  -------------------------------- */

  $("#ownerForm")?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const form =
        event.currentTarget;

      const button =
        form.querySelector("button");

      const password =
        $("#ownerPassword")
          ?.value || "";

      if (!password) {
        alert(
          "Please enter the owner password."
        );
        return;
      }

      if (button) {
        button.disabled = true;
      }

      try {
        const data =
          await api(
            "/api/owner-login",
            {
              password
            },
            false
          );

        setSession(
          data.token,
          "owner"
        );

        $("#ownerModal")
          ?.classList.add(
            "hidden"
          );

        alert(
          "Owner access activated."
        );

      } catch (error) {
        console.error(
          "Owner login error:",
          error
        );

        alert(
          error.message ||
          "Owner login failed."
        );

      } finally {
        if (button) {
          button.disabled = false;
        }
      }
    }
  );

  /* --------------------------------
     Modal Controls
  -------------------------------- */

  $("#activatePremium")?.addEventListener(
    "click",
    () => {
      $("#licenseModal")
        ?.classList.remove(
          "hidden"
        );
    }
  );

  $("#ownerAccess")?.addEventListener(
    "click",
    () => {
      $("#ownerModal")
        ?.classList.remove(
          "hidden"
        );
    }
  );

  document
    .querySelectorAll(
      "[data-close-modal]"
    )
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          const modal =
            $(
              `#${button.dataset.closeModal}`
            );

          modal?.classList.add(
            "hidden"
          );
        }
      );
    });

  /* --------------------------------
     Logout
  -------------------------------- */

  $("#logout")?.addEventListener(
    "click",
    () => {
      clearSession();

      state.bulk = [];

      renderBulk();
    }
  );

  /* --------------------------------
     Initial UI
  -------------------------------- */

  updatePremiumUI();

  renderBulk();

})();
