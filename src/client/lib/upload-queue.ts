interface UploadJob {
  signal: AbortSignal;
  start: () => void;
  cancel: () => void;
}
interface UploadQueue {
  active: number;
  limit: number;
  jobs: UploadJob[];
}
const queues = new Map<string, UploadQueue>();

function drain(queue: UploadQueue): void {
  while (queue.active < queue.limit && queue.jobs.length) {
    const job = queue.jobs.shift()!;
    job.signal.removeEventListener('abort', job.cancel);
    queue.active++;
    job.start();
  }
}

export function scheduleUpload<T>(userId: string, limit: number, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  let queue = queues.get(userId);
  if (!queue) {
    queue = { active: 0, limit, jobs: [] };
    queues.set(userId, queue);
  }
  queue.limit = limit;
  const current = queue;
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const job: UploadJob = {
      signal,
      start: () => {
        void Promise.resolve().then(() => { signal.throwIfAborted(); return run(); })
          .then(resolve, reject).finally(() => { current.active--; drain(current); });
      },
      cancel: () => {
        const index = current.jobs.indexOf(job);
        if (index >= 0) current.jobs.splice(index, 1);
        reject(signal.reason);
      },
    };
    current.jobs.push(job);
    signal.addEventListener('abort', job.cancel, { once: true });
    drain(current);
  });
}
