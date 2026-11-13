import type {
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cx } from "./cx.mjs";

export function Field({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("grid gap-1.5", className)} />;
}

export function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      {...props}
      className={cx("text-sm font-semibold text-slate-800", className)}
    />
  );
}

const controlStyles = [
  "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm",
  "placeholder:text-slate-400 hover:border-slate-400",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-700",
  "disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 disabled:opacity-80",
  "aria-[invalid=true]:border-rose-500 aria-[invalid=true]:focus-visible:outline-rose-600",
  "motion-reduce:transition-none",
].join(" ");

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ className, invalid, "aria-invalid": ariaInvalid, ...props }: InputProps) {
  const isInvalid = invalid ?? ariaInvalid;

  return (
    <input
      {...props}
      aria-invalid={isInvalid || undefined}
      className={cx(controlStyles, className)}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select({ className, invalid, "aria-invalid": ariaInvalid, children, ...props }: SelectProps) {
  const isInvalid = invalid ?? ariaInvalid;

  return (
    <select
      {...props}
      aria-invalid={isInvalid || undefined}
      className={cx(controlStyles, "pr-9", className)}
    >
      {children}
    </select>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ className, invalid, "aria-invalid": ariaInvalid, ...props }: TextareaProps) {
  const isInvalid = invalid ?? ariaInvalid;

  return (
    <textarea
      {...props}
      aria-invalid={isInvalid || undefined}
      className={cx(controlStyles, "min-h-24 resize-y", className)}
    />
  );
}

export function FieldHint({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} className={cx("text-xs leading-5 text-slate-500", className)} />;
}

export function FieldError({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      {...props}
      role="alert"
      className={cx("text-xs font-medium leading-5 text-rose-700", className)}
    />
  );
}
