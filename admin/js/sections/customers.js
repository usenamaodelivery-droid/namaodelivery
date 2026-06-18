// Clientes Pedir NaMão: visão agregada por pedido.
//
// Não temos uma coleção `customers/{id}` (o MVP grava o telefone direto no
// pedido). Em vez de inventar uma coleção sintética, agregamos `orders` por
// `customerId` (telefone só com dígitos) na hora, igual o dashboard de
// motoristas faz com profile/driverInfo.
//
// Lazy load: lê até 1000 pedidos recentes pra montar a base. Em produção isso
// dá cobertura de várias semanas — quando crescer, ajustar pra paginar.
import {
  collection, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID } from "../firebase.js";
import {
  formatBRL, formatDate, badge, ORDER_STATUS, escapeHtml, showToast,
  debounce, downloadCsv,
} from "../util.js";

const ORDERS_PATH = `artifacts/${APP_ID}/public/data/orders`;
const DAY_MS = 86400000;
const MAX_ORDERS_SCANNED = 1000;

let allCustomers = [];
let orderIndex = new Map(); // customerId -> [order]
let filterTier = "all";
let filterRecency = "all";
let filterText = "";

function bucketCustomerId(o) {
  // Mesmo bucket usado no orderStore.ts do PWA pra gerar customerId.
  if (o.customerPhone) return String(o.customerPhone).replace(/\D/g, "") || `anon_${o.id}`;
  if (o.customerId) return String(o.customerId);
  return `anon_${o.id}`;
}

async function loadCustomers() {
  const snap = await getDocs(query(
    collection(db, ORDERS_PATH),
    orderBy("createdAt", "desc"),
    limit(MAX_ORDERS_SCANNED),
  ));
  const byCustomer = new Map();
  orderIndex = new Map();
  snap.forEach((d) => {
    const o = { id: d.id, ...d.data() };
    const cid = bucketCustomerId(o);
    let c = byCustomer.get(cid);
    if (!c) {
      c = {
        id: cid,
        name: o.customerName || "",
        phone: o.customerPhone || (cid.startsWith("anon_") ? "" : cid),
        firstOrderAt: o.createdAt || 0,
        lastOrderAt: o.createdAt || 0,
        lastStatus: o.status,
        ordersCount: 0,
        completedCount: 0,
        cancelledCount: 0,
        totalSpent: 0,
        addresses: new Set(),
        merchants: new Set(),
      };
      byCustomer.set(cid, c);
      orderIndex.set(cid, []);
    }
    // Mantém o nome mais "completo" (heurística: maior).
    if ((o.customerName || "").length > (c.name || "").length) c.name = o.customerName;
    if (o.customerPhone && !c.phone) c.phone = o.customerPhone;
    if ((o.createdAt || 0) > c.lastOrderAt) {
      c.lastOrderAt = o.createdAt;
      c.lastStatus = o.status;
    }
    if ((o.createdAt || 0) < c.firstOrderAt) c.firstOrderAt = o.createdAt;
    c.ordersCount++;
    if (o.status === "completed") {
      c.completedCount++;
      c.totalSpent += Number(o.price || 0);
    } else if (o.status === "cancelled" || o.status === "refunded") {
      c.cancelledCount++;
    }
    if (o.destination) c.addresses.add(o.destination);
    if (o.merchantName) c.merchants.add(o.merchantName);
    orderIndex.get(cid).push(o);
  });
  const out = [];
  for (const c of byCustomer.values()) {
    out.push({
      ...c,
      addresses: Array.from(c.addresses).slice(0, 5),
      merchants: Array.from(c.merchants).slice(0, 5),
    });
  }
  out.sort((a, b) => (b.lastOrderAt || 0) - (a.lastOrderAt || 0));
  return out;
}

function tierOf(c) {
  if (c.completedCount >= 5) return "vip";
  if (c.completedCount >= 2) return "regular";
  return "new";
}

function tierBadge(c) {
  const t = tierOf(c);
  if (t === "vip") return `<span class="badge badge-green">VIP</span>`;
  if (t === "regular") return `<span class="badge badge-blue">Recorrente</span>`;
  return `<span class="badge badge-gray">Novo</span>`;
}

function recencyOf(c) {
  if (!c.lastOrderAt) return "churned";
  const ageDays = (Date.now() - c.lastOrderAt) / DAY_MS;
  if (ageDays <= 7) return "active";
  if (ageDays <= 30) return "warm";
  return "churned";
}

function recencyBadge(c) {
  const r = recencyOf(c);
  if (r === "active") return `<span class="badge badge-green">Ativo (≤7d)</span>`;
  if (r === "warm") return `<span class="badge badge-yellow">Morno (8-30d)</span>`;
  return `<span class="badge badge-red">Inativo (>30d)</span>`;
}

function filtered() {
  return allCustomers.filter((c) => {
    if (filterTier !== "all" && tierOf(c) !== filterTier) return false;
    if (filterRecency !== "all" && recencyOf(c) !== filterRecency) return false;
    if (filterText) {
      const q = filterText.toLowerCase();
      const hay = `${c.id} ${c.name || ""} ${c.phone || ""} ${(c.addresses || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function row(c) {
  const name = c.name || "(sem nome)";
  const initials = name.split(" ").filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  return `
    <tr class="table-row border-t border-slate-100 cursor-pointer" onclick="window.customersSection.openDetail('${escapeHtml(c.id)}')">
      <td class="px-5 py-3">
        <div class="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center font-bold text-slate-600 text-sm">${escapeHtml(initials || "?")}</div>
      </td>
      <td class="px-5 py-3">
        <p class="font-bold">${escapeHtml(name)}</p>
        <p class="text-xs text-slate-500">${escapeHtml(c.phone || c.id)}</p>
      </td>
      <td class="px-5 py-3 text-center text-sm font-bold">${c.ordersCount}</td>
      <td class="px-5 py-3 text-center text-sm">${c.completedCount}</td>
      <td class="px-5 py-3 text-right font-bold">${formatBRL(c.totalSpent)}</td>
      <td class="px-5 py-3">${tierBadge(c)}</td>
      <td class="px-5 py-3">${recencyBadge(c)}</td>
      <td class="px-5 py-3 text-xs text-slate-500">${formatDate(c.lastOrderAt)}</td>
    </tr>
  `;
}

function openDetail(customerId) {
  const c = allCustomers.find((x) => x.id === customerId);
  if (!c) { showToast("Cliente não encontrado", "error"); return; }
  const orders = (orderIndex.get(customerId) || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const waLink = c.phone
    ? `https://wa.me/${String(c.phone).replace(/\D/g, "")}`
    : null;
  const avgTicket = c.completedCount > 0 ? c.totalSpent / c.completedCount : 0;

  const html = `
    <div class="p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-black"><i class="fa-solid fa-user mr-2 text-accent"></i>${escapeHtml(c.name || "(sem nome)")}</h2>
        <button onclick="window.adminApp.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="flex items-start gap-4 mb-5">
        <div class="w-16 h-16 rounded-2xl bg-slate-200 flex items-center justify-center text-xl font-black text-slate-500">
          ${escapeHtml((c.name || "?").split(" ").filter(Boolean).map((s)=>s[0]).slice(0,2).join("").toUpperCase() || "?")}
        </div>
        <div class="flex-1">
          <p class="text-xl font-black">${escapeHtml(c.name || "(sem nome)")}</p>
          <p class="text-sm text-slate-500">${escapeHtml(c.phone || c.id)}</p>
          <div class="mt-2 flex gap-2 flex-wrap">${tierBadge(c)} ${recencyBadge(c)}</div>
        </div>
        ${waLink ? `<a href="${escapeHtml(waLink)}" target="_blank" class="px-3 py-2 bg-accent text-white text-sm font-bold rounded-lg hover:bg-accent-dark whitespace-nowrap"><i class="fa-brands fa-whatsapp mr-1"></i>WhatsApp</a>` : ""}
      </div>

      <div class="grid grid-cols-4 gap-3 text-center bg-slate-50 rounded-xl p-4 mb-5">
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Pedidos</p><p class="text-lg font-black">${c.ordersCount}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Concluídos</p><p class="text-lg font-black text-accent">${c.completedCount}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Cancelados</p><p class="text-lg font-black text-danger">${c.cancelledCount}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Gastou</p><p class="text-lg font-black">${formatBRL(c.totalSpent)}</p></div>
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm mb-5">
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Ticket médio</p><p class="font-bold">${formatBRL(avgTicket)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Primeira compra</p><p class="text-xs">${formatDate(c.firstOrderAt)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Última compra</p><p class="text-xs">${formatDate(c.lastOrderAt)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">ID cliente</p><p class="font-mono text-xs break-all">${escapeHtml(c.id)}</p></div>
      </div>

      ${c.merchants && c.merchants.length > 0 ? `
        <div class="mb-5">
          <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Lojas favoritas</p>
          <div class="flex gap-2 flex-wrap">
            ${c.merchants.map((m) => `<span class="px-2 py-1 bg-slate-100 rounded-md text-xs">${escapeHtml(m)}</span>`).join("")}
          </div>
        </div>` : ""}

      ${c.addresses && c.addresses.length > 0 ? `
        <div class="mb-5">
          <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Endereços usados</p>
          <div class="space-y-1">
            ${c.addresses.map((a) => `<p class="text-xs text-slate-700 bg-slate-50 px-3 py-2 rounded-md">${escapeHtml(a)}</p>`).join("")}
          </div>
        </div>` : ""}

      ${orders.length > 0 ? `
        <div>
          <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Pedidos (${orders.length})</p>
          <div class="space-y-1 max-h-72 overflow-y-auto">
            ${orders.map((o) => `
              <div class="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-xs">
                <div>
                  <p class="font-bold">#${escapeHtml(String(o.id).slice(-6).toUpperCase())} · ${escapeHtml(o.merchantName || "—")}</p>
                  <p class="text-slate-500">${formatDate(o.createdAt)}</p>
                </div>
                <div class="text-right">
                  ${badge(ORDER_STATUS, o.status)}
                  <p class="font-bold mt-1">${formatBRL(o.price)}</p>
                </div>
              </div>
            `).join("")}
          </div>
        </div>` : `<p class="text-sm text-slate-500 text-center py-6">Sem pedidos registrados.</p>`}
    </div>
  `;
  window.adminApp.openModal(html);
}

let rootRef;
function rerender() {
  if (!rootRef) return;
  const list = filtered();
  const tbody = rootRef.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = list.length
    ? list.map(row).join("")
    : `<tr><td colspan="8" class="text-center py-10 text-slate-400 text-sm">Nenhum cliente encontrado com esses filtros.</td></tr>`;
  rootRef.querySelector("[data-count]").textContent = `${list.length} de ${allCustomers.length}`;

  const vip = allCustomers.filter((c) => tierOf(c) === "vip").length;
  const active7 = allCustomers.filter((c) => recencyOf(c) === "active").length;
  const totalSpent = allCustomers.reduce((s, c) => s + (c.totalSpent || 0), 0);
  const kpiBar = rootRef.querySelector("[data-kpis]");
  if (kpiBar) {
    kpiBar.innerHTML = `
      <span class="px-2 py-1 rounded-md bg-slate-100 text-slate-700"><b>${allCustomers.length}</b> únicos</span>
      <span class="px-2 py-1 rounded-md bg-green-100 text-green-800"><b>${active7}</b> ativos ≤7d</span>
      <span class="px-2 py-1 rounded-md bg-blue-100 text-blue-800"><b>${vip}</b> VIPs</span>
      <span class="px-2 py-1 rounded-md bg-slate-100 text-slate-700">GMV total: <b>${formatBRL(totalSpent)}</b></span>
    `;
  }
}

export async function renderCustomers({ content, actionsRoot }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i><p class="mt-2 text-sm">Agregando pedidos recentes...</p></div>`;

  try {
    allCustomers = await loadCustomers();
  } catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro ao carregar clientes:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  actionsRoot.innerHTML = `
    <button id="csv-customers" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  actionsRoot.querySelector("#csv-customers").addEventListener("click", () => {
    const rows = [["ID", "Nome", "Telefone", "Pedidos", "Concluídos", "Cancelados", "Total gasto", "Tier", "Recência", "Primeira compra", "Última compra"]];
    allCustomers.forEach((c) => rows.push([
      c.id, c.name || "", c.phone || "", String(c.ordersCount), String(c.completedCount),
      String(c.cancelledCount), c.totalSpent.toFixed(2), tierOf(c), recencyOf(c),
      new Date(c.firstOrderAt || 0).toISOString(), new Date(c.lastOrderAt || 0).toISOString(),
    ]));
    downloadCsv(`clientes-${Date.now()}.csv`, rows);
  });

  content.innerHTML = `
    <div class="bg-white rounded-2xl shadow-card overflow-hidden" id="customers-root">
      <div class="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between">
        <div class="flex items-center gap-2 flex-wrap">
          <select id="c-tier" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Todos os tiers</option>
            <option value="vip">VIPs (≥5 pedidos)</option>
            <option value="regular">Recorrentes (2-4)</option>
            <option value="new">Novos (1 pedido)</option>
          </select>
          <select id="c-recency" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Todas as recências</option>
            <option value="active">Ativos (≤7d)</option>
            <option value="warm">Mornos (8-30d)</option>
            <option value="churned">Inativos (>30d)</option>
          </select>
          <input id="c-search" type="text" placeholder="🔍 Nome, telefone, endereço..." class="px-3 py-2 text-sm rounded-lg border border-slate-200 w-64" />
        </div>
        <p class="text-xs text-slate-500"><span data-count></span> clientes</p>
      </div>
      <div class="px-5 py-3 border-b border-slate-100 flex gap-2 text-xs flex-wrap" data-kpis></div>
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-5 py-2 text-left w-14"></th>
            <th class="px-5 py-2 text-left">Nome</th>
            <th class="px-5 py-2 text-center">Pedidos</th>
            <th class="px-5 py-2 text-center">Concluídos</th>
            <th class="px-5 py-2 text-right">Total gasto</th>
            <th class="px-5 py-2 text-left">Tier</th>
            <th class="px-5 py-2 text-left">Recência</th>
            <th class="px-5 py-2 text-left">Última compra</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <p class="px-5 py-3 text-tiny text-slate-400 border-t border-slate-100">
        ⓘ Agregação dos últimos ${MAX_ORDERS_SCANNED} pedidos. Clientes mais antigos podem não aparecer até gerarem um novo pedido.
      </p>
    </div>
  `;
  rootRef = document.getElementById("customers-root");

  document.getElementById("c-tier").addEventListener("change",     (e) => { filterTier    = e.target.value; rerender(); });
  document.getElementById("c-recency").addEventListener("change",  (e) => { filterRecency = e.target.value; rerender(); });
  document.getElementById("c-search").addEventListener("input", debounce((e) => {
    filterText = e.target.value;
    rerender();
  }, 200));
  rerender();

  window.customersSection = { openDetail };
  return () => { rootRef = null; window.customersSection = null; };
}
