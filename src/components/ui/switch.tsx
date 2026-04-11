"use client";

import * as React from "react";

import { cn } from "./utils";

type SwitchProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

const BRAND_BLUE = "rgb(95, 179, 249)";
const TRACK_OFF = "rgb(203, 213, 225)";
const TRACK_OFF_BORDER = "rgba(148, 163, 184, 0.55)";
const TRACK_ON_BORDER = "rgba(95, 179, 249, 0.42)";
const THUMB_BORDER = "rgba(148, 163, 184, 0.4)";
const THUMB_FILL = "#ffffff";

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      className,
      defaultChecked = false,
      disabled = false,
      onCheckedChange,
      onClick,
      style,
      type,
      ...props
    },
    ref,
  ) => {
    const isControlled = typeof checked === "boolean";
    const [internalChecked, setInternalChecked] = React.useState(defaultChecked);
    const isChecked = isControlled ? checked : internalChecked;

    const handleToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || disabled) {
        return;
      }

      const nextChecked = !isChecked;
      if (!isControlled) {
        setInternalChecked(nextChecked);
      }
      onCheckedChange?.(nextChecked);
    };

    return (
      <button
        {...props}
        ref={ref}
        type={type ?? "button"}
        role="switch"
        aria-checked={isChecked}
        disabled={disabled}
        data-slot="switch"
        data-state={isChecked ? "checked" : "unchecked"}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full border-0 p-0 align-middle outline-none transition-[transform,box-shadow] duration-200 focus-visible:ring-4 focus-visible:ring-[rgba(95,179,249,0.3)] focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        style={{
          width: "3.5rem",
          minWidth: "3.5rem",
          height: "2rem",
          padding: "0.1875rem",
          borderRadius: "9999px",
          backgroundColor: isChecked ? BRAND_BLUE : TRACK_OFF,
          boxShadow: `inset 0 1px 2px rgba(15, 23, 42, 0.18), 0 0 0 1px ${
            isChecked ? TRACK_ON_BORDER : TRACK_OFF_BORDER
          }`,
          cursor: disabled ? "not-allowed" : "pointer",
          ...style,
        }}
        onClick={handleToggle}
      >
        <span
          data-slot="switch-thumb"
          aria-hidden="true"
          className="block rounded-full transition-transform duration-200"
          style={{
            width: "1.625rem",
            height: "1.625rem",
            backgroundColor: THUMB_FILL,
            border: `1px solid ${THUMB_BORDER}`,
            boxShadow: "0 2px 6px rgba(15, 23, 42, 0.18)",
            transform: isChecked ? "translateX(1.5rem)" : "translateX(0)",
          }}
        />
      </button>
    );
  },
);

Switch.displayName = "Switch";

export { Switch };
