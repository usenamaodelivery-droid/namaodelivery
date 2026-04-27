import { doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";

/** Cria/atualiza perfil do motorista. Balance nunca é sobrescrito aqui. */
export async function registerDriver(uid, data) {
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  // Merge garante que "balance" preexistente não seja zerado se o doc já existe.
  await setDoc(ref, {
    name: data.name,
    cpf: data.cpf,
    plate: data.plate,
    status: "approved",
    registeredAt: Date.now()
  }, { merge: true });
}

/** Ouve em tempo real status do motorista (para banimento) e dados de carteira. */
export function subscribeDriverProfile(uid, cb) {
  const ref = doc(db, "artifacts", APP_ID, "users", uid, "profile", "driverInfo");
  return onSnapshot(ref, (snap) => {
    if (snap.exists()) cb({ id: snap.id, ...snap.data() });
    else cb(null);
  });
}
