import { PanelView } from './components/PanelView.js';
import { SettingsView } from './components/SettingsView.js';

export function register(env: {
  React: unknown;
  registerComponents: (pluginName: string, components: Record<string, unknown>) => void;
}): void {
  (globalThis as Record<string, unknown>).React = env.React;
  env.registerComponents('rally', {
    PanelView,
    SettingsView,
    RallySettings: SettingsView,
  });
}
