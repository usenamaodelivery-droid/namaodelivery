// Admin: confirmação PIX, status motoristas, logs de segurança.
// Autorização via custom claim `admin:true` (ver firestore.rules).
import { collection, doc, onSnapshot, updateDoc, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";
import { adminConfirmPix } from "./orders.js";
import { showToast } from "./ui.js";

export async function confirmPix(orderId) {
  try {
    await adminConfirmPix(orderId);
    showToast("PIX confirmado — pedido liberado aos motoristas");
  } catch (e) {
    showToast(e.message || "Falha ao confirmar PIX");
  }
}

/** Admin altera status do motorista (blocked | suspended | approved). */
export async function setDriverStatus(driverUid, status) {
  if (!["approved", "blocked", "suspended"].includes(status)) {
    throw new Error("Status inválido");
  }
  const ref = doc(db, "artifacts", APP_ID, "users", driverUid, "profile", "driverInfo");
  await updateDoc(ref, { status, statusChangedAt: Date.now() });
  showToast(`Motorista atualizado: ${status}`);
}

/**
 * Listener de logs de segurança recentes (cadastros bloqueados, etc).
 * O collection group seria ideal, mas mantemos coleção simples por compatibilidade
 * com Spark.
 */
export function subscribeSecurityLogs(cb) {
  const q = query(
    collection(db, "artifacts", APP_ID, "public", "data", "securityLogs"),
    orderBy("createdAt", "desc"),
    limit(20)
  );
  return onSnapshot(q, (snap) => {
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    cb(items);
  });
}
