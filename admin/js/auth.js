// Login + admin claim check.
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { auth } from "./firebase.js";
import { showToast } from "./util.js";

let currentUser = null;
let authSubscribers = [];

export function onAuth(cb) {
  authSubscribers.push(cb);
  if (currentUser !== undefined) cb(currentUser);
  return () => {
    authSubscribers = authSubscribers.filter((s) => s !== cb);
  };
}

export function getCurrentUser() {
  return currentUser;
}

export async function ensureAdmin(user) {
  if (!user) return false;
  // Force refresh para pegar claim atualizado
  const tokenResult = await user.getIdTokenResult(true);
  return Boolean(tokenResult.claims?.admin);
}

export async function loginWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logout() {
  await signOut(auth);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    authSubscribers.forEach((cb) => cb(null));
    return;
  }
  // Cache user com claim verificado
  let admin = false;
  try {
    admin = await ensureAdmin(user);
  } catch (e) {
    console.warn("Erro ao verificar admin claim:", e);
  }
  currentUser = { user, admin, email: user.email, uid: user.uid };
  authSubscribers.forEach((cb) => cb(currentUser));
});

export function showAdminError() {
  showToast("Acesso negado: você não é admin.", "error");
}
