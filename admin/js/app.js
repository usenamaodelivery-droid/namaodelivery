// Main controller: login flow + roteamento das seções.
import { loginWithEmail, logout, onAuth, getCurrentUser } from "./auth.js";
import { showToast } from "./util.js";

import { renderDashboard }  from "./sections/dashboard.js";
import { renderDrivers }    from "./sections/drivers.js";
import { renderOrders }     from "./sections/orders.js";
import { renderFinance }    from "./sections/finance.js";
import { renderPayouts }    from "./sections/payouts.js";
import { renderBlocks }     from "./sections/blocks.js";
import { renderBroadcast }  from "./sections/broadcast.js";
import { renderSecurity }   from "./sections/security.js";
import { renderConfig }     from "./sections/config.js";

const ROUTES = {
  dashboard: { render: renderDashboard, title: "Resumo",       subtitle: "Visão geral da operação" },
  drivers:   { render: renderDrivers,   title: "Motoristas",   subtitle: "Aprovar, bloquear, ver KYC" },
  orders:    { render: renderOrders,    title: "Pedidos",      subtitle: "Todos os pedidos da plataforma" },
  finance:   { render: renderFinance,   title: "Financeiro",   subtitle: "Receita, comissões e lucro" },
  payouts:   { render: renderPayouts,   title: "Repasses PIX", subtitle: "Histórico de saques dos motoristas" },
  blocks:    { render: renderBlocks,    title: "Bloqueios",    subtitle: "Motoristas suspensos ou banidos" },
  broadcast: { render: renderBroadcast, title: "Comunicados",  subtitle: "Avisos pra motoristas" },
  security:  { render: renderSecurity,  title: "Segurança",    subtitle: "Logs de eventos críticos" },
  config:    { render: renderConfig,    title: "Configurações", subtitle: "Taxas, regiões, parâmetros" },
};

const DEFAULT_ROUTE = "dashboard";
const AUTO_REFRESH_MS = 30 * 1000;
// Seções com formulário/edição não devem auto-refresh (perderia o input do user)
const NO_AUTO_REFRESH = new Set(["config", "broadcast"]);

let cleanupSection = null;
let currentRoute = null;
let autoRefreshTimer = null;

function setActiveSidebar(route) {
  document.querySelectorAll("[data-route]").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
  });
}

async function navigate(route, opts = {}) {
  const isRefresh = !!opts.refresh;
  const def = ROUTES[route] || ROUTES[DEFAULT_ROUTE];
  currentRoute = route in ROUTES ? route : DEFAULT_ROUTE;
  if (cleanupSection) {
    try { cleanupSection(); } catch (e) {}
    cleanupSection = null;
  }
  document.getElementById("page-title").textContent = def.title;
  document.getElementById("page-subtitle").textContent = def.subtitle || "";
  if (!isRefresh) document.getElementById("page-actions").innerHTML = "";
  const content = document.getElementById("page-content");
  if (!isRefresh) {
    content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i><p class="mt-2 text-sm">Carregando...</p></div>`;
  }
  setActiveSidebar(route);
  try {
    const cleanup = await def.render({
      content,
      actionsRoot: document.getElementById("page-actions"),
      navigate,
      isRefresh,
    });
    cleanupSection = typeof cleanup === "function" ? cleanup : null;
    updateRefreshIndicator();
  } catch (e) {
    console.error(e);
    if (!isRefresh) {
      content.innerHTML = `<div class="text-center py-12 text-danger"><i class="fa-solid fa-triangle-exclamation text-2xl"></i><p class="mt-2 text-sm">Erro ao carregar: ${e.message}</p></div>`;
    }
  }
  scheduleAutoRefresh();
}

function updateRefreshIndicator() {
  const el = document.getElementById("refresh-indicator");
  if (!el) return;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  if (NO_AUTO_REFRESH.has(currentRoute)) {
    el.innerHTML = `<i class="fa-solid fa-pause text-slate-400"></i> Atualização automática pausada`;
  } else {
    el.innerHTML = `<i class="fa-solid fa-arrows-rotate text-accent"></i> Atualizado ${hh}:${mm}:${ss} · auto a cada 30s`;
  }
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  if (NO_AUTO_REFRESH.has(currentRoute)) return;
  autoRefreshTimer = setTimeout(() => {
    if (document.hidden) {
      // Aba escondida — não atualiza pra economizar leituras Firestore.
      // Reagenda pra checar de novo daqui a pouco.
      scheduleAutoRefresh();
      return;
    }
    navigate(currentRoute, { refresh: true });
  }, AUTO_REFRESH_MS);
}

function handleHash() {
  const hash = (location.hash || "").replace(/^#/, "").trim();
  const route = ROUTES[hash] ? hash : DEFAULT_ROUTE;
  if (location.hash !== "#" + route) location.hash = "#" + route;
  navigate(route);
}

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  const u = getCurrentUser();
  document.getElementById("user-info").textContent = u?.email || "";
  handleHash();
}

// Quando a aba volta a ficar visível, atualiza imediatamente.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentRoute && !NO_AUTO_REFRESH.has(currentRoute)) {
    navigate(currentRoute, { refresh: true });
  }
});

// === Login form ===
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  const btn = document.getElementById("login-button");
  errorEl.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    await loginWithEmail(email, password);
  } catch (e) {
    let msg = "Email ou senha inválidos";
    if (e.code === "auth/user-not-found") msg = "Usuário não encontrado";
    else if (e.code === "auth/wrong-password") msg = "Senha incorreta";
    else if (e.code === "auth/invalid-credential") msg = "Email ou senha inválidos";
    else if (e.code === "auth/too-many-requests") msg = "Muitas tentativas. Espere alguns minutos.";
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  await logout();
  location.hash = "";
});

window.addEventListener("hashchange", handleHash);

// === Auth state listener ===
onAuth((u) => {
  if (!u) {
    showLogin();
    return;
  }
  if (!u.admin) {
    showToast("Sua conta não tem acesso admin. Saindo...", "error");
    setTimeout(() => logout(), 2000);
    return;
  }
  showApp();
});

// === Modal API ===
function closeModal() {
  const root = document.getElementById("modal-root");
  root.classList.add("hidden");
  document.getElementById("modal-content").innerHTML = "";
}

function openModal(html) {
  document.getElementById("modal-content").innerHTML = html;
  document.getElementById("modal-root").classList.remove("hidden");
}

window.adminApp = {
  navigate,
  closeModal,
  openModal,
};
