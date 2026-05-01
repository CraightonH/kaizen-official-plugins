export const BUSY_MESSAGES: readonly string[] = Object.freeze([
  "thinking…",
  "consulting the oracle…",
  "brewing tokens…",
  "kneading bytes…",
  "pondering the orb…",
  "shuffling electrons…",
]);

export function pickBusyMessage(): string {
  return BUSY_MESSAGES[Math.floor(Math.random() * BUSY_MESSAGES.length)]!;
}
