// Prova de Entrega (POD): foto + assinatura digital.
//
// Modo BASE64 (Spark): foto comprimida (~80KB) + assinatura PNG salvas
// inline no documento do pedido em Firestore. Cabe no limite de 1MB/doc.
// Modo STORAGE (Blaze): pode ser reativado trocando STORAGE_MODE para true
// (ainda mantemos as rules em /firebase/storage.rules para essa migração).
import { ref, uploadString, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { storage } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";
import { completeOrder, markInTransit } from "./orders.js";
import { showToast } from "./ui.js";

// Switch para futuro: setar como true depois de habilitar Blaze + Storage.
const STORAGE_MODE = false;
// Limite de tamanho da foto comprimida no modo base64 (200KB ≈ 270KB base64)
const MAX_PHOTO_BYTES = 200 * 1024;

let canvas, ctx, isDrawing = false, hasSignature = false;
let currentOrderId = null;

export function initSignaturePad() {
  canvas = document.getElementById("signature-pad");
  if (!canvas) return;
  ctx = canvas.getContext("2d");
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#0B1526";

  const pos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: cx - rect.left, y: cy - rect.top };
  };
  const start = (e) => {
    e.preventDefault();
    isDrawing = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const draw = (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasSignature = true;
    validatePOD();
  };
  const end = () => { isDrawing = false; };

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", draw);
  canvas.addEventListener("mouseup", end);
  canvas.addEventListener("mouseleave", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", draw, { passive: false });
  canvas.addEventListener("touchend", end);
}

export function clearSignature() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasSignature = false;
  validatePOD();
}

export function openPOD(orderId) {
  currentOrderId = orderId;
  hasSignature = false;
  clearSignature();
  const photoInput = document.getElementById("delivery-photo");
  if (photoInput) photoInput.value = "";
  validatePOD();
  document.getElementById("proof-delivery-modal").classList.remove("hidden");
}

export function closePOD() {
  document.getElementById("proof-delivery-modal").classList.add("hidden");
}

export function validatePOD() {
  const photo = document.getElementById("delivery-photo")?.files?.length > 0;
  const btn = document.getElementById("btn-confirm-pod");
  if (!btn) return;
  const valid = photo && hasSignature;
  btn.disabled = !valid;
  btn.classList.toggle("opacity-50", !valid);
}

/**
 * Redimensiona uma imagem para no máximo maxDim px no lado maior e
 * comprime em JPEG. Retorna data URL base64.
 */
async function compressImage(file, maxDim = 800, quality = 0.6) {
  const img = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  // Tenta progressivamente reduzir qualidade até caber em MAX_PHOTO_BYTES
  let q = quality;
  let dataUrl = c.toDataURL("image/jpeg", q);
  while (dataUrl.length > MAX_PHOTO_BYTES * 1.4 && q > 0.2) {
    q -= 0.1;
    dataUrl = c.toDataURL("image/jpeg", q);
  }
  return dataUrl;
}

/* ---------------- PICKUP photo (foto antes — coleta no estabelecimento) ---------------- */

let currentPickupOrderId = null;

export function openPickupPhoto(orderId) {
  currentPickupOrderId = orderId;
  const photoInput = document.getElementById("pickup-photo");
  if (photoInput) photoInput.value = "";
  validatePickupPhoto();
  document.getElementById("pickup-photo-modal")?.classList.remove("hidden");
}

export function closePickupPhoto() {
  document.getElementById("pickup-photo-modal")?.classList.add("hidden");
}

export function validatePickupPhoto() {
  const photo = document.getElementById("pickup-photo")?.files?.length > 0;
  const btn = document.getElementById("btn-confirm-pickup");
  if (!btn) return;
  btn.disabled = !photo;
  btn.classList.toggle("opacity-50", !photo);
}

export async function confirmPickupWithPhoto() {
  const photoInput = document.getElementById("pickup-photo");
  if (!photoInput?.files?.[0]) { showToast("Tira a foto da retirada"); return; }
  if (!currentPickupOrderId) { showToast("Pedido indefinido"); return; }

  const btn = document.getElementById("btn-confirm-pickup");
  btn.disabled = true;
  btn.innerText = "ENVIANDO...";

  try {
    let pickupPhotoUrl;
    const file = photoInput.files[0];

    if (STORAGE_MODE) {
      const path = `artifacts/${APP_ID}/pickup/${currentPickupOrderId}/photo-${Date.now()}.jpg`;
      const r = ref(storage, path);
      await uploadBytes(r, file, { contentType: file.type || "image/jpeg" });
      pickupPhotoUrl = await getDownloadURL(r);
    } else {
      pickupPhotoUrl = await compressImage(file, 800, 0.6);
    }

    await markInTransit(currentPickupOrderId, pickupPhotoUrl);
    closePickupPhoto();
    showToast("Coleta confirmada — siga para o destino");
  } catch (err) {
    console.error(err);
    showToast(err?.message || "Falha ao confirmar coleta");
  } finally {
    btn.disabled = false;
    btn.innerText = "CONFIRMAR COLETA";
  }
}

if (typeof window !== "undefined") {
  window.openPickupPhoto = openPickupPhoto;
  window.closePickupPhoto = closePickupPhoto;
  window.validatePickupPhoto = validatePickupPhoto;
  window.confirmPickupWithPhoto = confirmPickupWithPhoto;
}

/* ---------------- DELIVERY POD (foto depois + assinatura) ---------------- */

export async function confirmDeliveryWithPOD(driverId) {
  const photoInput = document.getElementById("delivery-photo");
  if (!photoInput?.files?.[0]) { showToast("Faça a foto do local"); return; }
  if (!hasSignature) { showToast("Assinatura obrigatória"); return; }
  if (!currentOrderId) { showToast("Pedido indefinido"); return; }

  const btn = document.getElementById("btn-confirm-pod");
  btn.disabled = true;
  btn.innerText = "ENVIANDO...";

  try {
    const photoFile = photoInput.files[0];
    let photoUrl, signatureUrl;

    if (STORAGE_MODE) {
      // Caminho Storage (requer Blaze)
      const basePath = `artifacts/${APP_ID}/pod/${currentOrderId}`;
      const photoRef = ref(storage, `${basePath}/photo-${Date.now()}.jpg`);
      await uploadBytes(photoRef, photoFile, { contentType: photoFile.type || "image/jpeg" });
      photoUrl = await getDownloadURL(photoRef);

      const sigDataUrl = canvas.toDataURL("image/png");
      const sigRef = ref(storage, `${basePath}/signature-${Date.now()}.png`);
      await uploadString(sigRef, sigDataUrl, "data_url");
      signatureUrl = await getDownloadURL(sigRef);
    } else {
      // Caminho Base64 (Spark / sem cartão)
      photoUrl = await compressImage(photoFile, 800, 0.6);
      signatureUrl = canvas.toDataURL("image/png");
    }

    await completeOrder({ orderId: currentOrderId, driverId, photoUrl, signatureUrl });
    closePOD();
    showToast("Entrega finalizada! Ganhos de 85% creditados.");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Falha ao enviar prova");
  } finally {
    btn.disabled = false;
    btn.innerText = "FINALIZAR E RECEBER";
  }
}
