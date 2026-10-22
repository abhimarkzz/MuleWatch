const MAX_BULLET_CHARS = 400;

export const SYSTEM_PROMPT =
  "You are a senior financial fraud analyst. Read the supplied transaction-network JSON. Summarize the flow of funds in exactly 3 concise bullet points. Explicitly state whether fan-out (one sender, many receivers) or layering (rapid multi-hop transfers) is observed. Base claims only on the supplied data; distinguish observed evidence from uncertainty, never invent facts, and never state that fraud is proven. " +
  "The graph covers a 24-hour window: each onward transfer is strictly later than, and less than 24 hours after, the flagged transfer; times are PaySim steps of one simulated hour. " +
  "Reply with exactly 3 lines, each starting with '- ', and nothing else.";

/** Exactly three bullet lines, or null if the model ignored the format. */
export function parseBullets(content: unknown): string[] | null {
  if (typeof content !== "string") return null;
  const bullets = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^([-*•]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^([-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  if (bullets.length !== 3) return null;
  return bullets.map((b) => (b.length > MAX_BULLET_CHARS ? `${b.slice(0, MAX_BULLET_CHARS - 1)}…` : b));
}
