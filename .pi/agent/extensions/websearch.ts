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
