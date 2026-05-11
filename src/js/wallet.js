/**
 * Carteira do motorista — saldo de ganhos + cadastro de chave PIX +
 * solicitação de saque (repasse via Mercado Pago).
 *
 * Backend correspondente: functions/index.js
 *   - getDriverBalance: retorna saldo disponível + lista de entregas
 *   - requestDriverPayout: solicita repasse PIX dos ganhos
 */
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
import { doc, setDoc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { functions, db } from "./firebaseInit.js";

const APP_ID = "namao-delivery-prod";

const PIX_KEY_TYPES = [
  { value: "cpf", label: "CPF", placeholder: "000.000.000-00" },
  { value: "email", label: "E-mail", placeholder: "voce@exemplo.com" },
  { value: "phone", label: "Telefone", placeholder: "+55 11 91234-5678" },
  { value: "random", label: "Chave aleatória", placeholder: "abcd1234-..." },
];

let cachedBalance = null;

function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) { console.log("toast:", msg); return; }
  t.innerText = msg;
  t.classList.remove("hidden", "opacity-0");
  t.classList.add("opacity-100");
  setTimeout(() => {
    t.classList.add("opacity-0");
    setTimeout(() => t.classList.add("hidden"), 300);
  }, 3500);
}

function formatBRL(n) {
  return Number(n || 0).toFixed(2).replace(".", ",");
}

function profileRef(uid) {
  return doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
}

/**
 * Lê chave PIX cadastrada do perfil do motorista.
 * Retorna { pixKey, pixKeyType } ou null se não cadastrada.
 */
export async function getDriverPixKey(uid) {
  if (!uid) return null;
  const snap = await getDoc(profileRef(uid));
  if (!snap.exists()) return null;
  const d = snap.data();
  if (!d.pixKey || !d.pixKeyType) return null;
  return { pixKey: d.pixKey, pixKeyType: d.pixKeyType };
}

/**
 * Salva (ou atualiza) a chave PIX no perfil. Validação básica por tipo.
 */
export async function saveDriverPixKey(uid, pixKey, pixKeyType) {
  if (!uid) throw new Error("Login obrigatório");
  const v = (pixKey || "").trim();
  if (!v) throw new Error("Informe a chave PIX");
  if (!PIX_KEY_TYPES.find((t) => t.value === pixKeyType)) {
    throw new Error("Tipo de chave inválido");
  }
  // Validações leves — MP rejeita formatos errados de qualquer jeito
  if (pixKeyType === "cpf") {
    const digits = v.replace(/\D/g, "");
    if (digits.length !== 11) throw new Error("CPF deve ter 11 dígitos");
  }
  if (pixKeyType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new Error("E-mail inválido");
  }
  if (pixKeyType === "phone") {
    const digits = v.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 14) throw new Error("Telefone inválido (com DDD)");
  }
  await setDoc(
    profileRef(uid),
    { pixKey: v, pixKeyType, pixKeyUpdatedAt: Date.now() },
    { merge: true }
  );
  return { pixKey: v, pixKeyType };
}

/**
 * Busca saldo do motorista no backend. Retorna estrutura:
 *   { available, pending, totalEarned, deliveries: [...] }
 */
export async function fetchDriverBalance() {
  try {
    const fn = httpsCallable(functions, "getDriverBalance");
    const r = await fn({});
    cachedBalance = r.data;
    return r.data;
  } catch (e) {
    console.warn("[wallet] getDriverBalance failed", e);
    throw e;
  }
}

/**
 * Solicita repasse PIX. Backend valida chave + soma + chama MP.
 */
export async function requestPayout() {
  const fn = httpsCallable(functions, "requestDriverPayout");
  const r = await fn({});
  return r.data;
}

/* ------------------------- UI ------------------------- */

function renderPixKeyForm(currentPixKey, currentPixKeyType) {
  const typeOptions = PIX_KEY_TYPES.map(
    (t) => `<option value="${t.value}" ${t.value === currentPixKeyType ? "selected" : ""}>${t.label}</option>`
  ).join("");
  return `
    <form id="pix-key-form" class="space-y-3 text-left" onsubmit="event.preventDefault();window.savePixKeyFromUI()">
      <div>
        <label class="text-xs font-extrabold text-gray-500 uppercase tracking-wider block mb-1">Tipo de chave</label>
        <select id="pix-key-type" class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl font-bold text-primary bg-white">
          ${typeOptions}
        </select>
      </div>
      <div>
        <label class="text-xs font-extrabold text-gray-500 uppercase tracking-wider block mb-1">Chave PIX</label>
        <input id="pix-key-value" type="text" autocomplete="off"
               value="${(currentPixKey || "").replace(/"/g, "&quot;")}"
               placeholder="${PIX_KEY_TYPES.find((t) => t.value === currentPixKeyType)?.placeholder || ""}"
               class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl font-bold text-primary" />
        <p class="text-tiny text-gray-400 mt-1">É pra essa chave que vamos transferir seus ganhos via PIX.</p>
      </div>
      <button type="submit" class="btn-accent w-full py-2.5 uppercase tracking-widest text-sm">
        <i class="fa-solid fa-floppy-disk"></i> Salvar chave PIX
      </button>
    </form>
  `;
}

function renderDeliveryItem(d) {
  const date = d.completedAt ? new Date(d.completedAt).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }) : "—";
  const statusBadge = d.payoutStatus === "completed"
    ? '<span class="text-tiny font-black text-success uppercase">Pago</span>'
    : d.payoutStatus === "pending"
      ? '<span class="text-tiny font-black text-amber-600 uppercase">Processando</span>'
      : '<span class="text-tiny font-black text-blue-600 uppercase">Disponível</span>';
  return `
    <div class="border-b border-gray-100 py-2.5 last:border-0">
      <div class="flex justify-between items-start gap-3">
        <div class="flex-1 min-w-0">
          <p class="text-xs font-bold text-gray-400">#${d.shortId} · ${date}</p>
          <p class="text-sm font-extrabold text-primary truncate">${d.destination || "—"}</p>
        </div>
        <div class="text-right">
          <p class="text-sm font-black text-success">R$ ${formatBRL(d.amount)}</p>
          ${statusBadge}
        </div>
      </div>
    </div>
  `;
}

/**
 * Abre o modal de carteira. Carrega saldo + chave PIX em paralelo.
 */
export async function openWallet(uid) {
  const modal = document.getElementById("wallet-modal");
  const body = document.getElementById("wallet-body");
  if (!modal || !body) return;

  body.innerHTML = `
    <div class="text-center py-12">
      <i class="fa-solid fa-spinner fa-spin text-4xl text-primary"></i>
      <p class="text-sm font-bold text-gray-500 mt-3">Carregando saldo...</p>
    </div>
  `;
  modal.classList.remove("hidden");

  try {
    const [balance, pixInfo] = await Promise.all([
      fetchDriverBalance().catch(() => ({ available: 0, pending: 0, totalEarned: 0, deliveries: [] })),
      getDriverPixKey(uid).catch(() => null),
    ]);

    const hasPix = Boolean(pixInfo?.pixKey);
    const hasAvailable = balance.available >= 1; // mínimo R$ 1,00
    const canPayout = hasPix && hasAvailable;

    body.innerHTML = `
      <div class="space-y-4 text-left">
        <div class="bg-primary text-white rounded-2xl p-5 shadow-lg">
          <p class="text-xs font-extrabold text-accent uppercase tracking-widest">Disponível para receber</p>
          <p class="text-4xl font-black mt-1">R$ ${formatBRL(balance.available)}</p>
          <div class="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-white/20">
            <div>
              <p class="text-tiny font-bold text-white/60 uppercase">Em processamento</p>
              <p class="text-sm font-extrabold">R$ ${formatBRL(balance.pending)}</p>
            </div>
            <div>
              <p class="text-tiny font-bold text-white/60 uppercase">Total ganho</p>
              <p class="text-sm font-extrabold">R$ ${formatBRL(balance.totalEarned)}</p>
            </div>
          </div>
        </div>

        <button id="payout-btn" ${!canPayout ? "disabled" : ""}
                onclick="window.requestPayoutFromUI()"
                class="btn-accent w-full py-3.5 uppercase tracking-widest text-base ${!canPayout ? "opacity-50 cursor-not-allowed" : ""}">
          <i class="fa-solid fa-money-bill-wave"></i>
          ${hasAvailable ? `Receber R$ ${formatBRL(balance.available)} via PIX` : "Sem ganhos para receber"}
        </button>
        ${!hasPix ? '<p class="text-xs font-bold text-amber-600 -mt-2"><i class="fa-solid fa-circle-exclamation"></i> Cadastre sua chave PIX abaixo pra liberar o saque</p>' : ""}

        <div class="bg-white border-2 border-gray-100 rounded-2xl p-4 shadow-sm">
          <h3 class="text-sm font-extrabold text-primary mb-3 uppercase tracking-wider">
            <i class="fa-solid fa-key text-accent"></i> Sua chave PIX
          </h3>
          ${renderPixKeyForm(pixInfo?.pixKey || "", pixInfo?.pixKeyType || "cpf")}
        </div>

        <div class="bg-white border-2 border-gray-100 rounded-2xl p-4 shadow-sm">
          <h3 class="text-sm font-extrabold text-primary mb-2 uppercase tracking-wider">
            <i class="fa-solid fa-list text-accent"></i> Histórico de entregas
          </h3>
          ${balance.deliveries.length === 0
            ? '<p class="text-xs text-gray-400 py-3 text-center">Nenhuma entrega concluída ainda.</p>'
            : balance.deliveries.slice(0, 50).map(renderDeliveryItem).join("")}
        </div>
      </div>
    `;
  } catch (e) {
    console.error("[wallet] open failed", e);
    body.innerHTML = `
      <div class="text-center py-8">
        <i class="fa-solid fa-triangle-exclamation text-4xl text-danger"></i>
        <p class="text-sm font-bold text-gray-700 mt-3">Erro ao carregar carteira</p>
        <p class="text-xs text-gray-400 mt-1">${(e?.message || e || "").toString().slice(0, 200)}</p>
      </div>
    `;
  }
}

export function closeWallet() {
  document.getElementById("wallet-modal")?.classList.add("hidden");
}

/**
 * Handler do form: lê inputs, salva via Firestore, recarrega o modal.
 */
export async function savePixKeyHandler(uid) {
  const type = document.getElementById("pix-key-type")?.value;
  const value = document.getElementById("pix-key-value")?.value;
  const btn = document.querySelector("#pix-key-form button[type=submit]");
  if (btn) { btn.disabled = true; btn.innerText = "SALVANDO..."; }
  try {
    await saveDriverPixKey(uid, value, type);
    showToast("Chave PIX salva.");
    await openWallet(uid); // recarrega
  } catch (e) {
    showToast(e.message || "Erro ao salvar chave");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar chave PIX';
    }
  }
}

/**
 * Handler do botão "Receber" — chama Cloud Function e exibe resultado.
 */
export async function requestPayoutHandler(uid) {
  const btn = document.getElementById("payout-btn");
  const originalLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando...'; }
  try {
    const r = await requestPayout();
    showToast(`Repasse de R$ ${formatBRL(r.amount)} solicitado. Cai na sua conta em segundos.`);
    await openWallet(uid);
  } catch (e) {
    console.error("[wallet] payout failed", e);
    const msg = e?.message || e?.code || "Erro ao processar saque";
    showToast(msg);
    if (btn && originalLabel) { btn.disabled = false; btn.innerHTML = originalLabel; }
  }
}
