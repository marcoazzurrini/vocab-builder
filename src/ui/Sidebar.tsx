import { Wordmark } from "./Wordmark";

/* Only French exists today; the map is here so the day a second language
   lands, this is the one place the sidebar needs to learn about it. The name
   is written in its own language — that is why the CSS sets it in the serif. */
const LANGUAGE_NAME: Record<string, string> = { fr: "français" };

export function Sidebar({
  email,
  open,
  onClose,
  onSignOut,
}: {
  email: string | null;
  open: boolean;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const name = email ? (email.split("@")[0] ?? email) : "…";

  return (
    <aside className={open ? "sidebar open" : "sidebar"} aria-label="Menu">
      <div className="wordmark">
        <Wordmark />
      </div>

      {/* The session is the only page there is; the rest is the roadmap,
          visible so the shell does not have to be rethought per page. */}
      <button type="button" className="nav-item active" onClick={onClose}>
        Sessione
      </button>
      <button type="button" className="nav-item" disabled>
        Parole <span className="presto">presto</span>
      </button>
      <button type="button" className="nav-item" disabled>
        Progressi <span className="presto">presto</span>
      </button>
      <button type="button" className="nav-item" disabled>
        Impostazioni <span className="presto">presto</span>
      </button>

      <div className="sidebar-footer">
        <div className="lang">
          <span className="label">Lingua</span>
          <span className="value">{LANGUAGE_NAME["fr"]}</span>
        </div>
        <div className="user">
          <span className="avatar" aria-hidden="true">
            {name.slice(0, 1)}
          </span>
          <span className="name">{name}</span>
          <button type="button" className="esci" onClick={onSignOut}>
            Esci
          </button>
        </div>
      </div>
    </aside>
  );
}
