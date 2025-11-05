"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox@1.1.4";
import { CheckIcon } from "lucide-react@0.487.0";

import { cn } from "./utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentProps<typeof CheckboxPrimitive.Root>
    >(({ className, ...props }, ref) => {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      data-slot="checkbox"
      className={cn(
        "glass-checkbox peer relative grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-lg border-2 border-slate-500/90 bg-white/65 backdrop-blur-2xl shadow-[0_3px_10px_-2px_rgba(15,23,42,0.4),inset_0_2px_rgba(255,255,255,0.9),inset_0_-1px_rgba(0,0,0,0.08)] ring-1 ring-inset ring-white/50 transition-all duration-200 outline-none hover:border-slate-600 hover:bg-white/75 hover:shadow-[0_4px_12px_-2px_rgba(15,23,42,0.45),inset_0_2px_rgba(255,255,255,0.95)] hover:ring-white/60 focus-visible:ring-2 focus-visible:ring-[rgb(95,179,249)]/65 focus-visible:ring-offset-[1.5px] focus-visible:ring-offset-white/35 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[rgb(95,179,249)] data-[state=checked]:border-[rgb(95,179,249)] data-[state=checked]:text-white data-[state=checked]:ring-[rgb(95,179,249)]/65 data-[state=checked]:shadow-[0_3px_10px_-2px_rgba(95,179,249,0.5),inset_0_1px_rgba(255,255,255,0.4)]",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="relative z-[1] flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-4" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

Checkbox.displayName = "Checkbox";

export { Checkbox };
