import type { TrayMenuItem } from './types.js';

/**
 * Manages the system tray icon and its context menu.
 * Pure data model — UI layer in Tauri would call Tauri's tray APIs.
 */
export class TrayController {
  private items: TrayMenuItem[] = [];
  private tooltip = 'Ghita Agent';

  /**
   * Set the tooltip shown on hover.
   */
  setTooltip(text: string): void {
    this.tooltip = text;
  }

  /**
   * Get the current tooltip.
   */
  getTooltip(): string {
    return this.tooltip;
  }

  /**
   * Replace the entire menu.
   */
  setMenu(items: TrayMenuItem[]): void {
    this.items = this.validateTree(items);
  }

  /**
   * Add a single item to the root menu.
   */
  addItem(item: TrayMenuItem): void {
    this.items.push(this.validateItem(item));
  }

  /**
   * Remove an item by id.
   */
  removeItem(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id && !i.submenu?.some((s) => s.id === id));
    return this.items.length !== before;
  }

  /**
   * Get the menu (validated).
   */
  getMenu(): TrayMenuItem[] {
    return this.items.map((i) => ({ ...i, submenu: i.submenu ? [...i.submenu] : undefined }));
  }

  /**
   * Find an item by id (recursive).
   */
  findItem(id: string): TrayMenuItem | undefined {
    const walk = (items: TrayMenuItem[]): TrayMenuItem | undefined => {
      for (const i of items) {
        if (i.id === id) return i;
        if (i.submenu) {
          const f = walk(i.submenu);
          if (f) return f;
        }
      }
      return undefined;
    };
    return walk(this.items);
  }

  private validateTree(items: TrayMenuItem[]): TrayMenuItem[] {
    return items.map((i) => this.validateItem(i));
  }

  private validateItem(i: TrayMenuItem): TrayMenuItem {
    if (!i.id) throw new Error('TrayMenuItem.id is required');
    if (!i.label) throw new Error(`TrayMenuItem(${i.id}).label is required`);
    return { ...i, submenu: i.submenu ? this.validateTree(i.submenu) : undefined };
  }
}
