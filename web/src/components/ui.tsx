import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function cn(...values: Parameters<typeof clsx>) {
  return twMerge(clsx(values));
}

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-full text-sm font-medium transition disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c1b17]",
  {
    variants: {
      variant: {
        default: "bg-[#1c1b17] text-[#f7f4ee] hover:bg-[#34322c]",
        outline: "border border-[#8a8478] bg-white hover:bg-[#f7f4ee]",
        ghost: "hover:bg-[#ebe6dc]",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }
>(function Button({ className, variant, size, asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-10 w-full rounded-xl border border-[#8a8478] bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c1b17]",
        props.className,
      )}
    />
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(props, ref) {
  return (
    <textarea
      ref={ref}
      {...props}
      className={cn(
        "min-h-28 w-full rounded-2xl border border-[#8a8478] bg-white px-4 py-3 text-[15px] leading-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c1b17]",
        props.className,
      )}
    />
  );
});

const tones: Record<string, string> = {
  suggestion: "bg-[#efe8d8] text-[#5c5346]",
  approved: "bg-[#e7e2d8] text-[#3f3a32]",
  signed: "bg-[#e4ebe8] text-[#245246]",
  queued: "bg-[#f3e7c8] text-[#6a4b12]",
  sent: "bg-[#dceadf] text-[#1d5c3d]",
  failed: "bg-[#f6d9d4] text-[#8a2e24]",
  missed: "bg-[#f3e0cf] text-[#7a4a1e]",
  rejected: "bg-[#eceae6] text-[#6d685f]",
  discarded: "bg-[#eceae6] text-[#6d685f]",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs capitalize", tones[status] ?? tones.suggestion)} data-testid={`status-${status}`}>
      {status}
    </span>
  );
}
