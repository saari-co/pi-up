/**
 * WebFetch Tool Extension
 *
 * Registers a `web_fetch` custom tool for fetching URL content.
 * Features:
 * - Auto-upgrades http:// to https://
 * - Strips HTML tags for readable text extraction
 * - 15-minute in-memory cache
 * - 50KB output truncation
 * - 30-second timeout
 * - Suggests `gh` CLI for GitHub URLs
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const MAX_OUTPUT_BYTES = 50 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 30_000;

interface CacheEntry {
	text: string;
	timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function pruneCache() {
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (now - entry.timestamp > CACHE_TTL_MS) {
			cache.delete(key);
		}
	}
}

function stripHtml(html: string): string {
	let text = html;
	// Remove script and style blocks entirely
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	// Remove all remaining tags
	text = text.replace(/<[^>]+>/g, " ");
	// Decode common HTML entities
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	// Collapse whitespace
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(text);
	if (encoded.length <= maxBytes) {
		return { text, truncated: false };
	}
	// Decode back from truncated bytes to get valid string
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const truncatedText = decoder.decode(encoded.slice(0, maxBytes));
	return { text: truncatedText, truncated: true };
}

function isGitHubUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.hostname === "github.com" || u.hostname === "api.github.com";
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		description:
			"Fetch content from a URL. Returns extracted text for HTML pages. Use for reading web pages, API responses, or documentation. For GitHub repos/issues/PRs, prefer the `gh` CLI instead.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch" }),
			extract: Type.Optional(
				Type.Union([Type.Literal("full"), Type.Literal("summary")], {
					description: "Extraction mode: 'full' returns all text, 'summary' returns first ~2000 chars. Default: 'full'",
				}),
			),
		}),

		async execute(args) {
			const extractMode = args.extract ?? "full";
			let url = args.url;

			// Auto-upgrade http to https
			if (url.startsWith("http://")) {
				url = "https://" + url.slice(7);
			}

			// Validate URL
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return {
					content: [{ type: "text", text: `Invalid URL: ${args.url}` }],
					isError: true,
				};
			}

			// Suggest gh CLI for GitHub URLs
			if (isGitHubUrl(url)) {
				const ghHint =
					"\n\nNote: For GitHub repos, issues, and PRs, the `gh` CLI is more reliable. " +
					"Try `gh repo view`, `gh issue view`, or `gh pr view` instead.";

				// Still fetch, but append the hint
				const result = await doFetch(url, extractMode);
				if (result.content[0]?.type === "text") {
					result.content[0].text += ghHint;
				}
				return result;
			}

			return doFetch(url, extractMode);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			const displayUrl = args.url.length > 80 ? args.url.slice(0, 77) + "..." : args.url;
			text += theme.fg("accent", displayUrl);
			if (args.extract === "summary") {
				text += " " + theme.fg("dim", "(summary)");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const first = result.content[0];
			const raw = first?.type === "text" ? first.text : "";

			if (result.isError) {
				return new Text(theme.fg("error", "✗ ") + raw, 0, 0);
			}

			if (!expanded) {
				const preview = raw.slice(0, 200).replace(/\n/g, " ");
				const suffix = raw.length > 200 ? "..." : "";
				return new Text(theme.fg("success", "✓ ") + theme.fg("dim", preview + suffix), 0, 0);
			}

			return new Text(theme.fg("success", "✓ ") + raw, 0, 0);
		},
	});
}

async function doFetch(
	url: string,
	extractMode: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	// Check cache
	pruneCache();
	const cacheKey = `${url}:${extractMode}`;
	const cached = cache.get(cacheKey);
	if (cached) {
		return { content: [{ type: "text", text: cached.text }] };
	}

	let response: Response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: {
				"User-Agent": "pi-coding-agent/1.0",
				Accept: "text/html, application/json, text/plain, */*",
			},
			redirect: "follow",
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("abort") || msg.includes("timeout") || msg.includes("TimeoutError")) {
			return { content: [{ type: "text", text: `Timeout after ${TIMEOUT_MS / 1000}s fetching ${url}` }], isError: true };
		}
		return { content: [{ type: "text", text: `Fetch error: ${msg}` }], isError: true };
	}

	if (!response.ok) {
		return {
			content: [{ type: "text", text: `HTTP ${response.status} ${response.statusText} for ${url}` }],
			isError: true,
		};
	}

	let body: string;
	try {
		body = await response.text();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { content: [{ type: "text", text: `Error reading response body: ${msg}` }], isError: true };
	}

	const contentType = response.headers.get("content-type") ?? "";
	let text: string;

	if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
		text = stripHtml(body);
	} else {
		text = body;
	}

	// Summary mode: first ~2000 chars
	if (extractMode === "summary") {
		text = text.slice(0, 2000);
		if (body.length > 2000) {
			text += "\n\n[... truncated to summary]";
		}
	}

	// Truncate to 50KB
	const { text: finalText, truncated } = truncate(text, MAX_OUTPUT_BYTES);
	const output = truncated ? finalText + "\n\n[... truncated to 50KB]" : finalText;

	// Cache the result
	cache.set(cacheKey, { text: output, timestamp: Date.now() });

	return { content: [{ type: "text", text: output }] };
}
