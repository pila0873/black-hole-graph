import { Plugin, WorkspaceLeaf } from 'obsidian';
import { BlackHoleView, VIEW_TYPE_BLACK_HOLE } from './view/BlackHoleView';
import { BlackHoleSettingTab } from './ui/SettingsTab';
import { DEFAULT_SETTINGS, PluginSettings } from './types';

export default class BlackHoleGraphPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_BLACK_HOLE, (leaf: WorkspaceLeaf) => new BlackHoleView(leaf, this));

    this.addRibbonIcon('orbit', 'Black hole graph', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-black-hole-graph',
      name: 'Open black hole graph',
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: 'reset-black-hole-camera',
      name: 'Reset camera',
      checkCallback: (checking) => {
        const view = this.getView();
        if (!view) return false;
        if (!checking) view.resetCamera();
        return true;
      },
    });

    this.addSettingTab(new BlackHoleSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void this.activateView(false);
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BLACK_HOLE);
  }

  getView(): BlackHoleView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BLACK_HOLE);
    if (!leaves.length) return null;
    const view = leaves[0].view;
    return view instanceof BlackHoleView ? view : null;
  }

  async activateView(reveal = true): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_BLACK_HOLE)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_BLACK_HOLE, active: true });
    }

    if (reveal) {
      await workspace.revealLeaf(leaf);
    }
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BLACK_HOLE)) {
      const view = leaf.view;
      if (view instanceof BlackHoleView) {
        view.applySettings();
      }
    }
  }
}
