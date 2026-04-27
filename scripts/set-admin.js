#!/usr/bin/env node
/**
 * Bootstrap script — promove um UID para admin usando a Service Account Key.
 * Uso local (NÃO requer a Cloud Function estar deployada):
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=/caminho/service-account.json
 *   node scripts/set-admin.js <UID> [--revoke]
 */
const admin = require("firebase-admin");

async function main() {
  const [uid, flag] = process.argv.slice(2);
  if (!uid) {
    console.error("Uso: node scripts/set-admin.js <UID> [--revoke]");
    process.exit(1);
  }
  const revoke = flag === "--revoke";

  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });

  const user = await admin.auth().getUser(uid);
  console.log(`Usuário: ${user.email || user.uid}`);
  await admin.auth().setCustomUserClaims(uid, revoke ? {} : { admin: true });
  console.log(revoke ? "Claim admin removida" : "Claim admin: true atribuída");
  console.log("Peça ao usuário para deslogar/relogar para a claim entrar em vigor.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
