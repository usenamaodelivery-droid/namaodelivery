// Pré-cadastros do portal /motorista (delivery.usenamao.com).
// Path Firestore: artifacts/{APP_ID}/public/data/driverLeads/{id}
// Cada lead = motorista que preencheu o form mas ainda não baixou/instalou o app.
// Equipe entra em contato via WhatsApp pra fechar onboarding.
import {
  collection, query, orderBy, getDocs, doc, updateDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID } from "../firebase.js";
import {
  formatDate, escapeHtml, showToast, confirmDialog, debounce, downloadCsv,
} from "../util.js";

let allLeads = [];
let filterStatus = "all";
let filterText = "";
let contentRef = null;

const STATUS = {
  new:        { label: "Novo",         badge: "bg-yellow-100 text-yellow-700" },
  contacted:  { label: "Contatado",    badge: "bg-blue-100 text-blue-700"     },
  enrolled:   { label: "Cadastrou",    badge: "bg-green-100 text-green-700"   },
  rejected:   { label: "Recusado",     badge: "bg-red-100 text-red-700"       },
};

const VEHICLES = {
  bike:   "🚴 Bike",
  moto:   "🛵 Moto",
  carro:  "🚗 Carro",
  unsure: "🤔 N/D",
};

function statusBadge(s) {
  const v = STATUS[s] || STATUS.new;
  return `<span class="px-2 py-0.5 rounded-full text-tiny font-bold ${v.badge}">${escapeHtml(v.label)}</span>`;
}

async function loadLeads() {
  const snap = await getDocs(query(
    collection(db, `artifacts/${APP_ID}/public/data/driverLeads`),
    orderBy("createdAt", "desc"),
  ));
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

async function setLeadStatus(id, status) {
  await updateDoc(doc(db, `artifacts/${APP_ID}/public/data/driverLeads/${id}`), {
    status,
    statusChangedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function removeLead(id) {
  await deleteDoc(doc(db, `artifacts/${APP_ID}/public/data/driverLeads/${id}`));
}

function filtered() {
  return allLeads.filter((l) => {
    if (filterStatus !== "all" && (l.status || "new") !== filterStatus) return false;
    if (filterText) {
      const q = filterText.toLowerCase();
      const hay = `${l.name || ""} ${l.whatsapp || ""} ${l.city || ""} ${l.vehicle || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function whatsappLink(phone, msg) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "#";
  const text = encodeURIComponent(msg || "Oi! Vi seu pré-cadastro no NaMão Entregador. Posso te ajudar a começar?");
  return `https://wa.me/55${digits}?text=${text}`;
}

function row(l) {
  const phone = l.whatsapp ? l.whatsapp.replace(/(\d{2})(\d{4,5})(\d{4})/, "($1) $2-$3") : "—";
  const status = l.status || "new";
  const cnhLabel = l.hasCnh === "yes" ? "Tem CNH" : l.hasCnh === "no" ? "Sem CNH" : "N/D";
  return `
    <tr class="border-t border-slate-100 hover:bg-slate-50" data-id="${l.id}">
      <td class="px-4 py-3">
        <div class="font-bold text-slate-800">${escapeHtml(l.name || "—")}</div>
        <div class="text-tiny text-slate-500">${escapeHtml(l.city || "")} · ${escapeHtml(cnhLabel)}</div>
      </td>
      <td class="px-4 py-3">
        <a href="${whatsappLink(l.whatsapp, `Oi ${l.name || ""}! Vi seu pré-cadastro no NaMão Entregador. Posso te ajudar a começar?`)}"
           target="_blank" rel="noopener"
           class="text-primary font-bold hover:underline">${escapeHtml(phone)}</a>
      </td>
      <td class="px-4 py-3 text-sm">${VEHICLES[l.vehicle] || "—"}</td>
      <td class="px-4 py-3 text-tiny text-slate-500">${escapeHtml(l.source || "—")}</td>
      <td class="px-4 py-3 text-tiny text-slate-500">${formatDate(l.createdAt)}</td>
      <td class="px-4 py-3">${statusBadge(status)}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-2 text-sm">
          <button data-act="contact" class="text-blue-600 hover:text-blue-800" title="Marcar como contatado">📞</button>
          <button data-act="enrolled" class="text-green-600 hover:text-green-800" title="Marcar que cadastrou">✓</button>
          <button data-act="reject" class="text-red-600 hover:text-red-800" title="Recusar/descartar">✗</button>
          <button data-act="delete" class="text-slate-400 hover:text-slate-600" title="Excluir">🗑</button>
        </div>
      </td>
    </tr>
  `;
}

function paintTable() {
  if (!contentRef) return;
  const list = filtered();
  const tbody = contentRef.querySelector("[data-leads-tbody]");
  if (tbody) {
    tbody.innerHTML = list.length
      ? list.map(row).join("")
      : `<tr><td colspan="7" class="text-center py-10 text-slate-400 text-sm">Nenhum lead encontrado</td></tr>`;
  }
  const counter = contentRef.querySelector("[data-count]");
  if (counter) counter.textContent = `${list.length} de ${allLeads.length}`;
  const counts = {
    new: allLeads.filter((l) => (l.status || "new") === "new").length,
    contacted: allLeads.filter((l) => l.status === "contacted").length,
    enrolled: allLeads.filter((l) => l.status === "enrolled").length,
  };
  const k = contentRef.querySelector("[data-kpis]");
  if (k) {
    k.querySelector("[data-k-total]").textContent = allLeads.length;
    k.querySelector("[data-k-new]").textContent = counts.new;
    k.querySelector("[data-k-contacted]").textContent = counts.contacted;
    k.querySelector("[data-k-enrolled]").textContent = counts.enrolled;
  }
  bindRowActions();
}

function bindRowActions() {
  contentRef.querySelectorAll("[data-leads-tbody] tr[data-id]").forEach((tr) => {
    const id = tr.getAttribute("data-id");
    tr.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const act = btn.getAttribute("data-act");
        try {
          if (act === "contact") {
            await setLeadStatus(id, "contacted");
            showToast("Marcado como contatado", "success");
          } else if (act === "enrolled") {
            await setLeadStatus(id, "enrolled");
            showToast("Marcado como cadastrado", "success");
          } else if (act === "reject") {
            const ok = await confirmDialog("Recusar este pré-cadastro?");
            if (!ok) return;
            await setLeadStatus(id, "rejected");
            showToast("Marcado como recusado", "info");
          } else if (act === "delete") {
            const ok = await confirmDialog("Excluir este lead permanentemente?");
            if (!ok) return;
            await removeLead(id);
            showToast("Excluído", "info");
          }
          const lead = allLeads.find((l) => l.id === id);
          if (lead) {
            if (act === "delete") {
              allLeads = allLeads.filter((l) => l.id !== id);
            } else {
              lead.status = act === "contact" ? "contacted" : act === "enrolled" ? "enrolled" : "rejected";
            }
          }
          paintTable();
        } catch (err) {
          console.error("[driver-leads] action failed:", err);
          showToast("Erro: " + (err.message || err), "error");
        }
      };
    });
  });
}

export async function renderDriverLeads({ content, actionsRoot }) {
  contentRef = content;
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i><p class="mt-2 text-sm">Carregando pré-cadastros...</p></div>`;

  try {
    allLeads = await loadLeads();
  } catch (e) {
    console.error("[driver-leads] load failed:", e);
    content.innerHTML = `<div class="bg-red-50 text-red-700 p-4 rounded-xl"><b>Erro ao carregar:</b> ${escapeHtml(e.message || String(e))}</div>`;
    return;
  }

  if (actionsRoot) {
    actionsRoot.innerHTML = `
      <button id="csv-leads" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
        <i class="fa-solid fa-file-csv mr-1"></i>CSV
      </button>
    `;
    actionsRoot.querySelector("#csv-leads").addEventListener("click", () => {
      const rows = [["ID", "Nome", "WhatsApp", "Cidade", "Veículo", "CNH", "Status", "Cadastro", "UA", "Referer"]];
      filtered().forEach((l) => rows.push([
        l.id, l.name || "", l.whatsapp || "", l.city || "", l.vehicle || "", l.hasCnh || "",
        l.status || "new", new Date(l.createdAt || 0).toISOString(), l.userAgent || "", l.referer || "",
      ]));
      downloadCsv(`pre-cadastros-${Date.now()}.csv`, rows);
    });
  }

  content.innerHTML = `
    <div data-kpis class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      <div class="bg-white rounded-2xl shadow-card p-4">
        <div class="text-tiny font-bold text-slate-500 uppercase">Total</div>
        <div class="text-2xl font-black text-slate-800" data-k-total>0</div>
      </div>
      <div class="bg-white rounded-2xl shadow-card p-4">
        <div class="text-tiny font-bold text-slate-500 uppercase">Novos</div>
        <div class="text-2xl font-black text-yellow-600" data-k-new>0</div>
      </div>
      <div class="bg-white rounded-2xl shadow-card p-4">
        <div class="text-tiny font-bold text-slate-500 uppercase">Contatados</div>
        <div class="text-2xl font-black text-blue-600" data-k-contacted>0</div>
      </div>
      <div class="bg-white rounded-2xl shadow-card p-4">
        <div class="text-tiny font-bold text-slate-500 uppercase">Cadastraram</div>
        <div class="text-2xl font-black text-green-600" data-k-enrolled>0</div>
      </div>
    </div>

    <div class="bg-white rounded-2xl shadow-card overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between">
        <div class="flex items-center gap-2 flex-wrap">
          <select id="lead-status-filter" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Todos os status</option>
            <option value="new">Novos</option>
            <option value="contacted">Contatados</option>
            <option value="enrolled">Cadastraram</option>
            <option value="rejected">Recusados</option>
          </select>
          <input id="lead-search" type="text" placeholder="🔍 Nome, WhatsApp, cidade..." class="px-3 py-2 text-sm rounded-lg border border-slate-200 w-64" />
        </div>
        <p class="text-xs text-slate-500"><span data-count></span> leads</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
            <tr>
              <th class="px-4 py-2 text-left">Nome</th>
              <th class="px-4 py-2 text-left">WhatsApp</th>
              <th class="px-4 py-2 text-left">Veículo</th>
              <th class="px-4 py-2 text-left">Origem</th>
              <th class="px-4 py-2 text-left">Quando</th>
              <th class="px-4 py-2 text-left">Status</th>
              <th class="px-4 py-2 text-left">Ações</th>
            </tr>
          </thead>
          <tbody data-leads-tbody></tbody>
        </table>
      </div>
    </div>
  `;

  const statusSelect = content.querySelector("#lead-status-filter");
  statusSelect.value = filterStatus;
  statusSelect.addEventListener("change", (e) => {
    filterStatus = e.target.value;
    paintTable();
  });

  const searchInput = content.querySelector("#lead-search");
  searchInput.value = filterText;
  searchInput.addEventListener("input", debounce((e) => {
    filterText = e.target.value.trim();
    paintTable();
  }, 200));

  paintTable();
}
