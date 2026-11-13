import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@macro88/ui";
import type { Profile } from "../api";
import { shortNpub } from "../npub";
import { detailPop, detailPopReduced, detailPush, detailPushReduced } from "../profile-motion";
import { ProfileForm, SheetHostContext } from "./ProfileForm";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 800px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function useReduced(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function ProfileSettings({
  profiles,
  currentId,
  onSaved,
  onRemoved,
}: {
  profiles: Profile[];
  currentId: string;
  onSaved: (id: string) => void;
  onRemoved: () => void;
}) {
  const narrow = useNarrow();
  const reduced = useReduced();
  const wasNarrow = useRef(narrow);
  const [selected, setSelected] = useState<string | "new">(currentId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pane, setPane] = useState<"list" | "detail">(narrow ? "list" : "detail");
  const [travel, setTravel] = useState(false);
  const [sheetHost, setSheetHost] = useState<HTMLDivElement | null>(null);
  const chosen = selected === "new" ? undefined : profiles.find((item) => item.id === selected) ?? profiles[0];
  const push = reduced ? detailPushReduced : detailPush;
  const pop = reduced ? detailPopReduced : detailPop;

  useEffect(() => {
    if (pendingId && profiles.some((item) => item.id === pendingId)) {
      setSelected(pendingId);
      setPendingId(null);
    }
  }, [pendingId, profiles]);

  useEffect(() => {
    if (narrow && !wasNarrow.current) {
      setTravel(false);
      setPane("detail");
    }
    wasNarrow.current = narrow;
  }, [narrow]);

  function openDetail(id: string | "new") {
    setSelected(id);
    setTravel(true);
    setPane("detail");
  }

  function back() {
    setTravel(true);
    setPane("list");
    if (selected === "new") setSelected(currentId);
  }

  const list = (
    <div className="profile-list" data-testid="profile-list">
      <Button type="button" variant="outline" data-testid="add-profile" onClick={() => openDetail("new")}>
        Add profile
      </Button>
      {profiles.map((item) => {
        const current = item.id === (selected === "new" ? "" : (chosen?.id ?? ""));
        return (
          <button
            key={item.id}
            type="button"
            className={`profile-row${current ? " is-current" : ""}`}
            aria-current={current ? "true" : undefined}
            data-testid={`profile-row-${item.id}`}
            onClick={() => openDetail(item.id)}
          >
            <span>{item.label}</span>
            <span className="mono">{item.npub ? shortNpub(item.npub) : ""}</span>
          </button>
        );
      })}
    </div>
  );

  const detail = (
    <div className="profile-detail" data-testid="profile-pane">
      {narrow ? (
        <Button type="button" variant="ghost" data-testid="profile-back" onClick={back}>
          Back
        </Button>
      ) : null}
      <ProfileForm
        key={selected}
        mode={selected === "new" || !chosen ? "create" : "edit"}
        profile={selected === "new" ? undefined : chosen}
        onSaved={(id) => {
          setPendingId(id);
          onSaved(id);
        }}
        onRemoved={onRemoved}
      />
    </div>
  );

  return (
    <SheetHostContext.Provider value={sheetHost}>
      <div className="profile-settings" data-testid="profile-settings">
      {narrow ? (
        <div className="profile-stage">
          <AnimatePresence mode="sync" initial={false}>
            {pane === "list" ? (
              <motion.div
                key="list"
                initial={travel ? pop.list.initial : false}
                animate={pop.list.animate}
                exit={push.list.exit}
                onUpdate={(latest) => noteTravel(latest.x)}
              >
                {list}
              </motion.div>
            ) : (
              <motion.div
                key="detail"
                initial={travel ? push.detail.initial : false}
                animate={push.detail.animate}
                exit={pop.detail.exit}
                onUpdate={(latest) => noteTravel(latest.x)}
              >
                {detail}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <Wide panes={{ list, detail }} />
      )}
      <div ref={setSheetHost} className="profile-sheet-host" data-testid="profile-sheet-host" />
      </div>
    </SheetHostContext.Provider>
  );
}

function noteTravel(x: unknown) {
  if (typeof x === "number" && Math.abs(x) > 1) document.documentElement.dataset.paneTravel = "1";
}

function Wide({ panes }: { panes: { list: ReactNode; detail: ReactNode } }) {
  return (
    <>
      {panes.list}
      {panes.detail}
    </>
  );
}
