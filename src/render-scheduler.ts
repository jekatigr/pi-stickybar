export interface RenderScheduler {
  schedule(delayMs?: number): void;
  cancel(): void;
}

export function createRenderScheduler(render: () => void, defaultDelayMs: number): RenderScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule(delayMs = defaultDelayMs) {
      if (timer) {
        // An explicit immediate render must not be held behind a throttled
        // context update that was queued while the model was streaming.
        if (delayMs !== 0) return;
        clearTimeout(timer);
        timer = null;
      }

      timer = setTimeout(() => {
        timer = null;
        render();
      }, delayMs);
    },
    cancel() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}
