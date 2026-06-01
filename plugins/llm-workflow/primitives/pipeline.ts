// Pipeline: each item flows through stages independently — no barrier between stages.
// Stage signature: (prev, item, index) => Promise<any>. A stage that throws drops the
// item to null for the remainder of its chain.
export const PIPELINE_SRC = `
async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, index) => {
    let prev = item;
    for (const stage of stages) {
      try { prev = await stage(prev, item, index); }
      catch { return null; }
      if (prev === null) return null;
    }
    return prev;
  }));
}
`;
