import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface UiEventAttributes extends HTMLAttributes<HTMLUiEventElement> {
  "event-name"?: string;
  label?: string;
  "max-events"?: number;
  "show-last-updated"?: boolean;
  "show-status"?: boolean;
  "show-timestamp"?: boolean;
  variant?: "outlined" | "filled";
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ui-event": DetailedHTMLProps<UiEventAttributes, HTMLUiEventElement>;
    }
  }
}
