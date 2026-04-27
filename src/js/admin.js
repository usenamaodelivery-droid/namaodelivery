// Admin controla PIX e status de motoristas. Autorização é via custom claim
// `admin:true` em request.auth.token (ver firestore.rules).
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";
import { adminConfirmPix } from "./orders.js";
import { showToast } from "./ui.js";

/** Exporta no window para uso inline no HTML de admin. */
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
}
