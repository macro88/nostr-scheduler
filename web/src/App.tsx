import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Profile } from "./api";
import { readShortcutsEnabled, singleKeyActive, writeShortcutsEnabled } from "./keys";
import { shortNpub } from "./npub";
import { Calendar } from "./screens/Calendar";
import { Composer } from "./screens/Composer";
import { Inbox } from "./screens/Inbox";
import { Log } from "./screens/Log";
import { Sign } from "./screens/Sign";
import { useTheme } from "./theme/mode";
import { ToastProvider } from "./toasts";

const views = ["inbox", "compose", "calendar", "log", "sign"] as const;
type View = (typeof views)[number];

export function App() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/api/profiles") });
  const [profileId, setProfileId] = useState("");
  const [view, setView] = useState<View>("inbox");
  const [shortcuts, setShortcuts] = useState(() => readShortcutsEnabled(typeof localStorage === "undefined" ? null : localStorage));
  const [menuOpen, setMenuOpen] = useState(false);
  const profileButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);
  const selected = profiles.data?.find((profile) => profile.id === profileId) ?? profiles.data?.[0];
  const sections: Record<View, string> = {
    inbox: "Inbox",
    compose: "Compose",
    calendar: "Queue",
    log: "Log",
    sign: "Sign",
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
      if (event.key === "1") setView("inbox");
      if (event.key === "2") setView("compose");
      if (event.key === "3") setView("calendar");
      if (event.key === "4") setView("log");
      if (event.key === "5") setView("sign");
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

  return (
    <ToastProvider>
      <header>
        <div className="brand-nav">
          <span className="wordmark">Scheduler</span>
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
        </div>
        <div className="header-tools">
          <button
            ref={profileButton}
            type="button"
            className="profile"
            data-testid="profile"
            aria-label={selected ? `Profile ${shortNpub(selected.pubkey)}` : "Profile"}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            {selected ? shortNpub(selected.pubkey) : "Profile"}
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
                    {shortNpub(profile.pubkey)}
                  </button>
                ))}
              </div>
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
      </header>
      <main>
        {!selected && !profiles.isPending ? <p>Add a profile in the data directory to begin.</p> : null}
        {selected && view === "inbox" ? <Inbox profile={selected} shortcuts={shortcuts} onCompose={() => setView("compose")} /> : null}
        {selected && view === "compose" ? <Composer profile={selected} /> : null}
        {selected && view === "calendar" ? <Calendar profileId={selected.id} /> : null}
        {selected && view === "log" ? <Log /> : null}
        {selected && view === "sign" ? <Sign profile={selected} /> : null}
      </main>
    </ToastProvider>
  );
}
