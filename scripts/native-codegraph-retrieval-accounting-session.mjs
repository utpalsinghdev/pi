import { fauxAssistantMessage, fauxToolCall } from "../packages/ai/src/providers/faux.ts";

export function measureAdapterInputs(requests) {
 const serialized = requests.map((request) => JSON.stringify(request.messages));
 return {
  requestBytes: serialized.map((input) => Buffer.byteLength(input, "utf8")),
  requestCharacters: serialized.map((input) => input.length),
 };
}

/** Capture normalized provider-adapter inputs while AgentSession drives scripted tool calls. */
export async function captureSessionTranscript(harness, prompt, calls) {
 const requests = [];
 let requestIndex = 0;
 const responses = calls.map((call, index) => (context, options, state, model) => {
  requests.push({
   index: requestIndex++,
   model: { provider: model.provider, id: model.id, api: model.api },
   options: options ? { sessionId: options.sessionId, cacheRetention: options.cacheRetention } : null,
   messages: structuredClone(context.messages),
  });
  return fauxAssistantMessage(fauxToolCall(call.name, call.arguments, { id: `accounting-${index}` }), { stopReason: "toolUse" });
 });
 responses.push((context, options, state, model) => {
  requests.push({
   index: requestIndex++,
   model: { provider: model.provider, id: model.id, api: model.api },
   options: options ? { sessionId: options.sessionId, cacheRetention: options.cacheRetention } : null,
   messages: structuredClone(context.messages),
  });
  return fauxAssistantMessage("offline scripted completion");
 });
 harness.setResponses(responses);
 await harness.session.prompt(prompt);
 return { requests, transcript: structuredClone(harness.session.messages) };
}
