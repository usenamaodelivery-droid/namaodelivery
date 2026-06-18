// Regras de repasse — fonte única da verdade pra "quanto cada um recebe".
//
// Modelo:
//   - Lojista recebe o produto menos a comissão (0% se ativo no NaMão social,
//     15% se só no NaMão Delivery), cobrada no Pedir NaMão.
//   - Motorista recebe 85% do FRETE (nunca do produto).
//   - NaMão fica com 15% do frete + a comissão do produto (0% ou 15%).
//
// O ponto crítico: pedido de loja (Pedir NaMão) tem `deliveryPriceCents`
// (frete) separado do subtotal dos produtos. O motorista só ganha sobre o
// frete. Pedido ponto-a-ponto não tem produto, então `price` já é o frete.
import { DRIVER_SHARE, PLATFORM_FEE } from "./firebaseConfig.js";

export function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/** Valor do FRETE (entrega) do pedido, em reais. */
export function orderFreteBRL(o) {
  if (o && o.deliveryPriceCents != null) return Number(o.deliveryPriceCents) / 100;
  return Number((o && o.price) || 0);
}

/** Subtotal dos produtos do pedido, em reais (0 em ponto-a-ponto). */
export function orderProdutosBRL(o) {
  if (o && o.itemsTotalCents != null) return Number(o.itemsTotalCents) / 100;
  return 0;
}

/** Quanto o motorista ganha: 85% do frete. */
export function driverEarningBRL(o) {
  return round2(orderFreteBRL(o) * DRIVER_SHARE);
}

/** Margem da NaMão sobre o frete: 15%. */
export function freteFeeBRL(o) {
  return round2(orderFreteBRL(o) * PLATFORM_FEE);
}

/** Comissão da NaMão sobre o produto (já calculada no pedido, ou 15% fallback). */
export function produtoCommissionBRL(o) {
  if (o && o.commissionCents != null) return Number(o.commissionCents) / 100;
  return round2(orderProdutosBRL(o) * 0.15);
}

/** Receita total da NaMão no pedido: margem do frete + comissão do produto. */
export function namaoRevenueBRL(o) {
  return round2(freteFeeBRL(o) + produtoCommissionBRL(o));
}
