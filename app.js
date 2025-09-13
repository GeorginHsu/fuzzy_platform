const $ = (sel) => document.querySelector(sel);
const tbody = $("#qa-table tbody");
let CURRENT = null;

// —— 打开页面就收集用户名（只要一次；存 localStorage） ——
(function bootstrapUsername() {
  let u = localStorage.getItem("username") || "";
  if (!u) {
    u = (prompt("Please enter your username:") || "").trim();
    if (u) localStorage.setItem("username", u);
  }
})();

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => {
    el.classList.add("hidden");
  }, 2000);
}

// 如果没用户名，再次弹出
async function ensureUsername() {
  let u = localStorage.getItem("username") || "";
  if (u) return true;
  u = (prompt("Please enter your username:") || "").trim();
  if (!u) { toast("Username not set"); return false; }
  localStorage.setItem("username", u);
  return true;
}

// 统一加请求头：把用户名带给后端
function headers(json = false) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  const u = localStorage.getItem("username");
  if (u) h["X-Username"] = u;
  return h;
}

// 等待 BACKEND_BASE（你有 config.json/config.js 异步设置）
async function waitForBackendBase(timeout = 10000) {
  const t0 = Date.now();
  while (!window.BACKEND_BASE) {
    await new Promise(r => setTimeout(r, 50));
    if (Date.now() - t0 > timeout) throw new Error("BACKEND_BASE not loaded");
  }
}

async function loadSample() {
  if (!await ensureUsername()) return;
  $("#btn-load").disabled = true;
  $("#btn-submit").disabled = true;
  tbody.innerHTML = "";
  try {
    await waitForBackendBase();
    const url = new URL("/api/sample", window.BACKEND_BASE);
    const res = await fetch(url, { method: "GET", headers: headers() });
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    const data = await res.json();
    CURRENT = data;

    const imgUrl = new URL(data.image_web_url, window.BACKEND_BASE).toString();
    await prewarmCurrentImage(imgUrl);   // ← 新增：先预热这一张
    $("#img").src = imgUrl;              // ← 原来的赋值行改成用 imgUrl

    $("#image-section").classList.remove("hidden");
    $("#qa-section").classList.remove("hidden");
    // $("#img").src = new URL(data.image_web_url, window.BACKEND_BASE).toString();
    $("#sample-id").textContent = data.sample_id;
    $("#image-rel").textContent = data.image_relpath;

    data.qas.forEach((qa, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${qa.dimension || "—"}</td>
        <td>${qa.question}</td>
        <td>${qa.answer}</td>
        <td>
          <select class="score-select" data-qid="${qa.id}">
            <option value="">—</option>
            <option value="1">+1 Good</option>
            <option value="0">0 Neutral</option>
            <option value="-1">-1 Bad</option>
          </select>
        </td>
        <td><input type="text" placeholder="Optional comment" data-cmt="${qa.id}" /></td>
      `;
      tbody.appendChild(tr);
    });

    $("#btn-submit").disabled = false;
  } catch (err) {
    console.error(err);
    toast("Failed to load");
  } finally {
    $("#btn-load").disabled = false;
  }
}

async function submitRatings() {
  if (!await ensureUsername()) return;
  if (!CURRENT) return toast("Please load a sample first");
  const ratings = [];
  tbody.querySelectorAll(".score-select").forEach(sel => {
    const val = sel.value;
    if (val === "") return;
    const qid = sel.getAttribute("data-qid");
    const cmt = tbody.querySelector(`input[data-cmt="${qid}"]`).value;
    ratings.push({ id: qid, score: Number(val), comment: cmt || undefined });
  });
  if (!ratings.length) return toast("Please rate at least one question");
  $("#btn-submit").disabled = true;
  try {
    await waitForBackendBase();
    const url = new URL("/api/rating", window.BACKEND_BASE);
    const res = await fetch(url, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ sample_id: CURRENT.sample_id, ratings }),
    });
    if (!res.ok) throw new Error(`rating failed: ${res.status}`);
    toast("Ratings submitted, thank you!");
  } catch (err) {
    console.error(err);
    toast("Submission failed");
  } finally {
    $("#btn-submit").disabled = false;
  }
}

// 只绑定现有按钮（你的 HTML 没有登录表单）
$("#btn-load").addEventListener("click", loadSample);
$("#btn-submit").addEventListener("click", submitRatings);


// ===== 持续预热图片（带进度） =====
const WARM = { warmed: new Set(), done: 0, total: 0, timer: null };

function updateWarmUI() {
  const bar = document.getElementById('preheat-bar');
  const txt = document.getElementById('preheat-text');
  if (!bar || !txt) return;
  const total = WARM.total || Math.max(WARM.done, 1);
  bar.max = total;
  bar.value = Math.min(WARM.done, total);
  txt.textContent = total ? `${WARM.done} / ${total}` : `${WARM.done}`;
}

async function fetchWarmTargets(limit) {
  const url = new URL("/api/cache/images", window.BACKEND_BASE);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("rand", "1");
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("images list failed");
  const data = await res.json();
  return (data.images || []).map(x =>
    new URL(x.image_web_url, window.BACKEND_BASE).toString()
  );
}

function preloadOne(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.decoding = "async";
    img.fetchPriority = "low";
    img.referrerPolicy = "no-referrer";
    img.onload = img.onerror = () => { WARM.done++; updateWarmUI(); resolve(); };
    img.src = url;
  });
}

async function warmLoop({ batch = 200, concurrency = 6, intervalMs = 10000 } = {}) {
  try {
    // 第一次尝试拿总数（需要后端有 /api/cache/stats）
    if (!WARM.total) {
      try {
        const s = await fetch(new URL("/api/cache/stats", window.BACKEND_BASE));
        if (s.ok) {
          const d = await s.json();
          WARM.total = d.images || d.count || 0;
        }
      } catch {}
      updateWarmUI();
    }

    const targets = await fetchWarmTargets(batch);
    const fresh = targets.filter(u => !WARM.warmed.has(u));
    fresh.forEach(u => WARM.warmed.add(u));

    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < fresh.length) {
        const i = idx++;
        await preloadOne(fresh[i]);
      }
    });
    await Promise.all(workers);
  } catch (e) {
    console.warn("warmLoop error", e);
  } finally {
    if (!WARM.total || WARM.done < WARM.total) {
      WARM.timer = setTimeout(() => warmLoop({ batch: 200, concurrency: 6, intervalMs }), intervalMs);
    } else {
      const txt = document.getElementById('preheat-text');
      if (txt) txt.textContent += " ✓";
    }
  }
}

// 页面加载后启动持续预热
document.addEventListener("DOMContentLoaded", () => {
  warmLoop({ batch: 200, concurrency: 6, intervalMs: 10000 });
});

// （可选）在展示前先把当前图预热，避免白屏
async function prewarmCurrentImage(urlStr) {
  await new Promise(resolve => {
    const pre = new Image();
    pre.onload = pre.onerror = resolve;
    pre.decoding = "async";
    pre.src = urlStr;
  });
}
