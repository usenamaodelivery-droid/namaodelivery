// Motoristas: lista + filtros + ações (aprovar/bloquear/suspender) + KYC.
import {
  collectionGroup, query, getDocs, doc, updateDoc, getDoc,
  collection, where, orderBy,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID, DRIVER_SHARE } from "../firebase.js";
import {
  formatBRL, formatDate, badge, DRIVER_STATUS, escapeHtml, showToast,
  confirmDialog, debounce, downloadCsv,
} from "../util.js";

let allDrivers = [];
let filterStatus = "all";
let filterText = "";

async function loadDrivers() {
  // collectionGroup busca todos os subcollection 'profile' e filtramos só driverInfo
  const snap = await getDocs(collectionGroup(db, "profile"));
  const out = [];
  snap.forEach((d) => {
    if (d.id !== "driverInfo") return;
    const uid = d.ref.parent.parent.id;
    out.push({ uid, ...d.data() });
  });
  // Ordena: pendentes primeiro, depois por createdAt desc
  out.sort((a, b) => {
    const ar = a.status === "pending" || !a.status ? 0 : 1;
    const br = b.status === "pending" || !b.status ? 0 : 1;
    if (ar !== br) return ar - br;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return out;
}

async function loadDriverEarnings(uid) {
  // Soma 85% das entregas concluídas
  const snap = await getDocs(query(
    collection(db, `artifacts/${APP_ID}/public/data/orders`),
    where("driverId", "==", uid),
    where("status", "==", "completed"),
  ));
  let total = 0;
  let count = 0;
  let pending = 0;
  let paid = 0;
  snap.forEach((d) => {
    const o = d.data();
    const earn = (Number(o.price) || 0) * DRIVER_SHARE;
    total += earn;
    count++;
    if (o.payoutStatus === "completed") paid += earn;
    else if (o.payoutStatus === "pending") pending += earn;
  });
  return { total, count, pending, paid, available: total - pending - paid };
}

async function setDriverStatus(uid, status) {
  const ref = doc(db, `artifacts/${APP_ID}/users/${uid}/profile/driverInfo`);
  await updateDoc(ref, { status, statusChangedAt: Date.now() });
}

function filtered() {
  return allDrivers.filter((d) => {
    if (filterStatus !== "all" && (d.status || "pending") !== filterStatus) return false;
    if (filterText) {
      const q = filterText.toLowerCase();
      const hay = `${d.name || ""} ${d.fullName || ""} ${d.email || ""} ${d.phone || ""} ${d.cpf || ""} ${d.uid}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function row(d) {
  const name = d.name || d.fullName || "(sem nome)";
  const initials = name.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  const photo = d.photoUrl || d.selfieUrl || "";
  return `
    <tr class="table-row border-t border-slate-100">
      <td class="px-5 py-3">
        ${photo
          ? `<img src="${escapeHtml(photo)}" class="w-10 h-10 rounded-full object-cover" alt="" />`
          : `<div class="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center font-bold text-slate-600">${escapeHtml(initials)}</div>`
        }
      </td>
      <td class="px-5 py-3">
        <p class="font-bold">${escapeHtml(name)}</p>
        <p class="text-xs text-slate-500">${escapeHtml(d.email || d.phone || d.cpf || d.uid.slice(0, 8) + "...")}</p>
      </td>
      <td class="px-5 py-3">${badge(DRIVER_STATUS, d.status || "pending")}</td>
      <td class="px-5 py-3 text-sm">${escapeHtml(d.veh || "Moto")}</td>
      <td class="px-5 py-3 text-xs text-slate-500">${formatDate(d.createdAt)}</td>
      <td class="px-5 py-3 text-right">
        <button onclick="window.driversSection.openDetail('${escapeHtml(d.uid)}')" class="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">Detalhes</button>
      </td>
    </tr>
  `;
}

async function openDetail(uid) {
  const ref = doc(db, `artifacts/${APP_ID}/users/${uid}/profile/driverInfo`);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    showToast("Motorista não encontrado", "error");
    return;
  }
  const d = { uid, ...snap.data() };
  const earn = await loadDriverEarnings(uid).catch(() => ({ total: 0, count: 0, pending: 0, paid: 0, available: 0 }));

  const html = `
    <div class="p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-black"><i class="fa-solid fa-motorcycle mr-2 text-accent"></i>Motorista</h2>
        <button onclick="window.adminApp.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="flex items-start gap-4 mb-5">
        ${d.photoUrl || d.selfieUrl
          ? `<img src="${escapeHtml(d.photoUrl || d.selfieUrl)}" class="w-20 h-20 rounded-2xl object-cover" />`
          : `<div class="w-20 h-20 rounded-2xl bg-slate-200 flex items-center justify-center text-2xl font-black text-slate-500">${escapeHtml((d.name || "??").split(" ").map((s)=>s[0]).slice(0,2).join("").toUpperCase())}</div>`
        }
        <div class="flex-1">
          <p class="text-xl font-black">${escapeHtml(d.name || d.fullName || "(sem nome)")}</p>
          <p class="text-sm text-slate-500">${escapeHtml(d.email || d.phone || "—")}</p>
          <div class="mt-2">${badge(DRIVER_STATUS, d.status || "pending")}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm mb-5">
        <div><p class="text-tiny text-slate-500 uppercase font-bold">CPF</p><p class="font-mono">${escapeHtml(d.cpf || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Telefone</p><p>${escapeHtml(d.phone || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">CNH</p><p class="font-mono">${escapeHtml(d.cnh || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Veículo</p><p>${escapeHtml(d.veh || "—")} ${escapeHtml(d.plate || "")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Cidade</p><p>${escapeHtml(d.city || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Cadastro</p><p class="text-xs">${formatDate(d.createdAt)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Chave PIX (${escapeHtml(d.pixKeyType || "—")})</p><p class="font-mono text-xs break-all">${escapeHtml(d.pixKey || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">UID</p><p class="font-mono text-xs break-all">${escapeHtml(d.uid)}</p></div>
      </div>

      <div class="bg-slate-50 rounded-xl p-4 mb-5">
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Ganhos (85% das entregas)</p>
        <div class="grid grid-cols-3 gap-3 text-sm">
          <div><p class="text-tiny text-slate-500">Total</p><p class="font-black text-lg">${formatBRL(earn.total)}</p></div>
          <div><p class="text-tiny text-slate-500">Disponível</p><p class="font-black text-lg text-accent">${formatBRL(earn.available)}</p></div>
          <div><p class="text-tiny text-slate-500">Já pago</p><p class="font-black text-lg">${formatBRL(earn.paid)}</p></div>
        </div>
        <p class="text-xs text-slate-500 mt-2">${earn.count} entregas no total</p>
      </div>

      ${(d.cnhUrl || d.crlvUrl || d.docUrl)
        ? `<div class="mb-5">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Documentos</p>
            <div class="flex gap-2 flex-wrap">
              ${d.cnhUrl  ? `<a href="${escapeHtml(d.cnhUrl)}" target="_blank" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-bold">CNH ↗</a>` : ""}
              ${d.crlvUrl ? `<a href="${escapeHtml(d.crlvUrl)}" target="_blank" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-bold">CRLV ↗</a>` : ""}
              ${d.docUrl  ? `<a href="${escapeHtml(d.docUrl)}" target="_blank" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-bold">Doc ↗</a>` : ""}
              ${d.selfieUrl ? `<a href="${escapeHtml(d.selfieUrl)}" target="_blank" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-bold">Selfie ↗</a>` : ""}
            </div>
          </div>` : ""}

      <div class="flex gap-2 flex-wrap">
        ${d.status !== "approved" ? `<button data-act="approve"  class="flex-1 py-2.5 bg-accent text-white font-black rounded-xl hover:bg-accent-dark"><i class="fa-solid fa-check mr-2"></i>Aprovar</button>` : ""}
        ${d.status !== "blocked"  ? `<button data-act="block"    class="flex-1 py-2.5 bg-danger text-white font-black rounded-xl hover:bg-red-700"><i class="fa-solid fa-ban mr-2"></i>Bloquear</button>` : ""}
        ${d.status !== "suspended"? `<button data-act="suspend"  class="flex-1 py-2.5 bg-warn text-white font-black rounded-xl hover:bg-yellow-600"><i class="fa-solid fa-pause mr-2"></i>Suspender</button>` : ""}
        ${d.status !== "rejected" ? `<button data-act="reject"   class="flex-1 py-2.5 bg-slate-200 text-slate-700 font-bold rounded-xl hover:bg-slate-300"><i class="fa-solid fa-xmark mr-2"></i>Reprovar</button>` : ""}
      </div>
    </div>
  `;

  window.adminApp.openModal(html);
  document.querySelectorAll("#modal-content [data-act]").forEach((b) => {
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      const map = { approve: "approved", block: "blocked", suspend: "suspended", reject: "rejected" };
      const status = map[act];
      const ok = await confirmDialog(`Tem certeza? Motorista vai ficar como "${status}".`);
      if (!ok) return;
      try {
        await setDriverStatus(uid, status);
        showToast(`Motorista ${status}`, "success");
        window.adminApp.closeModal();
        // Atualiza cache local
        const d2 = allDrivers.find((x) => x.uid === uid);
        if (d2) { d2.status = status; d2.statusChangedAt = Date.now(); }
        rerender();
      } catch (e) {
        showToast(e.message || "Erro ao salvar", "error");
      }
    });
  });
}

let rootRef;
function rerender() {
  if (!rootRef) return;
  const list = filtered();
  const tbody = rootRef.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = list.length
    ? list.map(row).join("")
    : `<tr><td colspan="6" class="text-center py-10 text-slate-400 text-sm">Nenhum motorista encontrado</td></tr>`;
  rootRef.querySelector("[data-count]").textContent = `${list.length} de ${allDrivers.length}`;
}

export async function renderDrivers({ content, actionsRoot }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;
  try {
    allDrivers = await loadDrivers();
  } catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  actionsRoot.innerHTML = `
    <button id="csv-drivers" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  actionsRoot.querySelector("#csv-drivers").addEventListener("click", () => {
    const rows = [["UID", "Nome", "Email", "Telefone", "CPF", "Veículo", "Status", "Cadastro"]];
    allDrivers.forEach((d) => rows.push([
      d.uid, d.name || d.fullName || "", d.email || "", d.phone || "", d.cpf || "",
      d.veh || "", d.status || "pending", new Date(d.createdAt || 0).toISOString(),
    ]));
    downloadCsv(`motoristas-${Date.now()}.csv`, rows);
  });

  content.innerHTML = `
    <div class="bg-white rounded-2xl shadow-card overflow-hidden" id="drivers-root">
      <div class="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between">
        <div class="flex items-center gap-2 flex-wrap">
          <select id="driver-status-filter" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Todos os status</option>
            <option value="pending">Pendente</option>
            <option value="approved">Aprovado</option>
            <option value="blocked">Bloqueado</option>
            <option value="suspended">Suspenso</option>
            <option value="rejected">Reprovado</option>
          </select>
          <input id="driver-search" type="text" placeholder="🔍 Nome, email, CPF, UID..." class="px-3 py-2 text-sm rounded-lg border border-slate-200 w-64" />
        </div>
        <p class="text-xs text-slate-500"><span data-count></span> motoristas</p>
      </div>
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-5 py-2 text-left w-14"></th>
            <th class="px-5 py-2 text-left">Nome</th>
            <th class="px-5 py-2 text-left">Status</th>
            <th class="px-5 py-2 text-left">Veículo</th>
            <th class="px-5 py-2 text-left">Cadastro</th>
            <th class="px-5 py-2 text-right"></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  rootRef = document.getElementById("drivers-root");

  document.getElementById("driver-status-filter").addEventListener("change", (e) => {
    filterStatus = e.target.value;
    rerender();
  });
  document.getElementById("driver-search").addEventListener("input", debounce((e) => {
    filterText = e.target.value;
    rerender();
  }, 200));
  rerender();

  window.driversSection = { openDetail };

  return () => { rootRef = null; window.driversSection = null; };
}
