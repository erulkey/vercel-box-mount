export function reviewClient(env: NodeJS.ProcessEnv) {
  const gatewayKey = env.AI_GATEWAY_API_KEY?.trim();
  if (gatewayKey) return { provider: "AI Gateway", key: gatewayKey, baseURL: "https://ai-gateway.vercel.sh/v1", model: env.AI_GATEWAY_MODEL?.trim() || "openai/gpt-5.5" };
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) return { provider: "OpenAI", key: openaiKey, baseURL: "https://api.openai.com/v1", model: env.OPENAI_MODEL?.trim() || "gpt-5.5" };
  return undefined;
}

export function assertReviewProvider(output: string, expected: string): void {
  const events = output.split("\n").flatMap((line) => {
    try { return [JSON.parse(line) as { stage?: string; provider?: string }]; } catch { return []; }
  });
  if (!events.some((event) => event.stage === "review-synchronized" && event.provider === expected)) {
    throw new Error(`Missing synchronized review from expected provider: ${expected}`);
  }
}
