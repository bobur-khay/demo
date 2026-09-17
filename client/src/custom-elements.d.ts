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

interface UiNotificationAttributes extends HTMLAttributes<HTMLUiNotificationElement> {
  duration?: number;
  message?: string;
  "show-close-button"?: boolean;
  "show-icon"?: boolean;
  type?: "info" | "success" | "warning" | "error";
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ui-event": DetailedHTMLProps<UiEventAttributes, HTMLUiEventElement>;
      "ui-notification": DetailedHTMLProps<
        UiNotificationAttributes,
        HTMLUiNotificationElement
      >;
    }
  }
}
