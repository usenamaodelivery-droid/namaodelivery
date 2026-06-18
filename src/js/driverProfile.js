import { doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";

/** Cria/atualiza perfil do motorista. Balance nunca é sobrescrito aqui. */
export async function registerDriver(uid, data) {
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  // Merge garante que "balance" preexistente não seja zerado se o doc já existe.
  const payload = {
    name: data.name,
    cpf: data.cpf,
    plate: data.plate,
    phone: data.phone || null,
    vehicleType: data.vehicleType || "Moto",
    status: "approved",
    registeredAt: Date.now()
  };
  if (data.cnhPhoto) payload.cnhPhoto = data.cnhPhoto;
  if (data.selfiePhoto) payload.selfiePhoto = data.selfiePhoto;
  if (data.cnhNumber) payload.cnhNumber = data.cnhNumber;
  if (data.city) payload.city = data.city;
  await setDoc(ref, payload, { merge: true });
}

/** Salva o FCM token do device no perfil do motorista (merge). */
export async function saveDriverFcmToken(uid, token) {
  if (!uid || !token) return;
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  await setDoc(ref, { fcmToken: token, fcmUpdatedAt: Date.now() }, { merge: true });
}

/**
 * Salva a última localização conhecida do motorista no perfil. Usado pra
 * filtrar os pedidos por proximidade (a Cloud Function só notifica motoristas
 * dentro do raio do ponto de coleta). Atualiza mesmo SEM corrida ativa, pra
 * que o motorista online apareça como "perto" do pedido novo.
 */
export async function updateDriverPresence(uid, lat, lng) {
  if (!uid || typeof lat !== "number" || typeof lng !== "number") return;
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  await setDoc(ref, { lastLat: lat, lastLng: lng, lastLocationAt: Date.now() }, { merge: true });
}

/** Liga/desliga notificações de novo pedido. */
export async function setNotifyOnNewOrder(uid, enabled) {
  if (!uid) return;
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  await setDoc(ref, { notifyOnNewOrder: !!enabled }, { merge: true });
}

/** Ouve em tempo real status do motorista (para banimento) e dados de carteira. */
export function subscribeDriverProfile(uid, cb) {
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  return onSnapshot(ref, (snap) => {
    if (snap.exists()) cb({ id: snap.id, ...snap.data() });
    else cb(null);
  });
}
