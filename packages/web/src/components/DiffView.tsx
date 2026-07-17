import { useQuery } from "@tanstack/react-query";
import { api, keys, queryDefaults } from "../lib/api";
import type { Review, HunkRef } from "../lib/api";

export function DiffView({ review, hunkRef }: { review: Review; hunkRef: HunkRef }) {
  const q = useQuery({
    queryKey: keys.patch(review, hunkRef.patchUri),
    queryFn: () => api.patch(review, hunkRef.patchUri),
    ...queryDefaults,
  });

  if (q.isLoading) return <div className="diff-loading">loading diff…</div>;
  if (q.isError || !q.data) return <div className="diff-loading">diff unavailable</div>;

  return (
    <div className="diff">
      <div className="diff-file">{hunkRef.file}</div>
      <pre className="diff-body">
        {q.data.split("\n").map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "dl dl-hunk";
  if (line.startsWith("+")) return "dl dl-add";
  if (line.startsWith("-")) return "dl dl-del";
  return "dl";
}
