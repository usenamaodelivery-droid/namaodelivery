// Resumo: KPIs gerais (receita, pedidos, motoristas ativos) + atalhos rápidos.
import {
  collection, collectionGroup, query, where, orderBy, limit, getDocs, getCountFromServer,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID, DRIVER_SHARE } from "../firebase.js";
import {
  formatBRL, formatDate, badge, ORDER_STATUS, escapeHtml,
  orderDriverEarnings, orderDeliveryMargin,
} from "../util.js";

const ORDERS_PATH = `artifacts/${APP_ID}/public/data/orders`;
const MERCHANTS_PATH = `artifacts/${APP_ID}/public/data/merchants`;
const DAY_MS = 86400000;

async function safeCount(q) {
  try {
    const snap = await getCountFromServer(q);
    return snap.data().count;
  } catch (e) {
    console.warn("count failed", e);
    return null;
  }
}

async function loadKpis() {
  const ordersRef = collection(db, ORDERS_PATH);
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();

  // Pedidos hoje
  const todaySnap = await getDocs(
    query(ordersRef, where("createdAt", ">=", startMs))
  );
  let todayRevenue = 0;
  let todayCompleted = 0;
  let todayActive = 0;
  todaySnap.forEach((d) => {
    const o = d.data();
    if (o.status === "completed") {
      todayRevenue += Number(o.price || 0);
      todayCompleted++;
    }
    if (["pending", "accepted", "in_transit"].includes(o.status)) {
      todayActive++;
    }
  });

  // Pedidos últimos 30 dias
  const last30 = await getDocs(
    query(ordersRef, where("createdAt", ">=", now - 30 * DAY_MS))
  );
  let monthRevenue = 0;
  let monthCompleted = 0;
  let monthDriverPayouts = 0;
  let monthDeliveryMargin = 0;
  last30.forEach((d) => {
    const o = d.data();
    if (o.status === "completed") {
      monthRevenue += Number(o.price || 0);
      monthCompleted++;
      // Repasse e margem incidem SÓ sobre o frete (fonte única em util.js).
      monthDriverPayouts += orderDriverEarnings(o, DRIVER_SHARE) || 0;
      monthDeliveryMargin += orderDeliveryMargin(o, DRIVER_SHARE) || 0;
    }
  });

  // Motoristas
  const profilesSnap = await getDocs(collectionGroup(db, "profile"));
  let driversTotal = 0;
  let driversApproved = 0;
  let driversPending = 0;
  let driversBlocked = 0;
  profilesSnap.forEach((d) => {
    if (d.id !== "driverInfo") return;
    driversTotal++;
    const p = d.data();
    if (p.status === "approved") driversApproved++;
    else if (p.status === "blocked") driversBlocked++;
    else if (p.status === "pending" || !p.status) driversPending++;
  });

  // Pedidos ativos (any status not done)
  const activeSnap = await getDocs(
    query(ordersRef, where("status", "in", ["waiting_confirmation", "pending", "accepted", "in_transit"]))
  );

  // Lojas (merchants)
  let merchantsTotal = 0;
  let merchantsActive = 0;
  let merchantsVisible = 0; // ativas com produto
  let merchantsCommissionFree = 0;
  try {
    const merchantsSnap = await getDocs(collection(db, MERCHANTS_PATH));
    merchantsSnap.forEach((d) => {
      const m = d.data();
      merchantsTotal++;
      if (m.isActive) merchantsActive++;
      if (m.isActive && Number(m.productsCount || 0) > 0) merchantsVisible++;
      if (m.commissionFree) merchantsCommissionFree++;
    });
  } catch (e) {
    console.warn("merchants count failed", e);
  }

  // Clientes únicos (últimos 30 dias, agrega por customerId no escopo já carregado)
  const customers = new Set();
  let monthOrdersTotal = 0;
  last30.forEach((d) => {
    const o = d.data();
    monthOrdersTotal++;
    const cid = o.customerPhone ? String(o.customerPhone).replace(/\D/g, "") : (o.customerId || "");
    if (cid) customers.add(cid);
  });

  return {
    todayRevenue,
    todayCompleted,
    todayActive,
    monthRevenue,
    monthCompleted,
    monthOrdersTotal,
    monthCommission: monthDeliveryMargin,
    monthDriverPayouts,
    monthUniqueCustomers: customers.size,
    driversTotal,
    driversApproved,
    driversPending,
    driversBlocked,
    merchantsTotal,
    merchantsActive,
    merchantsVisible,
    merchantsCommissionFree,
    activeOrdersCount: activeSnap.size,
  };
}

async function loadRecentOrders(n = 8) {
  const q = query(collection(db, ORDERS_PATH), orderBy("createdAt", "desc"), limit(n));
  const snap = await getDocs(q);
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

function kpiCard({ label, value, sub, icon, color }) {
  return `
    <div class="bg-white p-5 rounded-2xl shadow-card">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs font-extrabold uppercase tracking-wider text-slate-500">${escapeHtml(label)}</p>
        <div class="w-9 h-9 rounded-lg flex items-center justify-center" style="background:${color}1A;color:${color}">
          <i class="fa-solid ${icon}"></i>
        </div>
      </div>
      <p class="text-3xl font-black">${escapeHtml(value)}</p>
      ${sub ? `<p class="text-xs text-slate-500 mt-1">${escapeHtml(sub)}</p>` : ""}
    </div>
  `;
}

export async function renderDashboard({ content }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;

  let kpis;
  try {
    kpis = await loadKpis();
  } catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro ao carregar KPIs:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }
  const recent = await loadRecentOrders(8).catch(() => []);

  content.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      ${kpiCard({ label: "Receita Hoje",       value: formatBRL(kpis.todayRevenue),     sub: `${kpis.todayCompleted} pedidos concluídos`, icon: "fa-sack-dollar", color: "#22C55E" })}
      ${kpiCard({ label: "Pedidos Ativos",     value: String(kpis.activeOrdersCount),   sub: `${kpis.todayActive} hoje`, icon: "fa-box", color: "#3B82F6" })}
      ${kpiCard({ label: "Lojas no catálogo",  value: String(kpis.merchantsVisible),    sub: `${kpis.merchantsActive} ativas · ${kpis.merchantsCommissionFree} sem comissão`, icon: "fa-store", color: "#8B5CF6" })}
      ${kpiCard({ label: "Motoristas",         value: String(kpis.driversTotal),         sub: `${kpis.driversApproved} aprovados · ${kpis.driversPending} pendentes`, icon: "fa-motorcycle", color: "#F59E0B" })}
    </div>

    <h2 class="text-sm font-extrabold uppercase tracking-wider text-slate-500 mb-3">Últimos 30 dias</h2>
    <div class="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
      ${kpiCard({ label: "Receita Total (30d)",      value: formatBRL(kpis.monthRevenue),         sub: `${kpis.monthCompleted} entregas concluídas`, icon: "fa-chart-line", color: "#22C55E" })}
      ${kpiCard({ label: "Clientes únicos",          value: String(kpis.monthUniqueCustomers),    sub: `${kpis.monthOrdersTotal} pedidos totais`,    icon: "fa-users", color: "#06B6D4" })}
      ${kpiCard({ label: "Repasse Motoristas (88% frete)", value: formatBRL(kpis.monthDriverPayouts),   sub: "saiu (ou vai sair) via PIX",                icon: "fa-money-bill-transfer", color: "#3B82F6" })}
      ${kpiCard({ label: "Margem NaMão (frete)", value: formatBRL(kpis.monthCommission),     sub: "spread sobre frete · não cobrado do lojista", icon: "fa-trophy", color: "#F59E0B" })}
    </div>

    <div class="bg-white rounded-2xl shadow-card overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <p class="font-black">Últimos pedidos</p>
        <a href="#orders" class="text-sm font-bold text-accent hover:underline">Ver todos →</a>
      </div>
      ${recent.length === 0
        ? `<p class="text-center py-8 text-slate-400 text-sm">Nenhum pedido ainda</p>`
        : `
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
            <tr>
              <th class="px-5 py-2 text-left">ID</th>
              <th class="px-5 py-2 text-left">Cliente</th>
              <th class="px-5 py-2 text-left">Status</th>
              <th class="px-5 py-2 text-right">Valor</th>
              <th class="px-5 py-2 text-right">Quando</th>
            </tr>
          </thead>
          <tbody>
            ${recent.map((o) => `
              <tr class="table-row border-t border-slate-100 cursor-pointer" onclick="location.hash='#orders';">
                <td class="px-5 py-3 font-mono text-xs text-slate-500">#${escapeHtml(o.id.slice(-6).toUpperCase())}</td>
                <td class="px-5 py-3 font-bold">${escapeHtml(o.customerName || "—")}</td>
                <td class="px-5 py-3">${badge(ORDER_STATUS, o.status)}</td>
                <td class="px-5 py-3 text-right font-bold">${formatBRL(o.price)}</td>
                <td class="px-5 py-3 text-right text-xs text-slate-500">${formatDate(o.createdAt)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
}
