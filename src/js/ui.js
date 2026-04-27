// Feedback visual e navegação
export function showToast(message, duration = 3000) {
  const container = getOrCreateToast();
  container.querySelector(".toast-msg").textContent = message;
  container.style.opacity = "1";
  container.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(container._t);
  container._t = setTimeout(() => {
    container.style.opacity = "0";
    container.style.transform = "translateX(-50%) translateY(-20px)";
  }, duration);
}

function getOrCreateToast() {
  let el = document.getElementById("toast-notification");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-notification";
    el.className =
      "fixed top-4 left-1/2 -translate-x-1/2 bg-primary text-white px-5 py-3 rounded-2xl shadow-2xl z-[999] text-sm font-bold pointer-events-none transition-all";
    el.style.opacity = "0";
    el.innerHTML = '<span class="toast-msg"></span>';
    document.body.appendChild(el);
  }
  return el;
}

const MAIN_VIEWS = ["inicio", "atividade", "perfil", "admin"];
export function switchView(view) {
  ["view-cliente", "view-entregador", "view-atividade", "view-perfil", "view-admin", "main-tabs"].forEach(
    (id) => document.getElementById(id)?.classList.add("hidden")
  );
  if (view === "inicio") {
    document.getElementById("main-tabs").classList.remove("hidden");
    switchMainTab("cliente");
  } else {
    document.getElementById(`view-${view}`)?.classList.remove("hidden");
  }
}

export function switchMainTab(tab) {
  ["cliente", "entregador"].forEach((id) =>
    document.getElementById(`view-${id}`)?.classList.add("hidden")
  );
  document.getElementById(`view-${tab}`)?.classList.remove("hidden");
  const btnCliente = document.getElementById("btn-cliente");
  const btnEntregador = document.getElementById("btn-entregador");
  if (btnCliente && btnEntregador) {
    const active = "text-primary border-primary";
    const inactive = "text-gray-400 border-transparent";
    btnCliente.className = btnCliente.className.replace(active, "").replace(inactive, "").trim();
    btnEntregador.className = btnEntregador.className
      .replace(active, "")
      .replace(inactive, "")
      .trim();
    btnCliente.className += " " + (tab === "cliente" ? active : inactive);
    btnEntregador.className += " " + (tab === "entregador" ? active : inactive);
  }
}

export { MAIN_VIEWS };
