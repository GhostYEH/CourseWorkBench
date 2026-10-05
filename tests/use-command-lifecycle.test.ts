import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommand } from '../apps/learning/lib/use-command';

// A deterministic hook host lets us exercise scope commits and delayed promises
// without introducing a DOM or a renderer dependency into the Node test suite.
const host = vi.hoisted(() => {
  type Cell = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
  let cells: Cell[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  const changed = (previous: unknown[] | undefined, next: unknown[]) =>
    !previous ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]));
  const memo = <T>(create: () => T, deps: unknown[]): T => {
    const index = cursor++;
    const cell = (cells[index] ??= {});
    if (changed(cell.deps, deps)) {
      cell.value = create();
      cell.deps = deps;
    }
    return cell.value as T;
  };
  return {
    reset() {
      cells = [];
      cursor = 0;
      effects = [];
    },
    render<T>(render: () => T): T {
      cursor = 0;
      const result = render();
      const queued = effects;
      effects = [];
      queued.forEach((effect) => effect());
      return result;
    },
    unmount() {
      cells.forEach((cell) => cell.cleanup?.());
    },
    useMemo: memo,
    useCallback<T>(callback: T, deps: unknown[]): T {
      return memo(() => callback, deps);
    },
    useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
      const index = cursor++;
      const cell = (cells[index] ??= { value: initial });
      return [
        cell.value as T,
        (value) => {
          cell.value =
            typeof value === 'function' ? (value as (previous: T) => T)(cell.value as T) : value;
        },
      ];
    },
    useLayoutEffect(create: () => () => void, deps: unknown[]) {
      const index = cursor++;
      const cell = (cells[index] ??= {});
      if (changed(cell.deps, deps)) {
        cell.deps = deps;
        effects.push(() => {
          cell.cleanup?.();
          cell.cleanup = create();
        });
      }
    },
  };
});
vi.mock('../apps/learning/node_modules/react/index.js', () => host);
vi.mock('../apps/learning/lib/client', () => ({
  describeApiError: (error: unknown) => String(error),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const render = (scope: string) => host.render(() => useCommand(scope));

describe('useCommand scope lifecycle', () => {
  beforeEach(() => host.reset());

  it('clears the old error and gives a new scope an independent synchronous lock', async () => {
    const old = render('project-a');
    old.setError('previous project failure');
    expect(render('project-a').error).toBe('previous project failure');
    const pending = deferred<string>();
    let oldSignal!: AbortSignal;
    const stale = old.run((context) => {
      oldSignal = context.signal;
      return pending.promise;
    });
    expect(render('project-a').busy).toBe(true);
    const current = render('project-b');
    expect(current.error).toBeNull();
    expect(current.busy).toBe(false);
    expect(oldSignal.aborted).toBe(true);
    expect(await current.run(async () => 'new scope')).toBe('new scope');
    pending.resolve('late old result');
    expect(await stale).toBeUndefined();
    expect(render('project-b').error).toBeNull();
  });

  it('does not let old completion clear the new scope busy state', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const old = render('project-a').run(() => first.promise);
    const current = render('project-b').run(() => second.promise);
    first.resolve('old');
    expect(await old).toBeUndefined();
    expect(render('project-b').busy).toBe(true);
    const duplicate = vi.fn(async () => 'duplicate');
    expect(await render('project-b').run(duplicate)).toBeUndefined();
    expect(duplicate).not.toHaveBeenCalled();
    second.resolve('current');
    expect(await current).toBe('current');
    expect(render('project-b').busy).toBe(false);
  });

  it('releases both the visible busy state and gate when completion throws', async () => {
    const command = render('project');
    await expect(
      command.run(async () => 'saved', {
        onFinish: () => {
          throw new Error('callback failure');
        },
      }),
    ).rejects.toThrow('callback failure');
    expect(render('project').busy).toBe(false);
    expect(await render('project').run(async () => 'next')).toBe('next');
  });

  it('aborts on unmount and suppresses late result callbacks', async () => {
    const pending = deferred<string>();
    const success = vi.fn();
    let signal!: AbortSignal;
    const command = render('project').run(
      (context) => {
        signal = context.signal;
        return pending.promise;
      },
      { onSuccess: success },
    );
    host.unmount();
    expect(signal.aborted).toBe(true);
    pending.resolve('late');
    expect(await command).toBeUndefined();
    expect(success).not.toHaveBeenCalled();
  });
});
