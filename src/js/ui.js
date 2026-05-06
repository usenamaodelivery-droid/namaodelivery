// UI helpers: toast, splash, navegação principal, bottom nav.
// App é exclusivo do entregador — sem aba cliente.

export function showToast(message, duration = 3000) {
  const el = document.getElementById("toast-notification");
  if (!el) return;
  const msg = el.querySelector("#toast-message") || el.querySelector(".toast-msg");
  if (msg) msg.textContent = message;
  el.style.opacity = "1";
  el.style.transform = "translateX(-50%) translateY(0)";
  el.style.pointerEvents = "auto";
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(-20px)";
    el.style.pointerEvents = "none";
  }, duration);
}

export function hideSplash() {
  const splash = document.getElementById("splash-screen");
  if (!splash) return;
  splash.classList.add("faded");
  setTimeout(() => splash.classList.add("hidden"), 600);
}

const MAIN_VIEWS = [
  "view-entregador",
  "view-atividade",
  "view-perfil",
  "view-admin",
  "view-driver-registration"
];

export function switchView(view) {
  MAIN_VIEWS.forEach((id) => document.getElementById(id)?.classList.add("hidden"));
  document.getElementById("bottom-nav")?.classList.remove("hidden");

  if (view === "inicio") {
    document.getElementById("view-entregador")?.classList.remove("hidden");
  } else if (view === "atividade") {
    document.getElementById("view-atividade")?.classList.remove("hidden");
  } else if (view === "perfil") {
    document.getElementById("view-perfil")?.classList.remove("hidden");
    try { window.refreshPermissionStatuses?.(); } catch { /* ignore */ }
  } else if (view === "admin") {
    document.getElementById("view-admin")?.classList.remove("hidden");
    document.getElementById("bottom-nav")?.classList.add("hidden");
  } else if (view === "driver-registration") {
    document.getElementById("view-driver-registration")?.classList.remove("hidden");
    document.getElementById("bottom-nav")?.classList.add("hidden");
  }

  updateBottomNav(view);
}

function updateBottomNav(view) {
  const map = {
    inicio: "nav-inicio",
    atividade: "nav-atividade",
    perfil: "nav-perfil"
  };
  ["nav-inicio", "nav-atividade", "nav-perfil"].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.remove("active", "text-primary");
    btn.classList.add("text-gray-400");
  });
  const activeId = map[view];
  if (activeId) {
    const btn = document.getElementById(activeId);
    if (btn) {
      btn.classList.add("active", "text-primary");
      btn.classList.remove("text-gray-400");
    }
  }
}

export function updateFileLabel(inputId, labelId, previewId) {
  const inp = document.getElementById(inputId);
  const lbl = document.getElementById(labelId);
  if (!inp || !lbl) return;
  const file = inp.files && inp.files[0];
  if (!file) {
    lbl.classList.add("hidden");
    if (previewId) {
      const wrap = document.getElementById(previewId);
      if (wrap) wrap.innerHTML = "";
    }
    return;
  }
  lbl.classList.remove("hidden");
  if (previewId) {
    const wrap = document.getElementById(previewId);
    if (wrap) {
      const url = URL.createObjectURL(file);
      wrap.innerHTML = `
        <div class="mt-3 relative rounded-xl overflow-hidden border-2 border-success/40 bg-white">
          <img src="${url}" alt="preview" class="w-full h-40 object-cover" />
          <button type="button" onclick="document.getElementById('${inputId}').click()"
            class="absolute top-2 right-2 bg-white/90 text-primary text-xs font-extrabold px-3 py-1 rounded-full shadow-md uppercase tracking-wider">
            <i class="fa-solid fa-rotate"></i> Trocar
          </button>
        </div>`;
    }
  }
}

export { MAIN_VIEWS };
