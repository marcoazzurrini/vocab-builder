import { Trans } from "@lingui/react/macro";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * The last line before a blank page.
 *
 * The session refuses calls made in the wrong phase, by throwing — deliberately,
 * because a phase that does not match the screen is a bug and silence would hide
 * it. But an exception from a React event handler with nothing to catch it
 * unmounts the whole tree, so the loudest possible failure becomes the least
 * informative one: an empty white page, mid-session, with the day's work
 * apparently gone.
 *
 * It is not gone. Every answer is written as it happens, so reloading resumes
 * from the last one. That is what this offers.
 */
interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  // React requires an instance lifecycle method even when reporting uses no instance data.
  // oxlint-disable-next-line eslint/class-methods-use-this
  componentDidCatch(error: Error, info: ErrorInfo) {
    // No reporting service yet, so the console is the only record there is.
    console.error("Session crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertTitle>
            <Trans>something went wrong</Trans>
          </AlertTitle>
          <AlertDescription>
            <Trans>
              Your answers have been saved. Reload to pick up where you left
              off.
            </Trans>
          </AlertDescription>
        </Alert>
        <div>
          <Button type="button" onClick={() => window.location.reload()}>
            <Trans>Reload</Trans>
          </Button>
        </div>
        <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
          {error.message}
        </p>
      </div>
    );
  }
}
