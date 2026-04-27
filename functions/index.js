/**
 * Cloud Functions — admin & segurança
 *
 * - setAdminClaim: callable. Apenas quem já é admin (ou — no primeiro boot —
 *   o e-mail em ADMIN_BOOTSTRAP_EMAIL) pode promover outro UID.
 * - onDriverRegistered: se for o primeiro usuário cadastrado, pode ser
 *   promovido automaticamente (comentado — habilite se quiser auto-bootstrap).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10 });

const BOOTSTRAP_EMAIL = process.env.ADMIN_BOOTSTRAP_EMAIL || "";

exports.setAdminClaim = onCall(async (request) => {
  const { targetUid, admin: makeAdmin } = request.data || {};
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid obrigatório");

  const caller = request.auth;
  if (!caller) throw new HttpsError("unauthenticated", "Login obrigatório");

  const isBootstrap =
    BOOTSTRAP_EMAIL &&
    caller.token.email &&
    caller.token.email.toLowerCase() === BOOTSTRAP_EMAIL.toLowerCase();

  if (!caller.token.admin && !isBootstrap) {
    throw new HttpsError("permission-denied", "Apenas admins podem promover outros usuários");
  }

  await admin.auth().setCustomUserClaims(targetUid, { admin: Boolean(makeAdmin) });
  return { ok: true, targetUid, admin: Boolean(makeAdmin) };
});
