"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog@1.1.6";
import { XIcon } from "lucide-react@0.487.0";

import { cn } from "./utils";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ ...props }, ref) => (
  <DialogPrimitive.Trigger ref={ref} data-slot="dialog-trigger" {...props} />
));
DialogTrigger.displayName = DialogPrimitive.Trigger.displayName;

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, style, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      "fixed inset-0 z-[9999] backdrop-blur-xl transition-opacity duration-[1200ms] ease-out data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
      className,
    )}
    style={{
      backdropFilter: 'blur(4px) saturate(1.2)',
      WebkitBackdropFilter: 'blur(4px) saturate(1.2)',
      willChange: 'opacity',
      ...style,
    }}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, style, ...props }, ref) => (
  <DialogPortal data-slot="dialog-portal">
    <div
      className="fixed inset-x-0 bottom-0 z-[10000] flex items-center justify-center px-3 py-6 sm:px-4 sm:py-8"
      style={{
        top: 'var(--modal-header-offset, 6rem)',
        left: 0,
        right: 0,
      }}
    >
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="dialog-content"
        className={cn(
          "relative z-[1001] flex w-full max-w-[min(740px,calc(100vw-2rem))] flex-col overflow-y-auto squircle-xl glass-card border-[3px] p-6 text-slate-900 shadow-[0_24px_60px_-25px_rgba(7,27,27,0.55)] transition-[opacity,transform] duration-[1200ms] ease-[cubic-bezier(0.23,1,0.32,1)] data-[state=open]:opacity-100 data-[state=closed]:opacity-0 data-[state=open]:scale-100 data-[state=closed]:scale-95 focus:outline-none data-[state=closed]:pointer-events-none sm:max-w-[min(800px,calc(100vw-2.5rem))] lg:max-w-[min(50vw,48rem)]",
          className,
        )}
        style={{
          backgroundColor: 'rgba(245, 251, 255, 0.94)',
          borderColor: 'rgba(95, 179, 249, 0.65)',
          backdropFilter: 'blur(16px) saturate(1.45)',
          WebkitBackdropFilter: 'blur(16px) saturate(1.45)',
          // Leave room for the sticky header when positioning + sizing the modal
          maxHeight: 'calc(var(--viewport-height, 100dvh) - var(--modal-header-offset, 6rem) - clamp(1.5rem, 6vh, 3rem))',
          margin: 'clamp(0.5rem, 3vh, 2rem) auto 1.5rem',
          willChange: 'opacity, transform',
          ...style,
        }}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="dialog-close-btn inline-flex items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150 absolute top-4 right-4 disabled:pointer-events-none"
          style={{ backgroundColor: 'rgb(95, 179, 249)', width: '38px', height: '38px', borderRadius: '50%' }}>
          <XIcon className="h-4 w-4 sm:h-5 sm:w-5" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </div>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
