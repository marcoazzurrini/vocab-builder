import { Trans, useLingui } from "@lingui/react/macro";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

import { Wordmark } from "./wordmark";

export const Sidebar = ({
  email,
  sessionActive = true,
  onClose,
  onSignOut,
}: {
  email: string | null;
  sessionActive?: boolean;
  onClose: () => void;
  onSignOut: () => void;
}) => {
  const { t } = useLingui();
  const name = email ? (email.split("@")[0] ?? email) : "…";

  return (
    <aside
      className="flex h-full min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
      aria-label={t`Menu`}
    >
      <div className="text-lg font-semibold">
        <Wordmark />
      </div>
      <nav className="flex flex-col gap-1" aria-label={t`Menu`}>
        <Button
          type="button"
          variant={sessionActive ? "secondary" : "ghost"}
          className="justify-start"
          aria-current={sessionActive ? "page" : undefined}
          onClick={onClose}
        >
          <Trans>Session</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="justify-between"
          disabled
        >
          <Trans>Words</Trans>
          <Badge variant="outline">
            <Trans>coming soon</Trans>
          </Badge>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="justify-between"
          disabled
        >
          <Trans>Progress</Trans>
          <Badge variant="outline">
            <Trans>coming soon</Trans>
          </Badge>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="justify-between"
          disabled
        >
          <Trans>Settings</Trans>
          <Badge variant="outline">
            <Trans>coming soon</Trans>
          </Badge>
        </Button>
      </nav>
      <div className="mt-auto flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            <Trans>Learning language</Trans>
          </span>
          <span lang="fr">français</span>
        </div>
        <Separator />
        <div className="flex min-w-0 items-center gap-2">
          <Avatar aria-hidden="true">
            <AvatarFallback>{name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <span
            className="min-w-0 flex-1 truncate text-sm"
            title={email ?? undefined}
          >
            {name}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onClose();
              onSignOut();
            }}
          >
            <Trans>Sign out</Trans>
          </Button>
        </div>
      </div>
    </aside>
  );
};
