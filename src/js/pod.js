// Prova de Entrega (POD): foto + assinatura digital -> Firebase Storage
import { ref, uploadString, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { storage } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";
import { completeOrder } from "./orders.js";
import { showToast } from "./ui.js";

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

/** Sobe a prova no Storage e finaliza o pedido transacionalmente. */
export async function confirmDeliveryWithPOD(driverId) {
  const photoInput = document.getElementById("delivery-photo");
  if (!photoInput?.files?.[0]) { showToast("Faça a foto do local"); return; }
  if (!hasSignature) { showToast("Assinatura obrigatória"); return; }
  if (!currentOrderId) { showToast("Pedido indefinido"); return; }

  const btn = document.getElementById("btn-confirm-pod");
  btn.disabled = true;
  btn.innerText = "ENVIANDO...";

  try {
    const basePath = `artifacts/${APP_ID}/pod/${currentOrderId}`;
    const photoFile = photoInput.files[0];
    const photoRef = ref(storage, `${basePath}/photo-${Date.now()}.jpg`);
    await uploadBytes(photoRef, photoFile, { contentType: photoFile.type || "image/jpeg" });
    const photoUrl = await getDownloadURL(photoRef);

    const sigDataUrl = canvas.toDataURL("image/png");
    const sigRef = ref(storage, `${basePath}/signature-${Date.now()}.png`);
    await uploadString(sigRef, sigDataUrl, "data_url");
    const signatureUrl = await getDownloadURL(sigRef);

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
