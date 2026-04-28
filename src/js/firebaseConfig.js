// ⚠️ Substituir pelo firebaseConfig do console Firebase.
// Este arquivo é lido em runtime pelo app.js — NUNCA commite chaves que não
// correspondam ao projeto final. Os valores abaixo são placeholders.
//
// As "apiKey" do Firebase Web SDK não são secretas por natureza (ver docs),
// a segurança real vem das Firestore/Storage rules em /firebase/*.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyDAilsro9E7x88PixtdL5RWLn6zFINIajo",
  authDomain: "namao-delivery-prod.firebaseapp.com",
  projectId: "namao-delivery-prod",
  storageBucket: "namao-delivery-prod.firebasestorage.app",
  messagingSenderId: "129438267740",
  appId: "1:129438267740:web:2a50c599a912b09a696999",
  measurementId: "G-S4NYP7QZ1T"
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
