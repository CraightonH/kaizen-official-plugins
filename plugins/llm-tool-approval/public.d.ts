// Plugin-internal config shape. Consumed only by config:store.register and
// the plugin's own setup; never crosses other plugin boundaries.
export interface ToolApprovalConfig {
  allow: string[];
  deny: string[];
}
