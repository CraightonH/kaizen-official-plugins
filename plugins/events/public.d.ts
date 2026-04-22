export declare const VOCAB: {
  readonly SESSION_START: "session:start";
  readonly SESSION_END: "session:end";
  readonly SESSION_ERROR: "session:error";
  readonly INPUT_RECEIVED: "input:received";
  readonly SHELL_BEFORE: "shell:before";
  readonly SHELL_AFTER: "shell:after";
};

export type Vocab = typeof VOCAB;
export type EventName = Vocab[keyof Vocab];
