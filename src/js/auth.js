import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { app } from "./firebaseInit.js";
import { showToast } from "./ui.js";

export const auth = getAuth(app);

export function onAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function handleAuth(type) {
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  if (!email || !password) {
    showToast("Preencha e-mail e senha");
    return;
  }
  try {
    if (type === "login") {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      await createUserWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    showToast(mapAuthError(err.code) || err.message);
  }
}

export function signOutUser() {
  return signOut(auth);
}

function mapAuthError(code) {
  const map = {
    "auth/invalid-email": "E-mail inválido",
    "auth/user-not-found": "Usuário não encontrado",
    "auth/wrong-password": "Senha incorreta",
    "auth/invalid-credential": "Credenciais inválidas",
    "auth/email-already-in-use": "E-mail já cadastrado",
    "auth/weak-password": "Senha muito fraca (mínimo 6 caracteres)",
    "auth/network-request-failed": "Sem conexão com a internet"
  };
  return map[code];
}
