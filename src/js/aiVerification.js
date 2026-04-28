// Verificação por IA de motorista (cadastro)
// Sequência animada que simula análise de CNH, antecedentes e biometria.
// Regra de demonstração: CPF contendo "171" = reprovado (antecedentes criminais).
// Falhas registram um documento em /artifacts/<APP_ID>/public/data/securityLogs.
import { addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db } from "./firebaseInit.js";
import { APP_ID } from "./firebaseConfig.js";

const STEPS = [
  { icon: "fa-id-card", text: "Conectando aos servidores seguros..." },
  { icon: "fa-id-card", text: "Verificando autenticidade da CNH (OCR)..." },
  { icon: "fa-fingerprint", text: "Cruzando antecedentes criminais..." },
  { icon: "fa-user-astronaut", text: "Reconhecimento facial vs documento..." }
];

function setStep(i) {
  const icon = document.getElementById("ai-icon");
  const text = document.getElementById("ai-status-text");
  const bar = document.getElementById("ai-progress-bar");
  if (icon) icon.className = `fa-solid ${STEPS[i].icon}`;
  if (text) text.textContent = STEPS[i].text;
  if (bar) bar.style.width = `${((i + 1) / STEPS.length) * 100}%`;
}

function show() {
  const m = document.getElementById("ai-verification-modal");
  if (m) m.classList.remove("hidden");
}

function hide() {
  const m = document.getElementById("ai-verification-modal");
  if (m) m.classList.add("hidden");
  const bar = document.getElementById("ai-progress-bar");
  if (bar) bar.style.width = "0%";
}

function logSecurity(payload) {
  return addDoc(
    collection(db, "artifacts", APP_ID, "public", "data", "securityLogs"),
    {
      ...payload,
      createdAt: Date.now(),
      createdAtServer: serverTimestamp()
    }
  );
}

/**
 * Roda o fluxo de verificação. Retorna { ok: true } se aprovado,
 * { ok: false, reason: "..." } caso reprovado.
 */
export async function runVerification({ uid, name, cpf }) {
  show();

  for (let i = 0; i < STEPS.length; i++) {
    setStep(i);
    // Etapa 2 (antecedentes) é onde o "171" reprova
    if (i === 2) {
      await sleep(1200);
      if ((cpf || "").replace(/\D/g, "").includes("171")) {
        const text = document.getElementById("ai-status-text");
        const icon = document.getElementById("ai-icon");
        if (text) {
          text.textContent = "ANTECEDENTES CRIMINAIS DETECTADOS";
          text.classList.add("text-danger");
        }
        if (icon) {
          icon.className = "fa-solid fa-triangle-exclamation";
          icon.parentElement?.classList.add("text-danger");
        }
        try {
          await logSecurity({
            type: "registration_blocked",
            reason: "cpf_171_match",
            uid,
            name: name || null,
            cpfMasked: maskCpf(cpf)
          });
        } catch (e) { console.warn("falha ao registrar log seg.", e); }
        await sleep(2000);
        hide();
        return { ok: false, reason: "Antecedentes criminais detectados pela IA. Cadastro reprovado." };
      }
    }
    await sleep(1000);
  }

  // sucesso
  const icon = document.getElementById("ai-icon");
  const text = document.getElementById("ai-status-text");
  if (icon) icon.className = "fa-solid fa-circle-check";
  if (text) {
    text.textContent = "Aprovado! Bem-vindo ao time NaMão.";
    text.classList.remove("text-danger");
    text.classList.add("text-green-400");
  }
  await sleep(1500);
  hide();
  // limpa estado do toast verde para próxima execução
  if (text) text.classList.remove("text-green-400");
  return { ok: true };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function maskCpf(cpf) {
  if (!cpf) return null;
  const d = String(cpf).replace(/\D/g, "");
  if (d.length < 6) return d;
  return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`;
}
