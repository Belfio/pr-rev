import { useRef, useState, useEffect } from "react";
import Markdown from "react-markdown";
import type { Review } from "../lib/api";
import { useUi } from "../state/store";

export function Chat({ review }: { review: Review }) {
  const { view, tileId, selectedNodeId, selectedEntityId, chat, chatBusy, pushChat, appendToLastChat, setChatBusy } = useUi();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat]);

  async function send() {
    const message = input.trim();
    if (!message || chatBusy) return;
    setInput("");
    const history = chat.map((m) => ({ role: m.role, text: m.text }));
    pushChat({ role: "user", text: message });
    pushChat({ role: "assistant", text: "" });
    setChatBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: review.owner,
          repo: review.repo,
          prNumber: review.prNumber,
          baseSha: review.baseSha,
          headSha: review.headSha,
          tileId,
          selectedNodeId,
          view,
          selectedEntityId,
          message,
          history,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // parse SSE frames
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const eventMatch = frame.match(/^event: (.+)$/m);
          const dataMatch = frame.match(/^data: (.+)$/m);
          if (!dataMatch) continue;
          const event = eventMatch?.[1] ?? "message";
          if (event === "delta") {
            try {
              appendToLastChat(JSON.parse(dataMatch[1]!).text ?? "");
            } catch {
              /* skip malformed frame */
            }
          } else if (event === "error") {
            appendToLastChat(`\n\n*(error: ${JSON.parse(dataMatch[1]!).message})*`);
          }
        }
      }
    } catch (e) {
      appendToLastChat(`\n\n*(chat error: ${(e as Error).message})*`);
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-messages" ref={scrollRef}>
        {chat.length === 0 && (
          <div className="chat-hint">
            Ask about what you're looking at — the current diagram, the changes, a selected node. Context follows your
            navigation.
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            {m.role === "assistant" ? <Markdown>{m.text || "…"}</Markdown> : m.text}
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          placeholder={`Ask about ${tileId === "root" ? "this codebase" : tileId}…`}
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="chat-send" onClick={send} disabled={chatBusy || !input.trim()}>
          {chatBusy ? "…" : "→"}
        </button>
      </div>
    </div>
  );
}
