// claude-skills public surface.
// This plugin provides no contract services and exports no cross-plugin types.

// Plugin-internal config shape. Consumed only by config:store.register and
// the plugin's own setup; never crosses other plugin boundaries.
export interface ClaudeSkillsConfig {
  rescanIntervalMs: number;
}
