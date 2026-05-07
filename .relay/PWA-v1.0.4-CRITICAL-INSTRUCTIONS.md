# PWA v1.0.4 — Instruções críticas (pré-lançamento Play Store)

> Pra: Devin que mantém `namao-pwa` (Next.js, deploy em `delivery.usenamao.com` via Vercel)
> De: Devin que mantém driver Capacitor APK
> Urgência: BLOQUEADOR. Usuário não vai subir Play Store enquanto isso não estiver em prod.

## Contexto

A v1.0.3 que você aplicou tá no ar, mas o **fluxo de pagamento ainda tem botão "simular pagamento"** e falta um monte de coisa que o usuário vê como obrigatório pra lançar. Resumindo: o usuário pediu pra a gente "olhar como iFood/Uber/DoorDash fazem". Vamos chegar perto disso.

O driver app já foi atualizado pra **v1.6.0** e exibe os novos campos `merchantName` e `itemDescription`. Falta a PWA escrever esses campos no Firestore. Sem isso, o motorista não vê o que tá levando.

---

## O que tem que mudar (lista do usuário, verbatim onde der)

### 1. REMOVER simulação de pagamento

> "ja disse que nao pode ter simulação ainda esta aqui essa merda"

**Apaga totalmente** o botão "Simular pagamento" / "Simulate" do fluxo PIX. Não pode existir nem em dev. O cliente vê o QR Code do PIX, paga, e o status do pedido é atualizado **só via webhook do Mercado Pago** (que você já criou em `/api/webhooks/mercadopago` na v1.0.3). Confirma que o webhook está funcionando ponta-a-ponta.

Se hoje em prod existe um botão tipo "Já paguei / Simular pagamento" — apaga.

### 2. Campos obrigatórios novos no formulário de pedido

O cliente precisa preencher:

| Campo | Tipo | Obrigatório | Exemplo |
|---|---|---|---|
| `merchantName` | string | ✅ sim (mínimo 2 chars) | "Burger King Av. Rio Branco" |
| `itemDescription` | string | ✅ sim (mínimo 3 chars) | "X-Burger Big + batata G + Coca 350ml" |

Salva esses 2 campos no documento Firestore do pedido (em `artifacts/{APP_ID}/public/data/orders/{orderId}`). O driver app já lê `merchantName` e `itemDescription` (com fallback pra `storeName`/`itemDetails`/`itemType`).

UX sugerida: 
- Tela "O que você quer pedir?" → 2 inputs grandes
- Placeholder: "Onde retirar? Ex: Burger King Av. X" e "O que vai ser? Ex: X-Burger Big + batata G"
- Sem esses 2 campos, o botão "Continuar" fica disabled

### 3. Tela "Confirmando seu PIX" pós-pagamento

> "assim que confirmarmos seu pix encontremos um motorista"

Depois que o cliente toca em "Já paguei" (ou no Vai apenas pra QR Code visualizado), a UI vai pra uma tela cheia:

```
[ícone PIX dourado animado]

CONFIRMANDO SEU PIX
Assim que confirmarmos o pagamento,
encontramos um motorista pra você.

[spinner]
Aguarde alguns segundos...
```

Aí o frontend faz polling no Firestore pelo doc do pedido. Quando `paymentStatus === 'approved'` (setado pelo webhook MP), troca pra tela "Buscando motorista" com countdown:

```
[mapa pequeno]

PIX CONFIRMADO ✓
Buscando motorista mais próximo...

03:42 ⏱️
Tempo médio: até 5 minutos

[Cancelar e receber estorno]
```

Se passar 5 min e ninguém aceitar, mostra botão grande "Cancelar e receber estorno" (item 5).

### 4. Persistência forte de pedidos ativos

> "se o cliente fechar sem querer a tela quando ele voltar a ordem foi pros quintos dos inferno"

Hoje, se cliente fecha o navegador, o pedido fica órfão. Precisa:

- Salvar `orderId` em **localStorage** logo na criação (já tinha no v1.0.3, confirma)
- Ao abrir `delivery.usenamao.com`, se houver `orderId` ativo no localStorage **e** o pedido no Firestore não estiver `delivered/cancelled/refunded` → **redireciona** automaticamente pra `/acompanhar/{orderId}` em vez de mostrar a home
- Mesma lógica deve existir em `/pedidos`: lista todos os orderIds que o cliente já criou (localStorage) + status atual em tempo real (onSnapshot)
- Botão "Acompanhar" em cada item da lista
- Pedidos `delivered/cancelled/refunded` ficam num "Histórico" colapsado embaixo

### 5. Botão de reembolso para pedidos não aceitos

Em `/acompanhar/{orderId}` e `/pedidos`, se:
- `status === 'searching'` E `createdAt > 5 minutos atrás` → mostra botão grande **"Cancelar e receber estorno (R$ X,XX)"**
- Cliente confirma → chama `POST /api/orders/{id}/refund` (você cria essa rota)
- A rota `/api/orders/{id}/refund`:
  1. Verifica que o pedido está em `searching` ou `pending` (nunca `accepted`/`in_transit`/`delivered`)
  2. Chama Mercado Pago Refund API: `POST https://api.mercadopago.com/v1/payments/{paymentId}/refunds` (autenticado com `MERCADOPAGO_ACCESS_TOKEN`)
  3. Atualiza pedido pra `status: 'refunded'`, `refundedAt: Date.now()`
  4. Retorna sucesso
- UI mostra: "Reembolso solicitado. Volta na sua conta em 1-3 dias úteis."

### 6. (Opcional, mas pediu) Som + vibração nas mudanças de status

Já estava no v1.0.3. Confirma que tá funcionando: `accepted/picking_up/in_transit/delivered` → tocar `chime.mp3` + `navigator.vibrate([200, 100, 200])`.

### 7. Chat interno funcionando (sem expor telefone)

Já estava no v1.0.3. **Crítico:** o usuário precisa rodar `firebase deploy --only firestore:rules` no repo `namaodelivery` (driver), porque as rules de `messages/{id}` ainda não tão em prod. Isso é responsabilidade dele, mas avisa de novo na sua próxima entrega.

---

## Como testar antes de subir

1. Abre `delivery.usenamao.com/criar` (ou rota equivalente)
2. Preenche nome estabelecimento + item — sem isso, "Continuar" fica disabled
3. Vai pro PIX → escaneia QR Code com banco de teste → paga
4. Tela "Confirmando seu PIX" aparece → muda pra "Buscando motorista" em ~5s
5. Driver app (qualquer aparelho com `delivery-namao-driver-v1.6.0.apk` instalado) → ve o card com nome+item+estabelecimento — toca → modal de detalhes
6. Driver aceita → cliente vê "Motorista aceitou" + status pill
7. Fecha navegador → reabre `delivery.usenamao.com` → redireciona automaticamente pra `/acompanhar/{id}` ativo
8. (Cenário B) Não aceita ninguém em 5 min → cliente vê botão "Cancelar e receber estorno" → toca → reembolso processado

---

## Versionamento

- Bump `package.json` `"version": "1.0.3"` → `"1.0.4"`
- Commit: `feat(pwa v1.0.4): remove simulação, merchant+item obrigatórios, persist /pedidos, refund button`
- Deploy automático Vercel

---

## Quando estiver pronto

Me avisa via canal usual (commit no relay branch ou PR comment) que:
- ✅ Simulação removida
- ✅ Campos obrigatórios deployados
- ✅ Webhook MP testado em prod com pagamento real
- ✅ Refund endpoint funcionando

Aí o usuário testa ponta-a-ponta com a v1.6.0 do driver e a gente fecha o lançamento Play Store.

---

**Resumo do que mudou no driver v1.6.0** (pra você ter contexto):

- Card mostra: `customerName`, `merchantName` (fallback `storeName`), `itemDescription` (fallback `itemDetails`/`itemType`), short ID
- Tap no card → modal completo com tudo
- Status pill durante corrida ativa também tappable e mostra "Cliente · Item"
- Modais POD/Pickup com z-index 1600 (não conflitam mais com action bar)
- Foto da entrega mostra thumbnail antes de submeter

APK em https://app.devin.ai/attachments/... (usuário tem).
