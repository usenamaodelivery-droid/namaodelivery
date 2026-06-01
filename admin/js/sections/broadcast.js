// Comunicados/Broadcast: cria entradas na coleção broadcasts pra todos os motoristas verem no app.
import {
  collection, addDoc, query, orderBy, limit, getDocs, doc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID } from "../firebase.js";
import { formatDate, escapeHtml, showToast, confirmDialog } from "../util.js";

const PATH = `artifacts/${APP_ID}/public/data/broadcasts`;

async function loadBroadcasts() {
  const snap = await getDocs(query(collection(db, PATH), orderBy("createdAt", "desc"), limit(50)));
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

async function createBroadcast({ title, message, audience }) {
  await addDoc(collection(db, PATH), {
    title: title.trim(),
    message: message.trim(),
    audience,
    createdAt: Date.now(),
    active: true,
  });
}

async function deleteBroadcast(id) {
  await deleteDoc(doc(db, PATH, id));
}

export async function renderBroadcast({ content }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;
  let list;
  try { list = await loadBroadcasts(); }
  catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  content.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-1 bg-white rounded-2xl shadow-card p-5 self-start">
        <p class="text-sm font-extrabold uppercase text-slate-500 mb-3">Novo comunicado</p>
        <form id="bc-form" class="space-y-3">
          <div>
            <label class="text-xs font-bold text-slate-600">Título</label>
            <input id="bc-title" type="text" maxlength="60" required class="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200" placeholder="Ex: Manutenção sábado" />
          </div>
          <div>
            <label class="text-xs font-bold text-slate-600">Mensagem</label>
            <textarea id="bc-message" maxlength="300" required rows="4" class="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200" placeholder="Texto que aparece pros motoristas..."></textarea>
          </div>
          <div>
            <label class="text-xs font-bold text-slate-600">Público</label>
            <select id="bc-audience" class="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 bg-white">
              <option value="drivers">Motoristas</option>
              <option value="customers">Clientes</option>
              <option value="all">Todos</option>
            </select>
          </div>
          <button type="submit" class="w-full py-2.5 bg-accent text-white font-black rounded-xl hover:bg-accent-dark">
            <i class="fa-solid fa-bullhorn mr-2"></i>Publicar
          </button>
        </form>
      </div>

      <div class="lg:col-span-2 bg-white rounded-2xl shadow-card overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100">
          <p class="font-black">Comunicados publicados</p>
        </div>
        <div id="bc-list" class="divide-y divide-slate-100">
          ${list.length === 0
            ? `<p class="text-center py-12 text-slate-400 text-sm">Nenhum comunicado ainda.</p>`
            : list.map((b) => `
              <div class="px-5 py-3 flex items-start justify-between gap-3" data-id="${escapeHtml(b.id)}">
                <div class="flex-1">
                  <p class="font-black">${escapeHtml(b.title || "(sem título)")}</p>
                  <p class="text-sm text-slate-600 mt-1">${escapeHtml(b.message || "")}</p>
                  <p class="text-xs text-slate-400 mt-1"><i class="fa-solid fa-users mr-1"></i>${escapeHtml(b.audience || "—")} · ${formatDate(b.createdAt)}</p>
                </div>
                <button data-act="del" class="text-danger hover:bg-red-50 px-2 py-1 rounded-lg" title="Apagar">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            `).join("")
          }
        </div>
      </div>
    </div>
  `;

  document.getElementById("bc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("bc-title").value.trim();
    const message = document.getElementById("bc-message").value.trim();
    const audience = document.getElementById("bc-audience").value;
    if (!title || !message) return;
    try {
      await createBroadcast({ title, message, audience });
      showToast("Comunicado publicado!", "success");
      renderBroadcast({ content });
    } catch (e) {
      showToast(e.message || "Erro", "error");
    }
  });

  document.querySelectorAll('#bc-list [data-act="del"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("[data-id]").dataset.id;
      const ok = await confirmDialog("Apagar este comunicado?");
      if (!ok) return;
      try {
        await deleteBroadcast(id);
        showToast("Apagado", "success");
        renderBroadcast({ content });
      } catch (e) {
        showToast(e.message || "Erro", "error");
      }
    });
  });
}
