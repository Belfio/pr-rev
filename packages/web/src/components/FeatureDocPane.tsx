import { useQuery } from "@tanstack/react-query";
import { api, keys, queryDefaults, featureSlug, mergeDocSections } from "../lib/api";
import type { Review } from "../lib/api";
import { useUi } from "../state/store";

// Change layer "added"|"changed"|"removed" reuses the shared status badge palette
// (badge-added=green, badge-changed=amber, badge-removed=red) — see styles.css.
function ChangeBadge({ change }: { change: "added" | "changed" | "removed" }) {
  return <span className={`badge badge-${change}`}>{change}</span>;
}

/**
 * Left-pane feature documentation (replaces DiagramPane on the Flows tab). Renders the
 * merge-base narrative — purpose, ASCII "at a glance", core-model invariants — and the
 * merged section outline with PR change badges. Clicking a section selects it (the right
 * TextPane pane then shows the section's narrative, files, and diffs).
 */
export function FeatureDocPane({ review }: { review: Review }) {
  const { tileId, selectedNodeId, selectNode } = useUi();
  const slug = featureSlug(tileId);

  const docQ = useQuery({
    queryKey: keys.featureDoc(review, slug),
    queryFn: () => api.featureDoc(review, slug),
    ...queryDefaults,
  });
  const overlayQ = useQuery({
    queryKey: keys.featureDocOverlay(review, slug),
    queryFn: () => api.featureDocOverlay(review, slug),
    ...queryDefaults,
  });

  if (docQ.isLoading) return <div className="pane-loading">loading doc…</div>;
  if (docQ.isError || !docQ.data) return <div className="pane-loading">doc failed to load</div>;

  const doc = docQ.data;
  const overlay = overlayQ.data ?? null;
  const sections = mergeDocSections(doc, overlay);
  const changes = overlay?.sectionChanges ?? {};

  return (
    <div className="feature-doc">
      <div className="feature-doc-scroll">
        <h1 className="feature-title">{doc.title}</h1>
        {doc.purpose && <p className="feature-purpose">{doc.purpose}</p>}

        {doc.atAGlance && (
          <section className="feature-block">
            <h2 className="feature-block-title">At a glance</h2>
            <pre className="feature-ascii">{doc.atAGlance}</pre>
          </section>
        )}

        {doc.coreModel.length > 0 && (
          <section className="feature-block">
            <h2 className="feature-block-title">Core model</h2>
            <ul className="feature-core">
              {doc.coreModel.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="feature-block">
          <h2 className="feature-block-title">Sections</h2>
          <div className="feature-sections">
            {sections.map((s) => {
              const change = changes[s.id];
              return (
                <button
                  key={s.id}
                  className={`feature-section-row ${selectedNodeId === s.id ? "feature-section-active" : ""}`}
                  onClick={() => selectNode(s.id === selectedNodeId ? null : s.id)}
                >
                  <span className="feature-section-ord">{s.ordinal}</span>
                  <span className="feature-section-heading">{s.heading}</span>
                  {change && <ChangeBadge change={change.change} />}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
