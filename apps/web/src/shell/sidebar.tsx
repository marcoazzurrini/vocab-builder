import { Trans, useLingui } from "@lingui/react/macro";

import { Wordmark } from "./wordmark";

/* Only French exists today; the map is here so the day a second language
   lands, this is the one place the sidebar needs to learn about it. The name
   is written in its own language — that is why the CSS sets it in the serif. */
const LANGUAGE_NAME = { fr: "français" };

export const Sidebar = ({
  email,
  open,
  onClose,
  onSignOut,
}: {
  email: string | null;
  open: boolean;
  onClose: () => void;
  onSignOut: () => void;
}) => {
  const { t } = useLingui();
  const name = email ? (email.split("@")[0] ?? email) : "…";

  return (
    <aside className={open ? "sidebar open" : "sidebar"} aria-label={t`Menu`}>
      <div className="wordmark">
        <Wordmark />
      </div>

      {/* The session is the only page there is; the rest is the roadmap,
          visible so the shell does not have to be rethought per page. */}
      <button type="button" className="nav-item active" onClick={onClose}>
        <Trans>Session</Trans>
      </button>
      <button type="button" className="nav-item" disabled>
        <Trans>Words</Trans>{" "}
        <span className="presto">
          <Trans>coming soon</Trans>
        </span>
      </button>
      <button type="button" className="nav-item" disabled>
        <Trans>Progress</Trans>{" "}
        <span className="presto">
          <Trans>coming soon</Trans>
        </span>
      </button>
      <button type="button" className="nav-item" disabled>
        <Trans>Settings</Trans>{" "}
        <span className="presto">
          <Trans>coming soon</Trans>
        </span>
      </button>

      <div className="sidebar-footer">
        <div className="lang">
          <span className="label">
            <Trans>Learning language</Trans>
          </span>
          <span className="value">{LANGUAGE_NAME["fr"]}</span>
        </div>
        <div className="user">
          <span className="avatar" aria-hidden="true">
            {name.slice(0, 1)}
          </span>
          <span className="name">{name}</span>
          <button type="button" className="esci" onClick={onSignOut}>
            <Trans>Sign out</Trans>
          </button>
        </div>
      </div>
    </aside>
  );
};
