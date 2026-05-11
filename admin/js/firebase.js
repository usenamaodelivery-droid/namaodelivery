// Inicialização Firebase compartilhada da Admin Dashboard.
// Mesmo projeto / mesmo Firestore que o driver app + PWA cliente.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDAilsro9E7x88PixtdL5RWLn6zFINIajo",
  authDomain: "namao-delivery-prod.firebaseapp.com",
  projectId: "namao-delivery-prod",
  storageBucket: "namao-delivery-prod.firebasestorage.app",
  messagingSenderId: "129438267740",
  appId: "1:129438267740:web:2a50c599a912b09a696999",
  measurementId: "G-S4NYP7QZ1T",
};

export const APP_ID = "namao-delivery-prod";

// Constantes de negócio (mesmas do driver/PWA)
export const PLATFORM_FEE = 0.15;
export const DRIVER_SHARE = 0.85;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, "southamerica-east1");
