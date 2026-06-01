// Lojas (merchants) Pedir NaMão: lista + filtros + ações (ativar/desativar,
// commission-free, ver produtos, rotacionar token de acesso do mini-admin).
//
// O documento merchant fica em
//   artifacts/namao-delivery-prod/public/data/merchants/{merchantId}
// e o catálogo da loja em
//   artifacts/namao-delivery-prod/public/data/merchants/{merchantId}/products/{productId}
//
// O hash do token de acesso (accessTokenHash) NUNCA é exibido — só o token em
// texto puro recém-gerado pode ser copiado, e só durante a sessão atual do
// admin. Mesmo padrão do POST /api/admin/merchants/[id]/rotate-token.
import {
  collection, query, where, orderBy, limit, getDocs, doc, getDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID, PLATFORM_FEE } from "../firebase.js";
import {
  formatBRL, formatDate, badge, ORDER_STATUS, escapeHtml, showToast,
  confirmDialog, debounce, downloadCsv,
} from "../util.js";

const MERCHANTS_PATH = `artifacts/${APP_ID}/public/data/merchants`;
const ORDERS_PATH = `artifacts/${APP_ID}/public/data/orders`;

const CATEGORY_LABELS = {
  pizza: "Pizzaria",
  padaria: "Padaria",
  lanche: "Lanche",
  acai: "Açaí",
  farmacia: "Farmácia",
  mercado: "Mercado",
  restaurante: "Restaurante",
  bebidas: "Bebidas",
  doces: "Doceria",
  outros: "Outros",
};

let allMerchants = [];
let filterStatus = "all";   // all | active | inactive
let filterCommission = "all"; // all | free | paid
let filterSource = "all";   // all | namao | direct
let filterText = "";

async function loadMerchants() {
  const snap = await getDocs(query(collection(db, MERCHANTS_PATH), orderBy("createdAt", "desc")));
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

async function setActive(id, isActive) {
  await updateDoc(doc(db, MERCHANTS_PATH, id), {
    isActive: !!isActive,
    updatedAt: Date.now(),
  });
}

async function setCommissionFree(id, commissionFree) {
  await updateDoc(doc(db, MERCHANTS_PATH, id), {
    commissionFree: !!commissionFree,
    updatedAt: Date.now(),
  });
}

// SHA-256 hex compatível com merchantAuth.ts (createHash('sha256').digest('hex')).
async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 18 bytes aleatórios em base64url — mesmo formato de randomBytes(18).toString('base64url') do Node.
function generatePlainToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  // base64 -> base64url
  let b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function rotateToken(merchantId) {
  const plain = generatePlainToken();
  const hash = await sha256Hex(plain);
  await updateDoc(doc(db, MERCHANTS_PATH, merchantId), {
    accessTokenHash: hash,
    updatedAt: Date.now(),
  });
  return plain;
}

async function loadProducts(merchantId) {
  const snap = await getDocs(query(
    collection(db, `${MERCHANTS_PATH}/${merchantId}/products`),
    orderBy("sortOrder", "asc"),
    limit(200),
  ));
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}

async function loadMerchantOrderStats(merchantId) {
  // Pedidos dessa loja — usa merchantId quando o doc do pedido referencia,
  // senão cai pra merchantName (heurística, mas funciona pra cardápio MVP).
  // O schema padrão do Pedir NaMão grava `merchantId` no pedido (vide
  // src/lib/orderStore.ts → pwaOrderToDriverDoc), mas a coleção do driver
  // também inclui `merchantName` pra display, então fazemos dois sweeps.
  let total = 0;
  let count = 0;
  try {
    const snap = await getDocs(query(
      collection(db, ORDERS_PATH),
      where("merchantId", "==", merchantId),
    ));
    snap.forEach((d) => {
      const o = d.data();
      if (o.status === "completed") {
        total += Number(o.price || 0);
        count++;
      }
    });
  } catch (e) {
    // Sem índice composto? cai silenciosamente, count fica 0.
    console.warn("orders by merchantId failed", e);
  }
  return { total, count };
}

async function loadMerchantRecentOrders(merchantId, n = 10) {
  try {
    const snap = await getDocs(query(
      collection(db, ORDERS_PATH),
      where("merchantId", "==", merchantId),
      orderBy("createdAt", "desc"),
      limit(n),
    ));
    const out = [];
    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    return out;
  } catch (e) {
    console.warn("recent orders by merchantId failed", e);
    return [];
  }
}

function statusBadge(m) {
  if (!m.isActive) return `<span class="badge badge-gray">Inativa</span>`;
  if (!Number(m.productsCount)) return `<span class="badge badge-yellow">Sem produtos</span>`;
  return `<span class="badge badge-green">Ativa</span>`;
}

function commissionBadge(m) {
  if (m.commissionFree) return `<span class="badge badge-blue">NaMão ATIVO · 0%</span>`;
  return `<span class="badge badge-gray">${(PLATFORM_FEE * 100).toFixed(0)}% comissão</span>`;
}

function filtered() {
  return allMerchants.filter((m) => {
    if (filterStatus === "active"   && !m.isActive) return false;
    if (filterStatus === "inactive" && m.isActive) return false;
    if (filterCommission === "free" && !m.commissionFree) return false;
    if (filterCommission === "paid" && m.commissionFree) return false;
    if (filterSource === "namao"  && !m.namaoStoreId) return false;
    if (filterSource === "direct" && m.namaoStoreId) return false;
    if (filterText) {
      const q = filterText.toLowerCase();
      const hay = `${m.id} ${m.name || ""} ${m.slug || ""} ${m.whatsapp || ""} ${m.city || ""} ${m.state || ""} ${m.address || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function row(m) {
  const name = m.name || "(sem nome)";
  return `
    <tr class="table-row border-t border-slate-100 cursor-pointer" onclick="window.merchantsSection.openDetail('${escapeHtml(m.id)}')">
      <td class="px-5 py-3">
        ${m.imageUrl
          ? `<img src="${escapeHtml(m.imageUrl)}" class="w-10 h-10 rounded-lg object-cover" alt="" />`
          : `<div class="w-10 h-10 rounded-lg bg-slate-200 flex items-center justify-center font-bold text-slate-500"><i class="fa-solid fa-store"></i></div>`
        }
      </td>
      <td class="px-5 py-3">
        <p class="font-bold">${escapeHtml(name)}</p>
        <p class="text-xs text-slate-500">/${escapeHtml(m.slug || "—")} · ${escapeHtml(CATEGORY_LABELS[m.category] || m.category || "—")}</p>
      </td>
      <td class="px-5 py-3 text-sm">
        ${escapeHtml(m.city || "—")}${m.state ? " / " + escapeHtml(m.state) : ""}
      </td>
      <td class="px-5 py-3 text-sm">${escapeHtml(m.whatsapp || "—")}</td>
      <td class="px-5 py-3 text-center text-sm font-bold">${Number(m.productsCount || 0)}</td>
      <td class="px-5 py-3">${statusBadge(m)}</td>
      <td class="px-5 py-3">${commissionBadge(m)}</td>
      <td class="px-5 py-3 text-xs text-slate-500">${formatDate(m.createdAt)}</td>
    </tr>
  `;
}

async function openProductsModal(merchantId, merchantName) {
  let products = [];
  try {
    products = await loadProducts(merchantId);
  } catch (e) {
    showToast("Erro ao carregar produtos: " + e.message, "error");
    return;
  }
  const html = `
    <div class="p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-black"><i class="fa-solid fa-burger mr-2 text-accent"></i>Produtos · ${escapeHtml(merchantName)}</h2>
        <button onclick="window.adminApp.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl"><i class="fa-solid fa-xmark"></i></button>
      </div>
      ${products.length === 0
        ? `<p class="text-sm text-slate-500 text-center py-12">Esta loja ainda não tem produtos cadastrados.</p>`
        : `
          <div class="overflow-y-auto max-h-[65vh]">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider sticky top-0">
                <tr>
                  <th class="px-3 py-2 text-left w-12"></th>
                  <th class="px-3 py-2 text-left">Produto</th>
                  <th class="px-3 py-2 text-right">Preço</th>
                  <th class="px-3 py-2 text-center">Disponível</th>
                </tr>
              </thead>
              <tbody>
                ${products.map((p) => `
                  <tr class="border-t border-slate-100">
                    <td class="px-3 py-2">
                      ${p.imageUrl
                        ? `<img src="${escapeHtml(p.imageUrl)}" class="w-10 h-10 rounded-lg object-cover" alt="" />`
                        : `<div class="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400"><i class="fa-solid fa-image"></i></div>`}
                    </td>
                    <td class="px-3 py-2">
                      <p class="font-bold">${escapeHtml(p.name || "—")}</p>
                      <p class="text-xs text-slate-500">${escapeHtml((p.description || "").slice(0, 80))}</p>
                    </td>
                    <td class="px-3 py-2 text-right font-bold">
                      ${formatBRL((Number(p.priceCents || 0)) / 100)}
                      ${p.promoPriceCents ? `<p class="text-xs text-accent">Promo: ${formatBRL(Number(p.promoPriceCents) / 100)}</p>` : ""}
                    </td>
                    <td class="px-3 py-2 text-center">
                      ${p.isAvailable
                        ? `<span class="badge badge-green">Sim</span>`
                        : `<span class="badge badge-gray">Não</span>`}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `}
    </div>
  `;
  window.adminApp.openModal(html);
}

async function openDetail(merchantId) {
  const snap = await getDoc(doc(db, MERCHANTS_PATH, merchantId));
  if (!snap.exists()) { showToast("Loja não encontrada", "error"); return; }
  const m = { id: merchantId, ...snap.data() };
  const stats = await loadMerchantOrderStats(merchantId).catch(() => ({ total: 0, count: 0 }));
  const recent = await loadMerchantRecentOrders(merchantId, 8).catch(() => []);

  const hoursTxt = formatWorkingHours(m.workingHours || []);
  const sourceBadge = m.namaoStoreId
    ? `<span class="badge badge-blue">NaMão social</span>`
    : `<span class="badge badge-gray">Cadastro direto</span>`;

  const html = `
    <div class="p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-black"><i class="fa-solid fa-store mr-2 text-accent"></i>${escapeHtml(m.name || "(sem nome)")}</h2>
        <button onclick="window.adminApp.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="flex items-start gap-4 mb-5">
        ${m.imageUrl
          ? `<img src="${escapeHtml(m.imageUrl)}" class="w-20 h-20 rounded-2xl object-cover" />`
          : `<div class="w-20 h-20 rounded-2xl bg-slate-200 flex items-center justify-center text-2xl text-slate-400"><i class="fa-solid fa-store"></i></div>`}
        <div class="flex-1">
          <p class="text-xl font-black">${escapeHtml(m.name || "—")}</p>
          <p class="text-sm text-slate-500">/${escapeHtml(m.slug || "—")} · ${escapeHtml(CATEGORY_LABELS[m.category] || m.category || "—")}</p>
          <div class="mt-2 flex gap-2 flex-wrap">${statusBadge(m)} ${commissionBadge(m)} ${sourceBadge}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm mb-5">
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Telefone / WhatsApp</p><p>${escapeHtml(m.whatsapp || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Endereço</p><p class="text-xs">${escapeHtml(m.address || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Bairro</p><p>${escapeHtml(m.neighborhood || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Cidade / UF</p><p>${escapeHtml(m.city || "—")} / ${escapeHtml(m.state || "—")}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Lat / Lng</p><p class="font-mono text-xs">${m.lat ?? "—"}, ${m.lng ?? "—"}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Raio entrega</p><p>${Number(m.deliveryRadiusKm || 0)} km</p></div>
        <div class="col-span-2"><p class="text-tiny text-slate-500 uppercase font-bold">Horário</p><p class="text-xs">${escapeHtml(hoursTxt)}</p></div>
        ${m.minOrderCents ? `<div><p class="text-tiny text-slate-500 uppercase font-bold">Pedido mínimo</p><p class="font-bold">${formatBRL(Number(m.minOrderCents) / 100)}</p></div>` : ""}
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Produtos</p><p class="font-bold">${Number(m.productsCount || 0)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Criado</p><p class="text-xs">${formatDate(m.createdAt)}</p></div>
        <div><p class="text-tiny text-slate-500 uppercase font-bold">Atualizado</p><p class="text-xs">${formatDate(m.updatedAt)}</p></div>
        <div class="col-span-2"><p class="text-tiny text-slate-500 uppercase font-bold">ID Pedir NaMão</p><p class="font-mono text-xs break-all">${escapeHtml(m.id)}</p></div>
        ${m.namaoStoreId ? `<div class="col-span-2"><p class="text-tiny text-slate-500 uppercase font-bold">UUID NaMão social</p><p class="font-mono text-xs break-all">${escapeHtml(m.namaoStoreId)}</p></div>` : ""}
      </div>

      ${m.description
        ? `<div class="mb-5"><p class="text-tiny text-slate-500 uppercase font-bold mb-1">Descrição</p><p class="text-sm">${escapeHtml(m.description)}</p></div>`
        : ""}

      <div class="bg-slate-50 rounded-xl p-4 mb-5">
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Vendas (entregas concluídas)</p>
        <div class="grid grid-cols-3 gap-3 text-sm">
          <div><p class="text-tiny text-slate-500">Total</p><p class="font-black text-lg">${formatBRL(stats.total)}</p></div>
          <div><p class="text-tiny text-slate-500">Pedidos</p><p class="font-black text-lg">${stats.count}</p></div>
          <div><p class="text-tiny text-slate-500">${m.commissionFree ? "Comissão" : `Comissão (${(PLATFORM_FEE * 100).toFixed(0)}%)`}</p>
               <p class="font-black text-lg">${m.commissionFree ? "Isento" : formatBRL(stats.total * PLATFORM_FEE)}</p></div>
        </div>
      </div>

      <div class="bg-slate-50 rounded-xl p-3 mb-5">
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Mini-admin do lojista</p>
        <p class="text-xs text-slate-500 mb-2">Link com o token só aparece quando você rotaciona — guarda o valor pra mandar pro lojista pelo WhatsApp.</p>
        <div class="flex gap-2 flex-wrap">
          <button data-act="rotate-token" class="px-3 py-2 text-sm bg-warn text-white font-bold rounded-lg hover:bg-yellow-600">
            <i class="fa-solid fa-rotate-right mr-1"></i>Gerar novo link de acesso
          </button>
          <button data-act="copy-id" class="px-3 py-2 text-sm bg-slate-200 hover:bg-slate-300 font-bold rounded-lg">
            <i class="fa-solid fa-copy mr-1"></i>Copiar ID
          </button>
        </div>
        <div data-token-output class="hidden mt-3 p-3 bg-white border border-warn rounded-lg">
          <p class="text-xs font-bold text-warn mb-1"><i class="fa-solid fa-triangle-exclamation"></i> Esse token só aparece UMA vez. Copia agora.</p>
          <code data-token-text class="text-xs break-all block font-mono bg-slate-50 p-2 rounded"></code>
          <p class="text-xs text-slate-500 mt-2">Link completo (pra mandar pelo WhatsApp):</p>
          <code data-token-url class="text-xs break-all block font-mono bg-slate-50 p-2 rounded"></code>
          <div class="mt-2 flex gap-2 flex-wrap">
            <button data-act="copy-url" class="px-3 py-1.5 text-xs bg-accent text-white font-bold rounded-lg">
              <i class="fa-solid fa-copy mr-1"></i>Copiar link
            </button>
            ${m.whatsapp ? `
              <a data-act="wa-send" target="_blank" rel="noopener" class="px-3 py-1.5 text-xs bg-[#25D366] text-white font-bold rounded-lg hover:bg-[#1ebe57]">
                <i class="fa-brands fa-whatsapp mr-1"></i>Enviar pelo WhatsApp
              </a>
            ` : `
              <span class="px-3 py-1.5 text-xs bg-slate-200 text-slate-500 rounded-lg">WhatsApp da loja não cadastrado</span>
            `}
          </div>
        </div>
      </div>

      ${recent.length > 0 ? `
        <div class="mb-5">
          <p class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Últimos pedidos</p>
          <div class="space-y-1">
            ${recent.map((o) => `
              <div class="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-xs">
                <div>
                  <p class="font-bold">#${escapeHtml(String(o.id).slice(-6).toUpperCase())} · ${escapeHtml(o.customerName || "—")}</p>
                  <p class="text-slate-500">${formatDate(o.createdAt)}</p>
                </div>
                <div class="text-right">
                  ${badge(ORDER_STATUS, o.status)}
                  <p class="font-bold mt-1">${formatBRL(o.price)}</p>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}

      <div class="flex gap-2 flex-wrap">
        <button data-act="products" class="flex-1 py-2.5 bg-primary text-white font-black rounded-xl hover:bg-primary-soft">
          <i class="fa-solid fa-burger mr-2"></i>Ver produtos (${Number(m.productsCount || 0)})
        </button>
        ${m.isActive
          ? `<button data-act="deactivate" class="flex-1 py-2.5 bg-danger text-white font-black rounded-xl hover:bg-red-700"><i class="fa-solid fa-power-off mr-2"></i>Desativar loja</button>`
          : `<button data-act="activate"   class="flex-1 py-2.5 bg-accent text-white font-black rounded-xl hover:bg-accent-dark"><i class="fa-solid fa-power-off mr-2"></i>Ativar loja</button>`}
        ${m.commissionFree
          ? `<button data-act="charge"   class="flex-1 py-2.5 bg-slate-200 text-slate-700 font-bold rounded-xl hover:bg-slate-300"><i class="fa-solid fa-percent mr-2"></i>Cobrar comissão</button>`
          : `<button data-act="freecomm" class="flex-1 py-2.5 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700"><i class="fa-solid fa-crown mr-2"></i>Isentar (NaMão ATIVO)</button>`}
      </div>
    </div>
  `;

  window.adminApp.openModal(html);

  document.querySelectorAll("#modal-content [data-act]").forEach((b) => {
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      try {
        if (act === "activate" || act === "deactivate") {
          const newVal = act === "activate";
          const ok = await confirmDialog(newVal
            ? "Ativar essa loja? Ela vai aparecer no catálogo do cliente."
            : "Desativar? Loja some do catálogo e novos pedidos são bloqueados.");
          if (!ok) return;
          await setActive(merchantId, newVal);
          showToast(newVal ? "Loja ativada" : "Loja desativada", "success");
          const cached = allMerchants.find((x) => x.id === merchantId);
          if (cached) cached.isActive = newVal;
          rerender();
          window.adminApp.closeModal();
        } else if (act === "freecomm" || act === "charge") {
          const newVal = act === "freecomm";
          const ok = await confirmDialog(newVal
            ? "Isentar comissão? Loja não paga os 5% sobre os produtos."
            : `Cobrar comissão de ${(PLATFORM_FEE * 100).toFixed(0)}% novamente?`);
          if (!ok) return;
          await setCommissionFree(merchantId, newVal);
          showToast(newVal ? "Loja isenta de comissão" : "Comissão reativada", "success");
          const cached = allMerchants.find((x) => x.id === merchantId);
          if (cached) cached.commissionFree = newVal;
          rerender();
          window.adminApp.closeModal();
        } else if (act === "rotate-token") {
          const ok = await confirmDialog(
            "Gerar NOVO link de acesso?\n\n" +
            "O link antigo deixa de funcionar imediatamente. " +
            "Você precisa mandar o novo pro lojista pelo WhatsApp."
          );
          if (!ok) return;
          const plain = await rotateToken(merchantId);
          const url = `https://delivery.usenamao.com/loja-admin?id=${merchantId}&key=${plain}`;
          const box = document.querySelector("#modal-content [data-token-output]");
          const txt = document.querySelector("#modal-content [data-token-text]");
          const urlEl = document.querySelector("#modal-content [data-token-url]");
          const waEl = document.querySelector("#modal-content [data-act='wa-send']");
          if (box && txt && urlEl) {
            txt.textContent = plain;
            urlEl.textContent = url;
            box.classList.remove("hidden");
          }
          if (waEl && m.whatsapp) {
            const digits = String(m.whatsapp).replace(/\D/g, "");
            const phone = digits.length >= 10 ? (digits.startsWith("55") ? digits : `55${digits}`) : digits;
            const msg = `🔗 Painel da sua loja "${m.name || "Pedir NaMão"}" — NaMão\n\nGuarda esse link (não compartilha com ninguém, qualquer um com ele aceita pedidos):\n\n${url}\n\n• Salva esta mensagem no seu WhatsApp\n• Adiciona o link na tela inicial do celular`;
            waEl.href = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
          }
          showToast("Token rotacionado", "success");
        } else if (act === "copy-url") {
          const urlEl = document.querySelector("#modal-content [data-token-url]");
          if (urlEl) {
            await navigator.clipboard.writeText(urlEl.textContent || "");
            showToast("Link copiado", "success");
          }
        } else if (act === "copy-id") {
          await navigator.clipboard.writeText(merchantId);
          showToast("ID copiado", "success");
        } else if (act === "products") {
          await openProductsModal(merchantId, m.name || merchantId);
        }
      } catch (e) {
        console.error(e);
        showToast(e.message || "Erro", "error");
      }
    });
  });
}

function formatWorkingHours(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return "Sem horário definido";
  const weekdays = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  // Agrupa por intervalo idêntico
  const byKey = new Map();
  for (const w of windows) {
    const key = `${w.start}-${w.end}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(w.weekday);
  }
  const parts = [];
  for (const [key, days] of byKey.entries()) {
    const list = days.sort().map((d) => weekdays[d]).join(", ");
    parts.push(`${list}: ${key.replace("-", " às ")}`);
  }
  return parts.join(" · ");
}

let rootRef;
function rerender() {
  if (!rootRef) return;
  const list = filtered();
  const tbody = rootRef.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = list.length
    ? list.map(row).join("")
    : `<tr><td colspan="8" class="text-center py-10 text-slate-400 text-sm">Nenhuma loja encontrada com esses filtros.</td></tr>`;
  rootRef.querySelector("[data-count]").textContent = `${list.length} de ${allMerchants.length}`;

  // KPIs do header
  const active   = allMerchants.filter((m) => m.isActive).length;
  const visible  = allMerchants.filter((m) => m.isActive && Number(m.productsCount) > 0).length;
  const free     = allMerchants.filter((m) => m.commissionFree).length;
  const fromNamao= allMerchants.filter((m) => m.namaoStoreId).length;
  const kpiBar = rootRef.querySelector("[data-kpis]");
  if (kpiBar) {
    kpiBar.innerHTML = `
      <span class="px-2 py-1 rounded-md bg-slate-100 text-slate-700"><b>${allMerchants.length}</b> total</span>
      <span class="px-2 py-1 rounded-md bg-green-100 text-green-800"><b>${active}</b> ativas</span>
      <span class="px-2 py-1 rounded-md bg-blue-100 text-blue-800"><b>${visible}</b> no catálogo</span>
      <span class="px-2 py-1 rounded-md bg-amber-100 text-amber-800"><b>${free}</b> NaMão ATIVO</span>
      <span class="px-2 py-1 rounded-md bg-slate-100 text-slate-700"><b>${fromNamao}</b> via NaMão social</span>
    `;
  }
}

export async function renderMerchants({ content, actionsRoot }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;

  try {
    allMerchants = await loadMerchants();
  } catch (e) {
    content.innerHTML = `<div class="bg-danger/10 text-danger p-4 rounded-xl"><b>Erro ao carregar lojas:</b> ${escapeHtml(e.message)}</div>`;
    return;
  }

  actionsRoot.innerHTML = `
    <button id="csv-merchants" class="px-3 py-2 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200">
      <i class="fa-solid fa-file-csv mr-1"></i>CSV
    </button>
  `;
  actionsRoot.querySelector("#csv-merchants").addEventListener("click", () => {
    const rows = [["ID", "Nome", "Slug", "Categoria", "Cidade", "UF", "WhatsApp", "Produtos", "Ativa", "CommissionFree", "NamaoStoreId", "Criada"]];
    allMerchants.forEach((m) => rows.push([
      m.id, m.name || "", m.slug || "", m.category || "", m.city || "", m.state || "",
      m.whatsapp || "", String(m.productsCount || 0), m.isActive ? "sim" : "não",
      m.commissionFree ? "sim" : "não", m.namaoStoreId || "", new Date(m.createdAt || 0).toISOString(),
    ]));
    downloadCsv(`lojas-${Date.now()}.csv`, rows);
  });

  content.innerHTML = `
    <div class="bg-white rounded-2xl shadow-card overflow-hidden" id="merchants-root">
      <div class="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between">
        <div class="flex items-center gap-2 flex-wrap">
          <select id="m-status" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Todas</option>
            <option value="active">Ativas</option>
            <option value="inactive">Inativas</option>
          </select>
          <select id="m-comm" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Comissão (todas)</option>
            <option value="paid">Pagam comissão</option>
            <option value="free">NaMão ATIVO (isentas)</option>
          </select>
          <select id="m-src" class="px-3 py-2 text-sm font-bold rounded-lg border border-slate-200 bg-white">
            <option value="all">Origem (todas)</option>
            <option value="namao">Veio do NaMão social</option>
            <option value="direct">Cadastro direto</option>
          </select>
          <input id="m-search" type="text" placeholder="🔍 Nome, slug, telefone, cidade..." class="px-3 py-2 text-sm rounded-lg border border-slate-200 w-64" />
        </div>
        <p class="text-xs text-slate-500"><span data-count></span> lojas</p>
      </div>
      <div class="px-5 py-3 border-b border-slate-100 flex gap-2 text-xs flex-wrap" data-kpis></div>
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-5 py-2 text-left w-14"></th>
            <th class="px-5 py-2 text-left">Loja</th>
            <th class="px-5 py-2 text-left">Cidade</th>
            <th class="px-5 py-2 text-left">WhatsApp</th>
            <th class="px-5 py-2 text-center">Produtos</th>
            <th class="px-5 py-2 text-left">Status</th>
            <th class="px-5 py-2 text-left">Comissão</th>
            <th class="px-5 py-2 text-left">Cadastro</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  rootRef = document.getElementById("merchants-root");

  document.getElementById("m-status").addEventListener("change", (e) => { filterStatus = e.target.value; rerender(); });
  document.getElementById("m-comm").addEventListener("change",   (e) => { filterCommission = e.target.value; rerender(); });
  document.getElementById("m-src").addEventListener("change",    (e) => { filterSource = e.target.value; rerender(); });
  document.getElementById("m-search").addEventListener("input", debounce((e) => {
    filterText = e.target.value;
    rerender();
  }, 200));
  rerender();

  window.merchantsSection = { openDetail };
  return () => { rootRef = null; window.merchantsSection = null; };
}
