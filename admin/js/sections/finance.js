// Financeiro: receita, repasses, lucro, com gráfico simples e CSV.
import {
  collection, query, where, orderBy, getDocs, limit,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID, PLATFORM_FEE, DRIVER_SHARE } from "../firebase.js";
import { formatBRL, formatDate, escapeHtml, downloadCsv } from "../util.js";

const ORDERS_PATH = `artifacts/${APP_ID}/public/data/orders`;
const PAYOUTS_PATH = `artifacts/${APP_ID}/payouts`;

const DAY_MS = 86400000;

async function loadFinance(days) {
  const since = Date.now() - days * DAY_MS;
  const ordersSnap = await getDocs(query(
    collection(db, ORDERS_PATH),
    where("status", "==", "completed"),
    where("completedAt", ">=", since),
    orderBy("completedAt", "desc"),
  )).catch(async () => {
    // fallback se não tiver índice
    return getDocs(query(collection(db, ORDERS_PATH), where("status", "==", "completed")));
  });
  const orders = [];
  ordersSnap.forEach((d) => orders.push({ id: d.id, ...d.data() }));

  // Filtra cliente-side se faltou índice
  const inWindow = orders.filter((o) => (o.completedAt || o.createdAt || 0) >= since);

  // Payouts
  let payouts = [];
  try {
    const ps = await getDocs(query(collection(db, PAYOUTS_PATH), orderBy("createdAt", "desc"), limit(500)));
    ps.forEach((d) => payouts.push({ id: d.id, ...d.data() }));
  } catch (e) { /* não tem payouts ainda */ }

  return { orders: inWindow, payouts };
}

function dayBucket(orders, days) {
  const buckets = new Array(days).fill(0);
  const labels = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    labels.push(d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }));
  }
  orders.forEach((o) => {
    const ts = o.completedAt || o.createdAt;
    if (!ts) return;
    const diff = Math.floor((today.getTime() - new Date(new Date(ts).setHours(0, 0, 0, 0)).getTime()) / DAY_MS);
    const idx = days - 1 - diff;
    if (idx >= 0 && idx < days) buckets[idx] += Number(o.price || 0);
  });
  return { labels, values: buckets };
}

function svgChart(labels, values) {
  if (!values.length) return `<p class="text-center py-8 text-slate-400 text-sm">Sem dados</p>`;
  const W = 800, H = 200, PAD = 28;
  const max = Math.max(1, ...values);
  const stepX = (W - PAD * 2) / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${PAD + i * stepX},${H - PAD - (v / max) * (H - PAD * 2)}`);
  const path = `M ${points.join(" L ")}`;
  const fill = `M ${PAD},${H - PAD} L ${points.join(" L ")} L ${W - PAD},${H - PAD} Z`;
  return `
    <div class="w-full overflow-x-auto">
      <svg viewBox="0 0 ${W} ${H}" class="w-full" style="min-width:600px;">
        <defs>
          <linearGradient id="grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#22C55E" stop-opacity="0.3" />
            <stop offset="100%" stop-color="#22C55E" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d="${fill}" fill="url(#grad)" />
        <path d="${path}" stroke="#22C55E" stroke-width="2.5" fill="none" />
        ${values.map((v, i) => `
          <circle cx="${PAD + i * stepX}" cy="${H - PAD - (v / max) * (H - PAD * 2)}" r="3" fill="#fff" stroke="#22C55E" stroke-width="2"/>
        `).join("")}
        ${labels.map((l, i) => i % Math.ceil(labels.length / 8) === 0 ? `<text x="${PAD + i * stepX}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#64748B">${l}</text>` : "").join("")}
      </svg>
    </div>
  `;
}

export async function renderFinance({ content, actionsRoot }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;

  let days = 30;
  let data;
  try {
    data = await loadFinance(days);
  } catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  const totalRevenue = data.orders.reduce((s, o) => s + Number(o.price || 0), 0);
  const driverPayouts = totalRevenue * DRIVER_SHARE;
  const platformCut = totalRevenue * PLATFORM_FEE;
  const totalPaidOut = data.payouts
    .filter((p) => p.status === "completed" || p.status === "processing")
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  const platformBalance = totalRevenue - totalPaidOut;

  const { labels, values } = dayBucket(data.orders, days);

  actionsRoot.innerHTML = `
    <select id="finance-period" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
      <option value="7">Últimos 7 dias</option>
      <option value="30" selected>Últimos 30 dias</option>
      <option value="90">Últimos 90 dias</option>
    </select>
    <button id="csv-finance" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  document.getElementById("csv-finance").addEventListener("click", () => {
    const rows = [["Data", "Receita Bruta", "Comissão (15%)", "Repasse Motoristas (85%)"]];
    labels.forEach((l, i) => rows.push([l, values[i].toFixed(2), (values[i] * PLATFORM_FEE).toFixed(2), (values[i] * DRIVER_SHARE).toFixed(2)]));
    downloadCsv(`financeiro-${days}d-${Date.now()}.csv`, rows);
  });
  document.getElementById("finance-period").addEventListener("change", async (e) => {
    days = Number(e.target.value);
    await renderFinance({ content, actionsRoot });
  });

  content.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Receita Bruta</p>
        <p class="text-3xl font-black text-accent">${formatBRL(totalRevenue)}</p>
        <p class="text-xs text-slate-500 mt-1">${data.orders.length} entregas</p>
      </div>
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Comissão Plataforma</p>
        <p class="text-3xl font-black">${formatBRL(platformCut)}</p>
        <p class="text-xs text-slate-500 mt-1">15% (lucro bruto)</p>
      </div>
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Repasse Motoristas</p>
        <p class="text-3xl font-black">${formatBRL(driverPayouts)}</p>
        <p class="text-xs text-slate-500 mt-1">85% (devido)</p>
      </div>
      <div class="bg-white p-5 rounded-2xl shadow-card">
        <p class="text-xs font-extrabold uppercase text-slate-500 mb-2">Já pago via PIX</p>
        <p class="text-3xl font-black">${formatBRL(totalPaidOut)}</p>
        <p class="text-xs text-slate-500 mt-1">${data.payouts.length} repasses</p>
      </div>
    </div>

    <div class="bg-white rounded-2xl shadow-card p-5 mb-6">
      <p class="text-sm font-extrabold uppercase text-slate-500 mb-3">Receita por dia (${days}d)</p>
      ${svgChart(labels, values)}
    </div>

    <div class="bg-white rounded-2xl shadow-card p-5">
      <p class="text-sm font-extrabold uppercase text-slate-500 mb-3">Saldo plataforma (após repasses já feitos)</p>
      <p class="text-4xl font-black ${platformBalance >= 0 ? "text-accent" : "text-danger"}">${formatBRL(platformBalance)}</p>
      <p class="text-xs text-slate-500 mt-1">Receita bruta - repasses já enviados via MP</p>
    </div>
  `;
}
