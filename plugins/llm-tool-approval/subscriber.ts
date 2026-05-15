import { CANCEL_TOOL } from "llm-events";
import type {
  ToolBeforeExecutePayload,
  UiPromptOptionsRequest,
  UiPromptService,
} from "llm-contracts/public";
import { deriveDomain, matchesAny } from "./matcher.ts";
import type { ConfigFile } from "./config.ts";

export interface SubscriberDeps {
  isPaused: () => boolean;
  rules: () => ConfigFile;
  summarize: (name: string, args: unknown) => string;
  prompt: Pick<UiPromptService, "requestOption" | "requestText">;
  persistAllow: (entry: string) => void;
  writeNotice: (text: string) => void;
  log: (msg: string) => void;
}

export type Subscriber = (payload: ToolBeforeExecutePayload) => Promise<void>;

const DENY_DEFAULT_REASON = "User denied this tool call.";
const DENY_BY_RULE_REASON = "Denied by allow/deny config rule.";

export function makeSubscriber(deps: SubscriberDeps): Subscriber {
  return async (payload) => {
    if (payload.args === CANCEL_TOOL) return;
    if (deps.isPaused()) return;

    const { allow, deny } = deps.rules();

    if (matchesAny(payload.name, deny)) {
      payload.args = CANCEL_TOOL;
      payload.cancelReason = DENY_BY_RULE_REASON;
      deps.writeNotice(`✗ approval gate: ${payload.name} denied by rule`);
      return;
    }
    if (matchesAny(payload.name, allow)) {
      return;
    }

    const domain = deriveDomain(payload.name);
    const options: UiPromptOptionsRequest["options"] = [
      { id: "approve-once", label: `Approve Once          (${payload.name})` },
      { id: "approve-always", label: `Approve Always        (${payload.name})` },
      ...(domain
        ? [{ id: "approve-domain-always", label: `Approve Domain Always (${domain})` }]
        : []),
      {
        id: "deny",
        label: `Deny`,
        expandsTo: { kind: "text" as const, placeholder: "Reason (optional)" },
      },
    ];
    const req: UiPromptOptionsRequest = {
      title: "Approve tool call?",
      body: deps.summarize(payload.name, payload.args),
      options,
      defaultId: "approve-once",
      cancelId: "deny",
    };
    const result = await deps.prompt.requestOption(req);

    switch (result.id) {
      case "approve-once":
        return;
      case "approve-always":
        tryPersist(deps, payload.name);
        return;
      case "approve-domain-always": {
        if (!domain) {
          deps.log(
            `approve-domain-always returned for nameless-domain tool ${payload.name}; treating as approve-once`,
          );
          return;
        }
        tryPersist(deps, domain);
        return;
      }
      case "deny": {
        const reason = (result.text && result.text.trim()) || DENY_DEFAULT_REASON;
        payload.args = CANCEL_TOOL;
        payload.cancelReason = reason;
        const reasonSuffix =
          result.text && result.text.trim() ? ` (reason: ${result.text.trim()})` : "";
        deps.writeNotice(`✗ user denied ${payload.name}${reasonSuffix}`);
        return;
      }
      default:
        deps.log(`unrecognized prompt option: ${result.id}; treating as approve-once`);
        return;
    }
  };
}

function tryPersist(deps: SubscriberDeps, entry: string): void {
  try {
    deps.persistAllow(entry);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    deps.writeNotice(`Failed to persist approval rule: ${msg}. This call was approved one-time.`);
  }
}
