const MESSAGES = [
  "thinking…",
  "consulting the oracle…",
  "brewing tokens…",
  "kneading bytes…",
  "pondering the orb…",
  "shuffling electrons…",
];
export function pickBusyMessage(): string {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)]!;
}
