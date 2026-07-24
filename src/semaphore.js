// Minimal async counting semaphore — bounds concurrency without unbounded
// Promise.all. `run(fn)` waits for a free slot, runs fn, releases on settle.
export function createSemaphore(max) {
  let active = 0;
  const waiters = [];
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        const attempt = () => {
          active++;
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(release);
        };
        if (active < max) attempt();
        else waiters.push(attempt);
      });
    },
    stats: () => ({ active, waiting: waiters.length }),
  };
}
