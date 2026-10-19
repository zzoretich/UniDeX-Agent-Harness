// Obsidian's Events and Component: an event emitter whose `on` returns a ref, and the load/unload lifecycle that
// runs every registered cleanup. The HUD leans on both for its 38 vault listeners and its timers.

export interface EventRef {
  e: Events;
  name: string;
  fn: (...data: unknown[]) => unknown;
  ctx?: unknown;
}

export class Events {
  private _handlers = new Map<string, EventRef[]>();

  on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef {
    const ref: EventRef = { e: this, name, fn: callback, ctx };
    const list = this._handlers.get(name) ?? [];
    list.push(ref);
    this._handlers.set(name, list);
    return ref;
  }

  off(name: string, callback: (...data: any[]) => any): void {
    const list = this._handlers.get(name);
    if (list) this._handlers.set(name, list.filter((r) => r.fn !== callback));
  }

  offref(ref: EventRef): void {
    const list = this._handlers.get(ref.name);
    if (list) this._handlers.set(ref.name, list.filter((r) => r !== ref));
  }

  trigger(name: string, ...data: unknown[]): void {
    for (const ref of [...(this._handlers.get(name) ?? [])]) this.tryTrigger(ref, data);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    try { ref.fn.apply(ref.ctx, args); }
    catch (err) { console.error(`[compat] handler for "${ref.name}" threw`, err); }
  }
}

export class Component {
  private _loaded = false;
  private _children: Component[] = [];
  private _cleanups: Array<() => void> = [];

  /** Returns onload's result, so a host can await an async onload the way Obsidian awaits a plugin's. */
  load(): void | Promise<void> {
    if (this._loaded) return;
    this._loaded = true;
    const result = this.onload();
    for (const c of this._children) void c.load();
    return result;
  }

  onload(): void | Promise<void> {}

  unload(): void {
    if (!this._loaded) return;
    this._loaded = false;
    for (const c of this._children.splice(0)) c.unload();
    for (const fn of this._cleanups.splice(0).reverse()) {
      try { fn(); } catch (err) { console.error("[compat] cleanup threw", err); }
    }
    void this.onunload();
  }

  onunload(): void | Promise<void> {}

  addChild<T extends Component>(c: T): T {
    this._children.push(c);
    if (this._loaded) c.load();
    return c;
  }

  removeChild<T extends Component>(c: T): T {
    this._children = this._children.filter((x) => x !== c);
    c.unload();
    return c;
  }

  register(cb: () => void): void { this._cleanups.push(cb); }

  registerEvent(ref: EventRef): void { this.register(() => ref.e.offref(ref)); }

  registerDomEvent(el: EventTarget, type: string, cb: (ev: any) => any, options?: boolean | AddEventListenerOptions): void {
    el.addEventListener(type, cb, options);
    this.register(() => el.removeEventListener(type, cb, options));
  }

  registerInterval(id: number): number {
    this.register(() => window.clearInterval(id));
    return id;
  }
}
