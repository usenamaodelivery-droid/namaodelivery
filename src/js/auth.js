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

function hint(msg, isError) {
  if (typeof window.showAuthHint === "function") window.showAuthHint(msg, isError);
  else showToast(msg);
}

export async function handleAuth(type) {
  if (authBusy) return;
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  if (!email || !password) {
    hint(
      type === "signup"
        ? "Digite seu e-mail e senha acima e toque em CRIAR CONTA."
        : "Digite seu e-mail e senha para entrar.",
      true
    );
    return;
  }
  if (type === "signup" && password.length < 6) {
    hint("A senha precisa ter pelo menos 6 caracteres.", true);
    return;
  }

  const primaryBtn = document.getElementById("auth-primary-btn");
  const originalText = primaryBtn ? primaryBtn.innerHTML : "";
  authBusy = true;
  if (primaryBtn) {
    primaryBtn.disabled = true;
    primaryBtn.innerHTML = type === "login" ? "Entrando…" : "Criando sua conta…";
  }

  try {
    if (type === "login") {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      await createUserWithEmailAndPassword(auth, email, password);
      // Sinaliza pro fluxo de auth (app.js) levar o novo entregador direto
      // pro formulário de cadastro (CNH/selfie), em vez de cair numa home vazia.
      window.__justSignedUp = true;
      hint("Conta criada! Agora envie seus documentos.", false);
    }
  } catch (err) {
    hint(mapAuthError(err.code) || err.message || "Não foi possível autenticar", true);
  } finally {
    authBusy = false;
    if (primaryBtn) {
      primaryBtn.disabled = false;
      primaryBtn.innerHTML = originalText;
    }
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
