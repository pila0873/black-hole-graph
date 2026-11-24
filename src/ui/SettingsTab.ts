import { App, PluginSettingTab, Setting } from 'obsidian';
import type BlackHoleGraphPlugin from '../main';
import { PluginSettings } from '../types';

export class BlackHoleSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: BlackHoleGraphPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Black hole graph' });

    /* ---------------- Rendering ---------------- */

    containerEl.createEl('h3', { text: 'Rendering' });

    new Setting(containerEl)
      .setName('Quality')
      .setDesc('Cinematic traces real light geodesics. Fast is a cheaper approximation for weak GPUs.')
      .addDropdown((dd) =>
        dd
          .addOption('cinematic', 'Cinematic')
          .addOption('fast', 'Fast')
          .setValue(this.plugin.settings.quality)
          .onChange(async (value) => {
            this.plugin.settings.quality = value === 'fast' ? 'fast' : 'cinematic';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Resolution scale')
      .setDesc('Render the black hole at a lower or higher resolution. Above 1 supersamples (sharper, slower).')
      .addSlider((sl) =>
        sl
          .setLimits(0.5, 1.5, 0.05)
          .setValue(this.plugin.settings.renderScale)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.renderScale = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Anti-aliasing')
      .setDesc('FXAA on the final image. Turn off only if you want the raw pixels.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.antiAliasing).onChange(async (v) => {
          this.plugin.settings.antiAliasing = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Frame rate cap')
      .addDropdown((dd) =>
        dd
          .addOption('30', '30 fps')
          .addOption('60', '60 fps')
          .setValue(String(this.plugin.settings.maxFps))
          .onChange(async (v) => {
            this.plugin.settings.maxFps = Number(v) === 30 ? 30 : 60;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Lensing')
      .setDesc('Bend the star field around the black hole.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.lensing).onChange(async (v) => {
          this.plugin.settings.lensing = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Star field')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showStars).onChange(async (v) => {
          this.plugin.settings.showStars = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Bloom')
      .addSlider((sl) =>
        sl
          .setLimits(0, 1.5, 0.05)
          .setValue(this.plugin.settings.bloom)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.bloom = v;
            await this.plugin.saveSettings();
          }),
      );

    /* ---------------- Accretion disk ---------------- */

    containerEl.createEl('h3', { text: 'Accretion disk' });

    new Setting(containerEl)
      .setName('Disk temperature')
      .setDesc('Peak temperature at the inner edge, Kelvin.')
      .addSlider((sl) =>
        sl
          .setLimits(4000, 20000, 500)
          .setValue(this.plugin.settings.diskTemperature)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.diskTemperature = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Disk brightness')
      .addSlider((sl) =>
        sl
          .setLimits(0, 2, 0.05)
          .setValue(this.plugin.settings.diskBrightness)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.diskBrightness = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Disk thickness')
      .setDesc('Vertical extent of the accretion disk. Above 1 it reads clearly from the side.')
      .addSlider((sl) =>
        sl
          .setLimits(0.3, 2.5, 0.05)
          .setValue(this.plugin.settings.diskThickness)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.diskThickness = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Galaxies')
      .setDesc('ASCII galaxies scattered on the black backdrop.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showGalaxies).onChange(async (v) => {
          this.plugin.settings.showGalaxies = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Planet labels')
      .setDesc('Folder names above the planets in the system view.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showPlanetLabels).onChange(async (v) => {
          this.plugin.settings.showPlanetLabels = v;
          await this.plugin.saveSettings();
        }),
      );

    /* ---------------- Camera and notes ---------------- */

    containerEl.createEl('h3', { text: 'Camera and notes' });

    new Setting(containerEl)
      .setName('Camera inclination')
      .setDesc('Viewing angle above the disk plane, degrees.')
      .addSlider((sl) =>
        sl
          .setLimits(-60, 60, 1)
          .setValue(this.plugin.settings.cameraInclination)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.cameraInclination = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Orbit speed')
      .addSlider((sl) =>
        sl
          .setLimits(0, 3, 0.05)
          .setValue(this.plugin.settings.orbitSpeed)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.orbitSpeed = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Show links')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showEdges).onChange(async (v) => {
          this.plugin.settings.showEdges = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Link opacity')
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.edgeOpacity)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.edgeOpacity = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Show titles')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showTitles).onChange(async (v) => {
          this.plugin.settings.showTitles = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Maximum notes')
      .setDesc('Notes are ranked by link degree; the most connected ones are kept.')
      .addSlider((sl) =>
        sl
          .setLimits(20, 500, 10)
          .setValue(this.plugin.settings.maxNotes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxNotes = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Only linked notes')
      .setDesc('Hide notes that have no incoming or outgoing links.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.onlyLinked).onChange(async (v) => {
          this.plugin.settings.onlyLinked = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('One path prefix per line, e.g. Templates/')
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.excludedFolders.join('\n')).onChange(async (v) => {
          this.plugin.settings.excludedFolders = v
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.addClass('bh-textarea');
      });

    new Setting(containerEl)
      .setName('Dim when window is unfocused')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.dimOnBlur).onChange(async (v) => {
          this.plugin.settings.dimOnBlur = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  getSetting(_key: keyof PluginSettings): unknown {
    return this.plugin.settings[_key];
  }
}
