export const CONTRACT_ID = "ui:status";
export const DESCRIPTION = "Marker service — signals that a status renderer is present in the harness.";

// Marker only; presence indicates that status:item-update / status:item-clear
// events will be rendered in the UI.
export interface UiStatusService {}
