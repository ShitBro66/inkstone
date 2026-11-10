import { expect, it, vi } from 'vitest';
import { scheduleUpload } from './upload-queue';

it('shares concurrency across batches and lets waiting images be cancelled', async () => {
    let release: () => void;
    const first = scheduleUpload('queue-test', 1, new AbortController().signal, () => new Promise<void>((resolve) => { release = resolve; }));
    const cancel = new AbortController();
    const skipped = vi.fn(async () => {});
    const second = scheduleUpload('queue-test', 1, cancel.signal, skipped);
    const third = vi.fn(async () => {});
    const last = scheduleUpload('queue-test', 1, new AbortController().signal, third);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(third).not.toHaveBeenCalled();
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    cancel.abort();
    await rejected;
    release!();
    await Promise.all([first, last]);
    expect(skipped).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledOnce();
})

it('starts two tasks in parallel when configured to two', async () => {
    const finish: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    const jobs = [1, 2, 3].map(() => scheduleUpload('parallel-test', 2, new AbortController().signal, run));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    finish[0]();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    finish[1](); finish[2]();
    await Promise.all(jobs);
})
