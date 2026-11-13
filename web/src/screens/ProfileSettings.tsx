import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@macro88/ui";
import type { Profile } from "../api";
import { shortNpub } from "../npub";
import { detailPop, detailPopReduced, detailPush, detailPushReduced, motionEase } from "../profile-motion";
import { ProfileForm } from "./ProfileForm";

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
  const push = reduced ? detailPushReduced : detailPush;
  const pop = reduced ? detailPopReduced : detailPop;
  const [selected, setSelected] = useState<string | "new">(currentId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pane, setPane] = useState<"list" | "detail">("list");
  const [motion, setMotion] = useState<"push" | "pop">("push");
  const chosen = selected === "new" ? undefined : profiles.find((item) => item.id === selected) ?? profiles[0];
  useEffect(() => {
    if (pendingId && profiles.some((item) => item.id === pendingId)) {
      setSelected(pendingId);
      setPendingId(null);
    }
  }, [pendingId, profiles]);
  const showList = !narrow || pane === "list";
  const showDetail = !narrow || pane === "detail" || selected === "new";
  const active = narrow ? (motion === "pop" ? pop : push) : null;

  function openDetail(id: string | "new") {
    setSelected(id);
    setMotion("push");
    setPane("detail");
  }

  return (
    <div className="profile-settings" data-testid="profile-settings">
      {showList ? (
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
                className={current ? "is-current" : undefined}
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
      ) : null}
      {showDetail ? (
        <div
          className={`profile-detail${narrow ? " is-push" : ""}${reduced ? " is-reduced" : ""}`}
          data-testid="profile-pane"
          style={
            active
              ? ({
                  "--push-x": `${"x" in active.initial ? active.initial.x : 0}px`,
                  "--push-ms": `${active.animate.transition.duration}s`,
                  "--push-ease": motionEase(active.animate.transition.ease),
                } as CSSProperties)
              : undefined
          }
        >
          {narrow ? (
            <Button
              type="button"
              variant="ghost"
              data-testid="profile-back"
              onClick={() => {
                setMotion("pop");
                setPane("list");
                if (selected === "new") setSelected(currentId);
              }}
            >
              Back
            </Button>
          ) : null}
          <ProfileForm
            key={selected}
            mode={selected === "new" ? "create" : "edit"}
            profile={selected === "new" ? undefined : chosen}
            onSaved={(id) => {
              setPendingId(id);
              onSaved(id);
            }}
            onRemoved={onRemoved}
          />
        </div>
      ) : null}
    </div>
  );
}
