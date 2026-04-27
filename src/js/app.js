// Entrypoint da app
import { auth, onAuth, handleAuth, signOutUser } from "./auth.js";
import { showToast, switchView, switchMainTab } from "./ui.js";
import {
  subscribeOrders,
  createOrder,
  acceptOrder,
  markInTransit,
  calculatePrice
} from "./orders.js";
import { subscribeDriverProfile, registerDriver } from "./driverProfile.js";
import { openPOD, closePOD, confirmDeliveryWithPOD, clearSignature, initSignaturePad, validatePOD } from "./pod.js";
import { confirmPix, setDriverStatus } from "./admin.js";
import { startTracking, stopTracking } from "./geolocation.js";
import { initClientMap, initDriverMap, destCoords, straightLineKm, startCoords } from "./maps.js";
import {
  APP_ID,
  DRIVER_SHARE,
  PIX_KEY,
  SUPPORT_WHATSAPP,
  ROUTE_DETOUR_FACTOR
} from "./firebaseConfig.js";

let currentUser = null;
let driverProfile = null;
let orders = [];
let currentTotalPrice = 0;
let driverFilter = "Todos";
let unsubOrders = null;
let unsubDriver = null;

// --- Auth lifecycle ---
onAuth(async (user) => {
  if (!user) {
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("account-blocked-overlay").classList.add("hidden");
    if (unsubOrders) { unsubOrders(); unsubOrders = null; }
    if (unsubDriver) { unsubDriver(); unsubDriver = null; }
    currentUser = null;
    driverProfile = null;
    return;
  }
  currentUser = user;
  document.getElementById("auth-screen").classList.add("hidden");

  // Listener de perfil (banimento + carteira)
  unsubDriver = subscribeDriverProfile(user.uid, (profile) => {
    driverProfile = profile;
    applyDriverProfile();
  });

  // Listener de pedidos
  unsubOrders = subscribeOrders((list) => {
    orders = list;
    renderAll();
  });

  initClientMap(() => calcPriceNow());
  initDriverMap();
  initSignaturePad();

  // Detecta admin via custom claim
  const token = await user.getIdTokenResult(true);
  window.__isAdmin = Boolean(token.claims?.admin);
});

function applyDriverProfile() {
  const overlay = document.getElementById("account-blocked-overlay");
  const blockMessage = document.getElementById("block-message");
  const walletBtn = document.getElementById("driver-wallet-btn");
  const displayName = document.getElementById("profile-display-name");
  const statusLabel = document.getElementById("profile-status");
  const balanceLabel = document.getElementById("profile-wallet-balance");

  if (!driverProfile) {
    overlay.classList.add("hidden");
    walletBtn?.classList.add("hidden");
    if (displayName) displayName.innerText = currentUser?.email?.split("@")[0] || "Cliente";
    if (statusLabel) statusLabel.innerText = "Status: Cliente";
    return;
  }

  if (displayName) displayName.innerText = driverProfile.name || "Motorista";
  if (statusLabel) statusLabel.innerText = `Status: ${driverProfile.status || "Ativo"}`;
  if (balanceLabel) {
    balanceLabel.innerText = Number(driverProfile.balance || 0)
      .toFixed(2)
      .replace(".", ",");
  }
  walletBtn?.classList.remove("hidden");

  if (driverProfile.status === "blocked") {
    blockMessage.innerText = "Esta conta foi suspensa por violar as regras de segurança.";
    overlay.classList.remove("hidden");
  } else if (driverProfile.status === "suspended") {
    blockMessage.innerText = "Sua conta está suspensa temporariamente. Contate o suporte.";
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }
}

// --- Render ---
function renderAll() {
  renderCustomerActivity();
  renderDriverMural();
  renderAdminPanel();
}

function renderCustomerActivity() {
  const el = document.getElementById("customer-orders-list");
  if (!el || !currentUser) return;
  const mine = orders.filter((o) => o.customerId === currentUser.uid);
  if (mine.length === 0) {
    el.innerHTML = `<p class="text-center py-20 text-[10px] font-black text-gray-300 uppercase">Sem corridas ainda</p>`;
    return;
  }
  el.innerHTML = mine.map(renderCustomerOrderCard).join("");
}

function renderCustomerOrderCard(o) {
  const statusLabel = {
    waiting_confirmation: "Aguardando PIX",
    pending: "Procurando motorista",
    accepted: "Motorista a caminho",
    in_transit: "Em trânsito",
    completed: "Entregue",
    cancelled: "Cancelada"
  }[o.status] || o.status;
  return `
    <div class="bg-white p-5 rounded-[2rem] flex justify-between items-center shadow-sm border border-gray-100">
      <div>
        <p class="font-black text-primary">#${o.id.slice(-4)}</p>
        <p class="text-[9px] uppercase font-black text-gray-400">${statusLabel}</p>
        ${o.driverName ? `<p class="text-[10px] text-gray-500 mt-1">Motorista: ${o.driverName}</p>` : ""}
      </div>
      <p class="font-black text-primary">R$ ${Number(o.price).toFixed(2).replace(".", ",")}</p>
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
    el.innerHTML = `<p class="text-center py-20 text-[10px] font-black text-gray-300 uppercase">Procurando corridas...</p>`;
    return;
  }
  el.innerHTML = available.map(renderAvailableOrderCard).join("");
}

function renderAvailableOrderCard(o) {
  const earning = (o.price * DRIVER_SHARE).toFixed(2).replace(".", ",");
  return `
    <div class="bg-primary text-white p-6 rounded-[2.5rem] shadow-2xl mb-4 border border-white/5">
      <div class="flex justify-between items-start mb-4">
        <span class="bg-accent text-primary text-[10px] font-black px-3 py-1 rounded-full uppercase">${o.veh}</span>
        <p class="text-3xl font-black text-accent">R$ ${earning}</p>
      </div>
      <div class="text-xs space-y-1 mb-4">
        <p><i class="fa-solid fa-location-dot text-accent"></i> ${o.origin || "—"}</p>
        <p><i class="fa-solid fa-flag-checkered text-accent"></i> ${o.destination || "—"}</p>
      </div>
      <button onclick="window.acceptOrderFromUI('${o.id}')"
        class="w-full bg-accent text-primary font-black py-4 rounded-2xl uppercase shadow-xl tracking-widest">
        Aceitar Entrega
      </button>
    </div>`;
}

function renderActiveDelivery(o) {
  const earning = (o.price * DRIVER_SHARE).toFixed(2).replace(".", ",");
  const isInTransit = o.status === "in_transit";
  return `
    <div class="bg-primary text-white p-6 rounded-[2.5rem] shadow-2xl border border-accent/20">
      <p class="text-[9px] font-black text-accent uppercase tracking-widest mb-2">
        Entrega em andamento — R$ ${earning}
      </p>
      <div class="text-xs space-y-2 mb-6">
        <p><i class="fa-solid fa-location-dot text-accent"></i> ${o.origin || "—"}</p>
        <p><i class="fa-solid fa-flag-checkered text-accent"></i> ${o.destination || "—"}</p>
      </div>
      ${
        isInTransit
          ? `<button onclick="window.openPODFromUI('${o.id}')" class="w-full bg-success text-white font-black py-4 rounded-2xl uppercase shadow-xl tracking-widest">Finalizar (POD)</button>`
          : `<button onclick="window.markPickedUp('${o.id}')" class="w-full bg-accent text-primary font-black py-4 rounded-2xl uppercase shadow-xl tracking-widest">Pacote Coletado</button>`
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
  document.getElementById("admin-gross").innerText = `R$ ${gross.toFixed(2).replace(".", ",")}`;
  document.getElementById("admin-net").innerText = `R$ ${net.toFixed(2).replace(".", ",")}`;

  el.innerHTML = orders.map(renderAdminOrderCard).join("") ||
    `<p class="text-center py-20 text-[10px] font-black text-gray-300 uppercase">Sem pedidos</p>`;
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
      ? `<button onclick="window.adminConfirm('${o.id}')" class="bg-success text-white px-3 py-1.5 rounded-lg text-[9px] font-black shadow-lg uppercase">Confirmar PIX</button>`
      : `<span class="text-primary font-black">R$ ${Number(o.price).toFixed(2).replace(".", ",")}</span>`;
  return `
    <div class="bg-white p-4 rounded-2xl border border-gray-100 mb-2 flex justify-between items-center">
      <div>
        <p class="font-black text-primary text-sm">#${o.id.slice(-4)} — ${o.veh}</p>
        <span class="inline-block mt-1 text-[9px] font-black px-2 py-0.5 rounded-full uppercase ${tag}">${o.status}</span>
      </div>
      ${action}
    </div>`;
}

// --- Cliente: cálculo e checkout ---
function calcPriceNow() {
  if (!destCoords) return;
  const baseKm = straightLineKm(startCoords, destCoords);
  const km = baseKm * ROUTE_DETOUR_FACTOR;
  const veh = document.querySelector('input[name="vehicle"]:checked').value;
  currentTotalPrice = calculatePrice(km, veh);
  document.getElementById("calc-total").innerText =
    `R$ ${currentTotalPrice.toFixed(2).replace(".", ",")}`;
  document.getElementById("calc-km").innerText = `${km.toFixed(1)} KM`;
}

function submitOrderHandler(e) {
  e.preventDefault();
  if (!destCoords) {
    showToast("Toque no mapa para definir o destino");
    return;
  }
  document.getElementById("checkout-price").innerText =
    `R$ ${currentTotalPrice.toFixed(2).replace(".", ",")}`;
  document.getElementById("checkout-pix-key").value = PIX_KEY;
  document.getElementById("checkout-modal").classList.remove("hidden");
}

async function confirmPaymentHandler() {
  if (!currentUser) return;
  const veh = document.querySelector('input[name="vehicle"]:checked').value;
  const origin = document.getElementById("origem").value.trim();
  const destination = document.getElementById("destino").value.trim();
  try {
    await createOrder({
      vehicle: veh,
      price: currentTotalPrice,
      origin,
      destination,
      customerId: currentUser.uid,
      originCoords: startCoords,
      destCoords
    });
    document.getElementById("checkout-modal").classList.add("hidden");
    switchView("atividade");
    showToast("Pedido criado! Aguardando confirmação do PIX pelo admin.");
  } catch (err) {
    showToast(err.message || "Falha ao criar pedido");
  }
}

function copyPixKeyHandler() {
  const input = document.getElementById("checkout-pix-key");
  input.select();
  document.execCommand("copy");
  showToast("Chave PIX copiada!");
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

// --- Cadastro motorista ---
async function registerDriverFromUI(e) {
  e.preventDefault();
  if (!currentUser) return;
  try {
    await registerDriver(currentUser.uid, {
      name: document.getElementById("driver-name").value.trim(),
      cpf: document.getElementById("driver-cpf").value.trim(),
      plate: document.getElementById("driver-plate").value.trim().toUpperCase()
    });
    showToast("Cadastro enviado — aguardando aprovação");
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
  confirmPayment: confirmPaymentHandler,
  closeCheckout: () => document.getElementById("checkout-modal").classList.add("hidden"),
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
    renderDriverMural();
  },
  openDriverWallet: () => {
    if (!driverProfile) return;
    const balance = Number(driverProfile.balance || 0).toFixed(2).replace(".", ",");
    showToast(`Saldo atual: R$ ${balance}. Solicitação de saque registrada.`);
  },
  openWhatsAppSupport: () => window.open(`https://wa.me/${SUPPORT_WHATSAPP}`, "_blank")
});
