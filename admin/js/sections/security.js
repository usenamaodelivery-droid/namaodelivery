// Logs de segurança (cadastros bloqueados pela IA, tentativas suspeitas, etc).
import {
  collection, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID } from "../firebase.js";
import { formatDate, escapeHtml, downloadCsv } from "../util.js";

const PATH = `artifacts/${APP_ID}/public/data/securityLogs`;

const TYPE_ICONS = {
  ai_blocked: "fa-robot",
  duplicate_cpf: "fa-copy",
  fraud_attempt: "fa-skull",
  login_blocked: "fa-lock",
};

async function loadLogs() {
  const snap = await getDocs(query(collection(db, PATH), orderBy("createdAt", "desc"), limit(200)));
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

export async function renderSecurity({ content, actionsRoot }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;
  let logs;
  try { logs = await loadLogs(); }
  catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  actionsRoot.innerHTML = `
    <button id="csv-sec" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  document.getElementById("csv-sec").addEventListener("click", () => {
    const rows = [["Quando", "Tipo", "Usuário", "Detalhes"]];
    logs.forEach((l) => rows.push([
      new Date(l.createdAt || 0).toISOString(),
      l.type || "",
      l.userId || l.email || l.cpf || "",
      JSON.stringify(l).replace(/[\r\n]/g, " "),
    ]));
    downloadCsv(`security-logs-${Date.now()}.csv`, rows);
  });

  content.innerHTML = `
    <div class="bg-white rounded-2xl shadow-card overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-100">
        <p class="font-black">Eventos críticos (últimos 200)</p>
        <p class="text-xs text-slate-500 mt-1">Cadastros bloqueados, tentativas suspeitas, ações de segurança.</p>
      </div>
      ${logs.length === 0
        ? `<p class="text-center py-12 text-slate-400 text-sm"><i class="fa-solid fa-shield-halved text-3xl text-accent mb-2 block"></i>Nenhum evento de segurança registrado.</p>`
        : `<div class="divide-y divide-slate-100">
            ${logs.map((l) => `
              <div class="px-5 py-3 flex items-start gap-3 text-sm">
                <div class="w-9 h-9 rounded-lg bg-red-100 text-danger flex items-center justify-center flex-shrink-0">
                  <i class="fa-solid ${TYPE_ICONS[l.type] || "fa-triangle-exclamation"}"></i>
                </div>
                <div class="flex-1">
                  <p class="font-bold">${escapeHtml(l.type || "—")}</p>
                  <p class="text-xs text-slate-500">${escapeHtml(l.reason || l.message || l.detail || "")}</p>
                  <p class="text-tiny text-slate-400 mt-1 font-mono">${escapeHtml(l.userId || l.email || l.cpf || "")} · ${formatDate(l.createdAt)}</p>
                </div>
              </div>
            `).join("")}
          </div>`
      }
    </div>
  `;
}
