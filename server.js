import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();
app.use(express.json());

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const PORT = process.env.PORT || 8080;

function requireToken() {
  if (!X_BEARER_TOKEN) {
    throw new Error("Missing X_BEARER_TOKEN environment variable");
  }
}

function cleanQuery(query) {
  return query
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 450);
}

function buildNewsQuery({
                          topic,
                          language = "es",
                          onlyLinks = true,
                          excludeRetweets = true
                        }) {
  const parts = [];

  parts.push(`(${topic})`);

  if (language && language !== "any") {
    parts.push(`lang:${language}`);
  }

  if (excludeRetweets) {
    parts.push("-is:retweet");
  }

  if (onlyLinks) {
    parts.push("has:links");
  }

  return cleanQuery(parts.join(" "));
}

async function xRecentSearch(query, maxResults = 10) {
  requireToken();

  const url = new URL("https://api.x.com/2/tweets/search/recent");

  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.min(Math.max(maxResults, 10), 100)));
  url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics,lang,entities");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,verified,public_metrics");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  const users = new Map((data.includes?.users || []).map((u) => [u.id, u]));

  return (data.data || []).map((tweet) => {
    const user = users.get(tweet.author_id) || {};

    return {
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at,
      author: user.username ? `@${user.username}` : tweet.author_id,
      author_name: user.name || "",
      url: `https://x.com/${user.username || "i"}/status/${tweet.id}`,
      metrics: tweet.public_metrics || {},
      links: tweet.entities?.urls?.map((u) => u.expanded_url || u.url) || []
    };
  });
}

function formatTweets(tweets) {
  if (!tweets.length) {
    return "No se encontraron posts recientes para esa búsqueda.";
  }

  return tweets
      .map((t, i) => {
        const likes = t.metrics.like_count ?? 0;
        const reposts = t.metrics.retweet_count ?? 0;
        const replies = t.metrics.reply_count ?? 0;
        const links = t.links.length ? `\nLinks: ${t.links.join(", ")}` : "";

        return `${i + 1}. ${t.author} ${t.author_name ? `(${t.author_name})` : ""}
Fecha: ${t.created_at}
Engagement: ${likes} likes, ${reposts} reposts, ${replies} replies
URL: ${t.url}
Texto: ${t.text}${links}`;
      })
      .join("\n\n---\n\n");
}

function createMcpServer() {
  const server = new McpServer({
    name: "x-news-mcp",
    version: "1.0.0"
  });

  server.tool(
      "search_x_news",
      "Busca posts recientes en X/Twitter sobre un tema, optimizado para extraer noticias con enlaces.",
      {
        topic: z.string().min(2).describe("Tema a buscar. Ejemplo: Cuba, Miami, inteligencia artificial, elecciones"),
        language: z.enum(["es", "en", "any"]).default("es").describe("Idioma de los posts"),
        max_results: z.number().int().min(10).max(100).default(10),
        only_links: z.boolean().default(true).describe("Prioriza posts con links, útil para noticias"),
        exclude_retweets: z.boolean().default(true)
      },
      async ({ topic, language, max_results, only_links, exclude_retweets }) => {
        try {
          const query = buildNewsQuery({
            topic,
            language,
            onlyLinks: only_links,
            excludeRetweets: exclude_retweets
          });

          const tweets = await xRecentSearch(query, max_results);

          return {
            content: [
              {
                type: "text",
                text: `Query usada: ${query}\n\n${formatTweets(tweets)}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error consultando X: ${error.message}`
              }
            ]
          };
        }
      }
  );

  server.tool(
      "breaking_x_news",
      "Busca posibles noticias de última hora en X/Twitter usando términos como breaking, última hora y developing.",
      {
        topic: z.string().min(2).describe("Tema de la noticia. Ejemplo: Cuba, Miami, Trump, AI"),
        language: z.enum(["es", "en", "any"]).default("es"),
        max_results: z.number().int().min(10).max(100).default(10)
      },
      async ({ topic, language, max_results }) => {
        try {
          const breakingTerms =
              language === "en"
                  ? '("breaking" OR "developing" OR "just in")'
                  : '("última hora" OR "urgente" OR "breaking" OR "en desarrollo")';

          const lang = language === "any" ? "" : ` lang:${language}`;

          const query = cleanQuery(
              `(${topic}) ${breakingTerms}${lang} -is:retweet`
          );

          const tweets = await xRecentSearch(query, max_results);

          return {
            content: [
              {
                type: "text",
                text: `Query usada: ${query}\n\n${formatTweets(tweets)}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error consultando X: ${error.message}`
              }
            ]
          };
        }
      }
  );

  server.tool(
      "x_news_from_accounts",
      "Extrae posts recientes de cuentas específicas de X/Twitter, útil para medios o periodistas.",
      {
        accounts: z.array(z.string().min(1)).min(1).max(10).describe("Cuentas sin @. Ejemplo: [cnnee, elnuevoherald]"),
        keyword: z.string().optional().describe("Palabra clave opcional para filtrar"),
        max_results: z.number().int().min(10).max(100).default(10)
      },
      async ({ accounts, keyword, max_results }) => {
        try {
          const fromClause = accounts
              .map((a) => `from:${a.replace("@", "")}`)
              .join(" OR ");

          const keywordClause = keyword ? ` (${keyword})` : "";

          const query = cleanQuery(
              `(${fromClause})${keywordClause} -is:retweet`
          );

          const tweets = await xRecentSearch(query, max_results);

          return {
            content: [
              {
                type: "text",
                text: `Query usada: ${query}\n\n${formatTweets(tweets)}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error consultando X: ${error.message}`
              }
            ]
          };
        }
      }
  );

  return server;
}

app.get("/", (req, res) => {
  res.json({
    name: "x-news-mcp",
    status: "running",
    mcp_endpoint: "/sse",
    tools: ["search_x_news", "breaking_x_news", "x_news_from_accounts"]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    has_x_token: Boolean(X_BEARER_TOKEN)
  });
});

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();

  res.on("close", async () => {
    try {
      await server.close();
    } catch (error) {
      console.error("Error closing MCP server:", error);
    }
  });

  try {
    await server.connect(transport);
  } catch (error) {
    console.error("Error connecting MCP server:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "Error connecting MCP server"
      });
    }
  }
});

app.post("/messages", async (req, res) => {
  res.status(202).end();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`X News MCP running on 0.0.0.0:${PORT}`);
});