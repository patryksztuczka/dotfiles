import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const NO_RESULTS = "No search results found. Please try a different query.";

type Provider = "exa" | "parallel";

type WebSearchParams = {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
  provider?: Provider;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description:
      `Search the web using a minimal OpenCode-style MCP HTTP adapter backed by Exa or Parallel. The current year is ${new Date().getFullYear()}.`,
    parameters: Type.Object({
      query: Type.String({ description: "Web search query" }),
      numResults: Type.Optional(Type.Number({ description: "Number of results, default 8" })),
      livecrawl: Type.Optional(
        Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
          description: "Exa live crawl mode",
        }),
      ),
      type: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
          description: "Exa search type",
        }),
      ),
      contextMaxCharacters: Type.Optional(
        Type.Number({ description: "Maximum context characters for model-optimized result text" }),
      ),
      provider: Type.Optional(Type.Union([Type.Literal("exa"), Type.Literal("parallel")], {
        description: "Provider override. Defaults to PI_WEBSEARCH_PROVIDER or exa.",
      })),
    }),
    async execute(_toolCallId, params: WebSearchParams) {
      const provider = selectProvider(params.provider);
      const text = provider === "parallel" ? await searchParallel(params) : await searchExa(params);

      return {
        content: [{ type: "text", text: text ?? NO_RESULTS }],
        details: { provider },
      };
    },
  });

  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description: "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
      format: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
          description: "Output format. Defaults to markdown.",
        }),
      ),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds, default 30, maximum 120" })),
    }),
    async execute(_toolCallId, params: { url: string; format?: "markdown" | "text" | "html"; timeout?: number }) {
      const result = await fetchUrl(params.url, params.format ?? "markdown", params.timeout ?? 30);
      return {
        content: [{ type: "text", text: result.output }],
        details: { url: result.url, contentType: result.contentType, format: result.format },
      };
    },
  });
}

function selectProvider(override?: Provider): Provider {
  if (override) return override;
  const env = process.env.PI_WEBSEARCH_PROVIDER ?? process.env.OPENCODE_WEBSEARCH_PROVIDER;
  return env === "parallel" ? "parallel" : "exa";
}

function exaUrl() {
  if (!process.env.EXA_API_KEY) return EXA_URL;
  const url = new URL(EXA_URL);
  url.searchParams.set("exaApiKey", process.env.EXA_API_KEY);
  return url.toString();
}

async function searchExa(params: WebSearchParams) {
  return callMcp(exaUrl(), "web_search_exa", {
    query: params.query,
    type: params.type ?? "auto",
    numResults: params.numResults ?? 8,
    livecrawl: params.livecrawl ?? "fallback",
    contextMaxCharacters: params.contextMaxCharacters,
  });
}

async function searchParallel(params: WebSearchParams) {
  return callMcp(
    PARALLEL_URL,
    "web_search",
    {
      objective: params.query,
      search_queries: [params.query],
      session_id: "pi-websearch",
    },
    {
      "User-Agent": "pi-websearch-extension",
      ...(process.env.PARALLEL_API_KEY ? { Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` } : {}),
    },
  );
}

async function callMcp(url: string, tool: string, args: unknown, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${tool} failed: ${response.status} ${response.statusText}`);
    }

    return parseMcpResponse(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

function parseMcpResponse(body: string): string | undefined {
  const direct = parsePayload(body);
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const parsed = parsePayload(line.slice(6));
    if (parsed) return parsed;
  }

  return undefined;
}

function parsePayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === "[DONE]" || !trimmed.startsWith("{")) return undefined;

  const parsed = JSON.parse(trimmed) as {
    result?: { content?: Array<{ type?: string; text?: string }> };
  };
  return parsed.result?.content?.find((item) => item.text)?.text;
}

type WebFetchFormat = "markdown" | "text" | "html";

async function fetchUrl(urlText: string, format: WebFetchFormat, timeoutSeconds: number) {
  const url = new URL(urlText);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http:// or https://");
  }

  const timeout = Math.max(1, Math.min(timeoutSeconds, 120)) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        Accept: acceptHeader(format),
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);

    const contentType = response.headers.get("content-type") ?? "";
    const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!isTextualMime(mime)) throw new Error(`Unsupported fetched content type: ${mime || contentType}`);

    const body = await boundedText(response, 5 * 1024 * 1024);
    return {
      url: url.toString(),
      contentType,
      format,
      output: convertBody(body, contentType, format),
    };
  } finally {
    clearTimeout(timer);
  }
}

function acceptHeader(format: WebFetchFormat) {
  if (format === "markdown") return "text/markdown;q=1.0, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  if (format === "text") return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
}

function isTextualMime(mime: string) {
  return (
    !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  );
}

async function boundedText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) throw new Error(`Response too large (exceeds ${maxBytes} bytes)`);
    chunks.push(value);
  }

  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function convertBody(body: string, contentType: string, format: WebFetchFormat) {
  if (!contentType.toLowerCase().includes("text/html")) return body;
  if (format === "html") return body;
  if (format === "text") return htmlToText(body);
  return htmlToMarkdown(body);
}

function htmlToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function htmlToMarkdown(html: string) {
  const main = extractMainHtml(html);
  return decodeHtmlEntities(
    main
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/section>/gi, "\n")
      .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function extractMainHtml(html: string) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main) return main;
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (article) return article;
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  return body ?? html;
}

function decodeHtmlEntities(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    return named[entity.toLowerCase()] ?? _match;
  });
}
