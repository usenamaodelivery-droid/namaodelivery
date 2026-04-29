// Entrypoint da app
import { auth, onAuth, handleAuth, signOutUser } from "./auth.js";
import { showToast, switchView, switchMainTab, hideSplash, updateFileLabel } from "./ui.js";
import { initTheme, toggleTheme } from "./theme.js";
import {
  processOrderUpdate as processNewOrderAlert,
  requestNotificationPermission,
  testNewOrderSound,
} from "./notifications.js";
import {
  subscribeOrders,
  createOrder,
  acceptOrder,
  markInTransit,
  calculatePrice
} from "./orders.js";
import { subscribeDriverProfile, registerDriver } from "./driverProfile.js";
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
import { startTracking, stopTracking } from "./geolocation.js";
import {
  initClientMap,
  initDriverMap,
  destCoords,
  straightLineKm,
  startCoords,
  centerDriverMap
} from "./maps.js";
import {
  APP_ID,
  DRIVER_SHARE,
  PIX_KEY,
  SUPPORT_WHATSAPP,
  ROUTE_DETOUR_FACTOR
} from "./firebaseConfig.js";
import { runVerification } from "./aiVerification.js";
import {
  openTrackingModal,
  closeTrackingModal,
  updateTrackingFromOrder
} from "./tracking.js";

let currentUser = null;
let driverProfile = null;
let orders = [];
let securityLogs = [];
let currentTotalPrice = 0;
let driverFilter = "Todos";
let unsubOrders = null;
let unsubDriver = null;
let unsubSecurity = null;

// --- Splash on load (some delay para deixar o efeito) ---
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

  // Pede permissão de notificação assim que o motorista loga (no-op em
  // dispositivos sem suporte ou já concedido).
  requestNotificationPermission();

  // Listener de pedidos
  unsubOrders = subscribeOrders((list) => {
    orders = list;
    // Dispara som + vibração + notificação para cada pedido novo 'pending'.
    // Fica em silêncio na primeira leitura (histórico).
    try { processNewOrderAlert(list); } catch (err) {
      console.warn("[notifications] failed to process update:", err);
    }
    renderAll();
    syncTracking();
  });

  initClientMap(() => calcPriceNow());
  initDriverMap();
  initSignaturePad();
  switchView("inicio");

  // Detecta admin via custom claim
  try {
    const token = await user.getIdTokenResult(true);
    window.__isAdmin = Boolean(token.claims?.admin);
  } catch { window.__isAdmin = false; }

  // Se admin, escuta logs de segurança
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

  if (!driverProfile) {
    overlay?.classList.add("hidden");
    walletBtn?.classList.add("hidden");
    ctaDriver?.classList.remove("hidden");
    if (displayName) displayName.innerText = currentUser?.email?.split("@")[0] || "Cliente";
    if (statusLabel) statusLabel.innerHTML = `Status: Cliente <i class="fa-solid fa-circle-check"></i>`;
    return;
  }
  ctaDriver?.classList.add("hidden");

  if (displayName) displayName.innerText = driverProfile.name || "Motorista";
  if (statusLabel) {
    const isApproved = driverProfile.status === "approved";
    statusLabel.innerHTML = `Status: ${driverProfile.status || "Ativo"} ${isApproved ? '<i class="fa-solid fa-circle-check"></i>' : ''}`;
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
  renderCustomerActivity();
  renderDriverMural();
  renderAdminPanel();
  renderActivityBadge();
}

function renderActivityBadge() {
  if (!currentUser) return;
  const badge = document.getElementById("badge-atividade");
  if (!badge) return;
  const hasActive = orders.some(
    (o) => o.customerId === currentUser.uid &&
      ["waiting_confirmation", "pending", "accepted", "in_transit"].includes(o.status)
  );
  badge.classList.toggle("hidden", !hasActive);
}

function renderCustomerActivity() {
  const el = document.getElementById("customer-orders-list");
  if (!el || !currentUser) return;
  const mine = orders.filter((o) => o.customerId === currentUser.uid);
  if (mine.length === 0) {
    el.innerHTML = `<p class="text-center py-12 text-base font-bold text-gray-400 uppercase"><i class="fa-solid fa-receipt text-3xl block mb-3 text-gray-300"></i>Sem corridas ainda</p>`;
    return;
  }
  el.innerHTML = mine.map(renderCustomerOrderCard).join("");
}

function renderCustomerOrderCard(o) {
  const statusInfo = {
    waiting_confirmation: { label: "Aguardando PIX", color: "bg-yellow-100 text-yellow-800", icon: "fa-clock" },
    pending: { label: "Procurando motorista", color: "bg-blue-100 text-blue-800", icon: "fa-magnifying-glass" },
    accepted: { label: "Motorista a caminho", color: "bg-purple-100 text-purple-800", icon: "fa-motorcycle" },
    in_transit: { label: "Em trânsito", color: "bg-purple-100 text-purple-800", icon: "fa-route" },
    completed: { label: "Entregue", color: "bg-green-100 text-green-800", icon: "fa-circle-check" },
    cancelled: { label: "Cancelada", color: "bg-red-100 text-red-800", icon: "fa-circle-xmark" }
  }[o.status] || { label: o.status, color: "bg-gray-100 text-gray-700", icon: "fa-circle" };
  const trackable = ["pending", "accepted", "in_transit"].includes(o.status);
  return `
    <div class="card-elevated">
      <div class="flex justify-between items-start mb-3">
        <div>
          <p class="text-xs font-extrabold text-gray-500 uppercase tracking-wider">Pedido #${o.id.slice(-4).toUpperCase()}</p>
          <p class="font-extrabold text-primary text-base mt-1"><i class="fa-solid fa-truck-ramp-box text-accentDark text-base mr-1"></i> ${o.itemType || "Item"} · ${o.veh}</p>
        </div>
        <p class="font-black text-primary text-xl">R$ ${Number(o.price).toFixed(2).replace(".", ",")}</p>
      </div>
      <span class="status-pill ${statusInfo.color}">
        <i class="fa-solid ${statusInfo.icon}"></i> ${statusInfo.label}
      </span>
      ${o.driverName ? `<p class="text-sm font-bold text-gray-600 mt-3"><i class="fa-solid fa-user-shield text-accentDark"></i> Motorista: <strong>${o.driverName}</strong></p>` : ""}
      ${trackable ? `<button onclick="window.openTrackingFor('${o.id}')" class="btn-primary mt-3 w-full text-base"><i class="fa-solid fa-satellite-dish mr-1"></i> Rastrear pedido</button>` : ""}
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
    return;
  }
  let available = orders.filter((o) => o.status === "pending");
  if (driverFilter !== "Todos") available = available.filter((o) => o.veh === driverFilter);
  if (available.length === 0) {
    el.innerHTML = `<p class="text-center py-12 text-base font-bold text-gray-400 uppercase"><i class="fa-solid fa-magnifying-glass text-3xl block mb-3 text-gray-300"></i>Procurando corridas...</p>`;
    return;
  }
  el.innerHTML = available.map(renderAvailableOrderCard).join("");
}

function renderAvailableOrderCard(o) {
  const earning = (o.price * DRIVER_SHARE).toFixed(2).replace(".", ",");
  const itemIcon = {
    Comida: "fa-burger",
    Documentos: "fa-file-alt",
    Caixas: "fa-box-open"
  }[o.itemType] || "fa-cube";
  return `
    <div class="card-primary-gradient p-5">
      <div class="flex justify-between items-start mb-3">
        <span class="bg-accent text-primary text-xs font-black px-3 py-1.5 rounded-full uppercase flex items-center gap-1">
          <i class="fa-solid ${itemIcon}"></i> ${o.itemType || "Item"} · ${o.veh}
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
  return `
    <div class="card-primary-gradient p-5">
      <p class="text-xs font-black text-accent uppercase tracking-widest mb-3">
        <i class="fa-solid fa-circle-dot fa-beat-fade"></i> Entrega em andamento — R$ ${earning}
      </p>
      <div class="text-sm font-bold space-y-2 mb-4">
        <p><i class="fa-solid fa-location-dot text-accent w-5"></i> ${o.origin || "—"}</p>
        <p><i class="fa-solid fa-flag-checkered text-accent w-5"></i> ${o.destination || "—"}</p>
      </div>
      ${
        isInTransit
          ? `<button onclick="window.openPODFromUI('${o.id}')" class="btn-success w-full uppercase tracking-widest text-base"><i class="fa-solid fa-camera"></i> FINALIZAR (POD)</button>`
          : `<button onclick="window.openPickupPhoto('${o.id}')" class="btn-accent w-full uppercase tracking-widest text-base"><i class="fa-solid fa-camera"></i> CONFIRMAR COLETA (FOTO)</button>`
      }
    </div>`;
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

// --- Cliente: cálculo e checkout ---
function calcPriceNow() {
  if (!destCoords) return;
  const baseKm = straightLineKm(startCoords, destCoords);
  const km = baseKm * ROUTE_DETOUR_FACTOR;
  const veh = document.querySelector('input[name="vehicle"]:checked')?.value || "Moto";
  currentTotalPrice = calculatePrice(km, veh);
  const totalEl = document.getElementById("calc-total");
  const kmEl = document.getElementById("calc-km");
  if (totalEl) totalEl.innerText = `R$ ${currentTotalPrice.toFixed(2).replace(".", ",")}`;
  if (kmEl) kmEl.innerText = `${km.toFixed(1)} KM`;
}

function updateVehicleSuggestion() {
  const itemType = document.querySelector('input[name="itemType"]:checked')?.value;
  // Caixas sugere Carro automaticamente
  if (itemType === "Caixas") {
    const carro = document.getElementById("veh-carro");
    if (carro) carro.checked = true;
  } else {
    const moto = document.getElementById("veh-moto");
    if (moto) moto.checked = true;
  }
  calcPriceNow();
}

function submitOrderHandler(e) {
  e.preventDefault();
  if (!destCoords) {
    showToast("Toque no mapa para definir o destino");
    return;
  }
  const priceEl = document.getElementById("checkout-price");
  const pixEl = document.getElementById("checkout-pix-key");
  if (priceEl) priceEl.innerText = `R$ ${currentTotalPrice.toFixed(2).replace(".", ",")}`;
  if (pixEl) pixEl.value = PIX_KEY;
  document.getElementById("checkout-modal")?.classList.remove("hidden");
}

async function confirmPaymentHandler() {
  if (!currentUser) return;
  const veh = document.querySelector('input[name="vehicle"]:checked')?.value || "Moto";
  const itemType = document.querySelector('input[name="itemType"]:checked')?.value || "Comida";
  const origin = document.getElementById("origem")?.value.trim() || "";
  const destination = document.getElementById("destino")?.value.trim() || "";
  try {
    await createOrder({
      vehicle: veh,
      itemType,
      price: currentTotalPrice,
      origin,
      destination,
      customerId: currentUser.uid,
      originCoords: startCoords,
      destCoords
    });
    document.getElementById("checkout-modal")?.classList.add("hidden");
    switchView("atividade");
    showToast("Pedido criado! Aguardando confirmação do PIX pelo admin.");
  } catch (err) {
    showToast(err.message || "Falha ao criar pedido");
  }
}

function copyPixKeyHandler() {
  const input = document.getElementById("checkout-pix-key");
  if (!input) return;
  input.select();
  document.execCommand("copy");
  showToast("Chave PIX copiada!");
}

// --- Tracking ---
function syncTracking() {
  // Se houver modal de tracking aberto, atualiza com o pedido correspondente
  const el = document.getElementById("tracking-modal");
  if (!el || el.classList.contains("hidden")) return;
  // re-busca o pedido pelo id ativo
  const activeId = el.dataset.orderId;
  if (!activeId) return;
  const o = orders.find((x) => x.id === activeId);
  if (o) updateTrackingFromOrder(o);
}

function openTrackingFor(orderId) {
  const o = orders.find((x) => x.id === orderId);
  if (!o) return;
  const el = document.getElementById("tracking-modal");
  if (el) el.dataset.orderId = orderId;
  openTrackingModal(o);
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

async function markPickedUp(orderId) {
  try {
    await markInTransit(orderId);
    showToast("Pacote coletado — siga para o destino");
  } catch (err) { showToast(err.message); }
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

  // Roda a verificação de IA
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
  switchMainTab,
  submitOrder: submitOrderHandler,
  calculatePrice: calcPriceNow,
  updateVehicleSuggestion,
  confirmPayment: confirmPaymentHandler,
  closeCheckout: () => document.getElementById("checkout-modal")?.classList.add("hidden"),
  copyPixKey: copyPixKeyHandler,
  acceptOrderFromUI,
  openPODFromUI,
  markPickedUp,
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
      b.classList.remove("bg-primary", "text-white", "shadow-sm");
      b.classList.add("text-gray-500");
    });
    const map = { Todos: "filter-todos", Moto: "filter-moto", Carro: "filter-carro" };
    const active = document.getElementById(map[f]);
    if (active) {
      active.classList.add("bg-primary", "text-white", "shadow-sm");
      active.classList.remove("text-gray-500");
    }
    renderDriverMural();
  },
  openDriverWallet: () => {
    if (!driverProfile) return;
    const balance = Number(driverProfile.balance || 0).toFixed(2).replace(".", ",");
    showToast(`Saldo atual: R$ ${balance}. Solicitação de saque registrada.`);
  },
  openWhatsAppSupport: () => window.open(`https://wa.me/${SUPPORT_WHATSAPP}`, "_blank"),
  centerDriverMap,
  closeTrackingModal,
  openTrackingFor,
  updateFileLabel
});
