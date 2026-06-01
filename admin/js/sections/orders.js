// Pedidos: lista paginada com filtros + detalhes (chat, POD, ações).
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID, DRIVER_SHARE, PLATFORM_FEE } from "../firebase.js";
import {
  formatBRL, formatDate, badge, ORDER_STATUS, escapeHtml, showToast,
  confirmDialog, debounce, downloadCsv,
} from "../util.js";

const ORDERS_PATH = `artifacts/${APP_ID}/public/data/orders`;

let allOrders = [];
let filterStatus = "all";
let filterText = "";

async function loadOrders(n = 200) {
  const q = query(collection(db, ORDERS_PATH), orderBy("createdAt", "desc"), limit(n));
  const snap = await getDocs(q);
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

function filtered() {
  return allOrders.filter((o) => {
    if (filterStatus !== "all" && o.status !== filterStatus) return false;
    if (filterText) {
      const q = filterText.toLowerCase();
      const hay = `${o.id} ${o.customerName || ""} ${o.driverName || ""} ${o.origin || ""} ${o.destination || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function row(o) {
  return `
    <tr class="table-row border-t border-slate-100 cursor-pointer" onclick="window.ordersSection.openDetail('${escapeHtml(o.id)}')">
      <td class="px-5 py-3 font-mono text-xs text-slate-500">#${escapeHtml(o.id.slice(-6).toUpperCase())}</td>
      <td class="px-5 py-3"><p class="font-bold">${escapeHtml(o.customerName || "—")}</p><p class="text-xs text-slate-500">${escapeHtml(o.merchantName || "")}</p></td>
      <td class="px-5 py-3">${escapeHtml(o.driverName || "—")}</td>
      <td class="px-5 py-3">${badge(ORDER_STATUS, o.status)}</td>
      <td class="px-5 py-3 text-right font-bold">${formatBRL(o.price)}</td>
      <td class="px-5 py-3 text-right text-xs text-slate-500">${formatDate(o.createdAt)}</td>
    </tr>
  `;
}

async function openDetail(orderId) {
  const ref = doc(db, ORDERS_PATH, orderId);
  const snap = await getDoc(ref);
  if (!snap.exists()) { showToast("Pedido não encontrado", "error"); return; }
  const o = { id: orderId, ...snap.data() };

  // Chat
  const chatSnap = await getDocs(query(
    collection(db, ORDERS_PATH, orderId, "messages"),
    orderBy("at", "asc"),
    limit(50),
  )).catch(() => null);
  const messages = [];
  if (chatSnap) chatSnap.forEach((d) => messages.push({ id: d.id, ...d.data() }));

  const driverEarn = (Number(o.price) || 0) * DRIVER_SHARE;
  const platform = (Number(o.price) || 0) * PLATFORM_FEE;

  const html = `
    <div class="p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-black"><i class="fa-solid fa-box mr-2 text-accent"></i>Pedido #${escapeHtml(o.id.slice(-6).toUpperCase())}</h2>
        <button onclick="window.adminApp.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm mb-4">
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Status</p><div class="mt-1">${badge(ORDER_STATUS, o.status)}</div></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Valor</p><p class="font-black text-lg">${formatBRL(o.price)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Cliente</p><p class="font-bold">${escapeHtml(o.customerName || "—")}</p><p class="text-xs text-slate-500">${escapeHtml(o.customerPhone || o.customerId || "")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Motorista</p><p class="font-bold">${escapeHtml(o.driverName || "—")}</p><p class="text-xs text-slate-500">${escapeHtml(o.driverId || "—")}</p></div>
        <div class="col-span-2"><p class="text-tiny text-slate-500 uppercase font-bold">Estabelecimento</p><p>${escapeHtml(o.merchantName || "—")}</p></div>
        <div class="col-span-2"><p class="text-tiny text-slate-500 uppercase font-bold">Coleta</p><p class="text-xs">${escapeHtml(o.origin || "—")}</p></div>
        <div class="col-span-2"><p class="text-tiny text-slate-500 uppercase font-bold">Entrega</p><p class="text-xs">${escapeHtml(o.destination || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Veículo</p><p>${escapeHtml(o.veh || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Distância</p><p>${typeof o.distanceKm === "number" ? o.distanceKm.toFixed(1) + " km" : "—"}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Criado</p><p class="text-xs">${formatDate(o.createdAt)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Concluído</p><p class="text-xs">${formatDate(o.completedAt || o.deliveredAt)}</p></div>
      </div>

      <div class="bg-slate-50 rounded-xl p-3 mb-4 grid grid-cols-3 gap-2 text-center">
        <div><p class="text-tiny text-slate-500">Motorista (85% frete)</p><p class="font-black">${formatBRL(driverEarn)}</p></div>
        <div><p class="text-tiny text-slate-500">Margem NaMão (15% frete)</p><p class="font-black text-accent">${formatBRL(platform)}</p></div>
        <div><p class="text-tiny text-slate-500">Status PIX</p><p class="font-bold text-xs">${escapeHtml(o.paymentStatus || "—")}</p></div>
      </div>

      ${o.items && Array.isArray(o.items) && o.items.length ? `
        <div class="mb-4">
          <p class="text-tiny text-slate-500 uppercase font-bold mb-1">Itens</p>
          <ul class="text-sm">
            ${o.items.map((it) => `<li>${escapeHtml(it.name || it)} ${it.qty ? `× ${it.qty}` : ""} ${it.price ? `— ${formatBRL(it.price)}` : ""}</li>`).join("")}
          </ul>
        </div>
      ` : ""}

      ${o.podPhotoUrl || o.podSignatureUrl ? `
        <div class="mb-4">
          <p class="text-tiny text-slate-500 uppercase font-bold mb-2">Comprovante de entrega</p>
          <div class="flex gap-2">
            ${o.podPhotoUrl     ? `<a href="${escapeHtml(o.podPhotoUrl)}"     target="_blank"><img src="${escapeHtml(o.podPhotoUrl)}"     class="w-32 h-32 object-cover rounded-xl border" /></a>` : ""}
            ${o.podSignatureUrl ? `<a href="${escapeHtml(o.podSignatureUrl)}" target="_blank"><img src="${escapeHtml(o.podSignatureUrl)}" class="w-32 h-32 object-cover rounded-xl border bg-white" /></a>` : ""}
          </div>
        </div>
      ` : ""}

      ${messages.length ? `
        <div class="mb-4">
          <p class="text-tiny text-slate-500 uppercase font-bold mb-2">Chat (${messages.length} mensagens)</p>
          <div class="bg-slate-50 rounded-xl p-3 max-h-48 overflow-y-auto space-y-1 text-sm">
            ${messages.map((m) => `
              <div class="flex ${m.from === "driver" ? "justify-end" : "justify-start"}">
                <div class="max-w-[70%] px-3 py-1.5 rounded-xl ${m.from === "driver" ? "bg-accent text-white" : "bg-white border"}">
                  <p>${escapeHtml(m.text || "")}</p>
                  <p class="text-tiny opacity-60">${formatDate(m.at)}</p>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}

      <div class="flex gap-2 flex-wrap">
        ${["waiting_confirmation", "pending"].includes(o.status) ? `
          <button data-act="cancel" class="flex-1 py-2.5 bg-danger text-white font-black rounded-xl hover:bg-red-700">
            <i class="fa-solid fa-ban mr-2"></i>Cancelar
          </button>
        ` : ""}
        ${o.status === "waiting_confirmation" ? `
          <button data-act="confirm" class="flex-1 py-2.5 bg-accent text-white font-black rounded-xl hover:bg-accent-dark">
            <i class="fa-solid fa-check mr-2"></i>Liberar (PIX recebido)
          </button>
        ` : ""}
      </div>
    </div>
  `;
  window.adminApp.openModal(html);

  document.querySelectorAll("#modal-content [data-act]").forEach((b) => {
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "cancel") {
        const ok = await confirmDialog("Cancelar este pedido?");
        if (!ok) return;
        await updateDoc(ref, { status: "cancelled", cancelledAt: Date.now(), cancelReason: "admin_cancelled" });
        showToast("Pedido cancelado", "success");
      } else if (act === "confirm") {
        const ok = await confirmDialog("Liberar pedido (PIX confirmado manualmente)?");
        if (!ok) return;
        await updateDoc(ref, { status: "pending", paymentApprovedAt: Date.now(), paymentApprovedBy: "admin" });
        showToast("Pedido liberado pros motoristas", "success");
      }
      // Atualiza cache local
      const o2 = allOrders.find((x) => x.id === orderId);
      if (o2) {
        const fresh = (await getDoc(ref)).data();
        Object.assign(o2, fresh);
      }
      window.adminApp.closeModal();
      rerender();
    });
  });
}

let rootRef;
function rerender() {
  if (!rootRef) return;
  const list = filtered();
  const tbody = rootRef.querySelector("tbody");
  tbody.innerHTML = list.length
    ? list.map(row).join("")
    : `<tr><td colspan="6" class="text-center py-10 text-slate-400 text-sm">Nenhum pedido encontrado</td></tr>`;
  rootRef.querySelector("[data-count]").textContent = `${list.length} de ${allOrders.length}`;
}

export async function renderOrders({ content, actionsRoot }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;
  try {
    allOrders = await loadOrders(200);
  } catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  actionsRoot.innerHTML = `
    <button id="csv-orders" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  actionsRoot.querySelector("#csv-orders").addEventListener("click", () => {
    const rows = [["ID", "Cliente", "Motorista", "Status", "Valor", "Origem", "Destino", "Criado", "Concluído"]];
    allOrders.forEach((o) => rows.push([
      o.id, o.customerName || "", o.driverName || "", o.status || "",
      o.price || "", o.origin || "", o.destination || "",
      new Date(o.createdAt || 0).toISOString(),
      o.completedAt ? new Date(o.completedAt).toISOString() : "",
    ]));
    downloadCsv(`pedidos-${Date.now()}.csv`, rows);
  });

  content.innerHTML = `
    <div class="bg-white rounded-2xl shadow-card overflow-hidden" id="orders-root">
      <div class="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between">
        <div class="flex items-center gap-2 flex-wrap">
          <select id="order-status-filter" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Todos os status</option>
            <option value="waiting_confirmation">Aguarda PIX</option>
            <option value="pending">Disponível</option>
            <option value="accepted">Aceito</option>
            <option value="in_transit">A caminho</option>
            <option value="completed">Entregue</option>
            <option value="cancelled">Cancelado</option>
            <option value="refunded">Estornado</option>
          </select>
          <input id="order-search" type="text" placeholder="🔍 ID, cliente, motorista..." class="px-3 py-2 text-sm rounded-lg border border-slate-200 w-64" />
        </div>
        <p class="text-xs text-slate-500"><span data-count></span> pedidos</p>
      </div>
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-5 py-2 text-left">ID</th>
            <th class="px-5 py-2 text-left">Cliente</th>
            <th class="px-5 py-2 text-left">Motorista</th>
            <th class="px-5 py-2 text-left">Status</th>
            <th class="px-5 py-2 text-right">Valor</th>
            <th class="px-5 py-2 text-right">Criado</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  rootRef = document.getElementById("orders-root");

  document.getElementById("order-status-filter").addEventListener("change", (e) => {
    filterStatus = e.target.value;
    rerender();
  });
  document.getElementById("order-search").addEventListener("input", debounce((e) => {
    filterText = e.target.value;
    rerender();
  }, 200));
  rerender();

  window.ordersSection = { openDetail };

  return () => { rootRef = null; window.ordersSection = null; };
}
