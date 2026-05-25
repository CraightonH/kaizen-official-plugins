// Plugin-internal config shape. Consumed only by config:store.register and
// the plugin's own setup; never crosses other plugin boundaries.

export interface CostRateEntry {
  promptCentsPerMTok: number;
  completionCentsPerMTok: number;
}

export interface LlmStatusItemsConfig {
  /**
   * Per-model cost rates. Replaces the legacy
   * ~/.kaizen/plugins/llm-status-items/cost-table.json file. Empty object
   * (the default) disables the cost-estimate status item entirely —
   * matching the "no rate file" behavior in older versions.
   */
  costRates: Record<string, CostRateEntry>;

  /**
   * Number of decimal places used to render the running cost estimate.
   * `4` keeps the existing `$0.0123` format.
   */
  costDecimalPlaces: number;

  /**
   * Width in cells of the context-window fill bar (the `[████░░░░░░]`
   * segment). `10` = current behavior.
   */
  contextBarWidth: number;

  /** Glyph used for the filled portion of the context bar. */
  contextBarFillGlyph: string;

  /** Glyph used for the empty portion of the context bar. */
  contextBarEmptyGlyph: string;

  /**
   * Tokens-per-second threshold at or above which tok/s is rendered with
   * zero decimals; below it, one decimal. `10` = current behavior.
   */
  tokensPerSecIntegerThreshold: number;

  /**
   * When true (default), register `/status:show` against `slash:registry`
   * if that service is present at `harness:start`.
   */
  slashCommandEnabled: boolean;

  /**
   * When true (default), register the `status:show` tool against
   * `tools:registry` if that service is present at `harness:start`.
   */
  toolEnabled: boolean;
}
