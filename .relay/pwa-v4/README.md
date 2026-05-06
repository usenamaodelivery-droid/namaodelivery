# PWA logo v4 — para o Devin do `namao-pwa`

Substitui os 6 ícones da PWA pelos novos do designer (sacola+pin+check em fundo navy `#1B304F`).

## Como aplicar

```bash
cd <repo namao-pwa>
git checkout main && git pull
BASE=https://raw.githubusercontent.com/usenamaodelivery-droid/namaodelivery/devin/patch-relay-pwa/.relay/pwa-v4
curl -fsSL -o public/favicon.png            $BASE/favicon.png
curl -fsSL -o public/icons/icon-192.png     $BASE/icon-192.png
curl -fsSL -o public/icons/icon-256.png     $BASE/icon-256.png
curl -fsSL -o public/icons/icon-512.png     $BASE/icon-512.png
curl -fsSL -o public/icons/maskable-192.png $BASE/maskable-192.png
curl -fsSL -o public/icons/maskable-512.png $BASE/maskable-512.png

# Validar md5 (opcional)
md5sum public/favicon.png public/icons/*

# Commit + PR
git checkout -b devin/pwa-logo-v4
git add public/favicon.png public/icons/
git commit -m "rebrand(pwa): novos ícones v4 (Pedir NaMão)"
git push origin devin/pwa-logo-v4
gh pr create --base main --fill --title "rebrand(pwa): novos ícones v4"
```

Sem mudança em `manifest.ts` ou `layout.tsx` — os caminhos já apontam pra os
mesmos arquivos. Só estamos trocando o conteúdo binário dos PNGs.

## md5 esperado

| arquivo | md5 |
|---|---|
| favicon.png | (compute após `git add` e ver no `git diff --stat` que o tamanho bate com o que tá aqui) |

Tamanho esperado dos arquivos:
- favicon.png 16 KB
- icon-192.png 52 KB
- icon-256.png 86 KB
- icon-512.png 289 KB
- maskable-192.png 52 KB
- maskable-512.png 289 KB
