// Repasses PIX (payouts collection — escrita só via Cloud Function).
import {
  collection, query, orderBy, getDocs, limit, doc as docRef, getDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
import { ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { db, APP_ID, functions, storage } from "../firebase.js";
import { formatBRL, formatDate, badge, PAYOUT_STATUS, escapeHtml, downloadCsv, showToast } from "../util.js";

const updatePayoutStatus = httpsCallable(functions, "adminUpdatePayoutStatus");

const PAYOUTS_PATH = `artifacts/${APP_ID}/payouts`;

function pixKeyLabel(t) {
  return ({ cpf: "CPF", email: "E-mail", phone: "Telefone", random: "Chave aleatória" })[t] || (t || "Chave");
}

async function loadDriverPhone(driverId) {
  if (!driverId) return null;
  try {
    const snap = await getDoc(docRef(db, `artifacts/${APP_ID}/users/${driverId}/profile/driverInfo`));
    if (!snap.exists()) return null;
    const d = snap.data();
    return { phone: d.phone || d.whatsapp || "", name: d.name || d.fullName || "" };
  } catch {
    return null;
  }
}

function onlyDigits(s) {
  return (s || "").replace(/\D+/g, "");
}

function whatsappLink(rawPhone, message) {
  let p = onlyDigits(rawPhone);
  if (!p) return null;
  // Adiciona DDI Brasil se vier só com DDD+número (10-11 dígitos)
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return `https://wa.me/${p}?text=${encodeURIComponent(message)}`;
}

async function uploadReceipt(payoutId, file) {
  const ext = (file.name?.split(".").pop() || "jpg").toLowerCase();
  const path = `artifacts/${APP_ID}/payouts/${payoutId}/receipt-${Date.now()}.${ext}`;
  const ref = storageRef(storage, path);
  await uploadBytes(ref, file, { contentType: file.type || "image/jpeg" });
  return await getDownloadURL(ref);
}

function openCompleteModal(payout) {
  const modalContent = `
    <div class="p-6">
      <div class="flex items-start justify-between mb-4">
        <div>
          <h2 class="text-xl font-black">Marcar saque como pago</h2>
          <p class="text-sm text-slate-500 mt-1">Motorista: ${escapeHtml(payout.driverName || "—")}</p>
        </div>
        <button onclick="window.adminApp.closeModal()" class="text-slate-400 hover:text-slate-700 text-xl"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="bg-slate-50 rounded-xl p-4 mb-4 space-y-2 text-sm">
        <div class="flex justify-between"><span class="text-slate-500">Valor</span><span class="font-black text-lg">${formatBRL(payout.amount)}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">${pixKeyLabel(payout.pixKeyType)}</span><span class="font-mono font-bold">${escapeHtml(payout.pixKey || "—")}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Solicitado</span><span>${formatDate(payout.createdAt)}</span></div>
        <button id="copy-pix-key" class="mt-2 w-full py-2 text-xs font-bold rounded-lg bg-slate-200 hover:bg-slate-300">
          <i class="fa-regular fa-copy"></i> Copiar chave PIX (cola no app do banco)
        </button>
      </div>

      <div class="mb-4">
        <label class="block text-xs font-extrabold uppercase text-slate-500 mb-2">Comprovante do PIX (opcional, mas recomendado)</label>
        <input type="file" id="receipt-file" accept="image/*,application/pdf"
               class="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:font-bold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200" />
        <p class="text-xs text-slate-400 mt-1">JPG/PNG/PDF até 5MB. Print da tela "PIX enviado" do app do banco/MP.</p>
        <div id="receipt-preview" class="mt-3 hidden"></div>
      </div>

      <div class="mb-4">
        <label class="block text-xs font-extrabold uppercase text-slate-500 mb-2">Nota interna (opcional)</label>
        <input type="text" id="payout-note" placeholder="ex: E2E do PIX MP, código transação..." class="w-full px-3 py-2 border-2 border-slate-200 rounded-lg text-sm" />
      </div>

      <div class="flex gap-2">
        <button onclick="window.adminApp.closeModal()" class="flex-1 px-4 py-3 text-sm font-bold rounded-xl bg-slate-100 hover:bg-slate-200">Cancelar</button>
        <button id="confirm-payout-btn" class="flex-1 px-4 py-3 text-sm font-black rounded-xl bg-emerald-600 text-white hover:bg-emerald-700">
          <i class="fa-solid fa-check"></i> Confirmar pagamento
        </button>
      </div>

      <p id="payout-error" class="text-danger text-sm mt-3 text-center hidden"></p>
    </div>
  `;
  window.adminApp.openModal(modalContent);

  document.getElementById("copy-pix-key").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(payout.pixKey || "");
      showToast("Chave PIX copiada");
    } catch (e) {
      showToast("Erro ao copiar: " + e.message);
    }
  });

  const fileInput = document.getElementById("receipt-file");
  const preview = document.getElementById("receipt-preview");
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) { preview.classList.add("hidden"); preview.innerHTML = ""; return; }
    if (f.size > 5 * 1024 * 1024) {
      preview.classList.remove("hidden");
      preview.innerHTML = `<p class="text-danger text-xs font-bold">Arquivo passou de 5MB.</p>`;
      return;
    }
    if (f.type.startsWith("image/")) {
      const url = URL.createObjectURL(f);
      preview.classList.remove("hidden");
      preview.innerHTML = `<img src="${url}" class="rounded-lg border border-slate-200 max-h-48" />`;
    } else {
      preview.classList.remove("hidden");
      preview.innerHTML = `<p class="text-xs text-slate-500"><i class="fa-regular fa-file-pdf"></i> ${escapeHtml(f.name)} (${(f.size / 1024).toFixed(0)} KB)</p>`;
    }
  });

  document.getElementById("confirm-payout-btn").addEventListener("click", async () => {
    const btn = document.getElementById("confirm-payout-btn");
    const errEl = document.getElementById("payout-error");
    const note = document.getElementById("payout-note").value.trim();
    const file = fileInput.files?.[0] || null;
    errEl.classList.add("hidden");
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';
    try {
      let receiptUrl = null;
      if (file) {
        btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin"></i> Subindo comprovante...';
        receiptUrl = await uploadReceipt(payout.id, file);
      }
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Finalizando...';
      await updatePayoutStatus({ payoutId: payout.id, action: "complete", note, receiptUrl });
      window.adminApp.closeModal();
      openPaidSuccessModal({ ...payout, receiptUrl, completedAt: Date.now() });
    } catch (e) {
      errEl.textContent = "Erro: " + (e.message || e);
      errEl.classList.remove("hidden");
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirmar pagamento';
    }
  });
}

async function openPaidSuccessModal(payout) {
  // Mostra confirmação + botão WhatsApp pro motorista com link do comprovante.
  const phone = await loadDriverPhone(payout.driverId);
  const driverName = (phone?.name || payout.driverName || "").split(" ")[0] || "Motorista";
  const amount = formatBRL(payout.amount);
  const receipt = payout.receiptUrl || "";
  const message = `Olá ${driverName}! O PIX do seu saque de ${amount} foi enviado pela NaMão Delivery. ✅\n${receipt ? `Comprovante: ${receipt}` : ""}\n\nQualquer dúvida, é só responder por aqui.`.trim();
  const waLink = phone?.phone ? whatsappLink(phone.phone, message) : null;

  window.adminApp.openModal(`
    <div class="p-6 text-center">
      <div class="w-16 h-16 mx-auto bg-emerald-100 rounded-full flex items-center justify-center mb-3">
        <i class="fa-solid fa-circle-check text-3xl text-emerald-600"></i>
      </div>
      <h2 class="text-xl font-black">Saque marcado como pago</h2>
      <p class="text-sm text-slate-500 mt-1">${amount} → ${escapeHtml(payout.pixKey || "—")}</p>

      ${receipt
        ? `<div class="mt-4 border-2 border-emerald-200 rounded-xl p-3 bg-emerald-50">
             <p class="text-xs font-bold text-emerald-700 mb-1">Comprovante salvo</p>
             <a href="${escapeHtml(receipt)}" target="_blank" class="text-xs underline text-emerald-700 break-all">${escapeHtml(receipt.slice(0, 80))}${receipt.length > 80 ? "..." : ""}</a>
           </div>`
        : `<div class="mt-4 border-2 border-amber-200 rounded-xl p-3 bg-amber-50 text-amber-700 text-xs font-bold">
             <i class="fa-solid fa-triangle-exclamation"></i> Você não anexou comprovante — recomendado pra histórico.
           </div>`
      }

      <div class="mt-5 space-y-2">
        ${waLink
          ? `<a href="${waLink}" target="_blank" class="block w-full px-4 py-3 text-sm font-black rounded-xl bg-green-500 hover:bg-green-600 text-white">
               <i class="fa-brands fa-whatsapp"></i> Enviar comprovante pelo WhatsApp
             </a>`
          : `<p class="text-xs text-amber-700 font-bold">Sem telefone cadastrado do motorista — não dá pra enviar WhatsApp.</p>`
        }
        <button onclick="window.adminApp.closeModal();window.location.reload();" class="block w-full px-4 py-3 text-sm font-bold rounded-xl bg-slate-100 hover:bg-slate-200">Fechar</button>
      </div>
    </div>
  `);
}

function openCancelModal(payout) {
  window.adminApp.openModal(`
    <div class="p-6">
      <div class="flex items-start justify-between mb-3">
        <h2 class="text-xl font-black">Cancelar saque</h2>
        <button onclick="window.adminApp.closeModal()" class="text-slate-400 hover:text-slate-700 text-xl"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <p class="text-sm text-slate-600 mb-3">Os ganhos voltam pro saldo disponível do motorista. Use isso quando a chave PIX estiver errada ou o pagamento não puder ser feito.</p>
      <div class="bg-slate-50 rounded-xl p-3 text-sm mb-3">
        <div class="flex justify-between"><span class="text-slate-500">Valor</span><span class="font-bold">${formatBRL(payout.amount)}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Motorista</span><span class="font-bold">${escapeHtml(payout.driverName || "—")}</span></div>
      </div>
      <div class="mb-3">
        <label class="block text-xs font-extrabold uppercase text-slate-500 mb-1">Motivo</label>
        <input type="text" id="cancel-note" placeholder="ex: chave PIX inválida" class="w-full px-3 py-2 border-2 border-slate-200 rounded-lg text-sm" />
      </div>
      <div class="flex gap-2">
        <button onclick="window.adminApp.closeModal()" class="flex-1 px-4 py-3 text-sm font-bold rounded-xl bg-slate-100 hover:bg-slate-200">Voltar</button>
        <button id="confirm-cancel-btn" class="flex-1 px-4 py-3 text-sm font-black rounded-xl bg-danger text-white hover:bg-red-700">
          <i class="fa-solid fa-ban"></i> Cancelar saque
        </button>
      </div>
      <p id="cancel-error" class="text-danger text-sm mt-3 text-center hidden"></p>
    </div>
  `);
  document.getElementById("confirm-cancel-btn").addEventListener("click", async () => {
    const btn = document.getElementById("confirm-cancel-btn");
    const errEl = document.getElementById("cancel-error");
    const note = document.getElementById("cancel-note").value.trim();
    errEl.classList.add("hidden");
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
      await updatePayoutStatus({ payoutId: payout.id, action: "cancel", note });
      window.adminApp.closeModal();
      showToast("Saque cancelado. Ganhos voltam pro saldo do motorista.");
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      errEl.textContent = "Erro: " + (e.message || e);
      errEl.classList.remove("hidden");
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-ban"></i> Cancelar saque';
    }
  });
}

// Expostas pros onclick inline
window.__payoutOpenComplete = function (payoutId) {
  const p = window.__payoutCache?.[payoutId];
  if (p) openCompleteModal(p);
};
window.__payoutOpenCancel = function (payoutId) {
  const p = window.__payoutCache?.[payoutId];
  if (p) openCancelModal(p);
};
window.__payoutOpenReceipt = function (url) {
  if (url) window.open(url, "_blank");
};

async function loadPayouts(n = 200) {
  const q = query(collection(db, PAYOUTS_PATH), orderBy("createdAt", "desc"), limit(n));
  const snap = await getDocs(q);
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

export async function renderPayouts({ content, actionsRoot }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;
  let payouts;
  try {
    payouts = await loadPayouts();
  } catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  // Cache por id pros handlers globais (escape de strings em onclick fica complicado)
  window.__payoutCache = Object.fromEntries(payouts.map((p) => [p.id, p]));

  actionsRoot.innerHTML = `
    <button id="csv-payouts" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  document.getElementById("csv-payouts").addEventListener("click", () => {
    const rows = [["ID", "Motorista", "Valor", "Status", "Chave PIX", "MP ID", "Criado", "Concluído", "Comprovante"]];
    payouts.forEach((p) => rows.push([
      p.id, p.driverName || p.driverId || "", p.amount || "", p.status || "",
      p.pixKey || "", p.mpRequestId || "", new Date(p.createdAt || 0).toISOString(),
      p.completedAt ? new Date(p.completedAt).toISOString() : "",
      p.receiptUrl || "",
    ]));
    downloadCsv(`repasses-${Date.now()}.csv`, rows);
  });

  const total = payouts.reduce((s, p) => s + Number(p.amount || 0), 0);
  const completed = payouts.filter((p) => p.status === "completed").reduce((s, p) => s + Number(p.amount || 0), 0);
  const pending = payouts.filter((p) => ["processing", "pending"].includes(p.status)).reduce((s, p) => s + Number(p.amount || 0), 0);
  const failed = payouts.filter((p) => p.status === "failed").length;

  content.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Total processado</p>
        <p class="text-2xl font-black">${formatBRL(total)}</p>
      </div>
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Concluídos</p>
        <p class="text-2xl font-black text-accent">${formatBRL(completed)}</p>
      </div>
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Pendentes (a pagar)</p>
        <p class="text-2xl font-black text-warn">${formatBRL(pending)}</p>
      </div>
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Falharam</p>
        <p class="text-2xl font-black text-danger">${failed}</p>
      </div>
    </div>

    <div class="bg-white rounded-2xl shadow-card overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <p class="font-black">Repasses PIX (saídas)</p>
        <p class="text-xs text-slate-500">${payouts.length} registros</p>
      </div>
      ${payouts.length === 0 ? `<p class="text-center py-12 text-slate-400 text-sm">Nenhum repasse ainda. Quando algum motorista clicar em "Receber" no app, aparece aqui.</p>` : `
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
            <tr>
              <th class="px-5 py-2 text-left">ID</th>
              <th class="px-5 py-2 text-left">Motorista</th>
              <th class="px-5 py-2 text-left">Status</th>
              <th class="px-5 py-2 text-left">Chave PIX</th>
              <th class="px-5 py-2 text-right">Valor</th>
              <th class="px-5 py-2 text-right">Quando</th>
              <th class="px-5 py-2 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${payouts.map((p) => {
              const canAct = ["pending", "processing", "failed"].includes(p.status);
              const hasReceipt = !!p.receiptUrl;
              return `
                <tr class="table-row border-t border-slate-100">
                  <td class="px-5 py-3 font-mono text-xs text-slate-500">#${escapeHtml(p.id.slice(-8).toUpperCase())}</td>
                  <td class="px-5 py-3">
                    <p class="font-bold">${escapeHtml(p.driverName || "—")}</p>
                    <p class="text-xs text-slate-500 font-mono">${escapeHtml((p.driverId || "").slice(0, 12))}</p>
                  </td>
                  <td class="px-5 py-3">${badge(PAYOUT_STATUS, p.status)}</td>
                  <td class="px-5 py-3 font-mono text-xs">${escapeHtml((p.pixKey || "—"))}</td>
                  <td class="px-5 py-3 text-right font-bold">${formatBRL(p.amount)}</td>
                  <td class="px-5 py-3 text-right text-xs text-slate-500">${formatDate(p.createdAt)}</td>
                  <td class="px-5 py-3 text-right whitespace-nowrap">
                    ${canAct ? `
                      <button onclick="window.__payoutOpenComplete('${escapeHtml(p.id)}')" class="px-2 py-1 text-xs font-bold rounded bg-emerald-600 text-white hover:bg-emerald-700 mr-1">
                        <i class="fa-solid fa-check"></i> Pagar
                      </button>
                      <button onclick="window.__payoutOpenCancel('${escapeHtml(p.id)}')" class="px-2 py-1 text-xs font-bold rounded bg-slate-200 text-slate-700 hover:bg-slate-300">
                        <i class="fa-solid fa-xmark"></i>
                      </button>
                    ` : hasReceipt ? `
                      <button onclick="window.__payoutOpenReceipt('${escapeHtml(p.receiptUrl)}')" class="px-2 py-1 text-xs font-bold rounded bg-slate-200 text-slate-700 hover:bg-slate-300">
                        <i class="fa-regular fa-file-image"></i> Comprovante
                      </button>
                    ` : `<span class="text-xs text-slate-400">—</span>`}
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
}
