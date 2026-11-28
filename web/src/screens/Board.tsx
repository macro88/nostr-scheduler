import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "@macro88/ui";
import { api, type Item, type Profile } from "../api";
import { boardColumn, boardMove, BOARD_COLUMNS, isBoardColumn, type BoardColumnId } from "../board";
import { plainError } from "../errors";
import { formatQueueWhen } from "../format";
import { usePendingSurface } from "../pending";
import { InlineError, LoadingBlock } from "../states";

function cardLabel(item: Item): string {
  const text = item.preview.trim();
  return text || "Untitled";
}

function byTime(left: Item, right: Item): number {
  const a = left.fireAt[0] ?? 0;
  const b = right.fireAt[0] ?? 0;
  if (a !== b) return a - b;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function Board({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const items = useQuery({
    queryKey: ["items", profile.id],
    queryFn: () => api<Item[]>(`/api/items?profileId=${profile.id}`),
  });
  const surface = usePendingSurface(items.isPending && !items.data);
  const itemsRef = useRef<Item[]>([]);
  const dragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const overRef = useRef<BoardColumnId | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumnId | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [live, setLive] = useState("");
  const [fault, setFault] = useState<unknown>(null);
  const [movedId, setMovedId] = useState<string | null>(null);
  const pendingRef = useRef(new Set<string>());
  const rows = (items.data ?? []).filter((item) => item.profileId === profile.id);
  itemsRef.current = rows;

  useEffect(() => {
    return () => {
      document.documentElement.removeAttribute("data-board-drag");
    };
  }, []);

  useEffect(() => {
    if (!dragId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dragRef.current = null;
      setDragId(null);
      setOver(null);
      overRef.current = null;
      document.documentElement.removeAttribute("data-board-drag");
      setLive("Move cancelled.");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragId]);

  useEffect(() => {
    if (!movedId) return;
    const card = document.querySelector<HTMLElement>(`[data-testid="board"] [data-item-id="${CSS.escape(movedId)}"]`);
    if (card?.dataset.column !== "ready") return;
    card.focus();
    setMovedId(null);
  }, [movedId, items.data]);

  const clearDrag = () => {
    dragRef.current = null;
    setDragId(null);
    setOver(null);
    overRef.current = null;
    document.documentElement.removeAttribute("data-board-drag");
  };

  const approve = async (id: string) => {
    if (pendingRef.current.has(id)) return;
    pendingRef.current.add(id);
    setPending([...pendingRef.current]);
    setFault(null);
    try {
      await api(`/api/items/${id}/approve`, { method: "POST", body: "{}" });
      setMovedId(id);
      setLive("Moved to Ready.");
      await queryClient.invalidateQueries({ queryKey: ["items"] });
    } catch (error) {
      setFault(error);
      setLive(plainError(error).message);
    } finally {
      pendingRef.current.delete(id);
      setPending([...pendingRef.current]);
    }
  };

  const columnUnder = (event: { clientX: number; clientY: number }): BoardColumnId | null => {
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const value = under?.closest("[data-column-id]")?.getAttribute("data-column-id");
    return isBoardColumn(value) ? value : null;
  };

  const beginDrag = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    dragRef.current = { id, pointerId: event.pointerId };
    setDragId(id);
    setOver(null);
    overRef.current = null;
    document.documentElement.dataset.boardDrag = "1";
  };

  const trackDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = columnUnder(event);
    overRef.current = next;
    setOver(next);
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const pointed = commit ? columnUnder(event) : null;
    const target = pointed ?? (commit ? overRef.current : null);
    const item = itemsRef.current.find((row) => row.id === current.id);
    const from = item ? boardColumn(item) : null;
    clearDrag();
    if (!commit) {
      setLive("Move cancelled.");
      return;
    }
    if (from && target && boardMove(from, target) === "approve") {
      void approve(current.id);
      return;
    }
    if (target && target !== from) setLive("That column does not take this note.");
  };

  const lanes = BOARD_COLUMNS.map((column) => ({
    ...column,
    cards: rows.filter((item) => boardColumn(item) === column.id).sort(byTime),
  }));

  return (
    <section data-testid="board" aria-label="Board">
      <div className="page-head compact">
        <div className="title-row">
          <h1 id="section-title" tabIndex={-1}>
            Board
          </h1>
          <p className="page-kicker">Unsigned notes</p>
        </div>
      </div>
      <p className={fault ? "sr" : "board-live"} role="status" data-testid="board-status">
        {live}
      </p>
      {items.isPending && !items.data && !surface.loading ? <p className="sr">Loading the board</p> : null}
      <LoadingBlock pending={surface.loading} label="Loading the board" />
      {items.isError ? <InlineError error={items.error} fallback="The board could not be loaded. Try again." /> : null}
      {fault ? <InlineError error={fault} /> : null}
      {surface.ready && !items.isError ? (
        <div className="board-frame">
          <div className="board-columns">
            {lanes.map((column) => {
              const open = dragId !== null && column.id === "ready" && over === "ready";
              const marked = dragId !== null && column.id === "ready";
              return (
                <section
                  key={column.id}
                  className={["board-column", marked ? "is-target" : "", open ? "is-over" : ""].filter(Boolean).join(" ")}
                  aria-label={column.label}
                  data-testid={`column-${column.id}`}
                  data-column-id={column.id}
                >
                  <h2>
                    {column.label}
                    <span className="count">{column.cards.length}</span>
                  </h2>
                  {column.cards.length === 0 ? <p data-testid={`empty-${column.id}`}>Nothing here.</p> : null}
                  <ul className="board-list">
                    {column.cards.map((item) => {
                      const label = cardLabel(item);
                      const stamp = item.fireAt[0];
                      const writing = column.id === "writing";
                      return (
                        <li key={item.id}>
                          <article className="board-card" data-testid="board-card" data-column={column.id} data-item-id={item.id} tabIndex={-1}>
                            {typeof stamp === "number" && stamp > 0 ? <time>{formatQueueWhen(stamp)}</time> : null}
                            <p>{label}</p>
                            {writing ? (
                              <footer>
                                <button
                                  type="button"
                                  className="board-handle"
                                  data-testid="board-drag"
                                  aria-label={`Drag ${label} to Ready`}
                                  onPointerDown={(event) => beginDrag(event, item.id)}
                                  onPointerMove={trackDrag}
                                  onPointerUp={(event) => endDrag(event, true)}
                                  onPointerCancel={(event) => endDrag(event, false)}
                                >
                                  Drag
                                </button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  data-testid="move-ready"
                                  disabled={pending.includes(item.id)}
                                  aria-label={`Move ${label} to Ready`}
                                  onClick={() => void approve(item.id)}
                                >
                                  Move to Ready
                                </Button>
                              </footer>
                            ) : null}
                          </article>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
