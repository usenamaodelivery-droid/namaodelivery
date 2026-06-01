/**
 * Cliente HTTP pras serverless functions hospedadas na Vercel.
 * Substitui httpsCallable() do Firebase, mantendo a mesma autenticação
 * via Firebase ID token (Bearer).
 *
 * Endpoint base: api.namaodelivery.com.br (production) ou
 *                <preview>.vercel.app (testing) — configurável via
 *                window.NAMAO_API_BASE (definido em index.html).
 */
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

// Fallback ordem: window override -> default vercel prod URL.
function getApiBase() {
  if (typeof window !== "undefined" && typeof window.NAMAO_API_BASE === "string" && window.NAMAO_API_BASE) {
    return window.NAMAO_API_BASE.replace(/\/$/, "");
  }
  return "https://namao-delivery-api.vercel.app";
}

async function getIdToken() {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Login obrigatório");
  return user.getIdToken();
}

export async function apiCall(endpoint, body = {}) {
  const token = await getIdToken();
  const url = `${getApiBase()}/api/${endpoint}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });
  let data;
  try {
    data = await r.json();
  } catch (_) {
    data = {};
  }
  if (!r.ok) {
    const e = new Error(data.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.body = data;
    throw e;
  }
  return data;
}
