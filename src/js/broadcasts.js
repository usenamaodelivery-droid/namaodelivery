// Comunicados (broadcasts) — ouve em tempo real a coleção
// artifacts/<APP_ID>/public/data/broadcasts e mostra o último não-visto
// como modal in-app. Atua junto com o push FCM (notifications.js) —
// se o push não chegar (app sem permissão, em foreground, dispositivo
// offline e voltou), o snapshot listener cobre.

import {
  collection,
  onSnapshot,
  orderBy,
  query,
  limit,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";

const PATH = ["artifacts", APP_ID, "public", "data", "broadcasts"];
const LS_KEY = "namao-broadcasts-seen-v1";
const VIEW_LIMIT = 20;

function loadSeen() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}

function saveSeen(seen) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(seen)); } catch { /* ignore */ }
}

export function markBroadcastSeen(id) {
  if (!id) return;
  const seen = loadSeen();
  seen[id] = Date.now();
  saveSeen(seen);
}

export function isBroadcastSeen(id) {
  if (!id) return true;
  return !!loadSeen()[id];
}

let unsubscribe = null;

/**
 * Começa a ouvir comunicados. `onNew(b)` é chamado quando entra um novo doc
 * que ainda não foi visto (LocalStorage). Idempotente; chamar de novo
 * substitui o listener antigo.
 */
export function subscribeBroadcasts(onNew) {
  if (unsubscribe) {
    try { unsubscribe(); } catch { /* ignore */ }
  }
  // Pega só comunicados criados nos últimos 7 dias, ordenados por createdAt desc.
  // Critério: campo `active` true OU ausente (broadcasts antigos não tinham).
  const q = query(collection(db, ...PATH), orderBy("createdAt", "desc"), limit(VIEW_LIMIT));
  // Marca a primeira snapshot como "carregamento inicial" — não dispara
  // o popup pra cada comunicado pré-existente. Só apresenta o mais recente
  // se ele ainda não tiver sido visto.
  let firstSnapshot = true;
  unsubscribe = onSnapshot(q, (snap) => {
    const docs = [];
    snap.forEach((d) => {
      const data = d.data();
      if (data.active === false) return;
      docs.push({ id: d.id, ...data });
    });
    if (!docs.length) { firstSnapshot = false; return; }

    if (firstSnapshot) {
      firstSnapshot = false;
      // No load inicial só mostra o mais recente se ainda não foi visto.
      const top = docs[0];
      if (!isBroadcastSeen(top.id)) {
        try { onNew(top); } catch (err) { console.warn("[broadcast] cb threw:", err); }
      }
      return;
    }

    // Updates subsequentes: dispara pros novos (não-vistos), do mais antigo
    // pro mais recente, pra que o último-mais-recente acabe na tela.
    const unseen = docs.filter((d) => !isBroadcastSeen(d.id));
    unseen.reverse().forEach((b) => {
      try { onNew(b); } catch (err) { console.warn("[broadcast] cb threw:", err); }
    });
  }, (err) => {
    console.warn("[broadcast] snapshot error:", err);
  });
  return () => {
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } unsubscribe = null; }
  };
}

/**
 * Mostra um modal in-app pro motorista com o comunicado. Marca como visto
 * quando o usuário fechar/confirmar. Tem som curto (já tocou no push, mas
 * cobre o caso de listener Firestore sem push).
 */
export function showBroadcastModal(b) {
  if (!b || !b.id) return;
  // Evita múltiplos modais empilhados — se já tá aberto, descarta novos.
  if (document.getElementById("broadcast-modal")) return;

  const overlay = document.createElement("div");
  overlay.id = "broadcast-modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(15,23,42,0.65); display: flex;
    align-items: center; justify-content: center; padding: 16px;
    backdrop-filter: blur(4px);
    animation: namao-fade-in 180ms ease-out;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #ffffff; color: #0f172a;
    width: min(420px, 100%); max-height: 80vh; overflow-y: auto;
    border-radius: 18px; padding: 22px 22px 18px;
    box-shadow: 0 18px 48px rgba(15,23,42,0.35);
    transform: translateY(8px); animation: namao-slide-up 220ms ease-out forwards;
    font-family: system-ui, -apple-system, sans-serif;
  `;

  const title = String(b.title || "Comunicado NaMão");
  const message = String(b.message || "");
  const audience = b.audience === "drivers" ? "Motoristas"
    : b.audience === "customers" ? "Clientes"
    : b.audience === "all" ? "Todos"
    : "—";
  const when = b.createdAt
    ? new Date(b.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";

  card.innerHTML = `
    <div style="display:flex; align-items:flex-start; gap:12px; margin-bottom:14px;">
      <div style="
        width:44px; height:44px; border-radius:14px;
        background:#16a34a; color:white;
        display:flex; align-items:center; justify-content:center;
        flex-shrink:0; font-size:22px;
      ">📣</div>
      <div style="flex:1; min-width:0;">
        <p style="margin:0 0 2px; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:#64748b; font-weight:700;">
          Comunicado NaMão · ${audience}${when ? " · " + when : ""}
        </p>
        <h2 style="margin:0; font-size:18px; font-weight:800; line-height:1.25;">${escapeText(title)}</h2>
      </div>
    </div>
    <p style="white-space:pre-wrap; line-height:1.45; font-size:15px; color:#1e293b; margin:0 0 18px;">
      ${escapeText(message)}
    </p>
    <button id="broadcast-modal-ok" style="
      width:100%; padding:12px 16px; border:none; border-radius:12px;
      background:#16a34a; color:white; font-weight:800; font-size:15px;
      cursor:pointer; box-shadow:0 6px 14px rgba(22,163,74,0.35);
    ">Entendi</button>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  injectAnimationKeyframes();

  function close() {
    markBroadcastSeen(b.id);
    overlay.style.animation = "namao-fade-out 160ms ease-in forwards";
    setTimeout(() => { overlay.remove(); }, 180);
  }

  card.querySelector("#broadcast-modal-ok").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", function escListener(e) {
    if (e.key === "Escape") {
      document.removeEventListener("keydown", escListener);
      close();
    }
  });
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let keyframesInjected = false;
function injectAnimationKeyframes() {
  if (keyframesInjected) return;
  keyframesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes namao-fade-in { from { opacity:0 } to { opacity:1 } }
    @keyframes namao-fade-out { from { opacity:1 } to { opacity:0 } }
    @keyframes namao-slide-up { from { transform:translateY(8px); opacity:0.6 } to { transform:translateY(0); opacity:1 } }
  `;
  document.head.appendChild(style);
}
