/**
 * Phrases for the post-turn duration line (e.g. "✻ Cooked for 29s"). Each
 * verb evokes time-passing or completion so the message reads naturally
 * regardless of how long the turn took. Picked at random per turn — same
 * pattern as `busy-messages.ts`.
 */
export const DONE_MESSAGES: readonly string[] = Object.freeze([
  "Cooked",
  "Simmered",
  "Brewed",
  "Steeped",
  "Pondered",
  "Mulled",
  "Marinated",
  "Ruminated",
  "Cogitated",
  "Stewed",
  "Percolated",
  "Reflected",
  "Deliberated",
  "Whisked",
  "Distilled",
  "Crunched",
  "Synthesized",
  "Plotted",
  "Cooked up wisdom for",
  "Wove thoughts for",
]);

export function pickDoneMessage(): string {
  return DONE_MESSAGES[Math.floor(Math.random() * DONE_MESSAGES.length)]!;
}
