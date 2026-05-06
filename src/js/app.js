// Entrypoint da app — versão Driver-only (v1.5+).
// Removida toda a lógica de cliente; este APK é exclusivo do entregador.

import { onAuth, handleAuth, signOutUser } from "./auth.js";
import { showToast, switchView, hideSplash, updateFileLabel } from "./ui.js";
import { initTheme, toggleTheme } from "./theme.js";
import { refreshPermissionStatuses, requestAppPermission } from "./permissions.js";
import {
  processOrderUpdate as processNewOrderAlert,
  requestNotificationPermission,
  testNewOrderSound,
  onFcmToken,
} from "./notifications.js";
import {
  subscribeOrders,
  acceptOrder,
} from "./orders.js";
import {
  subscribeDriverProfile,
  registerDriver,
  saveDriverFcmToken,
  setNotifyOnNewOrder,
} from "./driverProfile.js";
import {
  openPOD,
  closePOD,
  confirmDeliveryWithPOD,
  clearSignature,
  initSignaturePad,
  validatePOD
} from "./pod.js";
import {
  confirmPix,
  setDriverStatus,
  subscribeSecurityLogs
} from "./admin.js";
import { startTracking } from "./geolocation.js";
import {
  initDriverMap,
  centerDriverMap,
  showActiveDelivery,
  clearActiveDelivery,
} from "./maps.js";
import {
  DRIVER_SHARE,
  SUPPORT_WHATSAPP,
} from "./firebaseConfig.js";
import { runVerification } from "./aiVerification.js";

let currentUser = null;
let driverProfile = null;
let orders = [];
let securityLogs = [];
let driverFilter = "Todos";
let unsubOrders = null;
let unsubDriver = null;
let unsubSecurity = null;
let lastActiveOrderId = null;

// Estado online/offline persiste em localStorage. Default = online.
let driverOnline = (() => {
  try {
    const saved = localStorage.getItem("namao_driver_online");
    return saved === null ? true : saved === "true";
  } catch { return true; }
})();

// --- Splash on load ---
window.addEventListener("DOMContentLoaded", () => {
  initTheme();
  setTimeout(() => hideSplash(), 1200);
});

// --- Auth lifecycle ---
onAuth(async (user) => {
  if (!user) {
    document.getElementById("auth-screen")?.classList.remove("hidden");
    document.getElementById("account-blocked-overlay")?.classList.add("hidden");
    if (unsubOrders) { unsubOrders(); unsubOrders = null; }
    if (unsubDriver) { unsubDriver(); unsubDriver = null; }
    if (unsubSecurity) { unsubSecurity(); unsubSecurity = null; }
    currentUser = null;
    driverProfile = null;
    return;
  }
  currentUser = user;
  document.getElementById("auth-screen")?.classList.add("hidden");

  // Listener de perfil (banimento + carteira)
  unsubDriver = subscribeDriverProfile(user.uid, (profile) => {
    driverProfile = profile;
    applyDriverProfile();
  });

  // Permissão de notificação assim que o motorista loga.
  // Quando o Capacitor entregar o FCM token, salvamos no perfil pra que
  // a Cloud Function consiga mandar push pra esse device.
  onFcmToken((token) => {
    saveDriverFcmToken(user.uid, token).catch((err) =>
      console.warn("[fcm] save token failed:", err),
    );
  });
  requestNotificationPermission();

  // Listener de pedidos. Quando offline, ainda assinamos pra renderizar
  // corridas ativas do motorista (não pode perder uma entrega em andamento),
  // mas o filtro de "available" já zera a lista nesse caso.
  unsubOrders = subscribeOrders((list) => {
    orders = list;
    try { processNewOrderAlert(list); } catch (err) {
      console.warn("[notifications] failed to process update:", err);
    }
    renderAll();
  });

  initDriverMap();
  initSignaturePad();
  switchView("inicio");
  applyOnlineStatusUI();

  // Detecta admin via custom claim
  try {
    const token = await user.getIdTokenResult(true);
    window.__isAdmin = Boolean(token.claims?.admin);
  } catch { window.__isAdmin = false; }

  if (window.__isAdmin && !unsubSecurity) {
    unsubSecurity = subscribeSecurityLogs((items) => {
      securityLogs = items;
      renderSecurityLogs();
    });
  }
});

function applyDriverProfile() {
  const overlay = document.getElementById("account-blocked-overlay");
  const blockMessage = document.getElementById("block-message");
  const walletBtn = document.getElementById("driver-wallet-btn");
  const ctaDriver = document.getElementById("cta-driver-banner");
  const displayName = document.getElementById("profile-display-name");
  const statusLabel = document.getElementById("profile-status");
  const balanceLabel = document.getElementById("profile-wallet-balance");
  const notifyToggle = document.getElementById("notify-toggle");

  if (notifyToggle) {
    const enabled = driverProfile?.notifyOnNewOrder !== false;
    notifyToggle.setAttribute("aria-pressed", String(enabled));
    notifyToggle.querySelector(".theme-toggle-thumb")?.classList.toggle("on", enabled);
  }

  applyDriverDocs(driverProfile);
  applyDriverAvatar(driverProfile);

  if (!driverProfile) {
    overlay?.classList.add("hidden");
    walletBtn?.classList.add("hidden");
    ctaDriver?.classList.remove("hidden");
    if (displayName) displayName.innerText = currentUser?.email?.split("@")[0] || "Entregador";
    if (statusLabel) statusLabel.innerHTML = `Status: <span class="font-black">Aguardando cadastro</span>`;
    return;
  }
  ctaDriver?.classList.add("hidden");

  if (displayName) displayName.innerText = driverProfile.name || "Entregador";
  if (statusLabel) {
    const isApproved = driverProfile.status === "approved";
    const label = isApproved ? "Aprovado" : (driverProfile.status || "Pendente");
    statusLabel.innerHTML = `Status: <span class="font-black">${label}</span> ${isApproved ? '<i class="fa-solid fa-circle-check"></i>' : ''}`;
  }
  if (balanceLabel) {
    balanceLabel.innerText = Number(driverProfile.balance || 0)
      .toFixed(2)
      .replace(".", ",");
  }
  walletBtn?.classList.remove("hidden");

  if (driverProfile.status === "blocked") {
    if (blockMessage) blockMessage.innerText = "Esta conta foi suspensa por violar as regras de segurança.";
    overlay?.classList.remove("hidden");
  } else if (driverProfile.status === "suspended") {
    if (blockMessage) blockMessage.innerText = "Sua conta está suspensa temporariamente. Contate o suporte.";
    overlay?.classList.remove("hidden");
  } else {
    overlay?.classList.add("hidden");
  }
}

// --- Render ---
function renderAll() {
  renderDriverHistory();
  renderDriverMural();
  renderAdminPanel();
  renderActivityBadge();
  renderDriverStats();
  syncActiveDeliveryOnMap();
}

function renderActivityBadge() {
  if (!currentUser) return;
  const badge = document.getElementById("badge-atividade");
  if (!badge) return;
  const hasActive = orders.some(
    (o) => o.driverId === currentUser.uid &&
      ["accepted", "in_transit"].includes(o.status)
  );
  badge.classList.toggle("hidden", !hasActive);
}

// === Stats do entregador (HUD do mapa + grid em Atividade) ===
function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

function isThisWeek(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - now.getDay()); // domingo
  return d >= weekStart && d <= now;
}

function computeStats(predicate) {
  if (!currentUser) return { earnings: 0, count: 0, km: 0 };
  let earnings = 0, count = 0, km = 0;
  for (const o of orders) {
    if (o.driverId !== currentUser.uid) continue;
    if (o.status !== "completed") continue;
    if (!predicate(o.completedAt || o.createdAt)) continue;
    earnings += Number(o.driverEarnings ?? (o.price * DRIVER_SHARE) ?? 0);
    count += 1;
    km += Number(o.distanceKm || 0);
  }
  return { earnings, count, km };
}

function fmtBRL(n) {
  return `R$ ${Number(n || 0).toFixed(2).replace(".", ",")}`;
}
function fmtKm(n) {
  return `${Number(n || 0).toFixed(1)} km`;
}

function renderDriverStats() {
  const today = computeStats(isToday);
  const week = computeStats(isThisWeek);
  const total = computeStats(() => true);

  // HUD no mapa (em cima)
  const todayE = document.getElementById("today-earnings");
  const todayC = document.getElementById("today-count");
  if (todayE) todayE.innerText = fmtBRL(today.earnings);
  if (todayC) todayC.innerText = String(today.count);

  // Grid na aba Atividade
  const setText = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.innerText = txt;
  };
  setText("stats-today-earnings", fmtBRL(today.earnings));
  setText("stats-today-count", String(today.count));
  setText("stats-today-km", fmtKm(today.km));
  setText("stats-week-earnings", fmtBRL(week.earnings));
  setText("stats-week-count", String(week.count));
  setText("stats-week-km", fmtKm(week.km));
  setText("stats-total-earnings", fmtBRL(total.earnings));
  setText("stats-total-count", String(total.count));
  setText("stats-total-km", fmtKm(total.km));
}

// === Atividade — histórico do entregador ===
function renderDriverHistory() {
  const el = document.getElementById("driver-history-list");
  if (!el || !currentUser) return;
  const mine = orders.filter((o) => o.driverId === currentUser.uid);
  if (mine.length === 0) {
    el.innerHTML = `<p class="text-center py-12 text-base font-bold text-gray-400 uppercase"><i class="fa-solid fa-receipt text-3xl block mb-3 text-gray-300"></i>Nenhuma corrida ainda<br><span class="text-tiny font-semibold normal-case mt-2 inline-block">Aceite uma corrida no início pra começar</span></p>`;
    return;
  }
  el.innerHTML = mine.slice(0, 50).map(renderDriverHistoryCard).join("");
}

function renderDriverHistoryCard(o) {
  const statusInfo = {
    accepted: { label: "A caminho da retirada", color: "bg-purple-100 text-purple-800", icon: "fa-motorcycle" },
    in_transit: { label: "Em trânsito", color: "bg-blue-100 text-blue-800", icon: "fa-route" },
    completed: { label: "Entregue", color: "bg-green-100 text-green-800", icon: "fa-circle-check" },
    cancelled: { label: "Cancelada", color: "bg-red-100 text-red-800", icon: "fa-circle-xmark" }
  }[o.status] || { label: o.status, color: "bg-gray-100 text-gray-700", icon: "fa-circle" };
  const earning = Number(o.driverEarnings ?? (o.price * DRIVER_SHARE) ?? 0);
  const itemIcon = {
    Comida: "fa-burger",
    Documentos: "fa-file-alt",
    Caixas: "fa-box-open"
  }[o.itemType] || "fa-cube";
  const when = o.completedAt
    ? new Date(o.completedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";
  return `
    <div class="card-elevated">
      <div class="flex justify-between items-start mb-3">
        <div>
          <p class="text-xs font-extrabold text-gray-500 uppercase tracking-wider">#${o.id.slice(-4).toUpperCase()} · ${when}</p>
          <p class="font-extrabold text-primary text-base mt-1"><i class="fa-solid ${itemIcon} text-accentDark mr-1"></i> ${o.itemType || "Item"} · ${o.veh}</p>
        </div>
        <div class="text-right">
          <p class="text-tiny font-extrabold text-gray-500 uppercase">Você ganhou</p>
          <p class="font-black text-primary text-xl">${fmtBRL(earning)}</p>
        </div>
      </div>
      <span class="status-pill ${statusInfo.color}">
        <i class="fa-solid ${statusInfo.icon}"></i> ${statusInfo.label}
      </span>
      <p class="text-tiny font-bold text-gray-500 mt-3 truncate"><i class="fa-solid fa-location-dot text-primary"></i> ${o.origin || "—"}</p>
      <p class="text-tiny font-bold text-gray-500 truncate"><i class="fa-solid fa-flag-checkered text-accentDark"></i> ${o.destination || "—"}</p>
    </div>`;
}

function renderDriverMural() {
  const el = document.getElementById("available-orders-list");
  if (!el) return;
  const myActive = orders.find(
    (o) => o.driverId === currentUser?.uid && ["accepted", "in_transit"].includes(o.status)
  );
  if (myActive) {
    el.innerHTML = renderActiveDelivery(myActive);
    const pill = document.getElementById("orders-count-pill");
    if (pill) pill.innerText = "1";
    return;
  }

  // Offline: não mostra corridas disponíveis. Motorista precisa virar online.
  if (!driverOnline) {
    const pill = document.getElementById("orders-count-pill");
    if (pill) pill.innerText = "—";
    el.innerHTML = `<div class="text-center py-10 text-base font-bold text-gray-400 uppercase">
      <i class="fa-solid fa-power-off text-3xl block mb-3 text-gray-300"></i>
      Você está offline
      <p class="text-tiny font-semibold normal-case mt-2 text-gray-500">Toque em <span class="text-primary font-extrabold">OFFLINE</span> no topo do mapa pra começar a receber corridas.</p>
    </div>`;
    return;
  }

  let available = orders.filter((o) => o.status === "pending");
  if (driverFilter !== "Todos") available = available.filter((o) => o.veh === driverFilter);

  const pill = document.getElementById("orders-count-pill");
  if (pill) pill.innerText = String(available.length);

  if (available.length === 0) {
    el.innerHTML = `<p class="text-center py-10 text-base font-bold text-gray-400 uppercase"><i class="fa-solid fa-magnifying-glass text-3xl block mb-3 text-gray-300"></i>Procurando corridas...<br><span class="text-tiny font-semibold normal-case mt-2 inline-block">Você é avisado com som assim que aparecer</span></p>`;
    return;
  }
  el.innerHTML = available.map(renderAvailableOrderCard).join("");
}

function applyOnlineStatusUI() {
  const btn = document.getElementById("online-toggle");
  const dot = document.getElementById("online-dot");
  const lbl = document.getElementById("online-label");
  if (!btn || !dot || !lbl) return;

  if (driverOnline) {
    btn.setAttribute("aria-pressed", "true");
    dot.className = "w-2.5 h-2.5 bg-green-500 rounded-full shadow-[0_0_8px_#22c55e] animate-pulse";
    lbl.innerText = "Online";
    lbl.className = "text-xs font-extrabold text-primary uppercase tracking-wider";
  } else {
    btn.setAttribute("aria-pressed", "false");
    dot.className = "w-2.5 h-2.5 bg-gray-400 rounded-full";
    lbl.innerText = "Offline";
    lbl.className = "text-xs font-extrabold text-gray-500 uppercase tracking-wider";
  }
}

function toggleDriverOnlineImpl() {
  driverOnline = !driverOnline;
  try { localStorage.setItem("namao_driver_online", String(driverOnline)); } catch {}
  applyOnlineStatusUI();
  renderDriverMural();
  showToast(driverOnline ? "Você está ONLINE — recebendo corridas." : "Você está OFFLINE — não recebe novas corridas.");
}

function applyDriverAvatar(profile) {
  const img = document.getElementById("profile-avatar-img");
  const fb = document.getElementById("profile-avatar-fallback");
  if (!img || !fb) return;
  const selfie = profile?.selfiePhoto;
  if (selfie) {
    img.src = selfie;
    img.classList.remove("hidden");
    fb.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    fb.classList.remove("hidden");
  }
}

function applyDriverDocs(profile) {
  const card = document.getElementById("driver-docs-card");
  if (!card) return;
  const cnh = profile?.cnhPhoto;
  const selfie = profile?.selfiePhoto;
  if (!cnh && !selfie) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const cnhImg = document.getElementById("profile-cnh-img");
  const cnhFb = document.getElementById("profile-cnh-fallback");
  const selfImg = document.getElementById("profile-selfie-img");
  const selfFb = document.getElementById("profile-selfie-fallback");
  if (cnh && cnhImg) {
    cnhImg.src = cnh;
    cnhImg.classList.remove("hidden");
    cnhFb?.classList.add("hidden");
  }
  if (selfie && selfImg) {
    selfImg.src = selfie;
    selfImg.classList.remove("hidden");
    selfFb?.classList.add("hidden");
  }
}

function openDocPreview(which) {
  const url = which === "cnh"
    ? document.getElementById("profile-cnh-img")?.src
    : document.getElementById("profile-selfie-img")?.src;
  if (!url) return;
  const modal = document.getElementById("doc-preview-modal");
  const img = document.getElementById("doc-preview-img");
  if (modal && img) {
    img.src = url;
    modal.classList.remove("hidden");
  }
}

function closeDocPreview() {
  document.getElementById("doc-preview-modal")?.classList.add("hidden");
}

function renderAvailableOrderCard(o) {
  const earning = (o.price * DRIVER_SHARE).toFixed(2).replace(".", ",");
  const itemIcon = {
    Comida: "fa-burger",
    Documentos: "fa-file-alt",
    Caixas: "fa-box-open"
  }[o.itemType] || "fa-cube";
  const km = o.distanceKm ? `${Number(o.distanceKm).toFixed(1)} km` : "";
  return `
    <div class="card-primary-gradient p-5">
      <div class="flex justify-between items-start mb-3">
        <span class="bg-accent text-primary text-xs font-black px-3 py-1.5 rounded-full uppercase flex items-center gap-1">
          <i class="fa-solid ${itemIcon}"></i> ${o.itemType || "Item"} · ${o.veh}${km ? ` · ${km}` : ""}
        </span>
        <p class="text-3xl font-black text-accent">R$ ${earning}</p>
      </div>
      <div class="text-sm font-bold space-y-2 mb-4">
        <p><i class="fa-solid fa-location-dot text-accent w-5"></i> ${o.origin || "—"}</p>
        <p><i class="fa-solid fa-flag-checkered text-accent w-5"></i> ${o.destination || "—"}</p>
      </div>
      <button onclick="window.acceptOrderFromUI('${o.id}')" class="btn-accent w-full uppercase tracking-widest text-base">
        <i class="fa-solid fa-bolt"></i> ACEITAR ENTREGA
      </button>
    </div>`;
}

function renderActiveDelivery(o) {
  const earning = (o.price * DRIVER_SHARE).toFixed(2).replace(".", ",");
  const isInTransit = o.status === "in_transit";
  const km = o.distanceKm ? `${Number(o.distanceKm).toFixed(1)} km` : "";

  // botão "Abrir no Maps" (Google Maps app)
  const dest = o.destCoords;
  const orig = o.originCoords;
  const target = isInTransit ? dest : orig;
  const mapsBtn = (target?.length === 2)
    ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${target[0]},${target[1]}&travelmode=driving" target="_blank" class="block w-full text-center mt-2 py-3 bg-white text-primary font-extrabold uppercase text-sm tracking-widest rounded-2xl border-2 border-accent active:scale-[0.98] transition"><i class="fa-solid fa-route text-accentDark mr-1"></i> Abrir no Google Maps</a>`
    : "";

  return `
    <div class="card-primary-gradient p-5">
      <p class="text-xs font-black text-accent uppercase tracking-widest mb-3">
        <i class="fa-solid fa-circle-dot fa-beat-fade"></i> Entrega em andamento — R$ ${earning}${km ? ` · ${km}` : ""}
      </p>
      <div class="text-sm font-bold space-y-2 mb-4">
        <p><i class="fa-solid fa-location-dot text-accent w-5"></i> ${o.origin || "—"}</p>
        <p><i class="fa-solid fa-flag-checkered text-accent w-5"></i> ${o.destination || "—"}</p>
      </div>
      ${
        isInTransit
          ? `
            <div class="bg-white/10 border border-accent/40 rounded-2xl p-3 mb-3 text-xs text-white/90 leading-relaxed">
              <p class="font-extrabold text-accent uppercase tracking-widest mb-1"><i class="fa-solid fa-circle-info"></i> Como finalizar</p>
              <ol class="list-decimal list-inside space-y-0.5">
                <li>Entregue o produto ao cliente</li>
                <li>Peça para o cliente <b>assinar na tela</b></li>
                <li>Tire <b>1 foto</b> do produto entregue</li>
                <li>Toque em <b>CONFIRMAR ENTREGA</b> abaixo</li>
              </ol>
            </div>
            <button onclick="window.openPODFromUI('${o.id}')" class="btn-success w-full uppercase tracking-widest text-base shadow-lg animate-pulse"><i class="fa-solid fa-signature"></i> CONFIRMAR ENTREGA (ASSINATURA + FOTO)</button>
          `
          : `
            <div class="bg-white/10 border border-accent/40 rounded-2xl p-3 mb-3 text-xs text-white/90 leading-relaxed">
              <p class="font-extrabold text-accent uppercase tracking-widest mb-1"><i class="fa-solid fa-circle-info"></i> Pr\u00f3ximo passo</p>
              <p>V\u00e1 at\u00e9 a <b>origem</b>, colete o produto e tire uma foto pra comprovar a retirada.</p>
            </div>
            <button onclick="window.openPickupPhoto('${o.id}')" class="btn-accent w-full uppercase tracking-widest text-base"><i class="fa-solid fa-camera"></i> CONFIRMAR COLETA (FOTO)</button>
          `
      }
      ${mapsBtn}
    </div>`;
}

function syncActiveDeliveryOnMap() {
  if (!currentUser) return;
  const myActive = orders.find(
    (o) => o.driverId === currentUser.uid && ["accepted", "in_transit"].includes(o.status)
  );
  if (myActive) {
    if (myActive.id !== lastActiveOrderId) {
      lastActiveOrderId = myActive.id;
      showActiveDelivery(myActive);
    }
  } else if (lastActiveOrderId) {
    lastActiveOrderId = null;
    clearActiveDelivery();
  }
}

function renderAdminPanel() {
  const el = document.getElementById("admin-orders-list");
  if (!el) return;
  const gross = orders
    .filter((o) => o.status === "completed")
    .reduce((a, b) => a + Number(b.price || 0), 0);
  const net = gross * 0.15;
  const grossEl = document.getElementById("admin-gross");
  const netEl = document.getElementById("admin-net");
  if (grossEl) grossEl.innerText = `R$ ${gross.toFixed(2).replace(".", ",")}`;
  if (netEl) netEl.innerText = `R$ ${net.toFixed(2).replace(".", ",")}`;

  el.innerHTML = orders.map(renderAdminOrderCard).join("") ||
    `<p class="text-center py-8 text-base font-bold text-gray-400 uppercase">Sem pedidos</p>`;
}

function renderAdminOrderCard(o) {
  const tag = {
    waiting_confirmation: "bg-yellow-100 text-yellow-800",
    pending: "bg-blue-100 text-blue-800",
    accepted: "bg-purple-100 text-purple-800",
    in_transit: "bg-purple-100 text-purple-800",
    completed: "bg-green-100 text-green-800",
    cancelled: "bg-red-100 text-red-800"
  }[o.status] || "bg-gray-100 text-gray-800";
  const action =
    o.status === "waiting_confirmation"
      ? `<button onclick="window.adminConfirm('${o.id}')" class="btn-success px-4 py-2 text-xs uppercase" style="min-height:auto">Confirmar PIX</button>`
      : `<span class="text-primary font-black text-lg">R$ ${Number(o.price).toFixed(2).replace(".", ",")}</span>`;
  return `
    <div class="card-elevated flex justify-between items-center">
      <div>
        <p class="font-black text-primary text-base">#${o.id.slice(-4).toUpperCase()} · ${o.itemType || "Item"} · ${o.veh}</p>
        <span class="inline-block mt-1 text-tiny font-black px-2 py-1 rounded-full uppercase ${tag}">${o.status}</span>
      </div>
      ${action}
    </div>`;
}

function renderSecurityLogs() {
  const el = document.getElementById("admin-security-logs");
  if (!el) return;
  if (securityLogs.length === 0) {
    el.innerHTML = `<p class="text-sm text-gray-400 uppercase font-bold py-2">Nenhum alerta nas últimas 24h</p>`;
    return;
  }
  el.innerHTML = securityLogs.map((log) => {
    const when = new Date(log.createdAt || Date.now()).toLocaleString("pt-BR");
    return `
      <div class="bg-red-50 border-2 border-red-200 rounded-2xl p-3">
        <p class="text-danger font-extrabold uppercase tracking-wider text-xs"><i class="fa-solid fa-triangle-exclamation"></i> ${log.type || "alerta"}</p>
        <p class="text-gray-700 mt-1 text-sm font-semibold">${log.reason || ""} ${log.cpfMasked ? `· CPF ${log.cpfMasked}` : ""}</p>
        <p class="text-tiny text-gray-500 mt-1 font-semibold">${when}</p>
      </div>`;
  }).join("");
}

// --- Motorista ---
async function acceptOrderFromUI(orderId) {
  if (!driverProfile || driverProfile.status !== "approved") {
    showToast("Seu cadastro de motorista precisa estar aprovado");
    return;
  }
  try {
    await acceptOrder(orderId, currentUser.uid, driverProfile.name);
    await startTracking(orderId);
    showToast("Corrida aceita — vá para a coleta");
  } catch (err) {
    showToast(err.message || "Falha ao aceitar corrida");
  }
}

async function openPODFromUI(orderId) {
  openPOD(orderId);
}

// --- Admin ---
function promptAdmin() {
  if (!window.__isAdmin) {
    showToast("Apenas contas com permissão de admin (custom claim) acessam o painel.");
    return;
  }
  switchView("admin");
}

async function adminConfirmFromUI(orderId) { await confirmPix(orderId); }

// --- Cadastro motorista (com IA) ---
async function fileToCompressedDataUrl(file, maxDim = 600, quality = 0.6) {
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function registerDriverFromUI(e) {
  e.preventDefault();
  if (!currentUser) return;

  const name = document.getElementById("driver-name").value.trim();
  const cpf = document.getElementById("driver-cpf").value.trim();
  const phone = document.getElementById("driver-phone").value.trim();
  const plate = document.getElementById("driver-plate").value.trim().toUpperCase();
  const vehicleType = document.querySelector('input[name="reg-vehicle"]:checked')?.value || "Moto";
  const cnhFile = document.getElementById("driver-cnh").files[0];
  const selfieFile = document.getElementById("driver-selfie").files[0];

  if (!cnhFile || !selfieFile) {
    showToast("Anexe a CNH e a selfie");
    return;
  }

  const result = await runVerification({ uid: currentUser.uid, name, cpf });
  if (!result.ok) {
    showToast(result.reason || "Cadastro reprovado");
    return;
  }

  try {
    const [cnhPhoto, selfiePhoto] = await Promise.all([
      fileToCompressedDataUrl(cnhFile, 600, 0.5),
      fileToCompressedDataUrl(selfieFile, 600, 0.5)
    ]);
    await registerDriver(currentUser.uid, {
      name, cpf, plate, phone, vehicleType, cnhPhoto, selfiePhoto
    });
    showToast("Cadastro aprovado! Você já pode aceitar corridas.");
    switchView("inicio");
  } catch (err) { showToast(err.message); }
}

// --- Bindings globais usados pelos atributos onclick do HTML ---
Object.assign(window, {
  handleAuth,
  signOutUser,
  switchView,
  acceptOrderFromUI,
  openPODFromUI,
  clearSignature,
  validatePOD,
  confirmDeliveryWithPOD: () => confirmDeliveryWithPOD(currentUser.uid),
  closePOD,
  adminConfirm: adminConfirmFromUI,
  setDriverStatus,
  promptAdmin,
  registerDriver: registerDriverFromUI,
  setDriverFilter: (f) => {
    driverFilter = f;
    ["filter-todos", "filter-moto", "filter-carro"].forEach((id) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.classList.remove("active");
    });
    const map = { Todos: "filter-todos", Moto: "filter-moto", Carro: "filter-carro" };
    const active = document.getElementById(map[f]);
    if (active) active.classList.add("active");
    renderDriverMural();
  },
  openDriverWallet: () => {
    if (!driverProfile) return;
    const balance = Number(driverProfile.balance || 0).toFixed(2).replace(".", ",");
    showToast(`Saldo atual: R$ ${balance}. Solicitação de saque registrada.`);
  },
  openWhatsAppSupport: () => window.open(`https://wa.me/${SUPPORT_WHATSAPP}`, "_blank"),
  testNewOrderSound,
  toggleNotifyOnNewOrder: async () => {
    if (!currentUser) return;
    const next = driverProfile?.notifyOnNewOrder === false; // se estava off, vira on
    // Update visual otimistico (sem esperar Firestore confirmar)
    const btn = document.getElementById("notify-toggle");
    if (btn) {
      btn.setAttribute("aria-pressed", String(next));
      btn.querySelector(".theme-toggle-thumb")?.classList.toggle("on", next);
    }
    try {
      await setNotifyOnNewOrder(currentUser.uid, next);
      showToast(next ? "Notificações ativadas." : "Notificações desativadas.");
    } catch (err) {
      console.warn("[notify] toggle failed:", err);
      showToast("Erro ao salvar preferência.");
      // rollback
      if (btn) {
        btn.setAttribute("aria-pressed", String(!next));
        btn.querySelector(".theme-toggle-thumb")?.classList.toggle("on", !next);
      }
    }
  },
  centerDriverMap,
  toggleTheme,
  updateFileLabel,
  toggleDriverOnline: toggleDriverOnlineImpl,
  openDocPreview,
  closeDocPreview,
  requestAppPermission,
  refreshPermissionStatuses,
});
