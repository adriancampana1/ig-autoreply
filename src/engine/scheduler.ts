export interface ScheduledTask {
  name: string;
  intervalMs: number;
  /** `signal` é abortado por stop(): tarefas longas devem parar de pegar trabalho novo. */
  run: (signal: AbortSignal) => Promise<unknown> | unknown;
  /** Executa logo ao iniciar, além de a cada intervalo. */
  runOnStart?: boolean;
}

export interface Health {
  lastWorkerTickAt: number | null;
}

/** Timers simples sem sobreposição: se uma execução ainda está rodando, a próxima é pulada. */
export function startScheduler(
  tasks: ScheduledTask[],
  log: { error: (obj: object, msg: string) => void },
): { stop: () => Promise<void> } {
  const running = new Map<string, Promise<void>>();
  const timers: NodeJS.Timeout[] = [];
  const stopping = new AbortController();

  const trigger = (task: ScheduledTask) => {
    if (running.has(task.name) || stopping.signal.aborted) return;
    // Promise.resolve().then(): a tarefa só começa depois do `set`, mesmo se lançar erro de forma síncrona.
    const execution = Promise.resolve()
      .then(() => task.run(stopping.signal))
      .then(
        () => undefined,
        (error: unknown) => log.error({ task: task.name, err: error }, 'tarefa agendada falhou'),
      )
      .finally(() => running.delete(task.name));
    running.set(task.name, execution);
  };

  for (const task of tasks) {
    if (task.runOnStart) trigger(task);
    timers.push(setInterval(() => trigger(task), task.intervalMs));
  }

  return {
    async stop() {
      timers.forEach(clearInterval);
      stopping.abort();
      await Promise.all(running.values());
    },
  };
}
