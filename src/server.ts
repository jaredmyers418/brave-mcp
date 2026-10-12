/**
 * Paste this whole file over src/server.ts in Cloudflare's mcp-worker template.
 * Required Worker secret: BRAVE_API_KEY (saved once in Cloudflare).
 * Optional Worker setting: ENABLED_TOOLS (defaults to all).
 * Values: all | none | comma-separated web,local,images,videos,news,places,llm,summarizer
 * Full tool names are accepted too. No client authentication is required.
 *
 * A custom Brave API adapter, not a redistribution of Brave's official MCP package.
 * Uses the template's existing Agents SDK / MCP SDK v2 dependencies.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type BraveEnv = { BRAVE_API_KEY?: string; ENABLED_TOOLS?: string };
type Params = Record<string, unknown>;
type Shape = Record<string, z.ZodType>;
type Definition = { alias: string; name: string; description: string; schema: Shape; path: string };

const query = z.string().trim().min(1).max(400)
  .refine((s) => s.split(/\s+/).length <= 50, "Maximum 50 words")
  .describe("Search query; at most 400 characters and 50 words.");
const freshness = z.string().regex(/^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/)
  .describe("pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.").optional();
const goggles = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe("One or more Brave Goggle URLs or definitions.").optional();
const filter = z.union([z.string(), z.array(z.string())]).optional();
const safe = z.enum(["off", "moderate", "strict"]).optional();
const shared = {
  query,
  country: z.string().min(2).max(3).describe("Country code, for example US or AR; ALL is also accepted.").optional(),
  search_lang: z.string().min(2).max(12).describe("Search language, for example en or es.").optional(),
  spellcheck: z.boolean().optional(),
};
const ui = { ui_lang: z.string().min(2).max(20).optional() };
const paging = { offset: z.number().int().min(0).max(9).optional() };
const locHeaders = {
  "x-loc-lat": z.number().min(-90).max(90).optional(),
  "x-loc-long": z.number().min(-180).max(180).optional(),
  "x-loc-city": z.string().optional(),
  "x-loc-state": z.string().max(3).optional(),
  "x-loc-state-name": z.string().optional(),
  "x-loc-country": z.string().length(2).optional(),
  "x-loc-postal-code": z.string().optional(),
};
const requestHeaders = {
  "api-version": z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  "cache-control": z.literal("no-cache").optional(),
  "user-agent": z.string().optional(),
  accept: z.enum(["application/json", "*/*"]).optional(),
};
const webSchema = {
  ...shared, ...ui, ...paging, ...locHeaders, ...requestHeaders,
  count: z.number().int().min(1).max(20).optional(),
  safesearch: safe, freshness,
  text_decorations: z.boolean().optional(),
  result_filter: filter.describe("Result types such as web,news,locations; comma-separated or an array."),
  goggles,
  units: z.enum(["metric", "imperial"]).optional(),
  extra_snippets: z.boolean().optional(),
  summary: z.boolean().describe("Request summarizer.key for brave_summarizer; requires Brave endpoint access.").optional(),
};

const definitions: Definition[] = [
  {
    alias: "web", name: "brave_web_search", path: "/res/v1/web/search", schema: webSchema,
    description: "Search the web with Brave. Returns URLs, titles, descriptions, and available rich results. Supports country, language, freshness, pagination, extra snippets, and Goggles. Set summary=true to request the key required by brave_summarizer. Cite returned source URLs.",
  },
  {
    alias: "local", name: "brave_local_search", path: "/res/v1/web/search", schema: webSchema,
    description: "Search for local businesses and places. Retrieves location results and available AI-generated location descriptions. Falls back to web results when no locations are returned. Local enrichments depend on Brave account access and may use an additional API request. Cite returned URLs.",
  },
  {
    alias: "images", name: "brave_image_search", path: "/res/v1/images/search",
    schema: {
      ...shared,
      count: z.number().int().min(1).max(200).optional(),
      safesearch: z.enum(["off", "strict"]).optional(),
    },
    description: "Search images with Brave. Returns image URLs, source pages, thumbnails, and available image metadata. Does not download image bytes.",
  },
  {
    alias: "videos", name: "brave_video_search", path: "/res/v1/videos/search",
    schema: { ...shared, ...ui, ...paging, count: z.number().int().min(1).max(50).optional(), safesearch: safe, freshness },
    description: "Search videos with Brave, with optional language, country, freshness, and pagination. Returns source links, thumbnails, descriptions, and available video metadata.",
  },
  {
    alias: "news", name: "brave_news_search", path: "/res/v1/news/search",
    schema: {
      ...shared, ...ui, ...paging,
      count: z.number().int().min(1).max(50).optional(),
      safesearch: safe, freshness, goggles,
      text_decorations: z.boolean().optional(), extra_snippets: z.boolean().optional(),
    },
    description: "Search news with Brave. Supports freshness, country, language, pagination, and optional extra snippets. Cite original article URLs and distinguish publication dates from event dates.",
  },
  {
    alias: "places", name: "brave_place_search", path: "/res/v1/local/place_search",
    schema: {
      ...shared, ...ui, ...requestHeaders,
      query: query.optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      location: z.string().min(1).describe("Named area, for example Mendoza Argentina.").optional(),
      radius: z.number().positive().describe("Distance preference in meters, not a strict cutoff.").optional(),
      count: z.number().int().min(1).max(50).optional(),
      units: z.enum(["metric", "imperial"]).optional(),
      safesearch: safe,
      geoloc: z.string().optional(),
    },
    description: "Find points of interest, cities, addresses, and streets using Brave Place Search. Supply a query, a named location, or latitude and longitude. Omitting the query explores an area. Returns whatever place and geographic result types Brave provides.",
  },
  {
    alias: "llm", name: "brave_llm_context", path: "/res/v1/llm/context",
    schema: {
      ...shared, ...locHeaders, ...requestHeaders,
      count: z.number().int().min(1).max(50).optional(),
      maximum_number_of_urls: z.number().int().min(1).max(50).optional(),
      maximum_number_of_tokens: z.number().int().min(1024).max(32768).optional(),
      maximum_number_of_snippets: z.number().int().min(1).max(256).optional(),
      context_threshold_mode: z.enum(["disabled", "strict", "lenient", "balanced"]).optional(),
      maximum_number_of_tokens_per_url: z.number().int().min(512).max(8192).optional(),
      maximum_number_of_snippets_per_url: z.number().int().min(1).max(100).optional(),
      freshness, goggles,
      enable_local: z.boolean().optional(),
      enable_source_metadata: z.boolean().optional(),
    },
    description: "Retrieve relevance-ranked, pre-extracted web text, code, tables, and other grounding content using Brave LLM Context. This is not an AI-generated answer. Cite URLs in the returned sources map. The Worker maps query to the API's required q parameter.",
  },
  {
    alias: "summarizer", name: "brave_summarizer", path: "/res/v1/summarizer/search",
    schema: {
      key: z.string().min(1).describe("summarizer.key returned by brave_web_search with summary=true."),
      entity_info: z.boolean().optional(),
      inline_references: z.boolean().optional(),
    },
    description: "Retrieve Brave's generated summary using summarizer.key from a prior web search with summary=true. Access depends on Brave's legacy Summarizer entitlement. A listed tool does not grant API access. Includes bounded polling when the summary is still being generated.",
  },
];

const headerNames = new Set([...Object.keys(locHeaders), ...Object.keys(requestHeaders)]);

function selectedDefinitions(setting?: string): Definition[] {
  const value = (setting ?? "all").trim().toLowerCase();
  if (value === "all" || value === "*") return definitions;
  if (value === "none" || value === "") return [];
  const selected = new Set(value.split(/[\s,;]+/).filter(Boolean));
  const valid = new Set(definitions.flatMap((d) => [d.alias, d.name]));
  const invalid = [...selected].filter((name) => !valid.has(name));
  if (invalid.length) throw new Error(`Unknown ENABLED_TOOLS: ${invalid.join(", ")}. Use all, none, or web,local,images,videos,news,places,llm,summarizer.`);
  return definitions.filter((d) => selected.has(d.alias) || selected.has(d.name));
}

function apiRequest(path: string, params: Params, apiKey: string): { url: URL; headers: Headers } {
  const url = new URL(path, "https://api.search.brave.com");
  const headers = new Headers({ Accept: "application/json", "X-Subscription-Token": apiKey });
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (headerNames.has(name)) { headers.set(name, String(value)); continue; }
    // Brave's API uses q, including LLM Context and Place Search.
    const apiName = name === "query" ? "q" : name;
    // Avoid the known legacy Summarizer/result_filter interaction.
    if (name === "result_filter" && params.summary === true && path === "/res/v1/web/search") continue;
    if (Array.isArray(value)) {
      if (name === "ids" || name === "goggles") {
        for (const item of value) url.searchParams.append(apiName, String(item));
      } else {
        url.searchParams.set(apiName, value.join(","));
      }
    } else {
      url.searchParams.set(apiName, String(value));
    }
  }
  return { url, headers };
}

async function callBrave(path: string, params: Params, env: BraveEnv): Promise<Params> {
  const key = env.BRAVE_API_KEY?.trim();
  if (!key) throw new Error("Add BRAVE_API_KEY under this Worker's Settings > Variables and Secrets, then Deploy.");
  const { url, headers } = apiRequest(path, params, key);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  if (!response.ok) {
    const detail = body.split(key).join("[REDACTED]").slice(0,8000);
    throw new Error(`Brave HTTP ${response.status}: ${detail || response.statusText}`);
  }
  if (!body) throw new Error(`Brave returned an empty response (HTTP ${response.status}).`);
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Params;
  } catch {
    throw new Error("Brave returned an unexpected non-object JSON response.");
  }
}

async function localSearch(params: Params, env: BraveEnv): Promise<Params> {
  const result = await callBrave("/res/v1/web/search", { ...params, summary: false, result_filter: ["web", "locations"] }, env);
  const locations = result.locations as { results?: { id?: string }[] } | undefined;
  const ids = [...new Set((locations?.results ?? []).map((p) => p.id).filter((id): id is string => typeof id === "string" && !!id))].slice(0,20);
  if (!ids.length) return { ...result, local_search_note: "No local locations were returned. Available web results are the fallback; local access depends on the Brave plan." };
  // As in Brave's own local tool, enrich the returned location records with descriptions.
  try {
    const descriptions = await callBrave("/res/v1/local/descriptions", { ids }, env);
    return { ...result, local_descriptions: descriptions };
  } catch (error) {
    return { ...result, local_enrichment_error: error instanceof Error ? error.message : String(error) };
  }
}

async function summarizer(params: Params, env: BraveEnv): Promise<Params> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await callBrave("/res/v1/summarizer/search", params, env);
    if (result.status === "complete") return result;
    if (result.status === "failed" || result.status === "error") throw new Error(`Brave summary failed: ${JSON.stringify(result)}`);
    if (result.summary && !result.status) return result;
  }
  throw new Error("Brave summary is not ready after five polls. Retry later with the same summarizer key.");
}

function createServer(env: BraveEnv) {
  const server = new McpServer({ name: "Brave Cloudflare", version: "1.0.0" });
  for (const tool of selectedDefinitions(env.ENABLED_TOOLS)) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (arguments_) => {
      try {
        const params = arguments_ as Params;
        if (tool.alias === "places") {
          const hasCoords = typeof params.latitude === "number" && typeof params.longitude === "number";
          if (!params.query && !params.location && !hasCoords) throw new Error("Place Search needs query, location, or both latitude and longitude.");
          if ((params.latitude === undefined) !== (params.longitude === undefined)) throw new Error("Supply latitude and longitude together.");
        }
        const data = tool.alias === "local" ? await localSearch(params, env)
          : tool.alias === "summarizer" ? await summarizer(params, env)
          : await callBrave(tool.path, params, env);
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
  }
  return server;
}

export default {
  fetch(request, env, ctx) {
    // No OAuth, access token, password, or proxy is required by this endpoint.
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<BraveEnv>;
