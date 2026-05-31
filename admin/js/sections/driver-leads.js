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

const STATUS = {
  new:        { label: "Novo",         badge: "badge-yellow" },
  contacted:  { label: "Contatado",    badge: "badge-blue"   },
  enrolled:   { label: "Cadastrou",    badge: "badge-green"  },
  rejected:   { label: "Recusado",     badge: "badge-red"    },
};

const VEHICLES = {
  bike:   "🚴 Bike",
  moto:   "🛵 Moto",
  carro:  "🚗 Carro",
  unsure: "🤔 N/D",
};

function statusBadge(s) {
  const v = STATUS[s] || STATUS.new;
  return `<span class="badge ${v.badge}">${escapeHtml(v.label)}</span>`;
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
  return `
    <tr class="table-row border-t border-slate-100" data-id="${l.id}">
      <td class="px-4 py-3">
        <div class="font-bold text-slate-800">${escapeHtml(l.name || "—")}</div>
        <div class="text-tiny text-slate-500">${escapeHtml(l.city || "")}</div>
      </td>
      <td class="px-4 py-3">
        <a href="${whatsappLink(l.whatsapp, `Oi ${l.name || ""}! Vi seu pré-cadastro no NaMão Entregador. Posso te ajudar a começar?`)}"
           target="_blank" rel="noopener"
           class="text-primary font-bold hover:underline">${escapeHtml(phone)}</a>
      </td>
      <td class="px-4 py-3">${VEHICLES[l.vehicle] || "—"}</td>
      <td class="px-4 py-3 text-tiny text-slate-500">${escapeHtml(l.source || "—")}</td>
      <td class="px-4 py-3 text-tiny text-slate-500">${formatDate(l.createdAt)}</td>
      <td class="px-4 py-3">${statusBadge(status)}</td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-1">
          <button data-act="contact" class="text-tiny font-bold text-blue-600 hover:underline" title="Marcar como contatado">📞</button>
          <button data-act="enrolled" class="text-tiny font-bold text-green-600 hover:underline" title="Marcar que cadastrou">✓</button>
          <button data-act="reject" class="text-tiny font-bold text-red-600 hover:underline" title="Recusar/descartar">✗</button>
          <button data-act="delete" class="text-tiny font-bold text-slate-400 hover:underline" title="Excluir">🗑</button>
        </div>
      </td>
    </tr>
  `;
}

function render() {
  const list = filtered();
  const counts = {
    all: allLeads.length,
    new: allLeads.filter((l) => (l.status || "new") === "new").length,
    contacted: allLeads.filter((l) => l.status === "contacted").length,
    enrolled: allLeads.filter((l) => l.status === "enrolled").length,
  };

  const root = document.getElementById("section-root");
  if (!root) return;
  root.innerHTML = `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      <div class="card-stat">
        <div class="text-tiny font-bold text-slate-500 uppercase">Total</div>
        <div class="text-2xl font-black text-slate-800">${counts.all}</div>
      </div>
      <div class="card-stat">
        <div class="text-tiny font-bold text-slate-500 uppercase">Novos</div>
        <div class="text-2xl font-black text-yellow-600">${counts.new}</div>
      </div>
      <div class="card-stat">
        <div class="text-tiny font-bold text-slate-500 uppercase">Contatados</div>
        <div class="text-2xl font-black text-blue-600">${counts.contacted}</div>
      </div>
      <div class="card-stat">
        <div class="text-tiny font-bold text-slate-500 uppercase">Cadastraram</div>
        <div class="text-2xl font-black text-accent">${counts.enrolled}</div>
      </div>
    </div>

    <div class="bg-white rounded-2xl shadow-card mb-4 p-4 flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2">
        <label class="text-tiny font-bold text-slate-600 uppercase">Status:</label>
        <select id="lead-filter-status" class="border-2 border-slate-200 rounded-lg px-3 py-2 text-sm font-bold">
          <option value="all">Todos</option>
          <option value="new" ${filterStatus==="new"?"selected":""}>Novos</option>
          <option value="contacted" ${filterStatus==="contacted"?"selected":""}>Contatados</option>
          <option value="enrolled" ${filterStatus==="enrolled"?"selected":""}>Cadastraram</option>
          <option value="rejected" ${filterStatus==="rejected"?"selected":""}>Recusados</option>
        </select>
      </div>
      <input id="lead-filter-text" placeholder="Buscar por nome/WhatsApp/cidade…"
             class="flex-1 min-w-[200px] border-2 border-slate-200 rounded-lg px-3 py-2 text-sm" value="${escapeHtml(filterText)}"/>
      <button id="lead-export" class="bg-slate-800 text-white font-bold rounded-lg px-4 py-2 text-sm hover:bg-slate-900">
        <i class="fa-solid fa-download mr-1"></i> CSV
      </button>
      <button id="lead-refresh" class="bg-primary text-white font-bold rounded-lg px-4 py-2 text-sm hover:opacity-90">
        <i class="fa-solid fa-rotate"></i>
      </button>
    </div>

    <div class="bg-white rounded-2xl shadow-card overflow-hidden">
      <table class="w-full">
        <thead class="bg-slate-50 text-tiny font-bold text-slate-500 uppercase">
          <tr>
            <th class="px-4 py-3 text-left">Nome / Cidade</th>
            <th class="px-4 py-3 text-left">WhatsApp</th>
            <th class="px-4 py-3 text-left">Veículo</th>
            <th class="px-4 py-3 text-left">Origem</th>
            <th class="px-4 py-3 text-left">Recebido</th>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Ações</th>
          </tr>
        </thead>
        <tbody id="leads-tbody">
          ${list.length === 0 ?
            `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">Nenhum pré-cadastro ainda. Quando alguém preencher o form em delivery.usenamao.com/motorista/cadastro, aparece aqui.</td></tr>`
            : list.map(row).join("")}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById("lead-filter-status").onchange = (e) => {
    filterStatus = e.target.value;
    render();
  };
  document.getElementById("lead-filter-text").oninput = debounce((e) => {
    filterText = e.target.value;
    render();
  }, 200);
  document.getElementById("lead-refresh").onclick = () => renderDriverLeads();
  document.getElementById("lead-export").onclick = () => {
    const rows = filtered().map((l) => ({
      Nome: l.name || "",
      WhatsApp: l.whatsapp || "",
      Cidade: l.city || "",
      Veiculo: l.vehicle || "",
      "Tem CNH": l.hasCnh || "",
      Origem: l.source || "",
      Status: l.status || "new",
      Recebido: formatDate(l.createdAt),
    }));
    downloadCsv("pre-cadastros-motoristas.csv", rows);
  };

  // Ações por linha
  document.querySelectorAll("#leads-tbody tr").forEach((tr) => {
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
          renderDriverLeads();
        } catch (err) {
          console.error("[driver-leads] action failed:", err);
          showToast("Erro: " + (err.message || err), "error");
        }
      };
    });
  });
}

export async function renderDriverLeads() {
  const root = document.getElementById("section-root");
  if (root) {
    root.innerHTML = `<div class="bg-white rounded-2xl p-8 text-center text-slate-400">Carregando pré-cadastros…</div>`;
  }
  try {
    allLeads = await loadLeads();
    render();
  } catch (err) {
    console.error("[driver-leads] load failed:", err);
    if (root) {
      root.innerHTML = `<div class="bg-white rounded-2xl p-8 text-center text-red-500">Erro ao carregar: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}
