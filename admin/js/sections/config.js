// Configurações: taxa, preços base, regiões, regras gerais.
// Salva no doc artifacts/<appId>/config/general
import {
  doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, APP_ID, PLATFORM_FEE } from "../firebase.js";
import { escapeHtml, showToast } from "../util.js";

const CONFIG_PATH = `artifacts/${APP_ID}/config/general`;

const DEFAULTS = {
  platformFee: PLATFORM_FEE,
  cities: ["Vitória", "Vila Velha"],
  supportWhatsapp: "5527988528835",
  registrationOpen: true,
  driverAutoApprove: false,
  ordersOpen: true,
};

async function loadConfig() {
  try {
    const snap = await getDoc(doc(db, CONFIG_PATH));
    if (snap.exists()) return { ...DEFAULTS, ...snap.data() };
  } catch (e) {}
  return DEFAULTS;
}

async function saveConfig(data) {
  await setDoc(doc(db, CONFIG_PATH), { ...data, updatedAt: Date.now() }, { merge: true });
}

function inputField(id, label, value, type = "text", help = "") {
  return `
    <div class="mb-3">
      <label class="text-xs font-bold text-slate-600 uppercase">${escapeHtml(label)}</label>
      <input id="${id}" type="${type}" value="${escapeHtml(value ?? "")}" class="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200" />
      ${help ? `<p class="text-tiny text-slate-400 mt-1">${escapeHtml(help)}</p>` : ""}
    </div>
  `;
}

function toggleField(id, label, checked, help = "") {
  return `
    <label class="flex items-center justify-between p-3 bg-slate-50 rounded-lg mb-2 cursor-pointer">
      <div>
        <p class="text-sm font-bold">${escapeHtml(label)}</p>
        ${help ? `<p class="text-xs text-slate-500">${escapeHtml(help)}</p>` : ""}
      </div>
      <input id="${id}" type="checkbox" ${checked ? "checked" : ""} class="w-5 h-5 accent-accent" />
    </label>
  `;
}

export async function renderConfig({ content }) {
  content.innerHTML = `<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl"></i></div>`;
  const cfg = await loadConfig();

  content.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <form id="cfg-form" class="space-y-5">

        <div class="bg-white rounded-2xl shadow-card p-5">
          <p class="text-sm font-extrabold uppercase text-slate-500 mb-3">Divisão do frete</p>
          ${inputField("platformFee", "Fatia da plataforma sobre o frete (0..1)", cfg.platformFee, "number", "Ex: 0,12 = 12%. Motorista recebe (1 − taxa) do FRETE. Não é comissão da loja.")}
        </div>

        <div class="bg-white rounded-2xl shadow-card p-5">
          <p class="text-sm font-extrabold uppercase text-slate-500 mb-3">Regiões atendidas</p>
          ${inputField("cities", "Cidades (separadas por vírgula)", (cfg.cities || []).join(", "))}
        </div>

        <div class="bg-white rounded-2xl shadow-card p-5">
          <p class="text-sm font-extrabold uppercase text-slate-500 mb-3">Suporte</p>
          ${inputField("supportWhatsapp", "WhatsApp suporte (DDI+DDD+nº)", cfg.supportWhatsapp)}
        </div>

        <div class="bg-white rounded-2xl shadow-card p-5">
          <p class="text-sm font-extrabold uppercase text-slate-500 mb-3">Operação</p>
          ${toggleField("ordersOpen",        "Aceitar novos pedidos",     cfg.ordersOpen,        "Desligue pra pausar a plataforma.")}
          ${toggleField("registrationOpen",  "Cadastros abertos",         cfg.registrationOpen,  "Permitir novos motoristas se cadastrarem.")}
          ${toggleField("driverAutoApprove", "Aprovar motorista auto",    cfg.driverAutoApprove, "Se ligado, motoristas começam aprovados (sem revisão admin).")}
        </div>

        <button type="submit" class="w-full py-3 bg-accent text-white font-black rounded-xl hover:bg-accent-dark">
          <i class="fa-solid fa-floppy-disk mr-2"></i>Salvar configurações
        </button>
      </form>

      <div class="bg-primary text-white rounded-2xl shadow-card p-5 self-start">
        <p class="text-sm font-extrabold uppercase text-slate-300 mb-3">Cuidado</p>
        <ul class="text-sm space-y-2 text-slate-200">
          <li>• A <b class="text-accent">fatia da plataforma</b> é a divisão do FRETE (motorista × NaMão), não a comissão da loja.</li>
          <li>• Desligar <b class="text-accent">aceitar pedidos</b> impede clientes de fazer novos pedidos.</li>
          <li>• Cadastro auto-aprova é <b class="text-warn">arriscado</b>: deixe desligado em produção.</li>
        </ul>
      </div>
    </div>
  `;

  document.getElementById("cfg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      platformFee:        Number(document.getElementById("platformFee").value),
      cities:             document.getElementById("cities").value.split(",").map((s) => s.trim()).filter(Boolean),
      supportWhatsapp:    document.getElementById("supportWhatsapp").value.trim(),
      ordersOpen:         document.getElementById("ordersOpen").checked,
      registrationOpen:   document.getElementById("registrationOpen").checked,
      driverAutoApprove:  document.getElementById("driverAutoApprove").checked,
    };
    try {
      await saveConfig(data);
      showToast("Configurações salvas!", "success");
    } catch (e) {
      showToast(e.message || "Erro ao salvar", "error");
    }
  });
}
