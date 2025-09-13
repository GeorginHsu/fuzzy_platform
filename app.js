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

// === 预热当前展示图，避免白屏 ===
async function prewarmCurrentImage(urlStr) {
  await new Promise((resolve) => {
    const pre = new Image();
    pre.onload = pre.onerror = resolve;
    pre.decoding = "async";
    pre.src = urlStr;
  });
}

// === 持续预热所有“未使用”的图片（不依赖任何进度条元素） ===
const WARM = { done: 0, total: 0, seen: new Set(), timer: null };

async function fetchWarmTargets(limit) {
  await waitForBackendBase();
  const url = new URL("/api/cache/images", window.BACKEND_BASE);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("rand", "1");
  url.searchParams.set("exclude_used", "1"); // 关键：排除 logs 里已用图片
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.images || []).map(x =>
    new URL(x.image_web_url, window.BACKEND_BASE).toString()
  );
}

function preloadOne(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => { WARM.done++; resolve(); };
    img.decoding = "async";
    img.fetchPriority = "low";
    img.referrerPolicy = "no-referrer";
    img.src = src;
  });
}

async function warmLoop({ batch = 200, concurrency = 6, intervalMs = 10000 } = {}) {
  try {
    await waitForBackendBase();
    // 初始化总数（仅一次）
    if (!WARM.total) {
      const statsUrl = new URL("/api/cache/stats", window.BACKEND_BASE);
      statsUrl.searchParams.set("exclude_used", "1");
      const rs = await fetch(statsUrl);
      if (rs.ok) {
        const s = await rs.json();
        WARM.total = s.images || s.count || 0;
      }
      console.log("[warm] total images to warm:", WARM.total);
    }

    const targets = await fetchWarmTargets(batch);
    const fresh = targets.filter(u => !WARM.seen.has(u));
    fresh.forEach(u => WARM.seen.add(u));

    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, fresh.length)) }, async () => {
      while (i < fresh.length) {
        const idx = i++;
        await preloadOne(fresh[idx]);
      }
    });
    await Promise.all(workers);
  } catch (e) {
    console.warn("warmLoop error", e);
  } finally {
    if (!WARM.total || WARM.done < WARM.total) {
      WARM.timer = setTimeout(() => warmLoop({ batch, concurrency, intervalMs }), intervalMs);
    } else {
      console.log("[warm] done:", WARM.done, "/", WARM.total);
    }
  }
}

// 页面加载后启动持续预热
document.addEventListener("DOMContentLoaded", () => {
  warmLoop({ batch: 200, concurrency: 6, intervalMs: 10000 });
});

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

    $("#image-section").classList.remove("hidden");
    $("#qa-section").classList.remove("hidden");

    const imgUrl = new URL(data.image_web_url, window.BACKEND_BASE).toString();
    await prewarmCurrentImage(imgUrl);                // 先把当前图读进缓存
    $("#img").src = imgUrl;                           // 再显示，基本秒显

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
            <option value="1">+1 test model wrong</option>
            <option value="0">0 test model correct</option>
            <option value="-1">-1 unreasonable question</option>
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

// 事件绑定
$("#btn-load").addEventListener("click", loadSample);
$("#btn-submit").addEventListener("click", submitRatings);
