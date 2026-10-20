/**
 * Collects stage durations for the `Server-Timing` response header, which
 * browser dev tools display per request. Only names and milliseconds are
 * emitted — never request data.
 */
export function createTimer() {
  const entries: Array<[string, number]> = [];

  return {
    async measure<T>(name: string, work: () => PromiseLike<T>): Promise<T> {
      const started = performance.now();
      try {
        return await work();
      } finally {
        entries.push([name, performance.now() - started]);
      }
    },
    header(): string {
      return entries.map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(", ");
    },
  };
}
