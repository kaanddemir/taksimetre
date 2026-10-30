interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
}
export interface WakeLockApi {
  request(type: "screen"): Promise<Sentinel>;
}

/**
 * Keeps the screen on during a journey where the Screen Wake Lock API exists. Best effort only:
 * a rejected request is not retried until the next journey, and the browser releases the lock
 * whenever the page is hidden (re-requested on return). It does not enable background GPS.
 */
export class WakeLockManager {
  private sentinel: Sentinel | null = null;
  private wanted = false;
  private rejected = false;

  constructor(private readonly api: WakeLockApi | null, private readonly isHidden: () => boolean) {}

  get held(): boolean {
    return this.sentinel !== null;
  }

  /** Called when a journey starts or resumes. Clears a previous rejection. */
  async enable(): Promise<void> {
    this.wanted = true;
    this.rejected = false;
    await this.request();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s) await s.release().catch(() => undefined);
  }

  /** Call when the page becomes visible again. */
  async onVisible(): Promise<void> {
    if (this.wanted && !this.sentinel && !this.rejected) await this.request();
  }

  private async request(): Promise<void> {
    if (!this.api || this.sentinel || this.isHidden()) return;
    try {
      const s = await this.api.request("screen");
      if (!this.wanted) {
        await s.release().catch(() => undefined);
        return;
      }
      this.sentinel = s;
      s.addEventListener("release", () => {
        if (this.sentinel === s) this.sentinel = null;
      });
    } catch {
      this.rejected = true; // e.g. battery saver; do not keep retrying
    }
  }
}
