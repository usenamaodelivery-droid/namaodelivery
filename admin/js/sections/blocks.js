// Bloqueios: motoristas com status blocked/suspended/rejected, com botão de desbloquear.
import {
  collectionGroup, getDocs, doc, updateDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID } from "../firebase.js";
import { formatDate, badge, DRIVER_STATUS, escapeHtml, showToast, confirmDialog } from "../util.js";

async function loadBlocked() {
  const snap = await getDocs(collectionGroup(db, "profile"));
  const out = [];
  snap.forEach((d) => {
    if (d.id !== "driverInfo") return;
    const data = d.data();
    if (!["blocked", "suspended", "rejected"].includes(data.status)) return;
    out.push({ uid: d.ref.parent.parent.id, ...data });
  });
  out.sort((a, b) => (b.statusChangedAt || 0) - (a.statusChangedAt || 0));
  return out;
}

async function unblockDriver(uid) {
  const ref = doc(db, `artifacts/${APP_ID}/users/${uid}/profile/driverInfo`);
  await updateDoc(ref, { status: "approved", statusChangedAt: Date.now() });
}

export async function renderBlocks({ content }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;
  let list;
  try { list = await loadBlocked(); }
  catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  content.innerHTML = `
    <div class="bg-white rounded-2xl shadow-card overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-100">
        <p class="font-black">${list.length} motoristas bloqueados / suspensos / reprovados</p>
        <p class="text-xs text-slate-500 mt-1">Eles não conseguem aceitar pedidos enquanto estiverem nesse status.</p>
      </div>
      ${list.length === 0
        ? `<p class="text-center py-12 text-slate-400 text-sm"><i class="fa-solid fa-circle-check text-3xl text-accent mb-2 block"></i>Nenhum motorista bloqueado.</p>`
        : `
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
            <tr>
              <th class="px-5 py-2 text-left">Motorista</th>
              <th class="px-5 py-2 text-left">Status</th>
              <th class="px-5 py-2 text-left">Quando</th>
              <th class="px-5 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody id="blocks-tbody">
            ${list.map((d) => `
              <tr class="table-row border-t border-slate-100" data-uid="${escapeHtml(d.uid)}">
                <td class="px-5 py-3">
                  <p class="font-bold">${escapeHtml(d.name || d.fullName || "—")}</p>
                  <p class="text-xs text-slate-500">${escapeHtml(d.email || d.phone || d.uid.slice(0, 8) + "...")}</p>
                </td>
                <td class="px-5 py-3">${badge(DRIVER_STATUS, d.status)}</td>
                <td class="px-5 py-3 text-xs text-slate-500">${formatDate(d.statusChangedAt)}</td>
                <td class="px-5 py-3 text-right">
                  <button data-act="unblock" class="px-3 py-1.5 text-xs font-bold rounded-lg bg-accent text-white hover:bg-accent-dark">
                    <i class="fa-solid fa-circle-check mr-1"></i>Desbloquear
                  </button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;

  document.querySelectorAll('#blocks-tbody [data-act="unblock"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.closest("tr").dataset.uid;
      const ok = await confirmDialog("Desbloquear este motorista? Status volta para Aprovado.");
      if (!ok) return;
      try {
        await unblockDriver(uid);
        showToast("Motorista desbloqueado", "success");
        renderBlocks({ content });
      } catch (e) {
        showToast(e.message || "Erro", "error");
      }
    });
  });
}
