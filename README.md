# X News MCP

Servidor MCP simple para conectar ChatGPT Agent con X/Twitter y extraer noticias recientes.

## Tools incluidas

- `search_x_news`: busca posts recientes por tema.
- `breaking_x_news`: busca posibles noticias de última hora.
- `x_news_from_accounts`: extrae posts recientes de cuentas específicas.

## Importante

La conexión del MCP en ChatGPT puede ir **sin auth**.
Pero X/Twitter sí exige un Bearer Token de la X API v2 para leer posts.
Ese token se guarda como variable de entorno en tu servidor, no en ChatGPT.

## Ejecutar local

```bash
npm install
export X_BEARER_TOKEN="TU_BEARER_TOKEN_DE_X"
npm start
```

Servidor local:

```text
http://localhost:3000
```

Endpoint MCP:

```text
http://localhost:3000/sse
```

Para ChatGPT necesitas una URL pública HTTPS, por ejemplo:

```text
https://tu-app.onrender.com/sse
```

## Configuración en ChatGPT Agent

- Name: X News MCP
- Server URL: `https://tu-dominio.com/sse`
- Authentication: `No auth`

## Variables de entorno

```text
X_BEARER_TOKEN=tu_token_de_x
PORT=3000
```

## Deploy rápido en Render

1. Sube este proyecto a GitHub.
2. En Render crea un Web Service.
3. Build command: `npm install`
4. Start command: `npm start`
5. Agrega la variable `X_BEARER_TOKEN`.
6. Usa la URL pública con `/sse` en ChatGPT Agent.
