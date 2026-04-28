// Modal de rastreio do pedido (cliente).
// Atualiza status conforme o pedido muda: pending -> accepted -> in_transit -> completed.

const STATUS_TEXT = {
  waiting_confirmation: { text: "Aguardando confirmação do PIX", icon: "fa-clock" },
  pending: { text: "Procurando motorista", icon: "fa-magnifying-glass" },
  accepted: { text: "Motorista a caminho da retirada", icon: "fa-motorcycle" },
  in_transit: { text: "Em trânsito até você", icon: "fa-route" },
  completed: { text: "Entrega concluída", icon: "fa-circle-check" },
  cancelled: { text: "Pedido cancelado", icon: "fa-circle-xmark" }
};

let activeOrderId = null;

export function openTrackingModal(order) {
  if (!order) return;
  activeOrderId = order.id;
  const el = document.getElementById("tracking-modal");
  if (!el) return;
  el.classList.remove("hidden");
  el.classList.add("flex");
  updateTrackingFromOrder(order);
}

export function closeTrackingModal() {
  const el = document.getElementById("tracking-modal");
  if (!el) return;
  el.classList.add("hidden");
  el.classList.remove("flex");
  activeOrderId = null;
}

export function updateTrackingFromOrder(order) {
  if (!order) return;
  // se não há modal aberto não atualiza
  const el = document.getElementById("tracking-modal");
  if (!el || el.classList.contains("hidden")) return;
  if (activeOrderId && order.id !== activeOrderId) return;

  const info = STATUS_TEXT[order.status] || { text: order.status, icon: "fa-circle" };
  const txt = document.getElementById("tracking-status-text");
  const ic = document.getElementById("tracking-status-icon");
  if (txt) txt.textContent = info.text;
  if (ic) ic.className = `fa-solid ${info.icon} ${order.status === "in_transit" ? "fa-bounce" : ""} text-accent mr-2`;

  document.getElementById("tracking-driver-name").textContent =
    order.driverName || "Aguardando motorista";
  document.getElementById("tracking-order-id").textContent = `#${order.id.slice(-4).toUpperCase()}`;
  document.getElementById("track-origem").textContent = order.origin || "—";
  document.getElementById("track-destino").textContent = order.destination || "—";
}

export function getActiveTrackingId() {
  return activeOrderId;
}
