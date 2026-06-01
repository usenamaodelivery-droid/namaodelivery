# Delivery NaMão

App nativo do entregador construído com **Capacitor 8** + **Firebase** (Auth, Firestore, Storage, Cloud Functions). Empacotado como APK Android. O cliente usa a PWA `delivery.usenamao.com` e o app **Pedir NaMão**.

## Arquitetura

```
src/             # Web assets (Capacitor webDir)
  index.html     # Shell da aplicação (Tailwind via CDN, Leaflet, FontAwesome)
  css/styles.css
  icons/         # Ícone do app (placeholder em namao-icon.png)
  js/
    app.js              # Entrypoint (renderização + bindings DOM)
    auth.js             # Firebase Auth wrapper
    firebaseInit.js     # initializeApp(), getFirestore(), getStorage()
    firebaseConfig.js   # ⚠️ COLAR AQUI o config do projeto Firebase
    orders.js           # CRUD de pedidos (transações para evitar dupla aceitação e dupla contagem da carteira)
    pod.js              # Prova de Entrega (foto + assinatura → Storage)
    driverProfile.js    # Perfil do motorista (com listener de banimento)
    geolocation.js      # Background Geolocation (Capacitor) com fallback web
    admin.js            # Operações de admin (confirmar PIX, banir motorista)
    maps.js             # Leaflet (mapa cliente/motorista)
    ui.js               # switchView, toasts

android/         # Plataforma nativa (gerada por `npx cap add android`)
  app/
    src/main/AndroidManifest.xml   # Permissões: Internet, GPS fg+bg, Câmera, Notification
    build.gradle                    # Lê keystore.properties para assinatura release

firebase/
  firestore.rules        # Regras endurecidas (admin via custom claim)
  storage.rules          # Apenas motorista responsável escreve em /pod/{orderId}
  firestore.indexes.json

functions/
  index.js               # Callable: setAdminClaim (promove UID a admin)
  package.json

scripts/
  set-admin.js           # Bootstrap local do primeiro admin (usa Service Account)

firebase.json
capacitor.config.json
package.json
```

## Regras de negócio implementadas

| Regra | Onde |
|---|---|
| Pedido criado em `waiting_confirmation` (PIX manual) | <code>src/js/orders.js → createOrder</code> |
| Admin libera PIX (`pending`) | <code>src/js/admin.js → confirmPix</code> + rules |
| POD obrigatório (foto + assinatura → Storage) | <code>src/js/pod.js → confirmDeliveryWithPOD</code> |
| Carteira persistente 85% via transação atômica | <code>src/js/orders.js → completeOrder</code> |
| Status `blocked`/`suspended` em tempo real | <code>src/js/app.js → applyDriverProfile</code> |
| Background geolocation a cada 15s | <code>src/js/geolocation.js</code> |
| Admin via custom claim (não senha hardcoded) | <code>functions/index.js → setAdminClaim</code> + rules |

## Setup local

### 1. Cole o `firebaseConfig`
Edite <code>src/js/firebaseConfig.js</code> com o objeto do console Firebase.

### 2. Instale dependências
```bash
npm install
```

### 3. Build & sync para Android
```bash
npx cap sync android
```

### 4. Build APK debug (sem keystore)
```bash
cd android && ./gradlew assembleDebug
# saída: android/app/build/outputs/apk/debug/app-debug.apk
```

### 5. Build APK release (assinado)
1. Coloque o arquivo `.jks` em `android/app/namao-release.jks`
2. Crie `android/keystore.properties` com:
   ```
   storeFile=app/namao-release.jks
   storePassword=...
   keyAlias=namao
   keyPassword=...
   ```
3. Build:
   ```bash
   cd android && ./gradlew assembleRelease
   # saída: android/app/build/outputs/apk/release/app-release.apk
   ```

> O arquivo `keystore.properties` e os `.jks` estão no `.gitignore` — **nunca** comite.

## Deploy do backend Firebase

### Pré-requisitos
```bash
npm install -g firebase-tools
firebase login
firebase use namao-delivery-prod
```

### Aplicar Firestore + Storage rules e indexes
```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
```

### Deploy Cloud Functions (callable `setAdminClaim`)
```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```

## Bootstrap do primeiro admin

A `setAdminClaim` exige caller já-admin. Para criar o **primeiro** admin, use o script local com Service Account:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/service-account.json
cd functions && npm install   # baixa firebase-admin
node ../scripts/set-admin.js <UID_DO_ADMIN>
```

Após isso, o admin pode promover outros via `setAdminClaim` callable (ou a função aceita o e-mail listado em `ADMIN_BOOTSTRAP_EMAIL` como bypass — útil em produção).

## Pontos a validar (TODO produção)

- [ ] Substituir `namao-icon.png` placeholder por ícone real 512x512 + adaptive icon
- [ ] Definir `PIX_KEY` real em `firebaseConfig.js`
- [ ] Definir `SUPPORT_WHATSAPP` real em `firebaseConfig.js`
- [ ] Configurar `ADMIN_BOOTSTRAP_EMAIL` na Cloud Function (`firebase functions:config:set` ou env)
- [ ] Habilitar plano Blaze para Storage (ou trocar para base64 inline)
- [ ] Testar fluxo end-to-end no dispositivo real (cliente cria pedido → admin confirma PIX → motorista aceita → POD → carteira credita)
