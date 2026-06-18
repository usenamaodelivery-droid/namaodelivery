// Firebase Admin SDK + helpers compartilhados pras serverless functions Vercel.
// O service account vem da env var FIREBASE_SERVICE_ACCOUNT (JSON inteiro).
// Em dev local, cai pra GOOGLE_APPLICATION_CREDENTIALS apontando pro arquivo.

const admin = require("firebase-admin");

let app;

function initAdmin() {
  if (app) return app;
  if (admin.apps.length) {
    app = admin.app();
    return app;
  }

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const sa = JSON.parse(json);
      // Vercel sometimes escapes \n in env vars
      if (typeof sa.private_key === "string") {
        sa.private_key = sa.private_key.replace(/\\n/g, "\n");
      }
      app = admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: sa.project_id,
      });
      return app;
    } catch (e) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON inválido: " + e.message);
    }
  }

  // fallback (dev local): GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
  app = admin.initializeApp();
  return app;
}

function db() {
  initAdmin();
  return admin.firestore();
}

function auth() {
  initAdmin();
  return admin.auth();
}

// Valida o ID token que o cliente envia no header Authorization: Bearer <idToken>.
// Retorna o decoded token (com uid, email, claims) ou lança 401.
async function verifyAuth(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    const err = new Error("Login obrigatório");
    err.status = 401;
    throw err;
  }
  try {
    const decoded = await auth().verifyIdToken(m[1]);
    return decoded;
  } catch (e) {
    const err = new Error("Token inválido");
    err.status = 401;
    throw err;
  }
}

// Lê body JSON em ambiente Vercel (handler nativo).
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.status(status).end(JSON.stringify(body));
}

function sendError(res, e) {
  console.error(e);
  const status = e.status || 500;
  send(res, status, { error: e.message || "Erro interno" });
}

const APP_ID = "namao-delivery-prod";
const PLATFORM_FEE = 0.15;
const DRIVER_SHARE = 1 - PLATFORM_FEE;

function getMpToken() {
  return process.env.MERCADOPAGO_ACCESS_TOKEN || "";
}

module.exports = {
  initAdmin,
  db,
  auth,
  verifyAuth,
  readJson,
  send,
  sendError,
  APP_ID,
  PLATFORM_FEE,
  DRIVER_SHARE,
  getMpToken,
  admin,
};
