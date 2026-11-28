import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Profile } from "./api";
import { readShortcutsEnabled, singleKeyActive, writeShortcutsEnabled } from "./keys";
import { shortNpub } from "./npub";
import { Board } from "./screens/Board";
import { Calendar } from "./screens/Calendar";
import { Composer } from "./screens/Composer";
import { Inbox } from "./screens/Inbox";
import { Remix } from "./screens/Remix";
import { Log } from "./screens/Log";
import { Outliers } from "./screens/Outliers";
import { Performance } from "./screens/Performance";
import { FirstRun } from "./screens/FirstRun";
import { ProfileSettings } from "./screens/ProfileSettings";
import { Sign } from "./screens/Sign";
import { useTheme } from "./theme/mode";
import { Toaster } from "./toasts";

const views = ["inbox", "compose", "board", "calendar", "log", "sign", "outliers", "research", "performance"] as const;
type View = (typeof views)[number];

export function App() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/api/profiles") });
  const [profileId, setProfileId] = useState("");
  const [view, setView] = useState<View>("inbox");
  const [shortcuts, setShortcuts] = useState(() => readShortcutsEnabled(typeof localStorage === "undefined" ? null : localStorage));
  const [menuOpen, setMenuOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [repair, setRepair] = useState(false);
  const profileButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);
  const focusNote = useRef(false);
  const [returnFocus, setReturnFocus] = useState(0);
  const selected = profiles.data?.find((profile) => profile.id === profileId) ?? profiles.data?.[0];
  const sections: Record<View, string> = {
    inbox: "Inbox",
    compose: "Compose",
    board: "Board",
    calendar: "Queue",
    log: "Log",
    sign: "Sign",
    outliers: "Outliers",
    research: "Research",
    performance: "Performance",
  };

  useEffect(() => {
    if (!profileId && profiles.data?.[0]) setProfileId(profiles.data[0].id);
  }, [profileId, profiles.data]);

  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    document.getElementById("section-title")?.focus();
  }, [view]);

  useEffect(() => {
    if (returnFocus === 0) return;
    const outer = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const editor = focusNote.current ? document.querySelector<HTMLElement>("[data-testid='note-text']") : null;
        focusNote.current = false;
        const title = document.getElementById("section-title");
        const target = editor ?? title;
        if (!target) return;
        const options: FocusOptions = {};
        Object.assign(options, { focusVisible: true });
        target.focus(options);
      });
    });
    return () => window.cancelAnimationFrame(outer);
  }, [returnFocus]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = () => {
      void queryClient.invalidateQueries();
    };
    return () => source.close();
  }, [queryClient]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (menuOpen) return;
      if (!singleKeyActive(shortcuts, event.target)) return;
      const choice = views[Number(event.key) - 1];
      if (choice) setView(choice);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, shortcuts]);

  useEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const focusable = () =>
      menu ? [...menu.querySelectorAll<HTMLElement>("button, input, [href], [tabindex]:not([tabindex='-1'])")].filter((node) => !node.hasAttribute("disabled")) : [];
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        profileButton.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menu?.contains(target) || profileButton.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menuOpen]);

  const ready = Boolean(profiles.data && profiles.data.length > 0);
  if (profiles.isPending && !profiles.data) {
    return (
      <>
        <Toaster />
        <header>
          <div className="brand-nav">
            <span className="wordmark">Scheduler</span>
          </div>
        </header>
        <main>
          <p className="sr">Loading profiles</p>
        </main>
      </>
    );
  }

  return (
    <>
      <Toaster />
      <header>
        <div className="brand-row">
          <span className="wordmark">Scheduler</span>
          {ready && !repair ? (
          <div className="header-tools">
          <button
            ref={profileButton}
            type="button"
            className="profile"
            data-testid="profile"
            aria-label={selected ? `Profile ${selected.label}` : "Profile"}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            {selected ? selected.label : "Profile"}
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 4.5 6 8l3-3.5" />
            </svg>
          </button>
          {menuOpen ? (
            <div ref={menuRef} className="profile-menu" role="dialog" aria-label="Profile menu">
              <p className="menu-label" id="profile-label">Profiles</p>
              <div role="radiogroup" aria-labelledby="profile-label">
                {(profiles.data ?? []).map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    role="radio"
                    aria-checked={profile.id === selected?.id}
                    onClick={() => setProfileId(profile.id)}
                  >
                    {profile.label}
                    <span className="mono"> {shortNpub(profile.pubkey)}</span>
                  </button>
                ))}
              </div>
              <button type="button" data-testid="manage-profiles" onClick={() => { setManage(true); setMenuOpen(false); }}>
                Manage profiles
              </button>
              <p className="menu-label" id="theme-label">Theme</p>
              <div role="radiogroup" aria-labelledby="theme-label">
                {(["system", "light", "dark"] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    data-testid={`theme-${choice}`}
                    aria-checked={theme.choice === choice}
                    onClick={() => theme.setChoice(choice)}
                  >
                    {choice === "system" ? "System" : choice === "light" ? "Light" : "Dark"}
                  </button>
                ))}
              </div>
              <label className="shortcut-toggle">
                <input
                  type="checkbox"
                  data-testid="shortcuts"
                  checked={shortcuts}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    writeShortcutsEnabled(localStorage, enabled);
                    setShortcuts(enabled);
                  }}
                />
                Single-key shortcuts
              </label>
            </div>
          ) : null}
        </div>
        ) : null}
        </div>
        {ready && !repair ? (
        <nav aria-label="Sections">
          {views.map((name, index) => (
            <button
              key={name}
              type="button"
              data-testid={`nav-${name}`}
              aria-current={view === name ? "page" : undefined}
              onClick={() => setView(name)}
            >
              {sections[name]}
              <span className="sr"> {index + 1}</span>
            </button>
          ))}
        </nav>
        ) : null}
      </header>
      <main>
        {repair && selected ? (
          <FirstRun
            profile={selected}
            onExit={() => setRepair(false)}
            onSaved={() => {
              focusNote.current = true;
              setRepair(false);
              setView("compose");
              setReturnFocus((count) => count + 1);
              void queryClient.invalidateQueries({ queryKey: ["profiles"] });
            }}
          />
        ) : null}
        {!ready ? (
          <FirstRun
            onSaved={(id) => {
              setProfileId(id);
              setView("compose");
              setReturnFocus((count) => count + 1);
              void queryClient.invalidateQueries({ queryKey: ["profiles"] });
            }}
          />
        ) : null}
        {selected && manage && !repair ? (
          <ProfileSettings
            profiles={profiles.data ?? []}
            currentId={selected.id}
            onSaved={(id) => {
              setProfileId(id);
              void queryClient.invalidateQueries({ queryKey: ["profiles"] });
            }}
            onRemoved={() => {
              setManage(false);
              setProfileId("");
              void queryClient.invalidateQueries({ queryKey: ["profiles"] }).then(() => {
                setReturnFocus((count) => count + 1);
              });
            }}
          />
        ) : null}
        {selected && !manage && !repair && view === "inbox" ? <Inbox profile={selected} shortcuts={shortcuts} onCompose={() => setView("compose")} /> : null}
        {selected && !manage && !repair && view === "research" ? (
          <Remix profile={selected} headingId="section-title" onCompose={() => setView("compose")} />
        ) : null}
        {selected ? (
          <div hidden={repair || manage || view !== "compose"}>
            <Composer profile={selected} headingId={!repair && !manage && view === "compose" ? "section-title" : undefined} onRepair={() => setRepair(true)} onViewQueue={() => setView("calendar")} />
          </div>
        ) : null}
        {selected && !manage && !repair && view === "board" ? <Board profile={selected} /> : null}
        {selected && !manage && !repair && view === "calendar" ? (
          <Calendar profileId={selected.id} canSend={(selected.relays ?? []).some((item) => item.publish)} />
        ) : null}
        {selected && !manage && !repair && view === "log" ? <Log /> : null}
        {selected && !manage && !repair && view === "outliers" ? <Outliers profileId={selected.id} /> : null}
        {selected && !manage && !repair && view === "performance" ? <Performance profileId={selected.id} /> : null}
        {selected && !manage && !repair && view === "sign" ? <Sign profile={selected} /> : null}
      </main>
    </>
  );
}
