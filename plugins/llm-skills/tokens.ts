export function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4);
}
