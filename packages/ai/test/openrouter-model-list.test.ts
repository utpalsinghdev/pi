import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterModelList } from "../scripts/openrouter-model-list.ts";

const model = { id: "provider/model", name: "Model" };
const noWait = async (_milliseconds: number) => {};

describe("OpenRouter model-list requests", () => {
	it("retries a transient network failure and returns the response", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(Response.json({ data: [model] }));
		const wait = vi.fn(noWait);

		await expect(fetchOpenRouterModelList("", { fetcher, wait })).resolves.toEqual([model]);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(wait).toHaveBeenCalledWith(250);
	});

	it("retries throttling and server errors but not permanent client errors", async () => {
		const retryable = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(Response.json({ data: [model] }));
		const wait = vi.fn(noWait);
		await expect(fetchOpenRouterModelList("", { fetcher: retryable, wait })).resolves.toEqual([model]);
		expect(retryable).toHaveBeenCalledTimes(2);

		const permanent = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
		await expect(fetchOpenRouterModelList("", { fetcher: permanent, wait })).rejects.toThrow(
			"OpenRouter API returned 401",
		);
		expect(permanent).toHaveBeenCalledOnce();
	});

	it("fails after its bounded transient retries", async () => {
		const failure = new TypeError("fetch failed");
		const fetcher = vi.fn<typeof fetch>().mockRejectedValue(failure);
		const wait = vi.fn(noWait);

		await expect(fetchOpenRouterModelList("", { fetcher, wait })).rejects.toBe(failure);
		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 500]);
	});
});
