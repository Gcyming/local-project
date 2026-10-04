


























export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return (): Promise<T> => {
    if (inflight) {
      return inflight;
    }
    const p = run();
    inflight = p;
    
    
    
    
    p.catch(() => { inflight = null; });
    return p;
  };
}
