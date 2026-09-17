import { useLingui } from "@lingui/react/macro";
import { cn } from "cn";
import { Loader2Icon } from "lucide-react";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const { t } = useLingui();
  return (
    <Loader2Icon
      data-slot="spinner"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- The shadcn spinner is an SVG status indicator, not a form output element.
      role="status"
      aria-label={t`Loading…`}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
