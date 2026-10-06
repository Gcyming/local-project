export type Disposer = () => void | Promise<void>;

export interface DisposeFailure {
  index: number;
  error: unknown;
}

export interface DisposeReport {
  ok: number;
  failed: DisposeFailure[];
}

export class ContributionScope {
  private disposers: Disposer[] = [];
  private isDisposed = false;

  get size(): number {
    return this.disposers.length;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  track(d: Disposer): void {
    if (this.isDisposed) {
      throw new Error("ContributionScope 已撤销，不再接受新的撤销函数");
    }
    this.disposers.push(d);
  }

  async disposeAll(): Promise<DisposeReport> {
    if (this.isDisposed) {
      return { ok: 0, failed: [] };
    }
    this.isDisposed = true;
    const pending = this.disposers;
    this.disposers = [];
    const failed: DisposeFailure[] = [];
    let ok = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      const index = i;
      try {
        await pending[index]();
        ok++;
      } catch (error) {
        failed.push({ index, error });
      }
    }
    failed.sort((a, b) => a.index - b.index);
    return { ok, failed };
  }
}