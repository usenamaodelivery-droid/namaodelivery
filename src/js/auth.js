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

let authBusy = false;

export async function handleAuth(type) {
  if (authBusy) return;
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  if (!email || !password) {
    showToast("Preencha e-mail e senha");
    return;
  }
  if (type === "signup" && password.length < 6) {
    showToast("A senha precisa ter pelo menos 6 caracteres");
    return;
  }

  const loginBtn = document.getElementById("auth-login-btn");
  const signupBtn = document.getElementById("auth-signup-btn");
  const activeBtn = type === "login" ? loginBtn : signupBtn;
  const originalText = activeBtn ? activeBtn.innerHTML : "";
  authBusy = true;
  if (loginBtn) loginBtn.disabled = true;
  if (signupBtn) signupBtn.disabled = true;
  if (activeBtn) {
    activeBtn.innerHTML =
      type === "login" ? "Entrando…" : "Criando sua conta…";
  }

  try {
    if (type === "login") {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      await createUserWithEmailAndPassword(auth, email, password);
      // Sinaliza pro fluxo de auth (app.js) levar o novo entregador direto
      // pro formulário de cadastro (CNH/selfie), em vez de cair numa home vazia.
      window.__justSignedUp = true;
      showToast("Conta criada! Agora envie seus documentos.");
    }
  } catch (err) {
    showToast(mapAuthError(err.code) || err.message || "Não foi possível autenticar");
  } finally {
    authBusy = false;
    if (loginBtn) loginBtn.disabled = false;
    if (signupBtn) signupBtn.disabled = false;
    if (activeBtn) activeBtn.innerHTML = originalText;
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
    "auth/network-request-failed": "Sem conexão com a internet",
    "auth/too-many-requests": "Muitas tentativas. Tente de novo em alguns minutos",
    "auth/operation-not-allowed": "Cadastro indisponível no momento. Fale com o suporte",
    "auth/missing-password": "Digite sua senha",
    "auth/missing-email": "Digite seu e-mail"
  };
  return map[code];
}
