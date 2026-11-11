import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type Profile } from "./api";
import { readShortcutsEnabled, singleKeyActive, writeShortcutsEnabled } from "./keys";
import { shortKey } from "./labels";
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
      if (!singleKeyActive(shortcuts, event.target)) return;
      if (event.key === "1") setView("inbox");
      if (event.key === "2") setView("compose");
      if (event.key === "3") setView("calendar");
      if (event.key === "4") setView("log");
      if (event.key === "5") setView("sign");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);

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
            />{" "}
            Single-key shortcuts
          </label>
          <button type="button" className="theme-toggle" data-testid="theme" onClick={theme.toggle}>
            {theme.dark ? "Light theme" : "Dark theme"}
          </button>
          <label className="profile">
            Profile
            <select data-testid="profile" aria-label="Profile" value={selected?.id ?? ""} onChange={(event) => setProfileId(event.target.value)}>
              {(profiles.data ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {shortKey(profile.pubkey)}
                </option>
              ))}
            </select>
          </label>
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
