import type { ButtonHTMLAttributes } from "react";

import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variants: Record<ButtonVariant, string> = {
  primary: "border border-transparent bg-brand-700 text-white shadow-sm hover:bg-brand-800 focus-visible:outline-brand-700",
  secondary: "border border-slate-200 bg-slate-100 text-slate-900 hover:bg-slate-200 focus-visible:outline-slate-500",
  outline: "border border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-brand-700",
  ghost: "border border-transparent bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:outline-brand-700",
  danger: "border border-transparent bg-rose-700 text-white shadow-sm hover:bg-rose-800 focus-visible:outline-rose-700",
};

const sizes: Record<ButtonSize, string> = {
  sm: "min-h-8 rounded-md px-3 text-xs",
  md: "min-h-10 rounded-lg px-4 text-sm",
  lg: "min-h-12 rounded-xl px-5 text-base",
  icon: "size-10 rounded-lg p-0 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-2 font-semibold transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "motion-reduce:transition-none",
        variants[variant],
        sizes[size],
        className,
      )}
    />
  );
}
