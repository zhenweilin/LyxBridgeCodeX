// Only adjacent, waiting operations with the same nonempty string key may be
// replaced. In-flight work and unkeyed operations are ordering barriers.
export function createNativeInputQueue() {
  const pending = [];
  let running = false;

  async function drain() {
    running = true;
    try {
      while (pending.length) {
        const task = pending.shift();
        try {
          const result = await task.operation(task.data);
          for (const waiter of task.waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of task.waiters) waiter.reject(error);
        }
      }
    } finally {running = false;}
  }

  function enqueue(operation, {coalesceKey,data,merge}={}) {
    if (typeof operation !== 'function')
      return Promise.reject(new TypeError('An input operation must be a function'));
    const key = typeof coalesceKey === 'string' && coalesceKey ? coalesceKey : undefined;
    const result = new Promise((resolve,reject)=>{
      const tail = pending.at(-1);
      const sameKey = key && tail?.key === key && tail.merge === merge;
      // A merger can decline (e.g. an accumulated wheel delta would overflow).
      // In that case keep both operations, preserving every input's distance.
      const combined = sameKey && merge ? merge(tail.data,data) : data;
      if (sameKey && (!merge || combined !== undefined)) {
        tail.operation = operation;
        tail.data = combined;
        tail.waiters.push({resolve,reject});
      } else pending.push({operation,key,data,merge,waiters:[{resolve,reject}]});
    });
    if (!running) void drain();
    return result;
  }

  return {enqueue};
}
