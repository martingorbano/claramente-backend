# Claramente — Backend

Proxy entre el frontend de Claramente y la API de Anthropic.

## Deploy en Railway

1. Subí esta carpeta a un repo de GitHub
2. En Railway: New Project → Deploy from GitHub repo
3. En Variables de entorno agregá:
   - `ANTHROPIC_API_KEY` → tu API key de Anthropic (console.anthropic.com)
4. Railway te da una URL pública tipo `claramente-backend.up.railway.app`
5. Pegá esa URL en el frontend (reemplazá BACKEND_URL en claramente.html)

## Endpoints

GET  /       → health check
POST /chat   → { messages: [...] } → { content: [...] }

## Local

npm install
cp .env.example .env   # completá con tu API key
node index.js
