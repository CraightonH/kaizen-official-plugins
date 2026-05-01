export function newTurnId(): string {
  return `turn_${crypto.randomUUID()}`;
}

export function makeIdGen(seq: string[]): () => string {
  let i = 0;
  return () => {
    if (i >= seq.length) throw new Error("makeIdGen exhausted");
    return seq[i++]!;
  };
}
