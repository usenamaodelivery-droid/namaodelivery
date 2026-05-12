// Repasses PIX (payouts collection — escrita só via Cloud Function).
import {
  collection, query, orderBy, getDocs, limit,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
import { db, APP_ID, functions } from "../firebase.js";
import { formatBRL, formatDate, badge, PAYOUT_STATUS, escapeHtml, downloadCsv } from "../util.js";

const updatePayoutStatus = httpsCallable(functions, "adminUpdatePayoutStatus");

async function actOnPayout(payoutId, action, btn) {
  const confirmMsg = action === "complete"
    ? "Confirmar que você já pagou esse PIX manualmente?"
    : "Cancelar esse repasse? Os ganhos voltam pro saldo do motorista.";
  if (!confirm(confirmMsg)) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    await updatePayoutStatus({ payoutId, action });
    window.location.reload();
  } catch (e) {
    alert("Erro: " + (e.message || e));
    if (btn) { btn.disabled = false; btn.innerHTML = action === "complete" ? "Marcar como pago" : "Cancelar"; }
  }
}
window.__actOnPayout = actOnPayout;

const PAYOUTS_PATH = `artifacts/${APP_ID}/payouts`;

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

  actionsRoot.innerHTML = `
    <button id="csv-payouts" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  document.getElementById("csv-payouts").addEventListener("click", () => {
    const rows = [["ID", "Motorista", "Valor", "Status", "Chave PIX", "MP ID", "Criado", "Concluído"]];
    payouts.forEach((p) => rows.push([
      p.id, p.driverName || p.driverId || "", p.amount || "", p.status || "",
      p.pixKey || "", p.mpRequestId || "", new Date(p.createdAt || 0).toISOString(),
      p.completedAt ? new Date(p.completedAt).toISOString() : "",
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
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Em processamento</p>
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
            ${payouts.map((p) => `
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
                <td class="px-5 py-3 text-right">
                  ${(p.status === "pending" || p.status === "processing" || p.status === "failed")
                    ? `
                    <button onclick="window.__actOnPayout('${p.id}', 'complete', this)" class="px-2 py-1 text-xs font-bold rounded bg-emerald-600 text-white hover:bg-emerald-700 mr-1">Marcar pago</button>
                    <button onclick="window.__actOnPayout('${p.id}', 'cancel', this)" class="px-2 py-1 text-xs font-bold rounded bg-slate-200 text-slate-700 hover:bg-slate-300">Cancelar</button>
                  `
                    : `<span class="text-xs text-slate-400">—</span>`
                  }
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
}
