import { create } from "zustand";
import type { Review } from "../lib/api";
import { isFeatureId } from "../lib/api";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export type PrimaryView = "folders" | "flows" | "data";

interface UiState {
  review: Review | null;
  view: PrimaryView;
  tileId: string;
  selectedNodeId: string | null;
  selectedEntityId: string | null;
  transitioning: "in" | "out" | null;
  chat: ChatMessage[];
  chatBusy: boolean;
  setReview: (r: Review | null) => void;
  setView: (v: PrimaryView) => void;
  navigateTile: (tileId: string) => void;
  selectNode: (nodeId: string | null) => void;
  selectEntity: (entityId: string | null) => void;
  setTransitioning: (t: "in" | "out" | null) => void;
  pushChat: (m: ChatMessage) => void;
  appendToLastChat: (text: string) => void;
  setChatBusy: (b: boolean) => void;
  clearChat: () => void;
}

export const useUi = create<UiState>((set) => ({
  review: null,
  view: "folders",
  tileId: "root",
  selectedNodeId: null,
  selectedEntityId: null,
  transitioning: null,
  chat: [],
  chatBusy: false,
  setReview: (review) =>
    set({ review, view: "folders", tileId: "root", selectedNodeId: null, selectedEntityId: null, chat: [] }),
  // switching primary view: selections are scoped to a single view, so drop the ones
  // that don't belong to the destination (node selection is per-diagram; entity
  // selection only exists inside Data).
  setView: (view) => set((s) => ({ view, selectedNodeId: null, selectedEntityId: view === "data" ? s.selectedEntityId : null })),
  // The Flows tab renders feature docs (feature:<slug> ids); navigating to a structure
  // tile from there is a view change, so land the user in Folders where that tile lives.
  // Feature ids must stay in Flows (deep links + selecting a feature both go through here).
  navigateTile: (tileId) =>
    set((s) => ({
      tileId,
      selectedNodeId: null,
      view: s.view === "flows" && !isFeatureId(tileId) ? "folders" : s.view,
    })),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  selectEntity: (selectedEntityId) => set({ selectedEntityId }),
  setTransitioning: (transitioning) => set({ transitioning }),
  pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),
  appendToLastChat: (text) =>
    set((s) => {
      const chat = [...s.chat];
      const last = chat[chat.length - 1];
      if (last && last.role === "assistant") chat[chat.length - 1] = { ...last, text: last.text + text };
      return { chat };
    }),
  setChatBusy: (chatBusy) => set({ chatBusy }),
  clearChat: () => set({ chat: [] }),
}));

// --- URL sync (deep links: ?repo=owner/name&pr=1&view=data&tile=root/a&node=n:x&entity=Family) ---
export function syncUrl(
  review: Review | null,
  view: PrimaryView,
  tileId: string,
  nodeId: string | null,
  entityId: string | null,
): void {
  const params = new URLSearchParams();
  if (review) {
    params.set("repo", `${review.owner}/${review.repo}`);
    params.set("pr", String(review.prNumber));
    if (view !== "folders") params.set("view", view);
    params.set("tile", tileId);
    if (nodeId) params.set("node", nodeId);
    if (view === "data" && entityId) params.set("entity", entityId);
  }
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function parseView(v: string | null): PrimaryView {
  return v === "flows" || v === "data" ? v : "folders";
}

export function readUrl(): {
  repo: string | null;
  pr: number | null;
  view: PrimaryView;
  tile: string;
  node: string | null;
  entity: string | null;
} {
  const p = new URLSearchParams(location.search);
  return {
    repo: p.get("repo"),
    pr: p.get("pr") ? Number(p.get("pr")) : null,
    view: parseView(p.get("view")),
    tile: p.get("tile") ?? "root",
    node: p.get("node"),
    entity: p.get("entity"),
  };
}
