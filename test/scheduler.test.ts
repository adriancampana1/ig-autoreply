import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../src/engine/scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startScheduler', () => {
  it('executa no início e a cada intervalo, sem sobrepor execuções lentas', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<void>((resolve) => {
        calls += 1;
        release = resolve;
      });
    const scheduler = startScheduler([{ name: 'slow', intervalMs: 1000, run: slow, runOnStart: true }], { error: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBe(1); // ainda rodando: não sobrepõe
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    release();
    await scheduler.stop();
  });

  it('registra erro e continua agendando', async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    let calls = 0;
    const scheduler = startScheduler(
      [{ name: 'boom', intervalMs: 500, run: () => { calls += 1; throw new Error('x'); } }],
      { error },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('stop() sinaliza a tarefa em andamento (AbortSignal) e espera ela terminar', async () => {
    let seen: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const scheduler = startScheduler(
      [{
        name: 'worker',
        intervalMs: 60_000,
        runOnStart: true,
        run: (signal) => {
          seen = signal;
          return new Promise<void>((resolve) => { release = resolve; });
        },
      }],
      { error: () => undefined },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    expect(seen?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
