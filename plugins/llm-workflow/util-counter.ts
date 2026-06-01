export function counter() {
  let n = 0;
  return { next: () => ++n, peek: () => n };
}
