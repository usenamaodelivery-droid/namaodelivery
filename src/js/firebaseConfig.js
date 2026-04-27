// ⚠️ Substituir pelo firebaseConfig do console Firebase.
// Este arquivo é lido em runtime pelo app.js — NUNCA commite chaves que não
// correspondam ao projeto final. Os valores abaixo são placeholders.
//
// As "apiKey" do Firebase Web SDK não são secretas por natureza (ver docs),
// a segurança real vem das Firestore/Storage rules em /firebase/*.rules.
export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME"
};

export const APP_ID = "namao-delivery-prod";

// Parâmetros de negócio
export const PLATFORM_FEE = 0.15;      // 15% plataforma
export const DRIVER_SHARE = 0.85;      // 85% motorista
export const MOTO_BASE = 8.0;
export const MOTO_PER_KM = 1.9;
export const CAR_BASE = 15.0;
export const CAR_PER_KM = 3.8;
export const ROUTE_DETOUR_FACTOR = 1.35;
export const LOCATION_UPDATE_MS = 15_000;

// Contatos / chaves externas — sobrescritos em build de produção
export const SUPPORT_WHATSAPP = "5511999999999";
export const PIX_KEY = "SUA_CHAVE_PIX_AQUI";
