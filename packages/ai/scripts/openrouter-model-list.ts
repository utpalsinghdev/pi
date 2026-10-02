import type { OpenRouterModelListItem } from "./openrouter-catalog.ts";

const RETRY_DELAYS_MS = [250, 500] as const;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

type FetchOptions = {
	fetcher?: typeof fetch;
	wait?: (milliseconds: number) => Promise<void>;
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Retry transient OpenRouter list failures while preserving strict failure after bounded attempts. */
export async function fetchOpenRouterModelList(
	query: string,
	options: FetchOptions = {},
): Promise<OpenRouterModelListItem[]> {
	const fetcher = options.fetcher ?? fetch;
	const delay = options.wait ?? wait;
	const url = `https://openrouter.ai/api/v1/models${query}`;
	let lastError: unknown;

	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
		let response: Response;
		try {
			response = await fetcher(url);
		} catch (error) {
			lastError = error;
			if (attempt === RETRY_DELAYS_MS.length) break;
			await delay(RETRY_DELAYS_MS[attempt]!);
			continue;
		}

		if (!response.ok) {
			const error = new Error(`OpenRouter API returned ${response.status}`);
			if (!RETRYABLE_STATUS_CODES.has(response.status)) throw error;
			lastError = error;
		} else {
			try {
				const data = (await response.json()) as { data?: OpenRouterModelListItem[] };
				return data.data ?? [];
			} catch (error) {
				lastError = error;
			}
		}

		if (attempt === RETRY_DELAYS_MS.length) break;
		await delay(RETRY_DELAYS_MS[attempt]!);
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "OpenRouter request failed"));
}
