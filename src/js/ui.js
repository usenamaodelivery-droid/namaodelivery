// UI helpers: toast, splash, navegação principal, bottom nav
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
  "view-cliente",
  "view-entregador",
  "view-atividade",
  "view-perfil",
  "view-admin",
  "view-driver-registration"
];

export function switchView(view) {
  MAIN_VIEWS.forEach((id) => document.getElementById(id)?.classList.add("hidden"));
  document.getElementById("main-tabs")?.classList.add("hidden");
  document.getElementById("bottom-nav")?.classList.remove("hidden");

  if (view === "inicio") {
    document.getElementById("main-tabs")?.classList.remove("hidden");
    switchMainTab("cliente");
  } else if (view === "atividade") {
    document.getElementById("view-atividade")?.classList.remove("hidden");
  } else if (view === "perfil") {
    document.getElementById("view-perfil")?.classList.remove("hidden");
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

export function switchMainTab(tab) {
  document.getElementById("view-cliente")?.classList.add("hidden");
  document.getElementById("view-entregador")?.classList.add("hidden");
  document.getElementById(`view-${tab}`)?.classList.remove("hidden");
  const btnCliente = document.getElementById("btn-cliente");
  const btnEntregador = document.getElementById("btn-entregador");
  if (btnCliente) btnCliente.className = `flex-1 py-3 transition ${tab === "cliente" ? "tab-active" : "tab-inactive"}`;
  if (btnEntregador) btnEntregador.className = `flex-1 py-3 transition ${tab === "entregador" ? "tab-active" : "tab-inactive"}`;
}

export function updateFileLabel(inputId, labelId) {
  const inp = document.getElementById(inputId);
  const lbl = document.getElementById(labelId);
  if (!inp || !lbl) return;
  if (inp.files && inp.files.length > 0) {
    lbl.classList.remove("hidden");
  } else {
    lbl.classList.add("hidden");
  }
}

export { MAIN_VIEWS };
