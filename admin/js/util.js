// Helpers compartilhados.

export function showToast(msg, kind = "info") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.innerText = msg;
  t.className = "fixed bottom-6 right-6 px-4 py-3 font-bold rounded-xl shadow-card toast";
  if (kind === "error") t.classList.add("bg-danger", "text-white");
  else if (kind === "success") t.classList.add("bg-accent", "text-white");
  else t.classList.add("bg-primary", "text-white");
  t.classList.remove("hidden", "opacity-0");
  t.style.zIndex = "9999";
  setTimeout(() => { t.classList.remove("opacity-0"); t.classList.add("opacity-100"); }, 10);
  setTimeout(() => {
    t.classList.remove("opacity-100");
    t.classList.add("opacity-0");
    setTimeout(() => t.classList.add("hidden"), 300);
  }, 3500);
}

export function formatBRL(n) {
  const v = Number(n || 0);
  return "R$ " + v.toFixed(2).replace(".", ",");
}

export function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(typeof ts === "number" ? ts : ts.toMillis ? ts.toMillis() : Date.parse(ts));
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDateShort(ts) {
  if (!ts) return "—";
  const d = new Date(typeof ts === "number" ? ts : ts.toMillis ? ts.toMillis() : Date.parse(ts));
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

// status -> {label, badgeClass}
export const ORDER_STATUS = {
  waiting_confirmation: { label: "Aguarda PIX",   badge: "badge-yellow" },
  pending:              { label: "Disponível",    badge: "badge-blue"   },
  accepted:             { label: "Aceito",        badge: "badge-blue"   },
  in_transit:           { label: "A caminho",     badge: "badge-blue"   },
  completed:            { label: "Entregue",      badge: "badge-green"  },
  cancelled:            { label: "Cancelado",     badge: "badge-gray"   },
  refunded:             { label: "Estornado",     badge: "badge-red"    },
};

export const DRIVER_STATUS = {
  pending:    { label: "Pendente",    badge: "badge-yellow" },
  approved:   { label: "Aprovado",    badge: "badge-green"  },
  blocked:    { label: "Bloqueado",   badge: "badge-red"    },
  suspended:  { label: "Suspenso",    badge: "badge-gray"   },
  rejected:   { label: "Reprovado",   badge: "badge-red"    },
};

export const PAYOUT_STATUS = {
  processing: { label: "Processando", badge: "badge-yellow" },
  pending:    { label: "Pendente",    badge: "badge-blue"   },
  completed:  { label: "Pago",        badge: "badge-green"  },
  failed:     { label: "Falhou",      badge: "badge-red"    },
};

export function badge(map, status) {
  const s = map[status] || { label: status || "—", badge: "badge-gray" };
  return `<span class="badge ${s.badge}">${escapeHtml(s.label)}</span>`;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) =>
    r.map((c) => {
      const s = String(c ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  ).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

export function confirmDialog(message) {
  return Promise.resolve(window.confirm(message));
}
