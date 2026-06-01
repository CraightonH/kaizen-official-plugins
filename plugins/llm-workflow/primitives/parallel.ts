// Source string evaluated inside the worker's bootstrap. Pure JS — no imports.
// Installed as the global `parallel`. Acquires the host-side semaphore implicitly
// via the per-thunk `agent()` calls inside each thunk.
export const PARALLEL_SRC = `
async function parallel(thunks) {
  const results = await Promise.all(thunks.map((t) => {
    try { return Promise.resolve(t()).catch(() => null); }
    catch { return Promise.resolve(null); }
  }));
  return results;
}
`;
