// Injectable clock so scheduling/queue logic is deterministic under test.
// Production uses realClock; tests pass a fake that returns a fixed/advanceable time.
export const realClock = { now: () => new Date() };

export function fakeClock(startMs) {
  let t = startMs;
  return {
    now: () => new Date(t),
    set: (ms) => { t = ms; },
    advance: (ms) => { t += ms; },
  };
}
