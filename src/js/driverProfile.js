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
  await setDoc(ref, payload, { merge: true });
}

/** Ouve em tempo real status do motorista (para banimento) e dados de carteira. */
export function subscribeDriverProfile(uid, cb) {
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  return onSnapshot(ref, (snap) => {
    if (snap.exists()) cb({ id: snap.id, ...snap.data() });
    else cb(null);
  });
}
